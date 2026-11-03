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
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const CONFIG_DIR = join(homedir(), ".kayhost");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const DEFAULT_API_BASE = "https://kayhosthtml.zone.id";
/** Environment variables take precedence over the config file. */
export function readConfig() {
    const apiBaseUrl = process.env.KAYHOST_API_BASE || DEFAULT_API_BASE;
    const envToken = process.env.KAYHOST_TOKEN;
    let fileConfig = {};
    if (existsSync(CONFIG_FILE)) {
        try {
            const raw = readFileSync(CONFIG_FILE, "utf-8");
            fileConfig = JSON.parse(raw);
        }
        catch {
            // Corrupt config — treat as empty.
            fileConfig = {};
        }
    }
    return {
        apiBaseUrl,
        token: envToken || fileConfig.token,
        defaultTtl: fileConfig.defaultTtl || "7d",
        browserId: fileConfig.browserId,
    };
}
export function writeConfig(config) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
    });
    // Best-effort chmod — some filesystems ignore the mode above.
    try {
        chmodSync(CONFIG_FILE, 0o600);
    }
    catch {
        // ignore on platforms that don't support chmod (Windows)
    }
}
export function clearToken() {
    const current = readConfig();
    delete current.token;
    writeConfig(current);
}
export function getConfigPath() {
    return CONFIG_FILE;
}
//# sourceMappingURL=config.js.map