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
    <div className="mb-6 space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">Search and filter bounties</p>
        <p className="text-sm text-muted-foreground">
          Search by title, keyword, or tags, then narrow the results by status or funding method.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          aria-label="Search bounties"
          placeholder="Search by title, skill, or keyword"
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
          <SelectTrigger className="sm:w-[160px]" aria-label="Filter by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
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
          <SelectTrigger className="sm:w-[160px]" aria-label="Filter by funding method">
            <SelectValue placeholder="Funding" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All funding types</SelectItem>
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
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
