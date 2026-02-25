import { redirect } from "next/navigation";

interface PayoutRedirectPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function hasTrueFlag(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  const first = Array.isArray(value) ? value[0] : value;
  return first === "" || first === "1" || first.toLowerCase() === "true";
}

export default async function PayoutRedirectPage({
  searchParams,
}: PayoutRedirectPageProps) {
  const params = await searchParams;
  const nextParams = new URLSearchParams();

  if (hasTrueFlag(params.success)) {
    nextParams.set("payout_success", "true");
  }
  if (hasTrueFlag(params.refresh)) {
    nextParams.set("payout_refresh", "true");
  }

  const query = nextParams.toString();
  redirect(query ? `/settings?${query}` : "/settings");
}
