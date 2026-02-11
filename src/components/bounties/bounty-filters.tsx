"use client";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { useBountyFilters } from "@/hooks/use-bounty-filters";
import { BOUNTY_STATUS_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/constants";
import { BountyStatus, PaymentMethod } from "@/lib/types";

export function BountyFilters() {
  const {
    status,
    paymentMethod,
    search,
    setStatus,
    setPaymentMethod,
    setSearch,
    clearFilters,
  } = useBountyFilters();

  const hasFilters = status || paymentMethod || search;

  return (
    <div className="flex flex-col sm:flex-row gap-3 mb-6">
      <Input
        placeholder="Search bounties..."
        value={search ?? ""}
        onChange={(e) => setSearch(e.target.value || undefined)}
        className="sm:max-w-xs"
      />
      <Select
        value={status ?? "all"}
        onValueChange={(v) =>
          setStatus(v === "all" ? undefined : (v as BountyStatus))
        }
      >
        <SelectTrigger className="sm:w-[160px]">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Statuses</SelectItem>
          {Object.entries(BOUNTY_STATUS_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={paymentMethod ?? "all"}
        onValueChange={(v) =>
          setPaymentMethod(v === "all" ? undefined : (v as PaymentMethod))
        }
      >
        <SelectTrigger className="sm:w-[160px]">
          <SelectValue placeholder="Payment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Methods</SelectItem>
          {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters && (
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
