import type { Metadata } from "next";
import Link from "next/link";
import s from "@/components/shell/prose.module.css";

export const metadata: Metadata = {
  title: "Privacy — Once",
  description: "No accounts, no tracking. Card details go to Stripe Checkout in test mode and never reach this project.",
};

export default function PrivacyPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>Privacy</h1>
        <p className={s.lede}>No accounts, no analytics, no cookies of our own. Last changed 2026-10-17.</p>
      </section>
      <section className="wrap">
        <div className={`${s.sheet} ${s.prose}`}>
          <h2 id="collected">What is collected</h2>
          <ul>
            <li>
              <b>Nothing by this project.</b> There is no sign-up, no analytics script and no advertising. The one thing stored in your browser is <code>{'localStorage["once.mode"]'}</code>, your choice between the mock world and the sandbox.
            </li>
            <li>
              <b>Stripe Checkout</b> (test mode) handles the payment page. What you type there goes to Stripe under{" "}
              <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">
                Stripe&apos;s privacy policy
              </a>
              ; this project receives the Checkout Session and PaymentIntent ids and their status, not the card number. Use the test card, not a real one.
            </li>
            <li>
              <b>Hosting.</b> The app runs on Vercel; the sandbox on CreateOS; the model on OpenRouter. Each may keep ordinary server logs (IP address, request path, time) under its own policy. The model receives the settlement program and scenario reports, never anything you typed.
            </li>
          </ul>
          <h2 id="kept">What is kept</h2>
          <p>
            Holds, captures and refusals are Stripe test objects in a test sandbox; they are visible on the <Link href="/proof">proof page</Link> with their Stripe ids so anyone can check them. They carry a charger id, an amount and a time, not a person. The world&apos;s state lives in
            memory inside the sandbox and is gone when it is reset.
          </p>
          <h2 id="contact">Questions</h2>
          <p>
            Open an issue at{" "}
            <a href="https://github.com/iamdflame/once/issues" target="_blank" rel="noreferrer">
              github.com/iamdflame/once/issues
            </a>
            .
          </p>
        </div>
      </section>
    </>
  );
}
