---
name: composio-byo
description: Connect and use a user-owned Composio MCP server in Cetus.
---

# Composio BYO

Use this skill when the user wants to connect Composio, add SaaS tools through Composio, or troubleshoot Composio MCP access.

This is a bring-your-own Composio setup. The user owns their Composio account, API key, auth configs, connected accounts, quotas, and billing. Cetus should not use a shared Composio account or shared API key for this plugin.

## What the User Needs

Ask the user for these values, or help them find them in their Composio dashboard:

- Composio MCP URL, usually shaped like `https://backend.composio.dev/v3/mcp/...?...`
- Composio project API key, sent as the `x-api-key` header
- A short server name, such as `Composio`, `Composio Gmail`, or `Composio Work`

The user must authenticate the required Composio toolkits before using them. Composio creates connected accounts and stores the third-party credentials in the user's Composio project.

## Add to Cetus

Use Settings -> MCP, or the `manage_mcp` tool if available, with:

```json
{
  "name": "Composio",
  "transport": "http",
  "url": "https://backend.composio.dev/v3/mcp/YOUR_SERVER_ID?user_id=YOUR_USER_ID",
  "headers": {
    "x-api-key": "YOUR_COMPOSIO_API_KEY"
  },
  "enabled": true
}
```

After saving, test the MCP server. A successful test should list the tools that the Composio server exposes. Start a new conversation before relying on newly added tools, because Cetus freezes MCP configuration per conversation.

## Creating a Composio MCP URL

Composio supports creating MCP servers from the dashboard or SDK. For a single toolkit, Composio's documented flow is:

1. Create an auth config for the toolkit, such as Gmail, Linear, Notion, Slack, or GitHub.
2. Create an MCP server configuration with the toolkit and allowed tools.
3. Generate a user-specific MCP URL for a `user_id`.
4. Connect using the generated MCP URL and an `x-api-key` header.

Example shape from Composio docs:

```text
URL: https://backend.composio.dev/v3/mcp/YOUR_SERVER_ID?user_id=YOUR_USER_ID
Header: x-api-key: YOUR_COMPOSIO_API_KEY
```

## Operating Rules

Use the least consequential tool that can answer the request. Confirm before sending, posting, deleting, changing permissions, modifying records, inviting users, paying, refunding, purchasing, or changing calendar attendance.

If tools are missing, ask the user to add or authenticate the relevant toolkit in Composio, then re-test the MCP server in Cetus.
