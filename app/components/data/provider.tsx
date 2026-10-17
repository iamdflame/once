"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WorldAdapter } from "./adapter";
import { MockWorld } from "./mock";
import { LiveWorld } from "./live";
import type { Mode, Snapshot } from "./types";

interface Ctx {
  world: WorldAdapter;
  snap: Snapshot;
  mode: Mode;
  /** Whether the mode was chosen by the person or the environment (vs probed). */
  modeSource: "url" | "stored" | "env" | "probe";
  setMode(m: Mode): void;
}

const WorldCtx = createContext<Ctx | null>(null);

const g = globalThis as unknown as { __onceMock?: MockWorld; __onceLive?: LiveWorld };
const getMock = () => (g.__onceMock ??= new MockWorld());
const getLive = () => (g.__onceLive ??= new LiveWorld());

const STORE = "once.mode";

/** What the server renders: an empty wall. The client swaps in the real snapshot after hydration. */
const EMPTY: Snapshot = {
  chargers: [],
  events: [],
  receipt: [],
  intents: [],
  settle: { version: "v1", source: "", author: "shipped", loaded_at: 0 },
  suite: null,
  sandbox: { provider: "mock", name: "once-world", rootfs: "devbox:1", egress: ["sinkhole.invalid"], keys_inside: [], state: "absent" },
  tariff_cents_per_kwh: 38,
  connected: false,
};

function initialMode(): { mode: Mode; source: Ctx["modeSource"] } {
  if (typeof window === "undefined") return { mode: "mock", source: "env" };
  const q = new URLSearchParams(window.location.search).get("mode");
  if (q === "mock" || q === "live") {
    try {
      window.localStorage.setItem(STORE, q);
    } catch {
      /* private window */
    }
    return { mode: q, source: "url" };
  }
  try {
    const s = window.localStorage.getItem(STORE);
    if (s === "mock" || s === "live") return { mode: s, source: "stored" };
  } catch {
    /* private window */
  }
  const env = process.env.NEXT_PUBLIC_ONCE_MODE;
  if (env === "mock" || env === "live") return { mode: env, source: "env" };
  return { mode: "mock", source: "probe" };
}

export function WorldProvider({ children }: { children: React.ReactNode }) {
  // The server and the first client render agree on "mock"; the real choice
  // (URL, storage, env, probe) is applied right after mount, so hydration matches.
  const [{ mode, source }, setModeState] = useState<{ mode: Mode; source: Ctx["modeSource"] }>({ mode: "mock", source: "env" });
  const resolved = useRef(false);
  useEffect(() => {
    if (resolved.current) return;
    resolved.current = true;
    const m = initialMode();
    setModeState(m);
  }, []);
  const world = useMemo<WorldAdapter>(() => (mode === "live" ? getLive() : getMock()), [mode]);
  const probed = useRef(false);
  const subscribe = useCallback((fn: () => void) => world.subscribe(fn), [world]);
  const getSnap = useCallback(() => world.snapshot(), [world]);
  const snap = useSyncExternalStore(subscribe, getSnap, () => EMPTY);

  useEffect(() => {
    world.start();
    return () => world.stop();
  }, [world]);

  // With no explicit choice, ask once whether the live routes exist.
  useEffect(() => {
    if (source !== "probe" || probed.current) return;
    probed.current = true;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    fetch("/api/world/state", { cache: "no-store", signal: ctl.signal })
      .then((r) => {
        if (r.ok) setModeState({ mode: "live", source: "probe" });
      })
      .catch(() => {})
      .finally(() => clearTimeout(t));
  }, [source]);

  const setMode = useCallback((m: Mode) => {
    try {
      window.localStorage.setItem(STORE, m);
    } catch {
      /* private window */
    }
    setModeState({ mode: m, source: "stored" });
  }, []);

  const value = useMemo<Ctx>(() => ({ world, snap, mode, modeSource: source, setMode }), [world, snap, mode, source, setMode]);
  return <WorldCtx.Provider value={value}>{children}</WorldCtx.Provider>;
}

export function useWorld(): Ctx {
  const ctx = useContext(WorldCtx);
  if (!ctx) throw new Error("useWorld outside WorldProvider");
  return ctx;
}
