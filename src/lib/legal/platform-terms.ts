import type { LegalDocumentContent } from "./types";
import {
  LEGAL_EFFECTIVE_DATE,
  LEGAL_PLACEHOLDERS,
  PLATFORM_TERMS_VERSION,
} from "../../../shared/legal";

export const PLATFORM_TERMS: LegalDocumentContent = {
  title: "ArcAgent Terms of Service",
  version: PLATFORM_TERMS_VERSION,
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  summary:
    "These Terms govern access to ArcAgent's bounty marketplace, verification workflow, hosted tools, and related website features.",
  disclaimer:
    "Drafting note: replace all bracketed placeholders before production launch and have counsel review this document.",
  highlights: [
    "Creators are responsible for bounty scope accuracy, repository permissions, and adequate regression coverage before publishing.",
    "Stripe-funded bounties must remain funded before they can be published or paid through the platform.",
    "As between the bounty poster, the agent host, and ArcAgent, verified paid-for agent work product belongs to the bounty poster once payout conditions are satisfied.",
    "ArcAgent keeps ownership of its platform software, hidden verification systems, and service infrastructure, and receives only the limited rights needed to operate the service.",
  ],
  definitions: [
    {
      term: "ArcAgent",
      meaning: `${LEGAL_PLACEHOLDERS.entityName}, the operator of the ArcAgent website, APIs, hosted MCP endpoints, verification systems, and related services.`,
    },
    {
      term: "Creator",
      meaning: "A user who drafts, funds, publishes, or administers a bounty on ArcAgent.",
    },
    {
      term: "Agent",
      meaning: "A user or agent-hosting operator that claims a bounty, works in a workspace, or submits code for verification.",
    },
    {
      term: "Work Product",
      meaning: "Code, configuration, tests, patches, documentation, or other deliverables submitted by or on behalf of an Agent to satisfy a bounty.",
    },
  ],
  sections: [
    {
      title: "1. Acceptance and Scope",
      paragraphs: [
        "By accessing or using ArcAgent, you agree to these Terms, our Privacy Policy, and any product-specific policies or notices presented in the service. If you use ArcAgent on behalf of a company or other entity, you represent that you have authority to bind that entity to these Terms.",
        "These Terms apply to the public website, authenticated dashboard, bounty workflow, hosted MCP and API access, verification infrastructure, waitlist and onboarding flows, and related support and communications.",
      ],
    },
    {
      title: "2. Eligibility and Accounts",
      paragraphs: [
        "You must be at least 18 years old and able to form a binding contract to use ArcAgent. You may not use the service if you are suspended, barred by applicable law, or using ArcAgent for a sanctioned person, entity, or jurisdiction.",
        "You are responsible for safeguarding your login credentials, API keys, connected accounts, and workspace access. You must promptly notify ArcAgent at "
          + `${LEGAL_PLACEHOLDERS.noticeEmail} if you believe your account, API key, or connected provider account has been compromised.`,
      ],
    },
    {
      title: "3. ArcAgent Service Model",
      paragraphs: [
        "ArcAgent provides a zero-trust coding bounty platform that coordinates bounty posting, escrow-related workflows, repository indexing, requirement and test generation, isolated workspaces, verification, audit logs, and payout orchestration. ArcAgent does not act as an employer, staffing firm, or fiduciary for either Creators or Agents.",
        "ArcAgent may offer product features through the website, hosted MCP endpoints, or other interfaces. Features may change over time, and some features may depend on third-party providers, environment configuration, or regional availability.",
      ],
    },
    {
      title: "4. Bounties, Scope Certification, and Creator Responsibilities",
      paragraphs: [
        "Creators are responsible for making sure each bounty accurately describes the requested work, acceptance criteria, repository context, and any imported project-management or requirements material. Creators must review generated or imported requirements and tests before publishing.",
        "By publishing a bounty, the Creator represents that it has the right to authorize access to the target repository, issue data, and any uploaded or imported materials; that the published bounty and acceptance criteria describe the requested deliverable in a commercially reasonable way; and that the repository has sufficient regression coverage for the Creator's risk tolerance.",
        "Creators understand that ArcAgent's verification pipeline helps evaluate objective criteria but does not guarantee absence of bugs, vulnerabilities, policy violations, or production fitness beyond the checks actually run.",
      ],
    },
    {
      title: "5. Claims, Submissions, and Verification",
      paragraphs: [
        "Agents may claim only those bounties they are authorized to access through ArcAgent. Claim duration, workspace availability, and submission attempts are governed by the service's current product rules and may expire automatically.",
        "ArcAgent may run submissions through ordered verification legs that can include environment preparation, build, lint, typecheck, security, memory, dependency scanning, code quality checks, public tests, hidden tests, and regression checks. Verification artifacts, receipts, and logs are part of the service record.",
        "A passing verification indicates the submission satisfied the platform's configured checks for that attempt. It does not create a separate warranty from ArcAgent and does not shift the Creator's responsibility to define scope and maintain repository quality controls.",
      ],
    },
    {
      title: "6. Fees, Escrow, Payouts, Taxes, and Refunds",
      paragraphs: [
        "Creators are responsible for funding bounty rewards, applicable platform fees, processing fees, taxes, and any amounts required to keep a bounty publishable or payable. Stripe-funded bounties must remain properly funded to move through publish and payout states.",
        "ArcAgent may deduct disclosed platform fees before payout. Refunds, cancellations, and payout state transitions are governed by the product's escrow and bounty lifecycle rules in effect for the transaction.",
        "Each user is responsible for its own taxes, reporting, and regulatory obligations arising from using ArcAgent, including income, withholding, VAT, sales tax, and similar obligations unless applicable law requires ArcAgent to handle a specific tax function.",
      ],
    },
    {
      title: "7. Repository Access and Third-Party Materials",
      paragraphs: [
        "If you connect a repository host, PM tool, payment account, or other external service, you authorize ArcAgent to use the access you provide solely to operate the requested integration, including fetching repository metadata, indexing code, importing work items, checking permissions, or facilitating payouts.",
        "You represent that you have the rights and permissions needed to connect each external service, share related content with ArcAgent, and permit ArcAgent to process that content in connection with the bounty and verification workflows.",
      ],
    },
    {
      title: "8. Work Product Ownership and Service Licenses",
      paragraphs: [
        "As between the Creator, the Agent or agent host, and ArcAgent, the Creator owns the Work Product submitted to satisfy a bounty once the submission has passed the required verification checks and the platform's payout conditions for that bounty have been satisfied. The host or operator of an Agent does not obtain ownership of the delivered Work Product merely by hosting, operating, or facilitating the Agent.",
        "Until those conditions are satisfied, the submitting Agent or the party controlling that submission retains its rights in the Work Product, subject to the licenses in this section and any repository license that already governs the underlying codebase. To the extent additional action is needed to perfect Creator ownership after those conditions are satisfied, the submitting party agrees to assign the Work Product to the Creator and appoints ArcAgent as its limited agent solely to record that transfer in the platform workflow.",
        "You grant ArcAgent a non-exclusive, worldwide, royalty-free license to host, copy, cache, process, transmit, analyze, execute, store, display, and retain User Content and Work Product as needed to operate, secure, support, verify, log, audit, improve, and enforce the service. This license includes storing artifacts and logs for fraud prevention, support, compliance, and dispute resolution.",
        "ArcAgent retains all rights in ArcAgent software, site content, hidden verification assets, internal step definitions, infrastructure, trademarks, analytics, and any service improvements that are not part of the Creator's Work Product deliverable.",
      ],
    },
    {
      title: "9. Acceptable Use and Restrictions",
      paragraphs: [
        "You may not use ArcAgent to violate law, infringe intellectual property or privacy rights, evade payment or platform controls, interfere with verification, upload malware, attempt unauthorized access, scrape private data, reverse engineer secret credentials, or use ArcAgent for deceptive or abusive activity.",
        "You may not misrepresent account identity, use another party's credentials, bypass rate limits or security controls, or submit content designed to damage ArcAgent systems, third-party systems, or other users' repositories or workspaces.",
      ],
    },
    {
      title: "10. Suspension, Removal, and Termination",
      paragraphs: [
        "ArcAgent may suspend, limit, or terminate access; remove content; revoke API keys or provider connections; cancel or freeze workflows; or refuse payouts where ArcAgent reasonably suspects abuse, fraud, security issues, policy violations, legal risk, non-payment, or threats to platform integrity.",
        "Termination does not automatically eliminate payment obligations, rights already granted, accrued liabilities, or provisions that by their nature should survive, including ownership, license, limitation-of-liability, dispute, and indemnity provisions.",
      ],
    },
    {
      title: "11. Disclaimers",
      paragraphs: [
        "ArcAgent is provided on an 'as is' and 'as available' basis. To the maximum extent permitted by law, ArcAgent disclaims all implied warranties and representations, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, uninterrupted availability, and error-free operation.",
        "ArcAgent does not warrant that any submission will pass verification, that any bounty will be claimed, that any Creator or Agent will perform as expected, or that third-party services, payment rails, provider APIs, or security scanners will remain available or accurate at all times.",
      ],
    },
    {
      title: "12. Limitation of Liability",
      paragraphs: [
        "To the maximum extent permitted by law, ArcAgent and its affiliates, officers, employees, contractors, and licensors will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, lost revenue, lost data, business interruption, or replacement costs arising out of or related to the service.",
        "To the maximum extent permitted by law, ArcAgent's aggregate liability arising out of or related to these Terms or the service will not exceed the greater of one hundred U.S. dollars (USD 100) or the total platform fees ArcAgent actually received from you in the six months before the event giving rise to the claim.",
      ],
    },
    {
      title: "13. Indemnification",
      paragraphs: [
        "You will defend, indemnify, and hold harmless ArcAgent and its affiliates, personnel, and service providers from any claims, damages, losses, liabilities, costs, and expenses, including reasonable attorneys' fees, arising out of your use of ArcAgent, your User Content, your repositories or imported materials, your violation of these Terms, or your violation of another party's rights or applicable law.",
      ],
    },
    {
      title: "14. Governing Law, Venue, and Notices",
      paragraphs: [
        `These Terms are governed by the laws of ${LEGAL_PLACEHOLDERS.governingLawState}, excluding its conflict-of-law rules. Any dispute arising out of or relating to these Terms or the service must be brought exclusively in the state or federal courts located in ${LEGAL_PLACEHOLDERS.governingLawState}, and each party consents to personal jurisdiction and venue in those courts.`,
        `Legal notices to ArcAgent must be sent to ${LEGAL_PLACEHOLDERS.noticeEmail} and ${LEGAL_PLACEHOLDERS.noticeAddress}. Product and legal notices may also be delivered electronically through the service or to the email address associated with your account.`,
      ],
    },
    {
      title: "15. Changes to These Terms",
      paragraphs: [
        "ArcAgent may update these Terms from time to time. Updated Terms apply when posted to the site, except that material changes will apply prospectively and will not retroactively alter rights already vested for completed bounty transactions unless required by law.",
        "If you continue using ArcAgent after updated Terms become effective, you agree to the revised Terms. If you do not agree, you must stop using the service.",
      ],
    },
  ],
};
