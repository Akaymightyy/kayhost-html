/**
 * Bridge between zod schemas and the JSON Schema format expected by the MCP SDK.
 *
 * Uses the `zod-to-json-schema` library under the hood, with $ref strategy
 * set to "none" so the output is fully inlined. Some MCP clients (Cursor,
 * Antigravity) cannot resolve $ref pointers in inputSchema.
 */
import { zodToJsonSchema as convert } from "zod-to-json-schema";
export function zodToJsonSchema(schema) {
    const out = convert(schema, {
        name: undefined,
        $refStrategy: "none",
        target: "jsonSchema7",
    });
    // Strip the $schema field if present (the MCP SDK doesn't want it).
    if (out && typeof out === "object" && "$schema" in out) {
        const { $schema, ...rest } = out;
        void $schema;
        return rest;
    }
    return out;
}
//# sourceMappingURL=zod-to-json-schema.js.map