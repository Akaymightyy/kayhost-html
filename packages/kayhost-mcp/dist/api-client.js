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
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig } from "./config.js";
export class KayhostApiError extends Error {
    status;
    body;
    endpoint;
    constructor(message, status, body, endpoint) {
        super(message);
        this.status = status;
        this.body = body;
        this.endpoint = endpoint;
        this.name = "KayhostApiError";
    }
}
export class KayhostClient {
    config;
    constructor(config) {
        this.config = config ?? readConfig();
    }
    get baseUrl() {
        return this.config.apiBaseUrl.replace(/\/+$/, "");
    }
    /** True when a Bearer token is configured. Anonymous mode is used otherwise. */
    get isAuthenticated() {
        return Boolean(this.config.token);
    }
    /**
     * Lazily-fetched browserId for anonymous mode. Generated once, persisted
     * to ~/.kayhost/config.json so deploys from the same machine are tracked
     * together.
     */
    getBrowserId() {
        if (this.config.browserId)
            return this.config.browserId;
        const id = randomUUID();
        this.config.browserId = id;
        try {
            writeConfig(this.config);
        }
        catch {
            // If we can't persist, keep the in-memory id (still works for this session).
        }
        return id;
    }
    get authHeaders() {
        const headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            // kayhost-html's edge filter 403s non-browser UAs. Send a browser-like
            // UA with the kayhost-mcp identifier appended for server-side log
            // attribution. Server-side fix (allowlisting kayhost-mcp/*) tracked
            // separately in the kayhost-html repo.
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 " +
                "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 kayhost-mcp/0.1.0",
        };
        if (this.config.token) {
            headers["Authorization"] = `Bearer ${this.config.token}`;
        }
        return headers;
    }
    async request(method, path, body, init) {
        const url = `${this.baseUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers: this.authHeaders,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            ...init,
        });
        const text = await res.text();
        let parsed = text;
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json") && text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                // keep raw text
            }
        }
        if (!res.ok) {
            const message = (parsed && typeof parsed === "object" && "error" in parsed
                ? String(parsed.error)
                : `HTTP ${res.status} ${res.statusText}`) || `HTTP ${res.status}`;
            throw new KayhostApiError(message, res.status, parsed, path);
        }
        return parsed;
    }
    /**
     * Deploy a new site. Uses Bearer endpoint (/api/api-deploy) when a token
     * is configured; falls back to anonymous endpoint (/api/deploy) with the
     * persistent browserId otherwise.
     */
    async deploy(opts) {
        const ttl = opts.ttl || this.config.defaultTtl || "7d";
        if (this.isAuthenticated) {
            return this.request("POST", "/api/api-deploy", {
                html: opts.html,
                title: opts.title,
                ttl,
                slug: opts.slug,
            });
        }
        // Anonymous mode — /api/deploy with browserId
        const browserId = this.getBrowserId();
        const res = await this.request("POST", "/api/deploy", {
            html: opts.html,
            title: opts.title,
            ttl,
            browserId,
            slug: opts.slug,
        });
        // Normalize — /api/deploy returns {id, url, expiresAt, customName}
        return {
            id: res.id,
            url: res.url,
            title: opts.title,
            ttl,
            expiresAt: res.expiresAt
                ? new Date(typeof res.expiresAt === "number" ? res.expiresAt : Date.parse(String(res.expiresAt))).toISOString()
                : null,
        };
    }
    /**
     * List sites. Bearer mode: /api/api-sites. Anonymous mode:
     * /api/sites?browserId=X.
     */
    async listSites() {
        if (this.isAuthenticated) {
            const res = await this.request("GET", "/api/api-sites");
            return Array.isArray(res) ? res : res.sites || [];
        }
        const browserId = this.getBrowserId();
        const res = await this.request("GET", `/api/sites?browserId=${encodeURIComponent(browserId)}`);
        return Array.isArray(res) ? res : res.sites || [];
    }
    /**
     * Delete a site. Bearer mode: /api/api-delete. Anonymous mode: not
     * supported (the anonymous endpoint has no delete — sites expire by TTL).
     */
    async deleteSite(id) {
        if (!this.isAuthenticated) {
            throw new KayhostApiError("Deleting sites requires a Bearer token. Run `kayhost login --token kayh_...` to configure one. " +
                "Anonymous-mode sites can only be removed by waiting for their TTL to expire.", 401, null, "/api/api-delete");
        }
        return this.request("POST", "/api/api-delete", { id });
    }
    /** GET /site/:id — fetch the raw HTML of a deployed site. */
    async getSiteHtml(id) {
        const url = `${this.baseUrl}/site/${encodeURIComponent(id)}`;
        const res = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 kayhost-mcp/0.1.0",
            },
        });
        if (!res.ok) {
            throw new KayhostApiError(`HTTP ${res.status} ${res.statusText}`, res.status, await res.text(), `/site/${id}`);
        }
        return res.text();
    }
    /** POST /api/ai-edit — AI element edit. */
    async aiEdit(opts) {
        return this.request("POST", "/api/ai-edit", {
            html: opts.html,
            selector: opts.selector,
            instruction: opts.instruction,
            apiKey: opts.apiKey,
            provider: opts.provider,
        });
    }
    /** POST /api/clone — clone a URL into editable HTML. */
    async clone(opts) {
        return this.request("POST", "/api/clone", {
            url: opts.url,
            crawl: opts.crawl ?? false,
        });
    }
    /** POST /api/media — upload an image to Cloudinary. */
    async uploadMedia(opts) {
        return this.request("POST", "/api/media", {
            data: opts.data,
            filename: opts.filename,
            mimeType: opts.mimeType,
        });
    }
}
//# sourceMappingURL=api-client.js.map