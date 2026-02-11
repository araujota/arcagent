"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { useCallback } from "react";
import { BountyStatus, PaymentMethod } from "@/lib/types";

export function useBountyFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const status = (searchParams.get("status") as BountyStatus) || undefined;
  const paymentMethod =
    (searchParams.get("paymentMethod") as PaymentMethod) || undefined;
  const search = searchParams.get("search") || undefined;

  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      router.push(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname]
  );

  const setStatus = useCallback(
    (value: BountyStatus | undefined) => setFilter("status", value),
    [setFilter]
  );

  const setPaymentMethod = useCallback(
    (value: PaymentMethod | undefined) => setFilter("paymentMethod", value),
    [setFilter]
  );

  const setSearch = useCallback(
    (value: string | undefined) => setFilter("search", value),
    [setFilter]
  );

  const clearFilters = useCallback(() => {
    router.push(pathname);
  }, [router, pathname]);

  return {
    status,
    paymentMethod,
    search,
    setStatus,
    setPaymentMethod,
    setSearch,
    clearFilters,
  };
}
