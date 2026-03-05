import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getCurrentUser, requireAuth, requireRole } from "./lib/utils";
import { normalizeRepositoryForContext } from "./lib/repoContextKey";

const MAX_FILES_PER_REPO = 20;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_EXTRACTED_CHARS_PER_FILE = 150_000;
const MAX_EXTRACTED_CHARS_PER_REPO = 600_000;
const WORKSPACE_CONTEXT_DIR = "/workspace/ARCAGENT_CONTEXT";

const ALLOWED_EXTENSIONS = new Set(["md", "txt", "pdf", "docx"]);

const ALLOWED_MIME_BY_EXTENSION: Record<string, Set<string>> = {
  md: new Set(["text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"]),
  txt: new Set(["text/plain", "application/octet-stream"]),
  pdf: new Set(["application/pdf"]),
  docx: new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/octet-stream",
  ]),
};

function isRepoContextFilesEnabled(): boolean {
  return process.env.ENABLE_REPO_CONTEXT_FILES === "true";
}

function normalizeExtension(filename: string): string {
  const ext = filename.trim().toLowerCase().split(".").pop() ?? "";
  return ext;
}

function sanitizeFilenameBase(filename: string): string {
  const withoutExt = filename.replace(/\.[^./\\]+$/u, "");
  const normalized = withoutExt
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || "context-file";
}

