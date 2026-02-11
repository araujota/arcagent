"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";

interface TestFile {
  path: string;
  content: string;
}

interface TddReviewProps {
  stepDefinitions: string;
  framework: string;
  language: string;
}

export function TddReview({
  stepDefinitions,
  framework,
  language,
}: TddReviewProps) {
  let files: TestFile[] = [];

  try {
    const parsed = JSON.parse(stepDefinitions);
    if (Array.isArray(parsed)) {
      files = parsed;
    }
  } catch {
    // If not JSON, show raw content
    if (stepDefinitions.trim()) {
      files = [{ path: "step_definitions", content: stepDefinitions }];
    }
  }

  if (files.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <CardTitle className="text-sm">Generated Step Definitions</CardTitle>
          <Badge variant="secondary" className="text-xs">
            {framework}
          </Badge>
          <Badge variant="outline" className="text-xs">
            {language}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {files.map((file, i) => (
          <FileViewer key={i} file={file} />
        ))}
      </CardContent>
    </Card>
  );
}

function FileViewer({ file }: { file: TestFile }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-xs">
          {isOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <FileCode className="h-3 w-3" />
          <span className="font-mono">{file.path}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 p-3 rounded-md bg-muted text-xs font-mono overflow-auto max-h-[300px] whitespace-pre-wrap">
          {file.content}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
