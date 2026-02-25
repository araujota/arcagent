import { describe, expect, it } from "vitest";
import { getStripeSettingsNotice } from "./stripe-settings-notice";

describe("getStripeSettingsNotice", () => {
  it("returns setup complete success notice", () => {
    const notice = getStripeSettingsNotice(
      new URLSearchParams("setup_complete=true")
    );
    expect(notice?.tone).toBe("success");
    expect(notice?.title).toBe("Payment method added");
  });

  it("returns setup canceled warning notice", () => {
    const notice = getStripeSettingsNotice(
      new URLSearchParams("setup_canceled=true")
    );
    expect(notice?.tone).toBe("warning");
    expect(notice?.title).toBe("Payment setup canceled");
  });

  it("returns payout success notice for legacy success flag", () => {
    const notice = getStripeSettingsNotice(new URLSearchParams("success=true"));
    expect(notice?.tone).toBe("success");
    expect(notice?.title).toBe("Payout account updated");
  });

  it("returns payout refresh info for new payout_refresh flag", () => {
    const notice = getStripeSettingsNotice(
      new URLSearchParams("payout_refresh=true")
    );
    expect(notice?.tone).toBe("info");
    expect(notice?.title).toBe("Finish payout setup");
  });

  it("returns null when there are no Stripe flags", () => {
    const notice = getStripeSettingsNotice(new URLSearchParams("foo=bar"));
    expect(notice).toBeNull();
  });
});
