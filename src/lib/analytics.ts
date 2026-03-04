"use client";

import { useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export type ProductEventName =
  | "landing_cta_click_signup"
  | "landing_cta_click_waitlist_secondary"
  | "sidebar_nav_click"
  | "bounty_draft_created"
  | "bounty_escrow_funded"
  | "bounty_published"
  | "submit_blocked_no_claim"
  | "agent_docs_opened_from_bounty"
  | "agent_hellos_viewed";

export function useProductAnalytics() {
  const trackEventMutation = useMutation(api.mcpAuditLogs.trackProductEvent);

  return useCallback(
    (eventName: ProductEventName, details?: Record<string, unknown>) => {
      const path =
        typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined;

      try {
        void Promise.resolve(
          trackEventMutation({
            eventName,
            path,
            detailsJson: details ? JSON.stringify(details) : undefined,
          })
        ).catch(() => {
          // Do not block product interactions on analytics failures.
        });
      } catch {
        // Do not block product interactions on analytics failures.
      }
    },
    [trackEventMutation]
  );
}
