/**
 * LLM Provider Abstraction.
 * Provider-agnostic interface for Claude (default) and OpenAI (fallback).
 */

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
}

export interface LLMClient {
  chat(messages: Message[], options?: LLMOptions): Promise<string>;
  model: string;
  provider: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

interface OpenAIChatResponse {
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Create an Anthropic (Claude) LLM client.
 */
export function createAnthropicClient(
  apiKey: string,
  model: string = "claude-sonnet-4-5-20250929"
): LLMClient {
  return {
    model,
    provider: "anthropic",

    async chat(messages: Message[], options?: LLMOptions): Promise<string> {
      // Separate system message from conversation
      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter(
        (m) => m.role !== "system"
      );

      const body: Record<string, unknown> = {
        model,
        max_tokens: options?.maxTokens || 4096,
        messages: conversationMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      };

      if (systemMessages.length > 0) {
        body.system = systemMessages.map((m) => m.content).join("\n\n");
      }

      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }

      const response = await fetchWithRetry(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Anthropic API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data: AnthropicResponse = await response.json();
      const textContent = data.content.find((c) => c.type === "text");
      if (!textContent) {
        throw new Error("No text content in Anthropic response");
      }

      return textContent.text;
    },
  };
}

/**
 * Create an OpenAI LLM client.
 */
export function createOpenAIClient(
  apiKey: string,
  model: string = "gpt-4o"
): LLMClient {
  return {
    model,
    provider: "openai",

    async chat(messages: Message[], options?: LLMOptions): Promise<string> {
      const body: Record<string, unknown> = {
        model,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        max_tokens: options?.maxTokens || 4096,
      };

      if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
      }

      if (options?.responseFormat === "json") {
        body.response_format = { type: "json_object" };
      }

      const response = await fetchWithRetry(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data: OpenAIChatResponse = await response.json();
      return data.choices[0].message.content;
    },
  };
}

/**
 * Factory to create LLM client based on environment configuration.
 */
export function createLLMClient(
  provider?: string,
  model?: string,
  anthropicApiKey?: string,
  openaiApiKey?: string
): LLMClient {
  const resolvedProvider = provider || "anthropic";

  if (resolvedProvider === "anthropic") {
    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for Anthropic provider");
    }
    return createAnthropicClient(
      anthropicApiKey,
      model || "claude-sonnet-4-5-20250929"
    );
  }

  if (resolvedProvider === "openai") {
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI provider");
    }
    return createOpenAIClient(openaiApiKey, model || "gpt-4o");
  }

  throw new Error(`Unknown LLM provider: ${resolvedProvider}`);
}

/**
 * Fetch with exponential backoff retry for rate limits.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.status === 429 || response.status >= 500) {
        // Rate limited or server error — retry with backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}
