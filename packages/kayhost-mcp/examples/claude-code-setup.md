# Setup prompt for Claude Code

Copy-paste this entire block into Claude Code to set up kayhost-mcp in one shot:

```
Set up kayhost-mcp so you can deploy HTML to https://kayhosthtml.zone.id from this chat.

Steps:
1. Run: claude mcp add --scope user kayhost -- npx -y kayhost-mcp@latest
2. Confirm by listing MCP servers: claude mcp list
3. Verify the kayhost server shows up with status "connected"
4. Tell me the seven kayhost_* tools that are now available to you

Once that's done, I'll ask you to deploy sites by saying things like
"deploy this folder to kayhost". You should use the kayhost_deploy tool
and return the live URL to me.

If I haven't logged in yet, deploys will be anonymous (tracked to a
browserId in ~/.kayhost/config.json). I can run `kayhost login --token kayh_...`
later to associate them with my account.
```

## What Claude Code will do

After running the setup prompt, Claude Code will:

1. Register the MCP server globally (available in every project)
2. Verify it can connect and list the 7 tools
3. Be ready to call `kayhost_deploy`, `kayhost_list_sites`, `kayhost_delete_site`,
   `kayhost_get_site`, `kayhost_ai_edit`, `kayhost_clone`, `kayhost_upload_media`
   whenever you ask

## Example prompts to try after setup

- *"Deploy the current folder to kayhost and give me the link."*
- *"Make a simple landing page for a coffee shop called 'Brew & Co' and deploy it to kayhost."*
- *"Clone https://example.com and re-deploy it as my own site on kayhost."*
- *"What sites do I have on kayhost?"*
- *"Change the heading on my kayhost site abc123 to say 'Welcome' and re-deploy it."*
- *"Upload ./logo.png to my kayhost media library and give me the URL."*

## Removing the integration

```bash
claude mcp remove kayhost
```

Or for a project-scoped integration:

```bash
claude mcp remove kayhost --scope project
```
