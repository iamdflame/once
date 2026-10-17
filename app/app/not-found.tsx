import Link from "next/link";

export default function NotFound() {
  return (
    <section className="wrap" style={{ padding: "96px 0 64px", maxWidth: 640 }}>
      <p style={{ fontFamily: "var(--font-seg)", fontSize: 64, color: "var(--hold-amber-ink)", lineHeight: 1 }} aria-hidden="true">
        404
      </p>
      <h1 style={{ marginTop: 16, fontSize: "2.2rem" }}>No charger at this address.</h1>
      <p style={{ marginTop: 12, color: "var(--ink-soft)" }}>The wall has twelve plates and four pages. This is none of them.</p>
      <p style={{ marginTop: 24 }}>
        <Link href="/" className="btn btn-primary">
          Back to the board
        </Link>
      </p>
    </section>
  );
}
