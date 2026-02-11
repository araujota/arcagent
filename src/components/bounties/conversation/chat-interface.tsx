"use client";

import { useRef, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Bot, User } from "lucide-react";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
}

interface ChatInterfaceProps {
  messages: Message[];
  className?: string;
}

export function ChatInterface({ messages, className }: ChatInterfaceProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className={`space-y-3 ${className || ""}`}>
      {messages.map((message, i) => {
        // Skip raw system messages
        if (message.role === "system" && !isDisplayableSystemMessage(message.content)) {
          return null;
        }

        return (
          <MessageBubble key={`${message.timestamp}-${i}`} message={message} />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  // Try to parse structured content
  const parsed = tryParseStructured(message.content);

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      <div
        className={`flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${
          isUser ? "bg-primary" : "bg-muted"
        }`}
      >
        {isUser ? (
          <User className="h-4 w-4 text-primary-foreground" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>
      <Card className={`max-w-[80%] ${isUser ? "bg-primary/5" : ""}`}>
        <CardContent className="py-3 px-4">
          {parsed ? (
            <StructuredContent data={parsed} />
          ) : (
            <p className="text-sm whitespace-pre-wrap">{message.content}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface StructuredData {
  type?: string;
  ready?: boolean;
  questions?: Array<{
    question: string;
    reason: string;
    options?: string[];
  }>;
  summary?: string;
  [key: string]: unknown;
}

function StructuredContent({ data }: { data: StructuredData }) {
  if (data.type === "bdd_generated") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">Gherkin test specifications generated.</p>
        <p className="text-xs text-muted-foreground">
          Review the generated tests in the panels below.
        </p>
      </div>
    );
  }

  if (data.type === "tdd_generated") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium">
          Step definitions generated for {(data.framework as string) || "cucumber-js"}.
        </p>
        <p className="text-xs text-muted-foreground">
          Review the generated step definitions below.
        </p>
      </div>
    );
  }

  if (data.type === "validation_result") {
    const valid = data.valid as boolean;
    return (
      <div className="space-y-2">
        <p className={`text-sm font-medium ${valid ? "text-green-600" : "text-yellow-600"}`}>
          {valid ? "Validation passed" : "Validation found issues"}
        </p>
        {Array.isArray(data.issues) && data.issues.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc pl-4">
            {(data.issues as string[]).map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (data.ready !== undefined) {
    if (data.ready) {
      return (
        <div className="space-y-2">
          <p className="text-sm font-medium text-green-600">
            Requirements are clear. Ready to generate tests.
          </p>
          {data.summary && (
            <p className="text-xs text-muted-foreground">{data.summary}</p>
          )}
        </div>
      );
    }

    // Show questions
    return null; // Questions are rendered separately by QuestionCard
  }

  // Fallback: show as formatted JSON
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function tryParseStructured(content: string): StructuredData | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return null;
}

function isDisplayableSystemMessage(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return parsed.type === "validation_result" || parsed.type === "error";
  } catch {
    return content.startsWith("BDD generation failed") || content.startsWith("TDD generation failed");
  }
}
