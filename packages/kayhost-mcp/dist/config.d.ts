/**
 * Config storage for kayhost-mcp / kayhost-cli.
 *
 * Stores the API base URL and the user's bearer token at:
 *   ~/.kayhost/config.json
 *
 * The token is created on kayhosthtml.zone.id under "API Tokens" and pasted
 * locally via `kayhost login --token kayh_...` or by setting the
 * KAYHOST_TOKEN environment variable (which takes precedence).
 */
export interface KayhostConfig {
    /** API base URL, no trailing slash. */
    apiBaseUrl: string;
    /** Bearer token (kayh_...). Optional — anonymous mode is allowed. */
    token?: string;
    /** Default TTL for new deploys: "1d" | "7d" | "30d" | "never". */
    defaultTtl?: string;
    /** Persistent browser id for anonymous-mode deploys (when no token is set). */
    browserId?: string;
}
export declare const DEFAULT_API_BASE = "https://kayhosthtml.zone.id";
/** Environment variables take precedence over the config file. */
export declare function readConfig(): KayhostConfig;
export declare function writeConfig(config: KayhostConfig): void;
export declare function clearToken(): void;
export declare function getConfigPath(): string;
//# sourceMappingURL=config.d.ts.map