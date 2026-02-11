import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { parseFileAndExtractSymbols } from "../lib/treeSitter";
import { buildRepoMap, serializeSymbolTable, serializeDependencyGraph } from "../lib/repoMapper";
import { chunkAllFiles } from "../lib/chunker";
import { detectRepoLanguages } from "../lib/languageDetector";

/**
 * Parse all fetched source files through the symbol extractor.
 * Builds the repo map, symbol table, dependency graph, and code chunks.
 *
 * Pipeline chain: fetchRepo → ensureDockerfile → parseRepo → indexRepo
 */
export const parseRepo = internalAction({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    fileDataJson: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const fileData: Array<{
        filePath: string;
        sha: string;
        content: string;
        size: number;
      }> = JSON.parse(args.fileDataJson);

      const filePaths = fileData.map((f) => f.filePath);

      // Detect languages
      const { primary, all } = detectRepoLanguages(filePaths);
      console.log(`Detected languages: primary=${primary}, all=[${all.join(",")}]`);

      // Parse each file and extract symbols
      const parseResults = [];
      let totalSymbols = 0;

      for (const file of fileData) {
        try {
          const result = parseFileAndExtractSymbols(file.content, file.filePath);
          if (result.symbols.length > 0 || result.imports.length > 0) {
            parseResults.push(result);
            totalSymbols += result.symbols.length;
          }
        } catch (parseError) {
          // Skip files that fail to parse
          console.warn(`Failed to parse ${file.filePath}: ${parseError}`);
        }
      }

      console.log(
        `Parsed ${parseResults.length} files, extracted ${totalSymbols} symbols`
      );

      // Build repo map, symbol table, dependency graph
      const repoMap = buildRepoMap(parseResults);

      // Store repo map
      await ctx.runMutation(internal.repoMaps.create, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        repoMapText: repoMap.repoMapText,
        symbolTableJson: serializeSymbolTable(repoMap.symbolTable),
        dependencyGraphJson: serializeDependencyGraph(repoMap.dependencyGraph),
      });

      // Build code chunks for RAG
      const chunks = chunkAllFiles(parseResults);
      console.log(`Created ${chunks.length} code chunks`);

      // Store code chunks in batches (Convex mutation size limits)
      const CHUNK_BATCH_SIZE = 50;
      for (let i = 0; i < chunks.length; i += CHUNK_BATCH_SIZE) {
        const batch = chunks.slice(i, i + CHUNK_BATCH_SIZE);
        await ctx.runMutation(internal.codeChunks.createBatch, {
          repoConnectionId: args.repoConnectionId,
          bountyId: args.bountyId,
          chunksJson: JSON.stringify(batch),
        });
      }

      // Update repo connection metadata
      await ctx.runMutation(internal.repoConnections.updateParseResults, {
        repoConnectionId: args.repoConnectionId,
        totalSymbols,
        languages: all,
      });

      // Chain to index pipeline
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "indexing",
      });

      await ctx.scheduler.runAfter(0, internal.pipelines.indexRepo.indexRepo, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error during parse";
      console.error(`parseRepo failed: ${errorMessage}`);

      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "failed",
        errorMessage,
      });
    }
  },
});
