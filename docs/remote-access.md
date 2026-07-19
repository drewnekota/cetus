# Cetus Remote

Cetus Remote turns a phone browser into an authenticated companion for the Cetus instance running on your Mac. The Mac remains the only execution host: conversations, credentials, workspaces, Codex, Claude Code, and the built-in runtime never move to the phone.

## What the mobile client supports

- List current and archived conversations.
- Open full history and follow live text, thinking, and tool progress.
- Send text or up to four images, including while a turn is running.
- Create and rename conversations.
- Switch between Cetus, Codex, and Claude Code.
- Stop a running turn.
- Archive and restore conversations.
- Answer Codex and Claude Code approval or user-input requests.

Deliberately excluded from the remote API: API keys, Cetus settings, arbitrary terminal control, local file browsing, screen history, and destructive conversation deletion.

## Setup

1. Install Tailscale on the Mac and phone and sign both into the same tailnet.
2. In Cetus, open **Settings → Remote access**.
3. Enable **Mobile companion**. Cetus starts an HTTP server bound only to `127.0.0.1:17382` and runs:

   ```sh
   tailscale serve --bg --yes http://127.0.0.1:17382
   ```

4. Scan the QR code with the phone. It creates an authenticated HttpOnly, Secure, SameSite session.
5. Add the page to the phone's home screen if desired.

The stable URL is the Mac's MagicDNS HTTPS name, such as `https://my-mac.example.ts.net`. Tailscale Serve persists its proxy configuration across restarts. Cetus's local server still follows the Remote access toggle.

If automatic Serve setup fails, the Settings page shows the CLI error. Check `tailscale status`, ensure HTTPS is enabled for the tailnet, then run the command above manually. Current Serve syntax is documented by [Tailscale](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Security model

Access requires both Tailscale ACL access and a Cetus pairing cookie containing the current high-entropy random access secret. API requests also require a Cetus-specific header and use a `SameSite=Strict` cookie. The server binds only to loopback; it is never exposed directly to Wi-Fi or a public interface.

Use **Revoke phones** to rotate the secret, restart the Remote server, and invalidate every previously paired browser. Treat the pairing link like a password; anyone who obtains it can control the exposed conversation features.

## Architecture

```text
Phone browser
  HTTPS / WebSocket
        │
        ▼
Tailscale Serve + tailnet ACLs
        │
        ▼
127.0.0.1:17382
Cetus Remote (Axum)
  ├─ authenticated conversation API
  ├─ app-event WebSocket bridge
  └─ embedded mobile client
        │
        ▼
Cetus AppState / Store / runtimes
```

The WebSocket carries the same normalized `app-event` stream used by the Tauri window. History remains authoritative: after a turn completes, the mobile client reloads the conversation snapshot rather than treating transient deltas as durable storage.
