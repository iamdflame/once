// Model calls for the agent loop, streamed. Anthropic Claude when ANTHROPIC_API_KEY is
// set; otherwise OpenRouter (the key Stripe Projects provisions) with a chain of free
// coder models, falling through to the next one when a model errors or is rate-limited.
import "server-only";
import { env } from "./env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type StreamHandlers = {
  onText?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  /** A model is being tried (it may still fail and fall through to the next). */
  onTrying?: (info: { provider: string; model: string }) => void;
  onFallback?: (info: { model: string; error: string }) => void;
};
/** `model` is the id the provider reports it actually ran (OpenRouter's routed model, Anthropic's message.model); `requested` is what we asked for. */
export type Completion = { provider: "anthropic" | "openrouter"; model: string; requested: string; text: string; reasoning: string; ms: number };

// Free models on OpenRouter, best coder first. qwen3-coder:free was the planned default
// and is tried first, but OpenRouter withdrew its free tier (404) on 2026-10-17;
// inkling:free is restricted to listed agent apps (403), so it is not in the chain.
export const DEFAULT_FREE_MODELS = [
  "qwen/qwen3-coder:free",
  "poolside/laguna-s-2.1:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
];

/** Per model call: a free model that is still thinking after this is abandoned for the next one. */
const CALL_TIMEOUT_MS = 110_000;

class RetryableError extends Error {}

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
    // Low reasoning effort: some free models otherwise spend the whole budget thinking.
    body: JSON.stringify({ model, messages, stream: true, max_tokens: 16000, temperature: 0.2, reasoning: { effort: "low" } }),
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
    const E = res.status === 429 || res.status >= 500 ? RetryableError : Error;
    throw new E(`OpenRouter ${res.status} for ${model}: ${msg.slice(0, 400)}`);
  }
  let text = "";
  let reasoning = "";
  let served = "";
  for await (const data of sse(res)) {
    if (data === "[DONE]") break;
    let j: { model?: string; error?: { message?: string }; choices?: { delta?: { content?: string; reasoning?: string } }[] };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) {
      const m = j.error.message ?? JSON.stringify(j.error);
      throw new (/overloaded|rate|temporar|timeout/i.test(m) ? RetryableError : Error)(`OpenRouter stream error for ${model}: ${m}`);
    }
    if (j.model && !served) served = j.model;
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
  return { provider: "openrouter", model: served || model, requested: model, text, reasoning, ms: Date.now() - t0 };
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
  let served = "";
  for await (const data of sse(res)) {
    let j: { type?: string; message?: { model?: string }; delta?: { type?: string; text?: string; thinking?: string }; error?: { message?: string } };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.type === "error") throw new Error(`Anthropic stream error: ${j.error?.message}`);
    if (j.type === "message_start" && j.message?.model) served = j.message.model;
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
  return { provider: "anthropic", model: served || model, requested: model, text, reasoning, ms: Date.now() - t0 };
}

/**
 * Complete with the first model that answers. `accept` lets the caller reject an answer
 * (e.g. no code block) and fall through to the next model.
 */
export async function complete(
  messages: ChatMessage[],
  h: StreamHandlers = {},
  opts: { signal?: AbortSignal; accept?: (c: Completion) => string | null; startAt?: number; deadline?: number } = {},
): Promise<Completion & { modelIndex: number }> {
  const plan = modelPlan();
  if (plan.provider === "none") throw new Error("no model key: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (Stripe Projects writes OPENROUTER_API_API_KEY)");
  const errors: string[] = [];
  const deadline = opts.deadline ?? Infinity;
  // Two passes over the chain: free models are often rate-limited or overloaded for a
  // few seconds, so a model that failed with a retryable error gets one more chance.
  const retry = new Set<number>();
  for (let pass = 0; pass < 2; pass++) {
    for (let idx = opts.startAt ?? 0; idx < plan.models.length; idx++) {
      if (pass === 1 && !retry.has(idx)) continue;
      if (Date.now() > deadline - 20_000) {
        errors.push("out of time");
        break;
      }
      const model = plan.models[idx];
      // The model that answered last time (startAt) is worth waiting for when it is only
      // rate-limited: up to two short backoffs before falling through to slower models.
      const tries = idx === opts.startAt && pass === 0 ? 3 : 1;
      for (let t = 0; t < tries; t++) {
        h.onTrying?.({ provider: plan.provider, model });
        const budget = Math.max(15_000, Math.min(CALL_TIMEOUT_MS, deadline - Date.now() - 15_000));
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(budget)]) : AbortSignal.timeout(budget);
        try {
          const c = plan.provider === "anthropic" ? await anthropic(model, messages, h, signal) : await openrouter(model, messages, h, signal);
          const reject = opts.accept?.(c);
          if (reject) throw new Error(`${model}: ${reject}`);
          return { ...c, modelIndex: idx };
        } catch (e) {
          if (opts.signal?.aborted) throw e;
          const timedOut = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
          const msg = timedOut ? `${model}: no answer within ${Math.round(budget / 1000)} s` : (e as Error).message;
          errors.push(msg);
          h.onFallback?.({ model, error: msg });
          if (!(e instanceof RetryableError)) break;
          if (t === tries - 1) {
            if (pass === 0) retry.add(idx);
            break;
          }
          await new Promise((r) => setTimeout(r, 6000 * (t + 1)));
        }
      }
    }
    if (retry.size === 0) break;
    if (pass === 0) await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`every model failed: ${errors.join(" | ")}`);
}
