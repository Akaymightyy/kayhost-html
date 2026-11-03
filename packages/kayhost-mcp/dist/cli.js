#!/usr/bin/env node
/**
 * kayhost — CLI for kayhost-html.
 *
 *   kayhost login [--token kayh_...] [--api-base https://...]
 *   kayhost whoami
 *   kayhost deploy <file-or-dir> [--title "..."] [--ttl 7d] [--slug my-page]
 *   kayhost list
 *   kayhost get <id>
 *   kayhost delete <id>
 *   kayhost config
 *
 * Run `kayhost <command> --help` for per-command options.
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { basename, resolve, extname, join } from "node:path";
import { KayhostClient, KayhostApiError } from "./api-client.js";
import { readConfig, writeConfig, getConfigPath, clearToken, DEFAULT_API_BASE, } from "./config.js";
function parseArgs(argv) {
    const args = argv.slice(2);
    if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
        return { command: "help", positional: [], flags: {} };
    }
    const command = args[0];
    const positional = [];
    const flags = {};
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (next === undefined || next.startsWith("--")) {
                flags[key] = true;
            }
            else {
                flags[key] = next;
                i++;
            }
        }
        else if (a.startsWith("-")) {
            const key = a.slice(1);
            flags[key] = true;
        }
        else {
            positional.push(a);
        }
    }
    return { command, positional, flags };
}
// ---------- Helpers ----------
function die(msg, code = 1) {
    process.stderr.write(`kayhost: ${msg}\n`);
    process.exit(code);
}
function formatError(e) {
    if (e instanceof KayhostApiError) {
        return `API error (${e.status}) on ${e.endpoint}: ${e.message}`;
    }
    return e instanceof Error ? e.message : String(e);
}
function ttlFlag(flags) {
    const v = flags.ttl || flags.t;
    if (typeof v !== "string")
        return undefined;
    if (!["1d", "7d", "30d", "never"].includes(v)) {
        die(`Invalid --ttl value: ${v}. Must be one of: 1d, 7d, 30d, never.`);
    }
    return v;
}
// ---------- Commands ----------
function help() {
    process.stdout.write(`kayhost — CLI for kayhost-html

Usage:
  kayhost <command> [options]

Commands:
  login    Save your API token. Usage: kayhost login --token kayh_...
  whoami   Show the configured token and API base.
  deploy   Deploy a file or directory. Usage: kayhost deploy <path> [--title "..." --ttl 7d --slug my-page]
  list     List your deployed sites.
  get      Fetch the raw HTML of a site. Usage: kayhost get <id>
  delete   Delete a site by id. Usage: kayhost delete <id>
  config   Show the config file path and current contents (token redacted).
  logout   Remove the saved token.

Options:
  --token <tok>      Bearer token (kayh_...). Used with login.
  --api-base <url>   Override API base (default: ${DEFAULT_API_BASE}).
  --title <t>        Page title. Used with deploy.
  --ttl <t>          Time-to-live: 1d, 7d, 30d, never. Used with deploy.
  --slug <s>         Custom URL slug (3-30 chars: a-z0-9-). Used with deploy.
  -h, --help         Show this help.

Environment variables:
  KAYHOST_TOKEN      Bearer token (overrides config file).
  KAYHOST_API_BASE   API base URL (overrides config file, default: ${DEFAULT_API_BASE}).

Config file: ${getConfigPath()}
`);
}
function cmdLogin(positional, flags) {
    const token = typeof flags.token === "string" ? flags.token : positional[0];
    if (!token) {
        die("login: --token is required. Get one at https://kayhosthtml.zone.id → API Tokens.");
    }
    if (!token.startsWith("kayh_")) {
        process.stderr.write(`warning: token doesn't look like a kayhost token (expected prefix "kayh_"). Saving anyway.\n`);
    }
    const apiBase = typeof flags["api-base"] === "string" ? flags["api-base"] : DEFAULT_API_BASE;
    const cfg = readConfig();
    cfg.token = token;
    cfg.apiBaseUrl = apiBase;
    writeConfig(cfg);
    process.stdout.write(`Saved token to ${getConfigPath()}\n`);
    process.stdout.write(`API base: ${apiBase}\n`);
    process.stdout.write(`Run \`kayhost whoami\` to verify.\n`);
}
function cmdWhoami() {
    const cfg = readConfig();
    if (!cfg.token) {
        process.stdout.write(`Not logged in. Run: kayhost login --token kayh_...\n`);
        return;
    }
    const masked = cfg.token.slice(0, 8) + "..." + cfg.token.slice(-4);
    process.stdout.write(`Logged in as: ${masked}\n`);
    process.stdout.write(`API base:     ${cfg.apiBaseUrl}\n`);
    process.stdout.write(`Default TTL:  ${cfg.defaultTtl || "7d"}\n`);
}
function cmdConfig() {
    const cfg = readConfig();
    const display = { ...cfg };
    if (display.token) {
        display.token = display.token.slice(0, 8) + "..." + display.token.slice(-4);
    }
    process.stdout.write(`Config file: ${getConfigPath()}\n`);
    process.stdout.write(`Contents:    ${JSON.stringify(display, null, 2)}\n`);
}
function cmdLogout() {
    clearToken();
    process.stdout.write(`Token removed from ${getConfigPath()}\n`);
}
async function cmdDeploy(positional, flags) {
    const pathArg = positional[0];
    if (!pathArg) {
        die("deploy: path argument is required. Usage: kayhost deploy <file.html | directory>");
    }
    const absPath = resolve(pathArg);
    if (!existsSync(absPath)) {
        die(`deploy: path does not exist: ${absPath}`);
    }
    const cfg = readConfig();
    if (!cfg.token) {
        process.stderr.write(`note: no token configured — using anonymous mode (browserId-based).\n`);
        process.stderr.write(`      Run \`kayhost login --token kayh_...\` to track deploys to your account and unlock delete.\n\n`);
    }
    const client = new KayhostClient(cfg);
    const title = typeof flags.title === "string" ? flags.title : undefined;
    const ttl = ttlFlag(flags);
    const slug = typeof flags.slug === "string" ? flags.slug : undefined;
    const stats = statSync(absPath);
    if (stats.isFile()) {
        // Single-file deploy
        const html = readFileSync(absPath, "utf-8");
        process.stdout.write(`Deploying ${basename(absPath)} (${html.length} bytes)...\n`);
        try {
            const result = await client.deploy({ html, title, ttl, slug });
            process.stdout.write(`\n  Live URL: ${result.url}\n  Site ID:  ${result.id}\n`);
            if (result.expiresAt)
                process.stdout.write(`  Expires:  ${result.expiresAt}\n`);
        }
        catch (e) {
            die(formatError(e));
        }
        return;
    }
    if (stats.isDirectory()) {
        // Multi-file: kayhost's current API only supports single-page deploys.
        // For now: deploy index.html (or first .html file) and warn about the rest.
        const entries = readdirSync(absPath).filter((f) => extname(f).toLowerCase() === ".html");
        if (entries.length === 0) {
            die(`deploy: no .html files found in ${absPath}`);
        }
        if (entries.length > 1) {
            process.stderr.write(`note: kayhost's REST API currently supports single-page deploys. ` +
                `Found ${entries.length} HTML files; deploying the first one (${entries[0]}).\n` +
                `      Multi-page directory deploys are coming soon.\n`);
        }
        const first = entries.includes("index.html") ? "index.html" : entries[0];
        const html = readFileSync(join(absPath, first), "utf-8");
        process.stdout.write(`Deploying ${first} from ${basename(absPath)}/ (${html.length} bytes)...\n`);
        try {
            const result = await client.deploy({ html, title, ttl, slug });
            process.stdout.write(`\n  Live URL: ${result.url}\n  Site ID:  ${result.id}\n`);
            if (result.expiresAt)
                process.stdout.write(`  Expires:  ${result.expiresAt}\n`);
        }
        catch (e) {
            die(formatError(e));
        }
        return;
    }
    die(`deploy: path is neither a file nor a directory: ${absPath}`);
}
async function cmdList() {
    const cfg = readConfig();
    if (!cfg.token) {
        process.stderr.write(`note: no token — listing anonymous-mode sites for this machine's browserId.\n\n`);
    }
    const client = new KayhostClient(cfg);
    try {
        const sites = await client.listSites();
        if (sites.length === 0) {
            process.stdout.write("No sites found.\n");
            return;
        }
        process.stdout.write(`Found ${sites.length} site(s):\n\n`);
        for (const s of sites) {
            process.stdout.write(`  ${s.id}`);
            if (s.title)
                process.stdout.write(`  ${s.title}`);
            if (s.url)
                process.stdout.write(`  ${s.url}`);
            if (s.expiresAt)
                process.stdout.write(`  [expires ${s.expiresAt}]`);
            process.stdout.write("\n");
        }
    }
    catch (e) {
        die(formatError(e));
    }
}
async function cmdGet(positional) {
    const id = positional[0];
    if (!id)
        die("get: id argument is required. Usage: kayhost get <id>");
    const client = new KayhostClient();
    try {
        const html = await client.getSiteHtml(id);
        process.stdout.write(html);
        if (!html.endsWith("\n"))
            process.stdout.write("\n");
    }
    catch (e) {
        die(formatError(e));
    }
}
async function cmdDelete(positional) {
    const id = positional[0];
    if (!id)
        die("delete: id argument is required. Usage: kayhost delete <id>");
    const cfg = readConfig();
    if (!cfg.token)
        die("delete: no token configured. Run: kayhost login --token kayh_...");
    const client = new KayhostClient(cfg);
    try {
        await client.deleteSite(id);
        process.stdout.write(`Deleted site ${id}.\n`);
    }
    catch (e) {
        die(formatError(e));
    }
}
// ---------- Main ----------
async function main() {
    const { command, positional, flags } = parseArgs(process.argv);
    switch (command) {
        case "help":
        case "-h":
        case "--help":
            help();
            return;
        case "login":
            cmdLogin(positional, flags);
            return;
        case "whoami":
            cmdWhoami();
            return;
        case "config":
            cmdConfig();
            return;
        case "logout":
            cmdLogout();
            return;
        case "deploy":
            await cmdDeploy(positional, flags);
            return;
        case "list":
        case "ls":
            await cmdList();
            return;
        case "get":
            await cmdGet(positional);
            return;
        case "delete":
        case "rm":
            await cmdDelete(positional);
            return;
        default:
            die(`Unknown command: ${command}. Run \`kayhost --help\` for usage.`);
    }
}
main().catch((e) => die(formatError(e)));
//# sourceMappingURL=cli.js.map