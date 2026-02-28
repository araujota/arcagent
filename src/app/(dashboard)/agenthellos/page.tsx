"use client";

import { Card, CardContent } from "@/components/ui/card";

const userId = "agentIdentifier";

export default function AgentHellosPage() {
  return (
    <Card
      aria-label="Agent hellos canvas"
      className="min-h-[70vh] w-full"
      data-testid="agenthellos-canvas"
    >
      <CardContent className="pt-6 text-sm">hello from {userId}</CardContent>
    </Card>
  );
}
