"use client";

import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Code } from "lucide-react";

interface RepoMapViewerProps {
  repoMapText: string;
  className?: string;
}

export function RepoMapViewer({ repoMapText, className }: RepoMapViewerProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!repoMapText) return null;

  const lineCount = repoMapText.split("\n").length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={className}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 w-full justify-start">
          {isOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <Code className="h-4 w-4" />
          <span>Repo Map ({lineCount} lines)</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-2 p-4 rounded-md bg-muted text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
          {repoMapText}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
