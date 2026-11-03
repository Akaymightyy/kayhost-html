# kayhost-mcp

MCP server + CLI for [kayhost-html](https://kayhosthtml.zone.id) — deploy HTML sites, manage them, and edit with AI from any MCP-compatible client (Claude Code, Cursor, Codex, Antigravity, Windsurf, Cline, VS Code, GitHub Copilot).

```
npm i -g kayhost-mcp
```

## What it gives you

Once installed, your AI agent can:

- **Deploy HTML** — "deploy this folder to kayhost" → returns a live URL
- **List your sites** — "what sites do I have on kayhost?"
- **Delete a site** — "delete site abc123"
- **Fetch site HTML** — "show me the HTML of my portfolio site"
- **AI-edit elements** — "change the heading on my landing page to say 'Welcome'"
- **Clone a URL** — "clone https://example.com so I can edit it"
- **Upload media** — "upload logo.png to my media library"

All seven operations are exposed as MCP tools that any MCP client can call.

## Quick start

### 1. Install

```bash
npm i -g kayhost-mcp
```

Requires Node.js 18+. Verify with:

```bash
kayhost --help
```

### 2. (Optional) Log in

Without logging in, you deploy in **anonymous mode** — sites are tracked to a persistent `browserId` stored in `~/.kayhost/config.json`. This works fine for trying things out, but you can't delete sites and your deploys aren't tied to an account.

To associate deploys with your kayhost-html account:

1. Go to **https://kayhosthtml.zone.id → API Tokens → Create new token**
2. Copy the token (starts with `kayh_`)
3. Run:

   ```bash
   kayhost login --token kayh_xxxxxxxxxxxxxxxx
   ```

3. Verify:

   ```bash
   kayhost whoami
   # Logged in as: kayh_xxxx...xxxx
   # API base:     https://kayhosthtml.zone.id
   ```

### 3a. Use the CLI directly

```bash
# Deploy a single file
kayhost deploy index.html --title "My landing page" --ttl 30d

# Deploy with a custom slug
kayhost deploy portfolio.html --slug my-portfolio --ttl never

# List your sites
kayhost list

# Fetch raw HTML of a deployed site
kayhost get abc123 > site.html

# Delete a site (requires login)
kayhost delete abc123
```

### 3b. Use from your AI agent (MCP)

Pick your client below and follow the setup. After setup, you can ask things like:

- *"Deploy the current folder to kayhost and give me the link."*
- *"Make the hero heading on my kayhost site bigger and purple."*
- *"Clone example.com and re-deploy it as my own site."*

---

## Client setup

### Claude Code

Run in your terminal (one-time setup, available in every project):

```bash
claude mcp add --scope user kayhost -- npx -y kayhost-mcp@latest
```

Or, if you prefer a per-project setup, run inside the project directory:

```bash
claude mcp add kayhost -- npx -y kayhost-mcp@latest
```

Then in Claude Code: *"Deploy this folder to kayhost and give me the link."*

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "kayhost": {
      "command": "npx",
      "args": ["-y", "kayhost-mcp@latest"]
    }
  }
}
```

Restart Claude Desktop. The kayhost tools will appear in the tool palette.

### Cursor

`Settings → MCP → Add MCP server`:

- **Name:** `kayhost`
- **Type:** `stdio`
- **Command:** `npx -y kayhost-mcp@latest`

Or add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kayhost": {
      "command": "npx",
      "args": ["-y", "kayhost-mcp@latest"]
    }
  }
}
```

