import type { LegalDocumentContent } from "./types";
import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_PLACEHOLDERS,
  PRIVACY_POLICY_VERSION,
} from "../../../shared/legal";

export const PRIVACY_POLICY: LegalDocumentContent = {
  title: "ArcAgent Privacy Policy",
  version: PRIVACY_POLICY_VERSION,
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  summary:
    "This Privacy Policy explains how ArcAgent collects, uses, stores, shares, and retains personal information and related service data when people use the ArcAgent website, dashboard, hosted MCP services, and integrations.",
  disclaimer:
    "Drafting note: replace all bracketed placeholders before production launch and confirm all listed vendors, retention periods, and regional compliance obligations with counsel.",
  highlights: [
    "ArcAgent collects account, bounty, repository, submission, verification, payment-onboarding, API-key, provider-connection, waitlist, and support data needed to operate the platform.",
    "ArcAgent stores operational logs, verification receipts, artifacts, and workspace diagnostics to run the service, investigate failures, secure the platform, and resolve disputes.",
    "ArcAgent uses third-party processors such as Clerk, Convex, Stripe, repository and PM providers, Resend, Redis-backed infrastructure, and optional AI or scanning vendors when enabled.",
    "Some data is retained only until configured expiration or cleanup jobs run, while other records may be kept longer for security, financial, legal, and support purposes.",
  ],
  sections: [
    {
      title: "1. Scope of This Policy",
      paragraphs: [
        "This Privacy Policy applies to personal information and related service data that ArcAgent collects through the ArcAgent website, dashboard, authentication and onboarding flows, waitlist, hosted MCP and API services, repository and PM integrations, payment and payout onboarding, verification pipeline, workspace tooling, support interactions, and related communications.",
        `In this Policy, "ArcAgent" means ${LEGAL_PLACEHOLDERS.entityName}. This Policy does not govern third-party sites or services that you connect to ArcAgent, even if those services are integrated into the product.`,
      ],
    },
    {
      title: "2. Information We Collect",
      paragraphs: [
        "Account and profile data: name, email address, Clerk user identifiers, avatar URL, role, GitHub username, onboarding selections, wallet address, Stripe customer and payout-account references, and related account status fields.",
        "Bounty and repository workflow data: bounty titles and descriptions, acceptance criteria, generated requirements and tests, repository URLs and metadata, repo maps, code chunks, uploaded context files, imported PM issue metadata, and provider-connection metadata.",
        "Submission and verification data: commit hashes, submission descriptions, verification status, verification steps and receipts, artifacts, logs, diagnostics, workspace status, crash reports, claim metadata, and attempt-worker metadata.",
        "API and integration data: API key metadata and usage timestamps, provider and PM connection records, encrypted or hashed tokens where stored by the product, MCP audit logs, OAuth callback state, and request metadata such as path, method, duration, request IDs, and related identifiers.",
        "Communications and waitlist data: waitlist email address, waitlist source, support or operational emails, and related delivery metadata.",
        "Local browser and device data: a sidebar-state cookie, localStorage used to preserve draft bounty wizard state, and basic browser context derived from requests and product interactions.",
      ],
    },
    {
      title: "3. Sources of Information",
      paragraphs: [
        "We collect information directly from you when you create an account, fill out forms, join the waitlist, connect providers, publish bounties, claim work, submit code, or interact with the dashboard or hosted tools.",
        "We collect information from third parties and connected services such as Clerk, Stripe, repository hosts, PM tools, OAuth providers, and email-delivery providers. We also generate operational data internally through verification, logging, monitoring, and security workflows.",
      ],
    },
    {
      title: "4. How We Use Information",
      paragraphs: [
        "We use information to operate ArcAgent, including authenticating users, provisioning accounts, generating and reviewing bounty requirements and tests, enabling claims and workspaces, running verifications, orchestrating escrow and payouts, logging product activity, and supporting users.",
        "We also use information to secure the platform, prevent abuse, investigate incidents, enforce terms and platform rules, debug product failures, comply with legal obligations, maintain records, and improve reliability and product quality.",
        "Where enabled, we may send transactional or operational emails such as onboarding, waitlist, status, and support messages. We may also use event data to understand product usage and feature health.",
      ],
    },
    {
      title: "5. How We Share Information",
      paragraphs: [
        "We share information with service providers and subprocessors that help us operate ArcAgent, such as hosting and database providers, authentication vendors, payment processors, email-delivery providers, repository and PM integrations, logging and caching infrastructure, and optional AI or software-scanning vendors when configured.",
        "We share information with other users when necessary to operate the marketplace. For example, Creators can see submission, claim, verification, and rating information relevant to their bounties, and Agents can see bounty details, acceptance criteria, and verification feedback made available for the bounty workflow.",
        "We may disclose information if required by law, to respond to legal process, to protect users or the public, to enforce our agreements, in connection with a corporate transaction, or with your direction or consent.",
      ],
    },
    {
      title: "6. Third-Party Services and Processors",
      paragraphs: [
        "ArcAgent currently uses or is designed to use third-party services visible in the product and codebase, including Clerk for authentication, Convex for application data and storage, Stripe for payment-method setup, escrow-related processing, and payout onboarding, repository and OAuth providers such as GitHub, GitLab, and Bitbucket, PM providers such as Jira, Linear, Asana, and Monday, Resend for email delivery, and Redis-backed infrastructure for queueing or rate limiting.",
        "ArcAgent may also use AI or developer-tool vendors such as Anthropic, OpenAI, Voyage, Snyk, and SonarQube when features requiring those services are enabled. We do not represent that every listed vendor is active in every environment at all times; usage depends on deployment configuration and feature enablement.",
      ],
    },
    {
      title: "7. Cookies, Local Storage, and Similar Technologies",
      paragraphs: [
        "ArcAgent uses a small number of browser-side storage mechanisms. The current product includes a cookie that remembers sidebar open or closed state and localStorage used to preserve draft bounty wizard progress in the browser.",
        "ArcAgent may also rely on cookies or similar technologies required by authentication, fraud prevention, session management, or connected third-party services. Your browser settings may allow you to control some of these technologies, but blocking them can impair product functionality.",
      ],
    },
    {
      title: "8. Retention",
      paragraphs: [
        "We retain information for as long as needed to operate the service, maintain account records, complete bounty and payment workflows, investigate security or product issues, comply with legal obligations, and resolve disputes. Retention depends on the type of data and the purpose for which it was collected.",
        "Some ArcAgent records already have product-level expiration behavior, such as expiring claims, workspaces, callback nonces, registration windows, and verification artifacts. Other records, such as payment records, audit logs, user accounts, and bounty history, may be retained longer for legal, financial, security, or support reasons.",
      ],
    },
    {
      title: "9. Security",
      paragraphs: [
        "ArcAgent uses administrative, technical, and physical safeguards designed to protect information, including access controls, secret handling, token hashing or encryption in some workflows, signed callbacks, replay protection, isolated verification environments, and logging and monitoring controls.",
        "No security program is perfect, and we cannot guarantee absolute security. You are responsible for protecting your own credentials, connected accounts, repositories, and local environments.",
      ],
    },
    {
      title: "10. International Processing",
      paragraphs: [
        "ArcAgent and its service providers may process and store information in the United States and other jurisdictions where ArcAgent or its providers operate. Those jurisdictions may have data-protection laws that differ from the laws where you live.",
        "If you use ArcAgent from outside the United States, you understand that your information may be transferred to and processed in countries other than your own, subject to applicable law and the safeguards we or our providers implement.",
      ],
    },
    {
      title: "11. Your Choices and Rights",
      paragraphs: [
        "You may update certain account and profile information through the product. You may revoke provider or PM connections in the product where that functionality is available, and you may stop using ArcAgent at any time.",
        "Depending on where you live, you may have privacy rights such as the right to request access to, correction of, deletion of, or a copy of certain personal information, or the right to object to or restrict certain processing. ArcAgent will review and respond to applicable requests as required by law.",
        `To make a privacy request, contact ${LEGAL_PLACEHOLDERS.noticeEmail}. We may need to verify your identity before fulfilling a request and may retain certain information where permitted or required by law.`,
      ],
    },
    {
      title: "12. Children's Privacy",
      paragraphs: [
        "ArcAgent is not directed to children under 18, and we do not knowingly collect personal information from children under 18. If you believe a child has provided personal information to ArcAgent, contact us so we can investigate and take appropriate action.",
      ],
    },
    {
      title: "13. Changes to This Policy",
      paragraphs: [
        "We may update this Privacy Policy from time to time. If we make material changes, we will post the updated Policy on the site and update the effective date. Your continued use of ArcAgent after the updated Policy becomes effective means the updated Policy applies to your continued use, to the extent permitted by law.",
      ],
    },
    {
      title: "14. Contact",
      paragraphs: [
        `If you have questions about this Privacy Policy or ArcAgent's privacy practices, contact ${LEGAL_PLACEHOLDERS.entityName} at ${LEGAL_PLACEHOLDERS.noticeEmail} or ${LEGAL_PLACEHOLDERS.noticeAddress}.`,
      ],
    },
  ],
};
