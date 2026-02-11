/**
 * Provider-agnostic embedding client.
 * Supports Voyage Code-2 (default, best for code) and OpenAI text-embedding-3-large (fallback).
 */

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
  model: string;
  dimensions: number;
}

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * Create a Voyage AI embedding client (Voyage Code-2).
 * Best performance for code retrieval — 14.5% better than OpenAI ada on code benchmarks.
 * 1536 dimensions, batch size up to 128.
 */
export function createVoyageClient(apiKey: string): EmbeddingClient {
  return {
    model: "voyage-code-2",
    dimensions: 1536,

    async embed(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      const batchSize = 64;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await voyageEmbed(apiKey, batch);
        results.push(...embeddings);
      }

      return results;
    },
  };
}

/**
 * Create an OpenAI embedding client (text-embedding-3-large).
 * 3072 dimensions (can be reduced to 1536). Fallback option.
 */
export function createOpenAIEmbeddingClient(apiKey: string): EmbeddingClient {
  return {
    model: "text-embedding-3-large",
    dimensions: 1536, // Use reduced dimensions for cost/perf

    async embed(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      const batchSize = 64;

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const embeddings = await openaiEmbed(apiKey, batch, 1536);
        results.push(...embeddings);
      }

      return results;
    },
  };
}

/**
 * Factory to create the appropriate embedding client based on available API keys.
 */
export function createEmbeddingClient(
  voyageApiKey?: string,
  openaiApiKey?: string
): EmbeddingClient {
  if (voyageApiKey) {
    return createVoyageClient(voyageApiKey);
  }
  if (openaiApiKey) {
    return createOpenAIEmbeddingClient(openaiApiKey);
  }
  throw new Error(
    "No embedding API key configured. Set VOYAGE_AI_API_KEY or OPENAI_API_KEY."
  );
}

/**
 * Format a code chunk for embedding.
 * Prepends metadata to improve retrieval quality.
 */
export function formatChunkForEmbedding(chunk: {
  filePath: string;
  symbolName: string;
  symbolType: string;
  content: string;
}): string {
  return `File: ${chunk.filePath}\nSymbol: ${chunk.symbolName} (${chunk.symbolType})\n\n${chunk.content}`;
}

async function voyageEmbed(
  apiKey: string,
  texts: string[]
): Promise<number[][]> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: "voyage-code-2",
          input_type: "document",
        }),
      });

      if (response.status === 429) {
        // Rate limited — exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `Voyage API error: ${response.status} ${response.statusText}`
        );
      }

      const data: VoyageEmbeddingResponse = await response.json();
      return data.data.map((d) => d.embedding);
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Failed to get embeddings from Voyage");
}

async function openaiEmbed(
  apiKey: string,
  texts: string[],
  dimensions: number
): Promise<number[][]> {
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model: "text-embedding-3-large",
            dimensions,
          }),
        }
      );

      if (response.status === 429) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (!response.ok) {
        throw new Error(
          `OpenAI API error: ${response.status} ${response.statusText}`
        );
      }

      const data: OpenAIEmbeddingResponse = await response.json();
      return data.data.map((d) => d.embedding);
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Failed to get embeddings from OpenAI");
}
