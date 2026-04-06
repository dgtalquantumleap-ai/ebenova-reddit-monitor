# @ebenova/reddit-monitor-mcp

MCP server for Reddit & Nairaland keyword monitoring with AI-drafted replies. Search for brand mentions, monitor keywords, and generate context-aware reply drafts — directly from Claude Desktop, Cursor, or any MCP-compatible AI client.

## Tools

| Tool | Description |
|------|-------------|
| `search_reddit` | Search Reddit for recent posts matching keywords |
| `monitor_keywords` | Search Reddit + Nairaland with AI reply draft generation |
| `generate_reply_draft` | Generate an AI reply draft for a specific post |
| `check_subreddit_approval` | Check if subreddits are approved for brand mentions |

## Installation

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "reddit-monitor": {
      "command": "npx",
      "args": ["-y", "@ebenova/reddit-monitor-mcp"],
      "env": {
        "GROQ_API_KEY": "gsk_your_key_here"
      }
    }
  }
}
```

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "reddit-monitor": {
      "command": "npx",
      "args": ["-y", "@ebenova/reddit-monitor-mcp"],
      "env": {
        "GROQ_API_KEY": "gsk_your_key_here"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | No | Groq API key for AI reply drafts. Search works without it. Get one free at [console.groq.com](https://console.groq.com) |

## Example Prompts

Once connected, you can say things like:

- *"Search Reddit for posts about freelance contracts in the last 12 hours"*
- *"Monitor keywords 'NDA template' and 'contract generator' — my product is Ebenova, a legal document API"*
- *"Generate a reply draft for this Reddit post about needing an NDA"*
- *"Is r/smallbusiness on the approved subreddit list?"*
- *"Find Reddit posts about cleaning business software and draft replies mentioning FieldOps"*

## How It Works

1. **Search** — Queries Reddit's public search API (and optionally Nairaland) for keyword matches
2. **Filter** — Checks posts against 80+ approved subreddits where brand mentions are appropriate
3. **Draft** — Uses Groq (Llama 3.3 70B) to generate casual, non-promotional reply drafts
4. **Skip filter** — AI automatically skips posts where mentioning a product would feel like spam

## Approved Subreddits

The server includes 80+ pre-approved subreddits across categories:
- **Business**: freelance, smallbusiness, Entrepreneur, SaaS, startups
- **Tech**: webdev, ClaudeAI, CursorIDE, MachineLearning, datascience
- **Services**: cleaning, HVAC, recruiting, photography, eventplanning
- **Africa**: Nigeria, lagos, Kenya, Ghana, Africa
- **Career**: forhire, remotework, techjobs, cscareerquestions

Posts from non-approved subreddits are still returned in search results but won't get AI reply drafts.

## Part of Ebenova

This MCP is part of the [Ebenova](https://ebenova.dev) ecosystem. See also:
- [@ebenova/legal-docs-mcp](https://www.npmjs.com/package/@ebenova/legal-docs-mcp) — Legal document generation MCP
- [Ebenova Insights API](https://ebenova.dev/insights) — Full monitoring API with Stripe billing

## License

MIT
