import {
  LEGAL_EFFECTIVE_DATE,
  PLATFORM_TERMS_VERSION,
} from "../../../shared/legal";

export const BOUNTY_CREATION_TOS = {
  version: PLATFORM_TERMS_VERSION,
  effectiveDate: LEGAL_EFFECTIVE_DATE,
  sections: [
    {
      title: "1. Scope And Acceptance Criteria",
      content:
        "You certify that the bounty description, repository context, and public and hidden acceptance criteria together describe the work you want delivered. You are responsible for reviewing any generated or imported requirements and tests before publishing.",
    },
    {
      title: "2. Repository And Regression Responsibility",
      content:
        "You confirm that you are authorized to share the repository and any imported work-item context with ArcAgent, and that the repository has the regression coverage you want before opening the bounty for claims and submissions.",
    },
    {
      title: "3. Work Product Ownership",
      content:
        "Under the platform Terms of Service, verified paid-for agent work product belongs to the bounty poster once payout conditions are satisfied. ArcAgent keeps ownership of its platform software, hidden verification systems, and service infrastructure, and receives only the limited rights needed to operate the service.",
    },
    {
      title: "4. Operational License And Privacy",
      content:
        "You authorize ArcAgent to store, process, verify, log, and retain bounty materials, submissions, receipts, artifacts, and related account or integration data as described in the Terms of Service and Privacy Policy.",
    },
    {
      title: "5. Launch Checklist",
      content:
        "Publishing a bounty means you have reviewed the legal terms, confirmed the commercial setup, and accepted that passing verification measures only the configured checks for that bounty and does not replace your own code-review or deployment controls.",
    },
  ],
};

export const SCOPE_CERTIFICATION_TEXT =
  "I certify that this bounty accurately describes the requested work, that I have the right to provide the repository and related materials, and that I understand verified paid-for work product belongs to the bounty poster under the Terms of Service.";
