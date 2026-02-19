import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

describe("Waitlist", () => {
  describe("join", () => {
    it("returns success and inserts entry for valid email", async () => {
      const t = convexTest(schema);

      const result = await t.mutation(api.waitlist.join, {
        email: "hello@example.com",
      });

      expect(result.status).toBe("success");
      const entries = await t.run(async (ctx) =>
        ctx.db.query("waitlist").collect()
      );
      expect(entries).toHaveLength(1);
      expect(entries[0].email).toBe("hello@example.com");
    });

    it("trims and lowercases email before storing", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, {
        email: "  Hello@EXAMPLE.COM  ",
      });

      const entries = await t.run(async (ctx) =>
        ctx.db.query("waitlist").collect()
      );
      expect(entries[0].email).toBe("hello@example.com");
    });

    it("stores optional source field", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, {
        email: "agent@example.com",
        source: "hero",
      });

      const entries = await t.run(async (ctx) =>
        ctx.db.query("waitlist").collect()
      );
      expect(entries[0].source).toBe("hero");
      expect(entries[0].joinedAt).toBeDefined();
    });

    it("returns duplicate when email already exists", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, { email: "dup@example.com" });
      const second = await t.mutation(api.waitlist.join, {
        email: "dup@example.com",
      });

      expect(second.status).toBe("duplicate");
      // Only one record in DB
      const entries = await t.run(async (ctx) =>
        ctx.db.query("waitlist").collect()
      );
      expect(entries).toHaveLength(1);
    });

    it("duplicate check is case-insensitive (normalised before lookup)", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, { email: "Case@Example.com" });
      const second = await t.mutation(api.waitlist.join, {
        email: "CASE@EXAMPLE.COM",
      });

      expect(second.status).toBe("duplicate");
    });

    it("throws on invalid email — no @", async () => {
      const t = convexTest(schema);

      await expect(
        t.mutation(api.waitlist.join, { email: "notanemail" })
      ).rejects.toThrow("Invalid email address");
    });

    it("throws on invalid email — empty string", async () => {
      const t = convexTest(schema);

      await expect(
        t.mutation(api.waitlist.join, { email: "" })
      ).rejects.toThrow("Invalid email address");
    });

    it("throws on invalid email — only @", async () => {
      const t = convexTest(schema);

      await expect(
        t.mutation(api.waitlist.join, { email: "@" })
      ).rejects.toThrow("Invalid email address");
    });
  });

  describe("count", () => {
    it("returns 0 when waitlist is empty", async () => {
      const t = convexTest(schema);
      const count = await t.query(api.waitlist.count, {});
      expect(count).toBe(0);
    });

    it("returns correct count after multiple joins", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, { email: "a@example.com" });
      await t.mutation(api.waitlist.join, { email: "b@example.com" });
      await t.mutation(api.waitlist.join, { email: "c@example.com" });

      const count = await t.query(api.waitlist.count, {});
      expect(count).toBe(3);
    });

    it("does not double-count duplicate join attempts", async () => {
      const t = convexTest(schema);

      await t.mutation(api.waitlist.join, { email: "x@example.com" });
      await t.mutation(api.waitlist.join, { email: "x@example.com" }); // duplicate

      const count = await t.query(api.waitlist.count, {});
      expect(count).toBe(1);
    });
  });
});