function buildWorkspaceSafeFilename(filenameOriginal: string, extension: string): string {
  const safeBase = sanitizeFilenameBase(filenameOriginal);
  if (extension === "md" || extension === "txt") {
    return `${safeBase}.${extension}`;
  }
  return `${safeBase}.txt`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function assertAllowedFileType(filename: string, contentType: string): string {
  const ext = normalizeExtension(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("Unsupported file type. Allowed: .md, .txt, .pdf, .docx");
  }

  const normalizedType = contentType.trim().toLowerCase();
  const allowedTypes = ALLOWED_MIME_BY_EXTENSION[ext];
  if (!allowedTypes.has(normalizedType)) {
    throw new Error(`File MIME type does not match .${ext}`);
  }
  return ext;
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function assertFileSignature(extension: string, bytes: Uint8Array): void {
  if (extension === "pdf" && !hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new Error("PDF signature mismatch");
  }
  if (extension === "docx" && !hasPrefix(bytes, [0x50, 0x4b])) {
    throw new Error("DOCX signature mismatch");
  }
}

async function requireCreatorOrAdmin(ctx: any) {
  const user = requireAuth(await getCurrentUser(ctx));
  requireRole(user, ["creator", "admin"]);
  return user;
}

export const listByRepositoryUrl = query({
  args: { repositoryUrl: v.string() },
  handler: async (ctx, args) => {
    await requireCreatorOrAdmin(ctx);
    if (!isRepoContextFilesEnabled()) return [];

    const normalized = normalizeRepositoryForContext(args.repositoryUrl);
    const rows = await ctx.db
      .query("repoContextFiles")
      .withIndex("by_repoKey", (q) => q.eq("repoKey", normalized.repoKey))
      .collect();

    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        _id: row._id,
        repositoryUrlCanonical: row.repositoryUrlCanonical,
        filenameOriginal: row.filenameOriginal,
        filenameSafe: row.filenameSafe,
        extension: row.extension,
        contentType: row.contentType,
        bytes: row.bytes,
        sha256: row.sha256,
        extractionStatus: row.extractionStatus,
        extractionError: row.extractionError,
        uploadedByUserId: row.uploadedByUserId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  },
});

export const generateUploadUrl = mutation({
  args: { repositoryUrl: v.string() },
  handler: async (ctx, args) => {
    await requireCreatorOrAdmin(ctx);
    if (!isRepoContextFilesEnabled()) {
      throw new Error("Repository context files are disabled");
    }

    normalizeRepositoryForContext(args.repositoryUrl);

    return {
      uploadUrl: await ctx.storage.generateUploadUrl(),
      limits: {
        maxFilesPerRepo: MAX_FILES_PER_REPO,
        maxUploadBytes: MAX_UPLOAD_BYTES,
      },
      allowed: [".md", ".txt", ".pdf", ".docx"],
    };
  },
});

export const finalizeUpload = mutation({
  args: {
    repositoryUrl: v.string(),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.string(),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await requireCreatorOrAdmin(ctx);
    if (!isRepoContextFilesEnabled()) {
      throw new Error("Repository context files are disabled");
    }

    const normalized = normalizeRepositoryForContext(args.repositoryUrl);
    const extension = assertAllowedFileType(args.filename, args.contentType);

    if (args.bytes <= 0 || args.bytes > MAX_UPLOAD_BYTES) {
      throw new Error(`File size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`);
    }

    const blob = await ctx.storage.get(args.storageId);
    if (!blob) {
      throw new Error("Uploaded file not found");
    }
    if (blob.size <= 0 || blob.size > MAX_UPLOAD_BYTES) {
      await ctx.storage.delete(args.storageId).catch(() => {});
      throw new Error(`File size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes`);
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (args.bytes !== blob.size) {
      await ctx.storage.delete(args.storageId).catch(() => {});
      throw new Error("Uploaded byte count mismatch");
    }
    try {
      assertFileSignature(extension, bytes);
    } catch (error) {
      await ctx.storage.delete(args.storageId).catch(() => {});
      throw error;
    }
    const sha256 = await sha256Hex(bytes);
    const rows = await ctx.db
      .query("repoContextFiles")
      .withIndex("by_repoKey", (q) => q.eq("repoKey", normalized.repoKey))
      .collect();

    if (rows.length >= MAX_FILES_PER_REPO) {
      await ctx.storage.delete(args.storageId).catch(() => {});
      throw new Error(`Maximum ${MAX_FILES_PER_REPO} files per repository`);
    }

    const duplicate = rows.find((row) => row.sha256 === sha256);
    if (duplicate) {
      await ctx.storage.delete(args.storageId).catch(() => {});
      throw new Error("A file with identical content already exists for this repository");
    }

    const now = Date.now();
    const fileId = await ctx.db.insert("repoContextFiles", {
      repoKey: normalized.repoKey,
      repositoryUrlCanonical: normalized.repositoryUrlCanonical,
      uploadedByUserId: user._id,
      filenameOriginal: args.filename,
      filenameSafe: buildWorkspaceSafeFilename(args.filename, extension),
      extension,
      contentType: args.contentType.trim().toLowerCase(),
      bytes: blob.size,
      sha256,
      storageId: args.storageId,
      extractionStatus: "processing",
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.repoContextExtraction.extractAndStore, {
      fileId,
    });

    return { fileId };
  },
});

export const deleteFile = mutation({
  args: { fileId: v.id("repoContextFiles") },
  handler: async (ctx, args) => {
    await requireCreatorOrAdmin(ctx);
    if (!isRepoContextFilesEnabled()) {
      throw new Error("Repository context files are disabled");
    }

    const row = await ctx.db.get(args.fileId);
    if (!row) throw new Error("File not found");

    await ctx.storage.delete(row.storageId).catch(() => {});
    await ctx.db.delete(args.fileId);
    return { success: true };
  },
});

export const getByIdInternal = internalQuery({
  args: { fileId: v.id("repoContextFiles") },
  handler: async (ctx, args) => ctx.db.get(args.fileId),
});

export const listReadyByRepoKeyInternal = internalQuery({
  args: { repoKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repoContextFiles")
      .withIndex("by_repoKey_and_extractionStatus", (q) =>
        q.eq("repoKey", args.repoKey).eq("extractionStatus", "ready"),
      )
      .collect();
  },
});

export const listReadyForRepositoryUrlInternal = internalQuery({
  args: { repositoryUrl: v.string() },
  handler: async (ctx, args) => {
    if (!isRepoContextFilesEnabled()) return [];
    const normalized = normalizeRepositoryForContext(args.repositoryUrl);
    const ready = await ctx.db
      .query("repoContextFiles")
      .withIndex("by_repoKey_and_extractionStatus", (q) =>
        q.eq("repoKey", normalized.repoKey).eq("extractionStatus", "ready"),
      )
      .collect();

    return ready
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        _id: row._id,
        filenameOriginal: row.filenameOriginal,
        filenameSafe: row.filenameSafe,
        bytes: row.bytes,
        uploadedAt: row.createdAt,
        extractedText: row.extractedText ?? "",
      }));
  },
});

export const markExtractionReadyInternal = internalMutation({
  args: {
    fileId: v.id("repoContextFiles"),
    extractedText: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.fileId, {
      extractionStatus: "ready",
      extractedText: args.extractedText,
      extractionError: undefined,
      updatedAt: Date.now(),
    });
  },
});

export const markExtractionFailedInternal = internalMutation({
  args: {
    fileId: v.id("repoContextFiles"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.fileId, {
      extractionStatus: "failed",
      extractedText: undefined,
      extractionError: args.error.slice(0, 500),
      updatedAt: Date.now(),
    });
  },
});

export const getWorkspaceContextConstants = internalQuery({
  args: {},
  handler: async () => ({
    maxFilesPerRepo: MAX_FILES_PER_REPO,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxExtractedCharsPerFile: MAX_EXTRACTED_CHARS_PER_FILE,
    maxExtractedCharsPerRepo: MAX_EXTRACTED_CHARS_PER_REPO,
    workspaceContextDir: WORKSPACE_CONTEXT_DIR,
  }),
});
