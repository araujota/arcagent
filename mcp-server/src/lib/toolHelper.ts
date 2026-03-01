import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

type ToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

function deriveDefaultAnnotations(name: string): ToolAnnotations {
  const tool = name.toLowerCase();
  const isReadOnly = /^(get|list|check|workspace_read|workspace_list|workspace_search|workspace_glob|workspace_grep|workspace_status|workspace_startup_log|workspace_crash_reports|worker_health)/.test(
    tool,
  );
  const isLikelyDestructive = /^(cancel|release|workspace_write|workspace_edit|workspace_apply_patch|workspace_exec|workspace_exec_stream|workspace_shell|submit|fund|create|claim|rate)/.test(
    tool,
  );
  const isOpenWorld = /^(import_work_item|setup_payment_method|setup_payout_account)/.test(tool);

  return {
    readOnlyHint: isReadOnly,
    destructiveHint: isLikelyDestructive && !isReadOnly,
    idempotentHint: isReadOnly,
    openWorldHint: isOpenWorld,
  };
}

/**
 * Register a tool with the MCP server, working around TypeScript's
 * "Type instantiation is excessively deep" error that occurs with
 * zod 3.25+ and the MCP SDK's dual v3/v4 type inference.
 *
 * The schema is passed as `any` to bypass deep type inference,
 * while still getting runtime validation from zod.
 */
export function registerTool(
  server: McpServer,
  name: string,
  description: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any, extra: RequestHandlerExtra<any, any>) => Promise<CallToolResult>,
  options?: { annotations?: ToolAnnotations },
): void {
  const annotations = {
    ...deriveDefaultAnnotations(name),
    ...(options?.annotations ?? {}),
  };

  // Prefer structured registration so annotations are exposed in tool metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (server as any).registerTool === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(name, {
      description,
      inputSchema: schema,
      annotations,
    }, handler);
    return;
  }

  // Fallback for mocks or older SDK surfaces.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.tool as any)(name, description, schema, handler);
}
