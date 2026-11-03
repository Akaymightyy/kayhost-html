/**
 * Bridge between zod schemas and the JSON Schema format expected by the MCP SDK.
 *
 * Uses the `zod-to-json-schema` library under the hood, with $ref strategy
 * set to "none" so the output is fully inlined. Some MCP clients (Cursor,
 * Antigravity) cannot resolve $ref pointers in inputSchema.
 */
import type { ZodTypeAny } from "zod";
export declare function zodToJsonSchema(schema: ZodTypeAny): unknown;
//# sourceMappingURL=zod-to-json-schema.d.ts.map