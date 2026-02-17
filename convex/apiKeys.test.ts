import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser } from "./__tests__/helpers";

describe("API Key Lifecycle", () => {
  // ---------------------------------------------------------------------------
  // validateByHash
  // ---------------------------------------------------------------------------
  describe("validateByHash", () => {
    it("active key returns user + scopes", async () => {
      const t = convexTest(schema);
      const { userId, apiKeyId } = await t.run(async (ctx) => {
        const userId = await seedUser(ctx, { role: "agent" });
        const apiKeyId = await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_active_hash",
          keyPrefix: "arc_abcd",
          name: "test key",
          scopes: ["bounties:read", "bounties:claim"],
          status: "active",
          createdAt: Date.now(),
        });
        return { userId, apiKeyId };
      });

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_active_hash",
      });

      expect(result).not.toBeNull();
      expect(result!.apiKeyId).toBe(apiKeyId);
      expect(result!.userId).toBe(userId);
      expect(result!.scopes).toEqual(["bounties:read", "bounties:claim"]);
      expect(result!.user).toBeDefined();
    });

    it("revoked key returns null", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_revoked_hash",
          keyPrefix: "arc_revo",
          name: "revoked key",
          scopes: ["bounties:read"],
          status: "revoked",
          createdAt: Date.now(),
        });
      });

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_revoked_hash",
      });

      expect(result).toBeNull();
    });

    it("expired key returns null", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_expired_hash",
          keyPrefix: "arc_expr",
          name: "expired key",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now() - 86400000,
          expiresAt: Date.now() - 1000, // expired 1 second ago
        });
      });

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_expired_hash",
      });

      expect(result).toBeNull();
    });

    it("key with no expiry is valid", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_no_expiry_hash",
          keyPrefix: "arc_noex",
          name: "no expiry key",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
          // no expiresAt
        });
      });

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_no_expiry_hash",
      });

      expect(result).not.toBeNull();
    });

    it("key for deleted user returns null", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_orphan_hash",
          keyPrefix: "arc_orph",
          name: "orphan key",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
        });
        // Delete the user
        await ctx.db.delete(userId);
      });

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_orphan_hash",
      });

      expect(result).toBeNull();
    });

    it("non-existent hash returns null", async () => {
      const t = convexTest(schema);

      const result = await t.query(internal.apiKeys.validateByHash, {
        keyHash: "sha256_nonexistent_hash",
      });

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Internal mutations: create, revoke, updateLastUsed
  // ---------------------------------------------------------------------------
  describe("create (internal)", () => {
    it("inserts with all fields", async () => {
      const t = convexTest(schema);
      const userId = await t.run(async (ctx) => seedUser(ctx));

      const apiKeyId = await t.mutation(internal.apiKeys.create, {
        userId,
        keyHash: "sha256_created_hash",
        keyPrefix: "arc_crea",
        name: "created key",
        scopes: ["bounties:read", "bounties:claim", "bounties:submit"],
        expiresAt: Date.now() + 86400000,
      });

      const key = await t.run(async (ctx) => ctx.db.get(apiKeyId));
      expect(key).not.toBeNull();
      expect(key!.keyHash).toBe("sha256_created_hash");
      expect(key!.keyPrefix).toBe("arc_crea");
      expect(key!.name).toBe("created key");
      expect(key!.scopes).toEqual(["bounties:read", "bounties:claim", "bounties:submit"]);
      expect(key!.status).toBe("active");
      expect(key!.createdAt).toBeDefined();
      expect(key!.expiresAt).toBeDefined();
    });
  });

  describe("revoke (internal)", () => {
    it("sets status to revoked", async () => {
      const t = convexTest(schema);
      const apiKeyId = await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        return await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_to_revoke",
          keyPrefix: "arc_revo",
          name: "to revoke",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
        });
      });

      await t.mutation(internal.apiKeys.revoke, { apiKeyId });

      const key = await t.run(async (ctx) => ctx.db.get(apiKeyId));
      expect(key!.status).toBe("revoked");
    });
  });

  describe("updateLastUsed", () => {
    it("bumps timestamp", async () => {
      const t = convexTest(schema);
      const apiKeyId = await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        return await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "sha256_last_used",
          keyPrefix: "arc_last",
          name: "last used",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
        });
      });

      const before = await t.run(async (ctx) => ctx.db.get(apiKeyId));
      expect(before!.lastUsedAt).toBeUndefined();

      await t.mutation(internal.apiKeys.updateLastUsed, { apiKeyId });

      const after = await t.run(async (ctx) => ctx.db.get(apiKeyId));
      expect(after!.lastUsedAt).toBeDefined();
      expect(after!.lastUsedAt).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listByUser (internal)
  // ---------------------------------------------------------------------------
  describe("listByUser", () => {
    it("returns all keys for a user (active + revoked)", async () => {
      const t = convexTest(schema);
      const userId = await t.run(async (ctx) => {
        const userId = await seedUser(ctx);
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "hash_1",
          keyPrefix: "arc_key1",
          name: "key 1",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
        });
        await ctx.db.insert("apiKeys" as any, {
          userId,
          keyHash: "hash_2",
          keyPrefix: "arc_key2",
          name: "key 2",
          scopes: ["bounties:read"],
          status: "revoked",
          createdAt: Date.now(),
        });
        return userId;
      });

      const keys = await t.query(internal.apiKeys.listByUser, { userId });
      expect(keys).toHaveLength(2);
      const statuses = keys.map((k: any) => k.status).sort();
      expect(statuses).toEqual(["active", "revoked"]);
    });
  });
});
