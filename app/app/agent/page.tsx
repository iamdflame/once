import type { Metadata } from "next";
import { Bench } from "@/components/bench/Bench";

export const metadata: Metadata = {
  title: "The bench — Once",
  description: "The agent writes settle.js and the world runs 30 storms against it inside the sandbox.",
};

export default function AgentPage() {
  return <Bench />;
}
