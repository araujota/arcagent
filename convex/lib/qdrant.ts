/**
 * Qdrant REST client.
 * Minimal client using fetch() — no SDK dependency.
 * Used for vector storage and retrieval of code chunks.
 */

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantClient {
  ensureCollection(name: string, vectorSize: number): Promise<void>;
  upsertPoints(collection: string, points: QdrantPoint[]): Promise<void>;
  search(
    collection: string,
    vector: number[],
    limit: number,
    filter?: QdrantFilter
  ): Promise<QdrantSearchResult[]>;
  deleteByFilter(collection: string, filter: QdrantFilter): Promise<void>;
}

export interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

export interface QdrantCondition {
  key: string;
  match: { value: string | number | boolean };
}

const COLLECTION_NAME = "arcagent_code_chunks";

/**
 * Create a Qdrant REST client.
 */
export function createQdrantClient(
  url: string,
  apiKey?: string
): QdrantClient {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["api-key"] = apiKey;
  }

  async function request(
    path: string,
    method: string,
    body?: unknown
  ): Promise<unknown> {
    const response = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Qdrant API error: ${response.status} ${response.statusText} - ${text}`
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return await response.json();
    }
    return null;
  }

  return {
    async ensureCollection(name: string, vectorSize: number): Promise<void> {
      try {
        // Check if collection exists
        await request(`/collections/${name}`, "GET");
      } catch {
        // Create if not exists
        await request(`/collections/${name}`, "PUT", {
          vectors: {
            size: vectorSize,
            distance: "Cosine",
          },
          optimizers_config: {
            indexing_threshold: 10000,
          },
        });

        // Create payload indexes for filtering
        await request(
          `/collections/${name}/index`,
          "PUT",
          {
            field_name: "bountyId",
            field_schema: "keyword",
          }
        );
        await request(
          `/collections/${name}/index`,
          "PUT",
          {
            field_name: "filePath",
            field_schema: "keyword",
          }
        );
        await request(
          `/collections/${name}/index`,
          "PUT",
          {
            field_name: "symbolType",
            field_schema: "keyword",
          }
        );
      }
    },

    async upsertPoints(
      collection: string,
      points: QdrantPoint[]
    ): Promise<void> {
      // Batch upsert in groups of 100
      const batchSize = 100;
      for (let i = 0; i < points.length; i += batchSize) {
        const batch = points.slice(i, i + batchSize);
        await request(`/collections/${collection}/points`, "PUT", {
          points: batch.map((p) => ({
            id: p.id,
            vector: p.vector,
            payload: p.payload,
          })),
        });
      }
    },

    async search(
      collection: string,
      vector: number[],
      limit: number,
      filter?: QdrantFilter
    ): Promise<QdrantSearchResult[]> {
      const body: Record<string, unknown> = {
        vector,
        limit,
        with_payload: true,
      };
      if (filter) {
        body.filter = filter;
      }

      const result = (await request(
        `/collections/${collection}/points/search`,
        "POST",
        body
      )) as { result: QdrantSearchResult[] };

      return result.result || [];
    },

    async deleteByFilter(
      collection: string,
      filter: QdrantFilter
    ): Promise<void> {
      await request(
        `/collections/${collection}/points/delete`,
        "POST",
        { filter }
      );
    },
  };
}

/**
 * Get the default collection name for code chunks.
 */
export function getCollectionName(): string {
  return COLLECTION_NAME;
}
