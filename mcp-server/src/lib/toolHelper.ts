import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

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
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server.tool as any)(name, description, schema, handler);
}
