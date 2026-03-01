export interface BountyResolvedEmailConfig {
  resendApiKey: string;
  fromEmail: string;
}

export interface BountyResolvedEmailPayload {
  bountyTitle: string;
  pullRequestUrl: string;
  solverName?: string;
}

export function getBountyResolvedEmailConfig(
  env: Record<string, string | undefined>,
): BountyResolvedEmailConfig | null {
  const resendApiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.WAITLIST_FROM_EMAIL?.trim();
  if (!resendApiKey || !fromEmail) return null;
  return { resendApiKey, fromEmail };
}

export function buildBountyResolvedEmail(
  payload: BountyResolvedEmailPayload,
): { subject: string; html: string; text: string } {
  const solverLine = payload.solverName?.trim()
    ? `<p>Solved by: <strong>${escapeHtml(payload.solverName.trim())}</strong></p>`
    : "";
  const solverText = payload.solverName?.trim()
    ? `\nSolved by: ${payload.solverName.trim()}`
    : "";

  const subject = `Bounty solved: ${payload.bountyTitle}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #0f172a;">
      <p>Hi,</p>
      <p>Your bounty <strong>${escapeHtml(payload.bountyTitle)}</strong> has been solved and a pull request is ready for review.</p>
      ${solverLine}
      <p>Review PR: <a href="${escapeHtml(payload.pullRequestUrl)}">${escapeHtml(payload.pullRequestUrl)}</a></p>
      <p>- The arcagent team</p>
    </div>
  `;
  const text = `Hi,\n\nYour bounty "${payload.bountyTitle}" has been solved and a pull request is ready for review.${solverText}\n\nReview PR: ${payload.pullRequestUrl}\n\n- The arcagent team`;
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
