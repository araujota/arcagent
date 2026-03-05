"use node";

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const MAX_EXTRACTED_CHARS_PER_FILE = 150_000;
const MAX_EXTRACTED_CHARS_PER_REPO = 600_000;

function normalizeExtractedText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

async function extractMdOrTxt(content: Uint8Array): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false }).decode(content);
}

async function extractDocx(content: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: content });
  return result.value ?? "";
}

async function extractPdf(content: Uint8Array): Promise<string> {
  const pdfJs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfJs.getDocument({
    data: content,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const doc = await loadingTask.promise;
  const chunks: string[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
    const page = await doc.getPage(pageNum);
    const contentObj = await page.getTextContent();
    const pageText = (contentObj.items as Array<{ str?: string }>)
      .map((item) => item.str ?? "")
      .join(" ")
      .trim();
    if (pageText) chunks.push(pageText);
  }
  await doc.destroy();
  return chunks.join("\n\n");
}

async function extractTextByExtension(extension: string, content: Uint8Array): Promise<string> {
  if (extension === "md" || extension === "txt") {
    return extractMdOrTxt(content);
  }
  if (extension === "docx") {
    return extractDocx(content.buffer);
  }
  if (extension === "pdf") {
    return extractPdf(content);
  }
  throw new Error("Unsupported file type for extraction");
}

export const extractAndStore = internalAction({
  args: { fileId: v.id("repoContextFiles") },
  handler: async (ctx, args) => {
    if (process.env.ENABLE_REPO_CONTEXT_FILES !== "true") return;

    const row = await ctx.runQuery(internal.repoContextFiles.getByIdInternal, {
      fileId: args.fileId,
    });
    if (!row) return;
    if (row.extractionStatus !== "processing") return;

    try {
      const blob = await ctx.storage.get(row.storageId);
      if (!blob) {
        throw new Error("Uploaded file is unavailable");
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const extractedRaw = await extractTextByExtension(row.extension, bytes);
      const extractedText = normalizeExtractedText(extractedRaw);
      if (!extractedText) {
        throw new Error("No extractable text found");
      }
      if (extractedText.length > MAX_EXTRACTED_CHARS_PER_FILE) {
        throw new Error(`Extracted text exceeds per-file limit (${MAX_EXTRACTED_CHARS_PER_FILE} chars)`);
      }

      const ready = await ctx.runQuery(internal.repoContextFiles.listReadyByRepoKeyInternal, {
        repoKey: row.repoKey,
      });
      const existingTotal = ready.reduce((sum, file) => sum + (file.extractedText?.length ?? 0), 0);
      if (existingTotal + extractedText.length > MAX_EXTRACTED_CHARS_PER_REPO) {
        throw new Error(`Total repo context exceeds ${MAX_EXTRACTED_CHARS_PER_REPO} chars`);
      }

      await ctx.runMutation(internal.repoContextFiles.markExtractionReadyInternal, {
        fileId: row._id,
        extractedText,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to extract context file";
      await ctx.runMutation(internal.repoContextFiles.markExtractionFailedInternal, {
        fileId: row._id,
        error: message,
      });
    }
  },
});
