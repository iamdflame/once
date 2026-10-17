import type { Metadata } from "next";
import { StatusView } from "@/components/status/StatusView";

export const metadata: Metadata = {
  title: "Status — Once",
  description: "Asserted outcomes: the world, the sandbox and its egress, creates against the plan, the last capture, the last suite, Stripe test mode.",
};

export default function StatusPage() {
  return <StatusView />;
}
