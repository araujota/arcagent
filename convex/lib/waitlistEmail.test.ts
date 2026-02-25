import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildWaitlistNotifyEmail,
  buildWaitlistWelcomeEmail,
  getWaitlistEmailConfig,
  sendResendEmail,
} from "./waitlistEmail";

describe("waitlist email helpers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null config when required env vars are missing", () => {
    expect(getWaitlistEmailConfig({})).toBeNull();
    expect(
      getWaitlistEmailConfig({
        RESEND_API_KEY: "re_123",
      })
    ).toBeNull();
  });

  it("returns config when required env vars are present", () => {
    expect(
      getWaitlistEmailConfig({
        RESEND_API_KEY: "re_123",
        WAITLIST_FROM_EMAIL: "hello@arcagent.dev",
        WAITLIST_NOTIFY_EMAIL: "ops@arcagent.dev",
      })
    ).toEqual({
      resendApiKey: "re_123",
      fromEmail: "hello@arcagent.dev",
      notifyEmail: "ops@arcagent.dev",
    });
  });

  it("builds welcome email text and html", () => {
    const email = buildWaitlistWelcomeEmail("user@example.com");
    expect(email.subject).toContain("waitlist");
    expect(email.text).toContain("user@example.com");
    expect(email.html).toContain("user@example.com");
  });

  it("builds notify email with source and timestamp", () => {
    const notify = buildWaitlistNotifyEmail({
      email: "user@example.com",
      source: "hero",
      joinedAt: 1739318400000,
    });
    expect(notify.subject).toContain("user@example.com");
    expect(notify.text).toContain("hero");
    expect(notify.text).toContain("2025");
  });

  it("sendResendEmail posts to Resend API", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    await sendResendEmail({
      apiKey: "re_123",
      from: "hello@arcagent.dev",
      to: "user@example.com",
      subject: "Welcome",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("throws with response body when Resend API returns non-200", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      sendResendEmail({
        apiKey: "re_bad",
        from: "hello@arcagent.dev",
        to: "user@example.com",
        subject: "Welcome",
        html: "<p>Hello</p>",
        text: "Hello",
      })
    ).rejects.toThrow("Resend email failed: 401 unauthorized");
  });
});
