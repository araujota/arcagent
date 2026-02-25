import { v } from "convex/values";
import {
  action,
  internalAction,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireAuth } from "./lib/utils";
import {
  buildWaitlistNotifyEmail,
  buildWaitlistWelcomeEmail,
  getWaitlistEmailConfig,
  sendResendEmail,
} from "./lib/waitlistEmail";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const join = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Invalid email address");
    }

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      return { status: "duplicate" as const };
    }

    const joinedAt = Date.now();

    await ctx.db.insert("waitlist", {
      email,
      source: args.source,
      joinedAt,
    });

    await ctx.scheduler.runAfter(0, internal.waitlist.sendJoinEmails, {
      email,
      source: args.source,
      joinedAt,
    });

    return { status: "success" as const };
  },
});

export const count = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("waitlist").collect();
    return entries.length;
  },
});

export const listAllInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("waitlist").collect();
  },
});

export const sendemailtowaitlist = action({
  args: {
    subject: v.string(),
    message: v.string(),
    html: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    if (user.role !== "admin") {
      throw new Error("Admin access required");
    }

    const config = getWaitlistEmailConfig({
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      WAITLIST_FROM_EMAIL: process.env.WAITLIST_FROM_EMAIL,
      WAITLIST_NOTIFY_EMAIL: process.env.WAITLIST_NOTIFY_EMAIL,
    });

    if (!config) {
      throw new Error(
        "RESEND_API_KEY and WAITLIST_FROM_EMAIL must be set in Convex env"
      );
    }

    const entries = await ctx.runQuery(internal.waitlist.listAllInternal);
    const recipients = entries;

    let sent = 0;
    const failed: Array<{ email: string; error: string }> = [];

    for (const entry of recipients) {
      try {
        await sendResendEmail({
          apiKey: config.resendApiKey,
          from: config.fromEmail,
          to: entry.email,
          subject: args.subject,
          html:
            args.html ??
            `<div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.5;"><p>${escapeHtml(
              args.message
            ).replaceAll("\n", "<br/>")}</p></div>`,
          text: args.message,
        });
        sent++;
      } catch (error) {
        failed.push({
          email: entry.email,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      totalRecipients: recipients.length,
      sent,
      failed,
    };
  },
});

export const sendJoinEmails = internalAction({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
    joinedAt: v.number(),
  },
  handler: async (_ctx, args) => {
    const config = getWaitlistEmailConfig({
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      WAITLIST_FROM_EMAIL: process.env.WAITLIST_FROM_EMAIL,
      WAITLIST_NOTIFY_EMAIL: process.env.WAITLIST_NOTIFY_EMAIL,
    });

    if (!config) {
      console.warn(
        "[waitlist.sendJoinEmails] Email skipped because RESEND_API_KEY or WAITLIST_FROM_EMAIL is missing"
      );
      return;
    }

    const welcome = buildWaitlistWelcomeEmail(args.email);
    await sendResendEmail({
      apiKey: config.resendApiKey,
      from: config.fromEmail,
      to: args.email,
      subject: welcome.subject,
      html: welcome.html,
      text: welcome.text,
    });

    if (config.notifyEmail) {
      const notify = buildWaitlistNotifyEmail({
        email: args.email,
        source: args.source,
        joinedAt: args.joinedAt,
      });
      await sendResendEmail({
        apiKey: config.resendApiKey,
        from: config.fromEmail,
        to: config.notifyEmail,
        subject: notify.subject,
        html: notify.html,
        text: notify.text,
      });
    }
  },
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
