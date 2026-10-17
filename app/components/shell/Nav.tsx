"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useWorld } from "@/components/data/provider";
import s from "./shell.module.css";

const LINKS = [
  { href: "/", label: "Board" },
  { href: "/agent", label: "Bench" },
  { href: "/proof", label: "Proof" },
  { href: "/status", label: "Status" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/about", label: "About" },
];

export function Nav() {
  const path = usePathname();
  const { mode, snap, setMode } = useWorld();
  return (
    <header className={s.nav}>
      <div className={`wrap ${s.navRow}`}>
        <Link href="/" className={s.brand} aria-label="Once, home">
          <Mark />
          <span className={s.wordmark}>
            ONCE
            <small>exactly-once payments for EV chargers</small>
          </span>
        </Link>
        <nav aria-label="Primary" className={s.links}>
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={s.link}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className={s.modeWrap}>
          <button
            type="button"
            className={`${s.mode} ${mode === "live" ? s.modeLive : s.modeMock} ${snap.connected ? "" : s.modeDown}`}
            onClick={() => setMode(mode === "live" ? "mock" : "live")}
            title={mode === "live" ? "Talking to the CreateOS sandbox and Stripe test mode. Click for the in-browser mock." : "In-browser mock world. Click to use the sandbox and Stripe test mode."}
          >
            <span className={s.modeDot} aria-hidden="true" />
            {mode === "live" ? (snap.connected ? "sandbox · test mode" : "sandbox · connecting") : "mock world"}
          </button>
        </div>
      </div>
    </header>
  );
}

function Mark() {
  // A faceplate seen head-on: enamel plate, a dark LCD, one amber digit.
  return (
    <svg className={s.mark} width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
      <rect x="1.5" y="1.5" width="31" height="31" rx="7" fill="var(--enamel)" stroke="oklch(0.3 0.02 60 / 0.25)" />
      <rect x="6" y="7" width="22" height="13" rx="2.5" fill="var(--lcd)" />
      <text x="17" y="17.6" textAnchor="middle" fontFamily="var(--font-seg)" fontWeight="700" fontSize="10" fill="var(--segment-amber)">
        1
      </text>
      <circle cx="17" cy="26" r="2.2" fill="var(--captured-green)" />
    </svg>
  );
}
