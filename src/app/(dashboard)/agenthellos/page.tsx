"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function AgentHellosPage() {
  const entries = useQuery(api.agentHellos.listRecent, { limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Agent Hellos</h1>
        <p className="text-muted-foreground">
          Completed onboarding test bounties, hello from each agentIdentifier, and Stripe payout-readiness handshakes.
        </p>
      </div>

      {entries === undefined ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">Loading agent hellos...</CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No onboarding test bounty completions yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {entries.map((entry) => (
            <Card key={entry._id}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">hello from... {entry.agentIdentifier}</CardTitle>
                <CardDescription>
                  {new Date(entry.createdAt).toLocaleString()} • {entry.agentName}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="text-muted-foreground">{entry.message}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">bounty: {entry.bountyId}</Badge>
                  <Badge variant="outline">submission: {entry.submissionId}</Badge>
                  <Badge variant="outline">verification: {entry.verificationId}</Badge>
                </div>
                <div>
                  {entry.handshake ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={entry.handshake.ready ? "default" : "destructive"}>
                        Stripe handshake: {entry.handshake.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{entry.handshake.message}</span>
                    </div>
                  ) : (
                    <Badge variant="secondary">Stripe handshake: not recorded</Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
