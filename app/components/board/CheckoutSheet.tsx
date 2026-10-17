"use client";

import { useEffect, useRef, useState } from "react";
import s from "./board.module.css";

/**
 * Mock mode only: a stand-in for Stripe Checkout so the demo runs without
 * keys. In live mode the board redirects to the real hosted Checkout page.
 */
export function CheckoutSheet({ charger, onPay, onClose }: { charger: string; onPay(): Promise<void>; onClose(): void }) {
  const [paying, setPaying] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !paying) onClose();
    };
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("button[data-pay]")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, paying]);

  return (
    <div className={s.sheetBackdrop} onClick={() => !paying && onClose()}>
      <div ref={ref} className={s.sheet} role="dialog" aria-modal="true" aria-labelledby="sheet-h" onClick={(e) => e.stopPropagation()}>
        <div className={s.sheetTag}>MOCK CHECKOUT · stand-in for Stripe Checkout (test mode)</div>
        <div className={s.sheetBody}>
          <div className={s.sheetSummary}>
            <p className={s.sheetMerchant}>Once charging</p>
            <h2 id="sheet-h" className={s.sheetAmount}>
              €50.00 <small>hold</small>
            </h2>
            <p className={s.sheetItem}>
              Charging hold · charger {charger}
              <br />
              <span>Authorised now, captured once for the energy used, the rest released.</span>
            </p>
          </div>
          <form
            className={s.sheetForm}
            onSubmit={async (e) => {
              e.preventDefault();
              setPaying(true);
              await onPay();
            }}
          >
            <label className={s.field}>
              <span>Card number</span>
              <input readOnly value="4242 4242 4242 4242" className="num" />
            </label>
            <div className={s.fieldRow}>
              <label className={s.field}>
                <span>Expiry</span>
                <input readOnly value="12 / 34" className="num" />
              </label>
              <label className={s.field}>
                <span>CVC</span>
                <input readOnly value="123" className="num" />
              </label>
            </div>
            <button type="submit" data-pay className={`btn btn-steel ${s.payBtn}`} disabled={paying}>
              {paying ? <span className={s.spinner} aria-label="Paying" /> : "Pay €50.00"}
            </button>
            <button type="button" className={s.sheetCancel} onClick={onClose} disabled={paying}>
              Cancel
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
