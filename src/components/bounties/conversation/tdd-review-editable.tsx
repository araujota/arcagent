"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight, Edit3, FileCode } from "lucide-react";

interface TestFile {
  path: string;
  content: string;
}

interface TddReviewEditableProps {
  stepDefinitions: string;
  framework: string;
  language: string;
  isEditable: boolean;
  onSave: (stepDefinitions: string) => void;
}

export function TddReviewEditable({
  stepDefinitions,
  framework,
  language,
  isEditable,
  onSave,
}: TddReviewEditableProps) {
  let files: TestFile[] = [];

  try {
    const parsed = JSON.parse(stepDefinitions);
    if (Array.isArray(parsed)) {
      files = parsed;
    }
  } catch {
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
          <EditableFileViewer
            key={i}
            file={file}
            isEditable={isEditable}
            onSave={(content) => {
              const updated = [...files];
              updated[i] = { ...file, content };
              onSave(JSON.stringify(updated));
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function EditableFileViewer({
  file,
  isEditable,
  onSave,
}: {
  file: TestFile;
  isEditable: boolean;
  onSave: (content: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(file.content);

  const handleSave = () => {
    onSave(editContent);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditContent(file.content);
    setIsEditing(false);
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 justify-start gap-2 text-xs"
          >
            {isOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            <FileCode className="h-3 w-3" />
            <span className="font-mono">{file.path}</span>
          </Button>
        </CollapsibleTrigger>
        {isEditable && isOpen && !isEditing && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsEditing(true)}
            className="h-6 gap-1 text-xs"
          >
            <Edit3 className="h-3 w-3" />
            Edit
          </Button>
        )}
      </div>
      <CollapsibleContent>
        {isEditing ? (
          <div className="mt-1 space-y-2">
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="font-mono text-xs min-h-[300px]"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave}>
                Save
              </Button>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <pre className="mt-1 p-3 rounded-md bg-muted text-xs font-mono overflow-auto max-h-[300px] whitespace-pre-wrap">
            {file.content}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
