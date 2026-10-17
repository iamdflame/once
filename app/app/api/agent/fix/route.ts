// POST /api/agent/fix: the agent writes settle.js; the world runs the suite. Streams NDJSON events (lib/agent.ts AgentEvent).
import { runAgentFix, type AgentEvent } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const maxDuration = 300;

const g = globalThis as unknown as { __onceAgentBusy?: boolean };

export async function POST() {
  if (g.__onceAgentBusy) {
    return Response.json({ error: "an agent run is already in progress" }, { status: 409 });
  }
  g.__onceAgentBusy = true;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const emit = (e: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify({ ...e, at: Date.now() }) + "\n"));
        } catch {
          open = false;
        }
      };
      const ping = setInterval(() => emit({ type: "delta", text: "" }), 10_000);
      try {
        // Not tied to req.signal: a run that loses its client still finishes, so a red attempt is reverted.
        await runAgentFix(emit);
      } catch (e) {
        emit({ type: "error", text: (e as Error)?.message ?? String(e) });
        emit({ type: "done", ok: false, version: "", attempts: 0, reason: "agent crashed" });
      } finally {
        clearInterval(ping);
        g.__onceAgentBusy = false;
        open = false;
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
