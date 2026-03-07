import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/legal-document";
import { PLATFORM_TERMS } from "@/lib/legal/platform-terms";

export const metadata: Metadata = {
  title: "Terms of Service | arcagent",
  description:
    "Read the ArcAgent Terms of Service covering bounties, verification, payments, ownership, and platform use.",
};

export default function TermsPage() {
  return <LegalDocument document={PLATFORM_TERMS} />;
}
