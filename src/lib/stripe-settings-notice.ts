export type StripeNoticeTone = "success" | "warning" | "info";

export interface StripeSettingsNotice {
  tone: StripeNoticeTone;
  title: string;
  description: string;
}

function hasTrueFlag(searchParams: URLSearchParams, key: string): boolean {
  const value = searchParams.get(key);
  if (value === null) return false;
  return value === "" || value === "1" || value.toLowerCase() === "true";
}

export function getStripeSettingsNotice(
  searchParams: URLSearchParams
): StripeSettingsNotice | null {
  if (hasTrueFlag(searchParams, "setup_complete")) {
    return {
      tone: "success",
      title: "Payment method added",
      description:
        "Your card was saved successfully. You can now fund bounties from this account.",
    };
  }

  if (hasTrueFlag(searchParams, "setup_canceled")) {
    return {
      tone: "warning",
      title: "Payment setup canceled",
      description:
        "No changes were made. You can retry card setup whenever you're ready.",
    };
  }

  if (
    hasTrueFlag(searchParams, "payout_success") ||
    hasTrueFlag(searchParams, "success")
  ) {
    return {
      tone: "success",
      title: "Payout account updated",
      description:
        "Stripe onboarding is complete or updated. Payout status will refresh automatically.",
    };
  }

  if (
    hasTrueFlag(searchParams, "payout_refresh") ||
    hasTrueFlag(searchParams, "refresh")
  ) {
    return {
      tone: "info",
      title: "Finish payout setup",
      description:
        "Stripe needs one more step before payouts can be enabled. Continue onboarding to finish setup.",
    };
  }

  return null;
}
