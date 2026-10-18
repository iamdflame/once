import type { Metadata } from "next";
import Link from "next/link";
import s from "../about/about.module.css";

export const metadata: Metadata = {
  title: "Demo — Once",
  description: "Two minutes: a Stripe test hold, a cut cable, the wrong driver billed by naive code, and the agent's fix proven in a CreateOS sandbox.",
};

export default function DemoPage() {
  return (
    <>
      <section className={`wrap ${s.head}`}>
        <h1 className={s.h1}>The two-minute demo</h1>
        <p className={s.lede}>
          Once in two minutes: a €50 test hold, a cut cable, the next driver billed for the previous driver&apos;s energy by naive code, and the agent&apos;s settlement program proven against 30 fault storms inside the CreateOS sandbox before it ships.
        </p>
      </section>
      <section className="wrap" style={{ paddingBottom: "4rem" }}>
        <video
          controls
          playsInline
          preload="metadata"
          poster="/demo/once-thumbnail.png"
          style={{ width: "100%", aspectRatio: "16 / 9", background: "var(--lcd-deep)", borderRadius: 14, boxShadow: "0 18px 50px oklch(0.3 0.03 70 / 0.25)" }}
        >
          <source src="/demo/once-demo.mp4" type="video/mp4" />
          <track kind="captions" src="/demo/once-demo.vtt" srcLang="en" label="English" />
        </video>
        <p style={{ marginTop: "1rem", color: "var(--ink-soft)" }}>
          <a href="/demo/once-demo.mp4" download>Download the video (MP4)</a> · Voiceover: ElevenLabs v4 · Music: ElevenLabs Music · B-roll: Pexels (licence in the repo) ·{" "}
          <Link href="/">Try it yourself</Link>
        </p>
      </section>
    </>
  );
}
