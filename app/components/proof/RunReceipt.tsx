"use client";

import { useState } from "react";
import type { Proof, Settle } from "@/components/data/types";
import s from "./proof.module.css";

/**
 * "Download run receipt": a JSON a third party can check against Stripe. Live mode
 * downloads the host's /api/receipt (the world's sha256 and one the host computes);
 * mock mode builds the same shape in the browser from the in-memory world, labelled.
 */
export function RunReceipt({ mode, proof, settle }: { mode: "mock" | "live"; proof: Proof | null; settle: Settle | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      let blob: Blob;
      let name: string;
      if (mode === "live") {
        const res = await fetch("/api/receipt", { cache: "no-store" });
        if (!res.ok) {
          let msg = `the host answered ${res.status}`;
          try {
            msg = ((await res.json()) as { error?: string }).error ?? msg;
          } catch {
            /* keep */
          }
          throw new Error(msg);
        }
        blob = await res.blob();
        name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? `once-run-receipt-${stamp()}.json`;
      } else {
        const body = await mockReceipt(proof, settle);
        blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
        name = `once-run-receipt-mock-${stamp()}.json`;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.receiptBox}>
      <button type="button" className="btn btn-steel" onClick={() => void download()} disabled={busy}>
        <DownloadIcon />
        {busy ? "Preparing…" : "Download run receipt"}
      </button>
      <span className={s.receiptNote}>
        {mode === "live"
          ? "JSON: sha256 of the deployed settle.js, the latest suite summary, every capture with its PaymentIntent id, idempotency key and status. Check each id with stripe payment_intents retrieve."
          : "Mock world: the same JSON shape, built in the browser and labelled mock. The Stripe ids are stand-ins."}
        {err ? <b className={s.err}> {err}</b> : null}
      </span>
    </div>
  );
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function sha256(text: string): Promise<string | null> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

async function mockReceipt(proof: Proof | null, settle: Settle | null) {
  const source = settle?.source ?? "";
  return {
    receipt: "once-run-receipt",
    schema: 1,
    mode: "mock",
    note: "Built in the browser from the in-memory mock world. The payment_intent ids are stand-ins and do not exist on Stripe.",
    generated_at: new Date().toISOString(),
    stripe_mode: "none (mock)",
    settle: {
      deploy: settle?.version ?? null,
      name: settle?.name ?? (settle?.author === "agent" ? "agent-written" : "v1-naive.js"),
      bytes: source.length,
      sha256_computed_in_browser: source ? await sha256(source) : null,
    },
    suite: proof?.suite
      ? {
          ran_at: proof.suite.ran_at ? new Date(proof.suite.ran_at).toISOString() : null,
          deploy: proof.suite.version,
          summary: proof.suite.summary ?? null,
          totals: proof.suite.totals,
          scenarios: proof.suite.scenarios.map((sc) => ({ seed: sc.seed, name: sc.name ?? null, faults: sc.faults, ok: sc.ok, double: sc.double, stranded: sc.stranded, unbilled: sc.unbilled, overbilled: sc.overbilled, underbilled: sc.underbilled ?? 0 })),
        }
      : null,
    captures: (proof?.captures ?? []).map((c) => ({
      at: c.t ? new Date(c.t).toISOString() : null,
      episode_id: c.episode_id,
      charger: c.charger,
      payment_intent: c.payment_intent,
      amount_cents: c.amount_cents,
      authorized_cents: c.authorized_cents,
      status: c.status,
      idempotency_key: c.idempotency_key,
      stripe_error: c.error ?? null,
    })),
    sandbox: proof?.sandbox ?? null,
  };
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}
