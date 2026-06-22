# Asset Release Review

Tracked docs assets intended for public release:

| Asset | Type / dimensions | Release note |
| --- | --- | --- |
| `docs/logo.svg` | SVG | Product logo. |
| `docs/logo.png` | PNG 1024x1024 | Product logo render. |
| `docs/agent-loop.excalidraw` | Excalidraw JSON | Source for the agent-loop diagram. Reviewed: no private data. |
| `docs/agent-loop.png` | PNG 4720x2528 | Agent-loop diagram render. Reviewed: renamed Cetus title, no private data. |
| `docs/screenshot-chat.png` | PNG 2000x1255 | Product screenshot. Reviewed: empty state, no private data found. |
| `docs/screenshot-kanban.png` | PNG 2000x1255 | Product screenshot. Reviewed: sample task only, no private data found. |
| `docs/screenshot-automations.png` | PNG 2000x1255 | Product screenshot. Reviewed: sample automation only, no private data found. |
| `docs/screenshot-launcher.png` | PNG 1600x392 | Product screenshot. Reviewed: generic launcher content only, no private data found. |
| `docs/screenshot-meetings.png` | PNG 2000x1294 | Product screenshot. Reviewed: stale pre-rename copy was replaced, no private data found. |
| `docs/screenshot-screen-history.png` | PNG 2000x1255 | Product screenshot. Reviewed: product example content only, no private data found. |
| `docs/screenshot-settings.png` | PNG 2000x1255 | Product screenshot. Reviewed: settings copy only, no private data found. |
| `docs/voice-hud.jpeg` | JPEG 2000x1500 | Product photo. Reviewed: no readable private data found. |

Automated scans can catch embedded text strings and filenames, but they cannot
prove screenshots are visually free of private data. Before a public launch,
review each product screenshot at full size for:

- real names, emails, calendars, chats, or documents
- API keys, paths, branch names, private repo names, or customer data
- third-party copyrighted material beyond incidental app chrome
- unreleased product claims that should not ship in README imagery
