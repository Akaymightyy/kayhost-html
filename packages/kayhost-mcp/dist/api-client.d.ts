/**
 * Thin HTTP client for the kayhost-html REST API.
 *
 * Two modes:
 *   1. Bearer mode (token configured): uses /api/api-deploy, /api/api-sites,
 *      /api/api-delete — deploys tracked to the user's account.
 *   2. Anonymous mode (no token): uses /api/deploy, /api/sites — deploys
 *      tracked to a persistent browserId stored in ~/.kayhost/config.json.
 *
 * Endpoints documented at https://kayhosthtml.zone.id/api
 *   POST   /api/api-deploy          Bearer-auth deploy
 *   GET    /api/api-sites           Bearer-auth list sites
 *   POST   /api/api-delete          Bearer-auth delete site
 *   POST   /api/deploy              Anonymous deploy (body: { html, title, ttl, browserId })
 *   GET    /api/sites?browserId=X   Anonymous list
 *   POST   /api/ai-edit             AI element edit (BYOK or hosted Gemini)
 *   POST   /api/media               Upload image to Cloudinary
 *   POST   /api/clone               Clone a URL
 *   GET    /site/:id                Fetch a deployed site's raw HTML
 *
 * All methods throw KayhostApiError on non-2xx responses.
 */
import { type KayhostConfig } from "./config.js";
export interface DeployOptions {
    /** Raw HTML of the page. */
    html: string;
    /** Optional page title. */
    title?: string;
    /** TTL: "1d" | "7d" | "30d" | "never". Defaults to config.defaultTtl. */
    ttl?: string;
    /** Optional custom slug (lowercase, 3-30 chars). */
    slug?: string;
}
export interface DeployResult {
    id: string;
    url: string;
    title?: string;
    ttl?: string;
    createdAt?: string;
    expiresAt?: string | null;
}
export interface SiteRecord {
    id: string;
    title?: string;
    url?: string;
    html?: string;
    ttl?: string;
    createdAt?: string;
    expiresAt?: string | null;
    views?: number;
}
export interface AiEditOptions {
    /** Current HTML of the page. */
    html: string;
    /** CSS selector for the element to edit. */
    selector: string;
    /** Natural-language instruction. */
    instruction: string;
    /** Optional BYOK API key (Gemini / OpenAI / Anthropic). */
    apiKey?: string;
    /** Optional provider hint: "gemini" | "openai" | "anthropic". */
    provider?: string;
}
export interface AiEditResult {
    html: string;
    /** What changed, if the API returns it. */
    diff?: string;
}
export interface CloneOptions {
    url: string;
    /** Crawl linked pages on the same domain (up to 10). */
    crawl?: boolean;
}
export interface CloneResult {
    id?: string;
    url?: string;
    html: string;
    title?: string;
    pages?: Array<{
        url: string;
        html: string;
        title?: string;
    }>;
}
export interface MediaUploadOptions {
    /** Base64-encoded file data (no data: prefix). */
    data: string;
    filename: string;
    mimeType: string;
}
export interface MediaUploadResult {
    url: string;
    publicId?: string;
    width?: number;
    height?: number;
    bytes?: number;
}
export declare class KayhostApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly endpoint: string;
    constructor(message: string, status: number, body: unknown, endpoint: string);
}
export declare class KayhostClient {
    private config;
    constructor(config?: KayhostConfig);
    private get baseUrl();
    /** True when a Bearer token is configured. Anonymous mode is used otherwise. */
    get isAuthenticated(): boolean;
    /**
     * Lazily-fetched browserId for anonymous mode. Generated once, persisted
     * to ~/.kayhost/config.json so deploys from the same machine are tracked
     * together.
     */
    private getBrowserId;
    private get authHeaders();
    private request;
    /**
     * Deploy a new site. Uses Bearer endpoint (/api/api-deploy) when a token
     * is configured; falls back to anonymous endpoint (/api/deploy) with the
     * persistent browserId otherwise.
     */
    deploy(opts: DeployOptions): Promise<DeployResult>;
    /**
     * List sites. Bearer mode: /api/api-sites. Anonymous mode:
     * /api/sites?browserId=X.
     */
    listSites(): Promise<SiteRecord[]>;
    /**
     * Delete a site. Bearer mode: /api/api-delete. Anonymous mode: not
     * supported (the anonymous endpoint has no delete — sites expire by TTL).
     */
    deleteSite(id: string): Promise<{
        ok: boolean;
        id: string;
    }>;
    /** GET /site/:id — fetch the raw HTML of a deployed site. */
    getSiteHtml(id: string): Promise<string>;
    /** POST /api/ai-edit — AI element edit. */
    aiEdit(opts: AiEditOptions): Promise<AiEditResult>;
    /** POST /api/clone — clone a URL into editable HTML. */
    clone(opts: CloneOptions): Promise<CloneResult>;
    /** POST /api/media — upload an image to Cloudinary. */
    uploadMedia(opts: MediaUploadOptions): Promise<MediaUploadResult>;
}
//# sourceMappingURL=api-client.d.ts.map