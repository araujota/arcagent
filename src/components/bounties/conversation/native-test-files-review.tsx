"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";

type FilePayload = { path: string; content: string };

function parseFiles(raw: string): FilePayload[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((file): file is FilePayload =>
        Boolean(file && typeof file.path === "string" && typeof file.content === "string"),
      );
    }
  } catch {
    // fall through
  }

  if (!raw.trim()) return [];
  return [{ path: "generated_test_file", content: raw }];
}

interface NativeTestFilesReviewProps {
  publicFiles: string;
  hiddenFiles: string;
  isEditable?: boolean;
  onSave: (kind: "public" | "hidden", content: string) => Promise<void> | void;
}

export function NativeTestFilesReview({
  publicFiles,
  hiddenFiles,
  isEditable = true,
  onSave,
}: NativeTestFilesReviewProps) {
  const publicPayloads = useMemo(() => parseFiles(publicFiles), [publicFiles]);
  const hiddenPayloads = useMemo(() => parseFiles(hiddenFiles), [hiddenFiles]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Native Test Files</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="public">
          <TabsList>
            <TabsTrigger value="public">Public files ({publicPayloads.length})</TabsTrigger>
            <TabsTrigger value="hidden">Hidden files ({hiddenPayloads.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="public" className="mt-3 space-y-2">
            <Badge variant="secondary">Visible to agents</Badge>
            {publicPayloads.map((file, index) => (
              <EditableFileCard
                key={`public-${index}`}
                file={file}
                isEditable={isEditable}
                onSave={(content) => {
                  const updated = [...publicPayloads];
                  updated[index] = { ...file, content };
                  return onSave("public", JSON.stringify(updated));
                }}
              />
            ))}
          </TabsContent>

          <TabsContent value="hidden" className="mt-3 space-y-2">
            <Badge variant="outline">Hidden from agents</Badge>
            {hiddenPayloads.map((file, index) => (
              <EditableFileCard
                key={`hidden-${index}`}
                file={file}
                isEditable={isEditable}
                onSave={(content) => {
                  const updated = [...hiddenPayloads];
                  updated[index] = { ...file, content };
                  return onSave("hidden", JSON.stringify(updated));
                }}
              />
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function EditableFileCard({
  file,
  isEditable,
  onSave,
}: {
  file: FilePayload;
  isEditable: boolean;
  onSave: (content: string) => Promise<void> | void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState(file.content);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="justify-start gap-2 flex-1">
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <span className="font-mono text-xs">{file.path}</span>
          </Button>
        </CollapsibleTrigger>
        {isEditable && isOpen && !isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>
      <CollapsibleContent className="mt-2">
        {isEditing ? (
          <div className="space-y-2">
            <Textarea
              className="min-h-[280px] font-mono text-xs"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  await onSave(content);
                  setIsEditing(false);
                }}
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setContent(file.content);
                  setIsEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <pre className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap overflow-auto max-h-[320px]">
            {file.content}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
