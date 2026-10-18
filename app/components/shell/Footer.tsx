import Link from "next/link";
import s from "./shell.module.css";

export const REPO = "https://github.com/iamdflame/once";

const COLUMNS: { title: string; links: { href: string; label: string; external?: boolean }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/", label: "Board" },
      { href: "/agent", label: "Bench" },
      { href: "/proof", label: "Proof" },
      { href: "/demo", label: "Demo" },
      { href: "/status", label: "Status" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/pricing", label: "Pricing" },
      { href: "/docs", label: "Docs" },
      { href: "/security", label: "Security" },
      { href: "/about", label: "About" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
      { href: REPO, label: "Source on GitHub", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={`wrap ${s.footerGrid}`}>
        <div className={s.footerBrand}>
          <p className={s.footerWord}>ONCE</p>
          <p className={s.footerLine}>The world decides, the host executes with an idempotency key, Stripe witnesses it.</p>
          <p className={s.footerNote}>
            Stripe test mode only. No real money moves. Built during the CreateOS × Stripe hackathon: the product code started from an empty directory at kickoff; the research and planning happened before.
          </p>
        </div>

        <nav className={s.footerCols} aria-label="Footer">
          {COLUMNS.map((col) => (
            <div key={col.title} className={s.footerCol}>
              <h2 className={s.footerColTitle}>{col.title}</h2>
              <ul>
                {col.links.map((l) =>
                  l.external ? (
                    <li key={l.href}>
                      <a href={l.href} target="_blank" rel="noreferrer">
                        {l.label}
                      </a>
                    </li>
                  ) : (
                    <li key={l.href}>
                      <Link href={l.href}>{l.label}</Link>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ))}
        </nav>

        <dl className={s.ratingPlate} aria-label="Rating plate">
          <div>
            <dt>Stack</dt>
            <dd>Stripe Projects</dd>
          </div>
          <div>
            <dt>Sandbox</dt>
            <dd>CreateOS</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>OpenRouter</dd>
          </div>
          <div>
            <dt>Host</dt>
            <dd>Vercel</dd>
          </div>
          <div>
            <dt>Money</dt>
            <dd>Stripe · test mode</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              <a href={REPO} target="_blank" rel="noreferrer">
                iamdflame/once
              </a>
            </dd>
          </div>
        </dl>
      </div>
    </footer>
  );
}
