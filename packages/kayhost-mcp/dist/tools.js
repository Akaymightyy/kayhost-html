/**
 * MCP tool definitions for kayhost-html.
 *
 * Each tool maps to one or more kayhost REST API calls and exposes a typed
 * input schema (zod) that the MCP runtime validates before invocation.
 */
import { z } from "zod";
import { KayhostApiError } from "./api-client.js";
function ok(text) {
    return { content: [{ type: "text", text }] };
}
function okJson(data) {
    return { content: [{ type: "json", json: data }] };
}
function err(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function formatError(e) {
    if (e instanceof KayhostApiError) {
        return `kayhost API error (${e.status}) on ${e.endpoint}: ${e.message}`;
    }
    if (e instanceof Error)
        return e.message;
    return String(e);
}
// ---------- Tool: kayhost_deploy ----------
const deploySchema = z.object({
    html: z
        .string()
        .min(1, "html is required — provide the full HTML document for the page."),
    title: z
        .string()
        .max(200)
        .optional()
        .describe("Optional page title. Shown in the kayhost dashboard and on the share link."),
    ttl: z
        .enum(["1d", "7d", "30d", "never"])
        .optional()
        .describe("Time-to-live for the site. Defaults to the value in ~/.kayhost/config.json (7d)."),
    slug: z
        .string()
        .regex(/^[a-z0-9-]{3,30}$/, "slug must be 3-30 chars: lowercase, numbers, hyphens; no leading/trailing hyphens.")
        .optional()
        .describe("Custom slug for the URL. If omitted, a random id is generated."),
});
export const deployTool = {
    name: "kayhost_deploy",
    description: "Deploy an HTML page to kayhost and get a live HTTPS shareable URL. " +
        "Use this when the user asks to 'deploy', 'publish', 'host', or 'put online' some HTML. " +
        "Returns the live URL on success.",
    inputSchema: deploySchema,
    handler: async (input, client) => {
        try {
            const result = await client.deploy(input);
            const lines = [
                `Deployed successfully.`,
                `Live URL: ${result.url}`,
                `Site ID:  ${result.id}`,
            ];
            if (result.title)
                lines.push(`Title:    ${result.title}`);
            if (result.ttl)
                lines.push(`TTL:      ${result.ttl}`);
            if (result.expiresAt)
                lines.push(`Expires:  ${result.expiresAt}`);
            return ok(lines.join("\n"));
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_list_sites ----------
const listSchema = z.object({}).describe("No parameters required.");
export const listSitesTool = {
    name: "kayhost_list_sites",
    description: "List all sites owned by the authenticated kayhost token. " +
        "Use this when the user asks 'what sites do I have?' or to enumerate deployable sites. " +
        "Returns id, title, url, ttl, createdAt, and expiresAt for each.",
    inputSchema: listSchema,
    handler: async (_input, client) => {
        try {
            const sites = await client.listSites();
            if (sites.length === 0) {
                return ok("No sites found. Deploy one with kayhost_deploy.");
            }
            const lines = sites.map((s, i) => {
                const parts = [`${i + 1}. ${s.id}`];
                if (s.title)
                    parts.push(`— ${s.title}`);
                if (s.url)
                    parts.push(`(${s.url})`);
                if (s.expiresAt)
                    parts.push(`[expires ${s.expiresAt}]`);
                return parts.join(" ");
            });
            return ok(`Found ${sites.length} site(s):\n\n${lines.join("\n")}`);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_delete_site ----------
const deleteSchema = z.object({
    id: z.string().min(1).describe("The site id to delete. Use kayhost_list_sites to find it."),
});
export const deleteSiteTool = {
    name: "kayhost_delete_site",
    description: "Delete a deployed site by id. This is permanent — the URL will return 404 immediately. " +
        "Always confirm with the user before calling this tool.",
    inputSchema: deleteSchema,
    handler: async (input, client) => {
        try {
            await client.deleteSite(input.id);
            return ok(`Deleted site ${input.id}.`);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_get_site ----------
const getSiteSchema = z.object({
    id: z.string().min(1).describe("The site id whose HTML to fetch."),
});
export const getSiteTool = {
    name: "kayhost_get_site",
    description: "Fetch the raw HTML of a deployed kayhost site by its id. " +
        "Use this when the user wants to inspect or re-edit a previously deployed site.",
    inputSchema: getSiteSchema,
    handler: async (input, client) => {
        try {
            const html = await client.getSiteHtml(input.id);
            return ok(html);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_ai_edit ----------
const aiEditSchema = z.object({
    html: z
        .string()
        .min(1)
        .describe("The current full HTML of the page. Typically the output of kayhost_get_site or a previous deploy."),
    selector: z
        .string()
        .min(1)
        .describe("CSS selector for the element to edit. e.g. 'h1', '.hero-title', '#cta-button', 'nav ul li:first-child'."),
    instruction: z
        .string()
        .min(1)
        .max(2000)
        .describe("Natural-language description of the change. e.g. 'make this button purple and rounded' or 'replace the heading text with Welcome to my portfolio'."),
    apiKey: z
        .string()
        .optional()
        .describe("Optional BYOK API key. If omitted, uses the hosted Gemini model."),
    provider: z
        .enum(["gemini", "openai", "anthropic"])
        .optional()
        .describe("Provider hint when apiKey is supplied."),
});
export const aiEditTool = {
    name: "kayhost_ai_edit",
    description: "Edit a specific element in an HTML page using AI. Provide the current HTML, a CSS selector for the element, " +
        "and a natural-language instruction. Returns the full modified HTML. " +
        "Chain this with kayhost_deploy to publish the edited version.",
    inputSchema: aiEditSchema,
    handler: async (input, client) => {
        try {
            const result = await client.aiEdit(input);
            return ok(result.html);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_clone ----------
const cloneSchema = z.object({
    url: z
        .string()
        .url()
        .describe("The full URL of the page to clone. Must be a public http(s) URL."),
    crawl: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, also crawl up to 10 linked pages on the same domain."),
});
export const cloneTool = {
    name: "kayhost_clone",
    description: "Fetch a live web page's HTML (and optionally linked pages on the same domain) so it can be edited and re-deployed. " +
        "Respects robots.txt and is SSRF-protected on the server side. " +
        "Use this when the user wants to 'clone', 'copy', 'import', or 'mirror' an existing website.",
    inputSchema: cloneSchema,
    handler: async (input, client) => {
        try {
            const result = await client.clone(input);
            if (result.pages && result.pages.length > 0) {
                const lines = [
                    `Cloned ${result.pages.length} page(s) from ${input.url}:`,
                    "",
                    ...result.pages.map((p, i) => `${i + 1}. ${p.url}${p.title ? ` — ${p.title}` : ""}`),
                    "",
                    `First page HTML is returned below. Use kayhost_deploy to publish a copy, or kayhost_ai_edit to modify it first.`,
                    "",
                    result.html,
                ];
                return ok(lines.join("\n"));
            }
            return ok(result.html);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- Tool: kayhost_upload_media ----------
const uploadMediaSchema = z.object({
    path: z
        .string()
        .min(1)
        .describe("Absolute path to the image file on disk. PNG, JPG, GIF, WebP, or SVG."),
});
export const uploadMediaTool = {
    name: "kayhost_upload_media",
    description: "Upload an image file from disk to kayhost's Cloudinary media library. " +
        "Returns a permanent URL that can be embedded in deployed HTML. " +
        "Use this when the user wants to 'host an image', 'upload an asset', or include a local image in a deployed page.",
    inputSchema: uploadMediaSchema,
    handler: async (input, client) => {
        try {
            const { readFileSync } = await import("node:fs");
            const { basename, extname } = await import("node:path");
            const buf = readFileSync(input.path);
            const ext = extname(input.path).slice(1).toLowerCase();
            const mimeMap = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
                svg: "image/svg+xml",
            };
            const mimeType = mimeMap[ext];
            if (!mimeType) {
                return err(`Unsupported image type: .${ext}. Use png, jpg, gif, webp, or svg.`);
            }
            const result = await client.uploadMedia({
                data: buf.toString("base64"),
                filename: basename(input.path),
                mimeType,
            });
            return ok(`Uploaded ${basename(input.path)} → ${result.url}`);
        }
        catch (e) {
            return err(formatError(e));
        }
    },
};
// ---------- All tools ----------
export const ALL_TOOLS = [
    deployTool,
    listSitesTool,
    deleteSiteTool,
    getSiteTool,
    aiEditTool,
    cloneTool,
    uploadMediaTool,
];
//# sourceMappingURL=tools.js.map