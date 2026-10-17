// Model calls for the agent loop, streamed. Anthropic Claude when ANTHROPIC_API_KEY is
// set; otherwise OpenRouter (the key Stripe Projects provisions) with a chain of free
// coder models, falling through to the next one when a model errors or is rate-limited.
import "server-only";
import { env } from "./env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type StreamHandlers = {
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onModel?: (info: { provider: string; model: string }) => void;
  onFallback?: (info: { model: string; error: string }) => void;
};
export type Completion = { provider: "anthropic" | "openrouter"; model: string; text: string; reasoning: string; ms: number };

export const DEFAULT_FREE_MODELS = [
  "qwen/qwen3-coder:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free",
  "thinkingmachines/inkling:free",
];

export function modelPlan(): { provider: "anthropic" | "openrouter" | "none"; models: string[] } {
  if (env.anthropicKey()) return { provider: "anthropic", models: [env.anthropicModel()] };
  if (env.openrouterKey()) {
    const custom = env.openrouterModels();
    return { provider: "openrouter", models: custom ? custom.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_FREE_MODELS };
  }
  return { provider: "none", models: [] };
}

/** Parse a server-sent-events body into `data:` payloads. */
async function* sse(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

async function openrouter(model: string, messages: ChatMessage[], h: StreamHandlers, signal?: AbortSignal): Promise<Completion> {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openrouterKey()}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://once.local",
      "X-Title": "Once",
    },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 16000, temperature: 0.2 }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    let msg = body;
    try {
      const j = JSON.parse(body);
      msg = j?.error?.message ?? body;
      const raw = j?.error?.metadata?.raw;
      if (raw) msg += ` (${String(raw).slice(0, 200)})`;
    } catch {}
    throw new Error(`OpenRouter ${res.status} for ${model}: ${msg.slice(0, 400)}`);
  }
  let text = "";
  let reasoning = "";
  for await (const data of sse(res)) {
    if (data === "[DONE]") break;
    let j: { error?: { message?: string }; choices?: { delta?: { content?: string; reasoning?: string } }[] };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new Error(`OpenRouter stream error for ${model}: ${j.error.message ?? JSON.stringify(j.error)}`);
    const d = j.choices?.[0]?.delta;
    if (d?.reasoning) {
      reasoning += d.reasoning;
      h.onReasoning?.(d.reasoning);
    }
    if (d?.content) {
      text += d.content;
      h.onText?.(d.content);
    }
  }
  if (!text.trim()) throw new Error(`OpenRouter ${model} returned no content`);
  return { provider: "openrouter", model, text, reasoning, ms: Date.now() - t0 };
}

async function anthropic(model: string, messages: ChatMessage[], h: StreamHandlers, signal?: AbortSignal): Promise<Completion> {
  const t0 = Date.now();
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.anthropicKey()!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      stream: true,
      system,
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${(await res.text().catch(() => "")).slice(0, 400)}`);
  let text = "";
  let reasoning = "";
  for await (const data of sse(res)) {
    let j: { type?: string; delta?: { type?: string; text?: string; thinking?: string }; error?: { message?: string } };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.type === "error") throw new Error(`Anthropic stream error: ${j.error?.message}`);
    if (j.type === "content_block_delta") {
      if (j.delta?.type === "text_delta" && j.delta.text) {
        text += j.delta.text;
        h.onText?.(j.delta.text);
      } else if (j.delta?.type === "thinking_delta" && j.delta.thinking) {
        reasoning += j.delta.thinking;
        h.onReasoning?.(j.delta.thinking);
      }
    }
  }
  if (!text.trim()) throw new Error(`Anthropic ${model} returned no content`);
  return { provider: "anthropic", model, text, reasoning, ms: Date.now() - t0 };
}

/**
 * Complete with the first model that answers. `accept` lets the caller reject an answer
 * (e.g. no code block) and fall through to the next model.
 */
export async function complete(
  messages: ChatMessage[],
  h: StreamHandlers = {},
  opts: { signal?: AbortSignal; accept?: (c: Completion) => string | null; startAt?: number } = {},
): Promise<Completion & { modelIndex: number }> {
  const plan = modelPlan();
  if (plan.provider === "none") throw new Error("no model key: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (Stripe Projects writes OPENROUTER_API_API_KEY)");
  const errors: string[] = [];
  for (let idx = opts.startAt ?? 0; idx < plan.models.length; idx++) {
    const model = plan.models[idx];
    h.onModel?.({ provider: plan.provider, model });
    try {
      const c = plan.provider === "anthropic" ? await anthropic(model, messages, h, opts.signal) : await openrouter(model, messages, h, opts.signal);
      const reject = opts.accept?.(c);
      if (reject) throw new Error(`${model}: ${reject}`);
      return { ...c, modelIndex: idx };
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const msg = (e as Error).message;
      errors.push(msg);
      h.onFallback?.({ model, error: msg });
    }
  }
  throw new Error(`every model failed: ${errors.join(" | ")}`);
}
