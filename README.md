# Reddit Brand Monitor

Monitor Reddit and Nairaland for keyword mentions, with AI-drafted replies ready to post.
Self-hosted, no Reddit API key required.

## Quick Start

```bash
cp .env.example .env   # set GROQ_API_KEY for AI drafts (optional)
npm install
npm start
```

## MCP Server (for Claude, Cursor, etc.)

This project includes an MCP server that exposes Reddit monitoring as tools for AI agents.

### Tools Available

| Tool | Description |
|------|-------------|
| `search_reddit` | Search Reddit for recent posts matching given keywords |
| `monitor_keywords` | Search Reddit + Nairaland with AI reply drafts |
| `generate_reply_draft` | Generate an AI reply draft for a specific Reddit post |
| `check_subreddit_approval` | Check if a subreddit is approved for brand mentions |

### Usage with Claude Desktop

Add to your Claude Desktop config (`~/.config/claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "reddit-monitor": {
      "command": "node",
      "args": ["/absolute/path/to/reddit-monitor/mcp-server.js"],
      "env": {
        "GROQ_API_KEY": "your-groq-api-key"
      }
    }
  }
}
```

### Usage with Cursor

Settings → Features → MCP Servers → Add New:
- **Command:** `node`
- **Args:** `/absolute/path/to/reddit-monitor/mcp-server.js`
- **Environment:** `GROQ_API_KEY=your-key` (optional)

### Usage with Smithery

Listed on [Smithery.ai](https://smithery.ai) — install via:
```
npx -y @smithery/cli install reddit-brand-monitor
```

### Example: Ask Claude

> "Search Reddit for recent mentions of 'freelance contract' and draft replies for approved subreddits"
>
> "Is r/freelance approved for brand mentions?"

## Deploy to Railway

Push to GitHub, connect repo to Railway, add environment variables.
Runs 24/7 for ~$5/month (or free tier if under usage limits).

## How it works

- **API Server** (`api-server.js`): RESTful HTTP endpoints for managing monitors
- **V1 Monitor** (`monitor.js`): Single-tenant keyword polling with email digest
- **V2 Monitor** (`monitor-v2.js`): Multi-tenant with Redis, semantic search, per-monitor config
- **Apify Actor** (`apify-actor.js`): One-shot invocation for Apify platform
- **MCP Server** (`mcp-server.js`): AI agent tools via stdio transport

All search modes use Reddit's public JSON API — no API key required.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GROQ_API_KEY` | AI reply draft generation (Llama 3.3 70b) | No (drafts skipped if missing) |
| `RESEND_API_KEY` | Email alert delivery | No (for cron workers) |
| `ALERT_EMAIL` | Digest email recipient | No |
| `UPSTASH_REDIS_REST_URL` | Redis for multi-tenant state | No (V2 only) |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth token | No (V2 only) |