### Codex (OpenAI)

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.kayhost]
command = "npx"
args = ["-y", "kayhost-mcp@latest"]
```

### VS Code (with Cline or Continue)

For **Cline**: `Settings → MCP Servers → Add`:

```json
{
  "mcpServers": {
    "kayhost": {
      "command": "npx",
      "args": ["-y", "kayhost-mcp@latest"],
      "env": {}
    }
  }
}
```

### Antigravity

Add the MCP server via Antigravity's settings UI, or edit `~/.antigravity/mcp.json`:

```json
{
  "mcpServers": {
    "kayhost": {
      "command": "npx",
      "args": ["-y", "kayhost-mcp@latest"]
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "kayhost": {
      "command": "npx",
      "args": ["-y", "kayhost-mcp@latest"]
    }
  }
}
```

### GitHub Copilot Chat (VS Code)

Copilot's MCP support is still rolling out — see the [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers). Add the same `mcpServers` block to your VS Code `settings.json` under `chat.mcp.servers`.

---

## Environment variables (optional)

Both the CLI and MCP server honor these env vars — they override the config file:

| Variable | Purpose | Default |
|---|---|---|
| `KAYHOST_TOKEN` | Bearer token (`kayh_...`) | none (anonymous mode) |
| `KAYHOST_API_BASE` | API base URL | `https://kayhosthtml.zone.id` |

Useful for CI / ephemeral environments where you don't want a config file:

```bash
KAYHOST_TOKEN=kayh_xxx npx kayhost deploy ./dist --ttl 30d
```

---

## Config file

Located at `~/.kayhost/config.json`, mode `0600`. Schema:

```json
{
  "apiBaseUrl": "https://kayhosthtml.zone.id",
  "token": "kayh_xxxxxxxxxxxxxxxx",
  "defaultTtl": "7d",
  "browserId": "94188824-55f5-4595-b425-9b5d8c1246f4"
}
```

Inspect with `kayhost config`. Token is redacted in the output.

---

## Tools reference

All seven MCP tools exposed by this server:

### `kayhost_deploy`

Deploy an HTML page to kayhost and get a live HTTPS shareable URL.

| Param | Type | Required | Description |
|---|---|---|---|
| `html` | string | yes | Full HTML document |
| `title` | string | no | Page title (max 200 chars) |
| `ttl` | `"1d"` \| `"7d"` \| `"30d"` \| `"never"` | no | Time-to-live. Defaults to config's `defaultTtl` (7d) |
| `slug` | string | no | Custom URL slug, 3-30 chars: lowercase, numbers, hyphens |

### `kayhost_list_sites`

List all sites owned by the authenticated token (or, in anonymous mode, all sites tracked to this machine's `browserId`). No parameters.

### `kayhost_delete_site`

Delete a deployed site by id. **Bearer-token mode only** — anonymous deploys can only be removed by waiting for their TTL to expire.

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Site id (use `kayhost_list_sites` to find it) |

### `kayhost_get_site`

Fetch the raw HTML of a deployed kayhost site by its id.

| Param | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Site id |

### `kayhost_ai_edit`

Edit a specific element in an HTML page using AI. Returns the full modified HTML. Chain with `kayhost_deploy` to publish.

| Param | Type | Required | Description |
|---|---|---|---|
| `html` | string | yes | Current full HTML of the page |
| `selector` | string | yes | CSS selector for the element to edit |
| `instruction` | string | yes | Natural-language change description (max 2000 chars) |
| `apiKey` | string | no | BYOK API key (Gemini / OpenAI / Anthropic) |
| `provider` | `"gemini"` \| `"openai"` \| `"anthropic"` | no | Provider hint when `apiKey` is supplied |

### `kayhost_clone`

Fetch a live web page's HTML (and optionally linked pages on the same domain) so it can be edited and re-deployed. Server-side SSRF-protected and respects robots.txt.

| Param | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full http(s) URL of the page to clone |
| `crawl` | boolean | no | If true, also crawl up to 10 linked pages on the same domain. Default `false`. |

### `kayhost_upload_media`

Upload an image file from disk to kayhost's Cloudinary media library. Returns a permanent URL.

| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Absolute path to the image file (PNG/JPG/GIF/WebP/SVG) |

---

## Development

```bash
git clone https://github.com/Akaymightyy/kayhost-html.git
cd kayhost-html/packages/kayhost-mcp
npm install
npm run build
npm run start:mcp   # starts the MCP server (stdio)
npm run start:cli   # runs the CLI
```

### Project layout

```
kayhost-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── mcp-server.ts         # MCP server entry — stdio transport
│   ├── cli.ts                # CLI entry — kayhost command
│   ├── api-client.ts         # HTTP client wrapping REST endpoints
│   ├── tools.ts              # MCP tool definitions + zod schemas
│   ├── config.ts             # ~/.kayhost/config.json read/write
│   └── zod-to-json-schema.ts # zod → JSON Schema bridge
├── examples/
│   └── sample-site.html      # for testing deploy
└── README.md
```

### Publishing

```bash
npm version patch
npm publish
```

The `prepublishOnly` script runs `tsc` so the `dist/` is always up to date.

---

## FAQ

**Q: Do I need a kayhost-html account?**
A: No. Without a token, the CLI/MCP server uses anonymous mode — sites are tracked to a persistent `browserId` in `~/.kayhost/config.json`. To delete sites or see them in your web dashboard, log in with `kayhost login --token kayh_...`.

**Q: Does this work with self-hosted kayhost-html?**
A: Yes. Set `KAYHOST_API_BASE=https://your-instance.example.com` or run `kayhost login --token kayh_... --api-base https://your-instance.example.com`.

**Q: Why does the User-Agent look like a browser?**
A: kayhost-html's edge layer 403s non-browser UAs as an anti-bot measure. The CLI sends a Chrome UA with `kayhost-mcp/0.1.0` appended for log attribution. The proper fix is to allowlist `kayhost-mcp/*` UAs on the kayhost-html server side.

**Q: Can I deploy multi-page sites?**
A: Not yet via this package — the current kayhost-html REST API only supports single-page deploys. Multi-page directory deploy is on the roadmap (see the wacz-archive-breakdown doc, Tier S item S3).

**Q: How are tokens stored?**
A: In `~/.kayhost/config.json` with file mode `0600`. Never sent anywhere except the kayhost-html API as a `Bearer` header.

---

## License

MIT © Akaymightyy
