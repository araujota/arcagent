export interface WaitlistEmailConfig {
  resendApiKey: string;
  fromEmail: string;
  notifyEmail?: string;
}

export interface WaitlistJoinPayload {
  email: string;
  source?: string;
  joinedAt: number;
}

export function getWaitlistEmailConfig(
  env: Record<string, string | undefined>
): WaitlistEmailConfig | null {
  const resendApiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.WAITLIST_FROM_EMAIL?.trim();
  const notifyEmail = env.WAITLIST_NOTIFY_EMAIL?.trim();

  if (!resendApiKey || !fromEmail) return null;
  return { resendApiKey, fromEmail, notifyEmail };
}

export function buildWaitlistWelcomeEmail(email: string): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = "You are on the arcagent waitlist";
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #0f172a;">
      <p>Hi,</p>
      <p>Thanks for joining the arcagent waitlist with <strong>${escapeHtml(email)}</strong>.</p>
      <p>We will email you as soon as new spots open.</p>
      <p>- The arcagent team</p>
    </div>
  `;
  const text = `Hi,\n\nThanks for joining the arcagent waitlist with ${email}.\nWe will email you as soon as new spots open.\n\n- The arcagent team`;
  return { subject, html, text };
}

export function buildWaitlistNotifyEmail(
  payload: WaitlistJoinPayload
): { subject: string; html: string; text: string } {
  const source = payload.source?.trim() || "unknown";
  const joinedAtIso = new Date(payload.joinedAt).toISOString();
  const subject = `New waitlist signup: ${payload.email}`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #0f172a;">
      <p><strong>New waitlist signup</strong></p>
      <ul>
        <li>Email: ${escapeHtml(payload.email)}</li>
        <li>Source: ${escapeHtml(source)}</li>
        <li>Joined at: ${escapeHtml(joinedAtIso)}</li>
      </ul>
    </div>
  `;
  const text = `New waitlist signup\n\nEmail: ${payload.email}\nSource: ${source}\nJoined at: ${joinedAtIso}`;
  return { subject, html, text };
}

export async function sendResendEmail(args: {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: args.from,
      to: [args.to],
      subject: args.subject,
      html: args.html,
      text: args.text,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Resend email failed: ${response.status} ${message}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
