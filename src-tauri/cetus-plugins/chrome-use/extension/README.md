# Cetus Chrome Use Extension

This unpacked Chrome extension is the browser-side half of `cetus.chrome-use`.
It runs inside the user's real Chrome profile, so it can see already-open tabs,
logged-in pages, cookies, and extension context after the user explicitly loads
and approves it.

Current status:

1. In Cetus, open Automation > Plugins.
2. Install the Chrome native host and run "Test host".
3. Open `chrome://extensions` from the Chrome Use plugin card.
4. Enable Developer mode.
5. Choose "Load unpacked".
6. Select this `extension` folder.

Manual install path:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose "Load unpacked".
4. Select this `extension` folder.

The extension has a fixed id:

```text
bellidpjmeaomkdjbhkcaokmeflanpmc
```

The extension already collects active-tab and tab-list context and sends it to a
Chrome Native Messaging host named `com.cetus.chrome_use`. Cetus can install
that native host manifest from the Plugins page. When the Chrome Use plugin is
enabled, the agent can request active-tab snapshots, list and select tabs,
navigate after confirmation, and click/fill visible page elements with sensitive
fields and consequential controls guarded.
