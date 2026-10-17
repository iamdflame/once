import type { Metadata, Viewport } from "next";
import { Barlow_Semi_Condensed, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { WorldProvider } from "@/components/data/provider";
import { Nav } from "@/components/shell/Nav";
import { Footer } from "@/components/shell/Footer";

const barlow = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-mono",
  display: "swap",
});

const dseg = localFont({
  src: [
    { path: "../public/fonts/DSEG7Classic-Bold.woff2", weight: "700", style: "normal" },
    { path: "../public/fonts/DSEG7Classic-Regular.woff2", weight: "400", style: "normal" },
  ],
  variable: "--font-lcd",
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: "Once — exactly-once payments for EV chargers",
  description:
    "Cut the cable, pull the plug, bring it back. The charger reports the stop twice. Stripe captures once. An agent writes the hold-meter-capture code and proves it against a fleet of simulated chargers in a CreateOS sandbox.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Once — exactly-once payments for EV chargers",
    description: "The charger reported the stop twice. Stripe captured once: €11.40.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#d8d2c4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${barlow.variable} ${mono.variable} ${dseg.variable}`}>
      <body>
        <WorldProvider>
          <a className="skip" href="#main">
            Skip to the board
          </a>
          <Nav />
          <main id="main">{children}</main>
          <Footer />
        </WorldProvider>
      </body>
    </html>
  );
}
