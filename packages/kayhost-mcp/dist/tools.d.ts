/**
 * MCP tool definitions for kayhost-html.
 *
 * Each tool maps to one or more kayhost REST API calls and exposes a typed
 * input schema (zod) that the MCP runtime validates before invocation.
 */
import { z } from "zod";
import { KayhostClient } from "./api-client.js";
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: z.ZodTypeAny;
    handler: (input: any, client: KayhostClient) => Promise<ToolResult>;
}
export interface ToolResult {
    content: Array<{
        type: "text";
        text: string;
    } | {
        type: "json";
        json: unknown;
    }>;
    isError?: boolean;
}
export declare const deployTool: ToolDef;
export declare const listSitesTool: ToolDef;
export declare const deleteSiteTool: ToolDef;
export declare const getSiteTool: ToolDef;
export declare const aiEditTool: ToolDef;
export declare const cloneTool: ToolDef;
export declare const uploadMediaTool: ToolDef;
export declare const ALL_TOOLS: ToolDef[];
//# sourceMappingURL=tools.d.ts.map