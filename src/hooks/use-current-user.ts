"use client";

import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function useCurrentUser() {
  const user = useQuery(api.users.getMe);
  const isLoading = user === undefined;

  return {
    user: user ?? null,
    isLoading,
    isAuthenticated: !!user,
    isCreator: user?.role === "creator",
    isAgent: user?.role === "agent",
    isAdmin: user?.role === "admin",
  };
}
