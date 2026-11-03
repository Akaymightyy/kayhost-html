#!/usr/bin/env node
/**
 * kayhost-mcp — MCP server (stdio transport) for kayhost-html.
 *
 * Run directly:
 *   node dist/mcp-server.js
 *
 * Or via npx:
 *   npx -y kayhost-mcp
 *
 * Or registered with an MCP client (Claude Code, Cursor, Codex, etc.) — see README.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { ALL_TOOLS } from "./tools.js";
import { KayhostClient } from "./api-client.js";
import { readConfig } from "./config.js";

const SERVER_NAME = "kayhost-mcp";
const SERVER_VERSION = "0.1.0";

const client = new KayhostClient(readConfig());

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// --- List tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema),
  })) as unknown as Tool[];
  return { tools };
});

// --- Call tool ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  // Validate input
  const parsed = def.inputSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Invalid input for ${name}:\n${issues}`,
        },
      ],
      isError: true,
    };
  }

  const result = await def.handler(parsed.data, client);
  return {
    content: result.content,
    isError: result.isError,
  };
});

// --- Start ---

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stdio transport: keep process alive, no console output (it would corrupt the MCP stream).
}

main().catch((e) => {
  // Errors here are fatal — write to stderr (stdout is reserved for MCP frames).
  process.stderr.write(
    `kayhost-mcp: fatal error: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
});
