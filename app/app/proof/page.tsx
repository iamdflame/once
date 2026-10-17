import type { Metadata } from "next";
import { ProofView } from "@/components/proof/ProofView";

export const metadata: Metadata = {
  title: "Proof — Once",
  description: "Every capture with its Stripe id, the latest storm report, the sandbox settings and how to verify.",
};

export default function ProofPage() {
  return <ProofView />;
}
