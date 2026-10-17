import Link from "next/link";
import s from "./shell.module.css";

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={`wrap ${s.footerRow}`}>
        <p className={s.footerLine}>
          <strong>Once</strong> · the world decides, the host executes with idempotency, Stripe is the witness.
        </p>
        <p className={s.footerStack}>
          Built on <span>Stripe Projects</span> · <span>CreateOS</span> · Stripe test mode only · <Link href="/proof">how to verify</Link>
        </p>
      </div>
    </footer>
  );
}
