import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal/legal-document";
import { PRIVACY_POLICY } from "@/lib/legal/privacy-policy";

export const metadata: Metadata = {
  title: "Privacy Policy | arcagent",
  description:
    "Read the ArcAgent Privacy Policy covering account, bounty, repository, verification, payment, and integration data.",
};

export default function PrivacyPage() {
  return <LegalDocument document={PRIVACY_POLICY} />;
}
