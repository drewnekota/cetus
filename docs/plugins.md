# Cetus Plugins

A Cetus plugin is a capability package for the agent. It can contribute prompt
guidance, Agent Skills, MCP servers, pi extensions, and metadata for app-style
integrations. The shape intentionally mirrors Codex-style plugins while keeping
native control behind Cetus-owned trust boundaries.

## Layout

```text
my-plugin/
  .codex-plugin/plugin.json
  .mcp.json              # optional
  .app.json              # optional metadata
  skills/                # optional: one or more Agent Skills
  prompts/system.md      # optional
  extensions/*.ts        # optional pi extensions
```

`plugin.json` accepts either `id` or Codex-style `name` as the stable plugin id.

```json
{
  "name": "example.plugin",
  "displayName": "Example Plugin",
  "version": "0.1.0",
  "description": "Adds example tools and guidance.",
  "skills": "./skills",
  "mcpServers": "./.mcp.json",
  "apps": "./.app.json",
  "systemPrompt": "./prompts/system.md",
  "interface": {
    "displayName": "Example Plugin",
    "shortDescription": "Adds example tools and guidance.",
    "capabilities": ["Read", "Write"],
    "riskLevel": "medium"
  }
}
```

`mcpServers` may be an inline object or a path to a standard MCP config:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}
```

`skills` can point to a single skill folder containing `SKILL.md`, or to a
folder containing multiple skill folders:

```text
skills/
  code-review/SKILL.md
  report-writing/SKILL.md
```

## Loading Model

Plugins are scanned from:

- built-ins: `<pi-install>/cetus-plugins`
- user imports: `<app_data>/plugins`

Enabled plugin state is persisted in app settings. Like Skills and Connectors,
plugin contributions are frozen per conversation when the conversation's agent
directory is first materialized, so toggles affect new conversations and do not
mutate existing chats.

## Security Boundaries

Third-party plugins can contribute skills, prompt guidance, MCP servers, and pi
extensions. They cannot claim Cetus built-in browser/computer control surfaces
or request native capabilities.

Native capabilities are reserved for built-in trusted plugins. The built-in
Computer Use plugin declares:

```json
[
  "macos.accessibility",
  "screen.capture",
  "hostTunnel.cua",
  "hostTunnel.agentStep"
]
```

`coreExtensionOverrides` is also built-in only. It lets Cetus migrate a core
extension into an internal plugin without loading the legacy extension twice.

## Built-In Agent Control Plugins

Browser Use is implemented as `cetus.browser-use`. It contributes a
`chrome-devtools` MCP server through `.mcp.json` and prompt guidance through
`prompts/system.md`. It uses a Cetus-managed Chrome profile and is the right
surface for local dev servers, public pages, and temporary browser sessions that
do not need the user's normal Chrome login state.

The user-facing Browser tab is the visible review surface for this plugin. By
default, typed URLs open in a Cetus-owned child WebView embedded in the right
workspace panel, so normal sites are not blocked by iframe embedding rules. The
Browser tab still offers an optional inline preview canvas for local or
embeddable pages, but that preview is not the default browsing path. Both the
inline canvas and the embedded WebView support coordinate-based annotations that
flow back into the active conversation as `@Browser` feedback. Browser does not
inherit the user's normal Chrome tabs, cookies, extensions, or login state.

The Browser Use plugin also contributes `browser_open_visible`, a host-tunneled
tool that opens or focuses a URL in that right-side Browser tab. DOM automation
still uses the Chrome DevTools MCP tools; the visible Browser is the shared
review surface the user can inspect and annotate.

In the desktop UI, Browser lives in the right workspace panel rather than as a
left-sidebar destination. `Cmd+B` toggles the workspace panel, `Cmd+T` opens a
new Browser tab there, and `Cmd+W` closes the active workspace tab instead of
closing the app window. The same workspace panel can also hold Files and
Terminal tabs.

Computer Use is implemented as `cetus.computer-use`. It contributes the
`computer-use.ts` pi extension, prompt guidance, and trusted native capability
metadata for the host-tunneled macOS Accessibility runtime. The primary control
path is still Accessibility indices because they are more precise and auditable
than pixels. For AX-blind or visually ambiguous screens, `computer_observe` can
opt into `includeScreenshot: true`, returning the current screen image to the
model alongside the numbered element list.

## Surface Selection

Prefer the most structured surface that can do the job:

1. Use a purpose-built plugin or MCP server when one exists.
2. Use Browser Use for local dev servers, public pages, and isolated temporary
   browser sessions.
3. Use Computer Use for native desktop apps, cross-app GUI workflows, or work
   that no structured plugin/MCP/browser surface can reach.
4. Stop for user confirmation before sending, submitting, purchasing,
   publishing, deleting, authenticating, or changing account/security settings.
