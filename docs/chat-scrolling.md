# Chat scrolling and virtualization

The main chat page and the session detail dialog both use `ChatPane`, so they share the same scrolling policy.

## Regression and ownership

Upward wheel input during a streaming response used to fight three independent mechanisms:

1. A scroll event near the bottom could immediately re-enable following after an upward wheel had disabled it.
2. React Virtuoso 4.18.10's size/viewport follow paths could initiate seeks without consulting the `followOutput` callback's return value.
3. Its upward-scroll measurement compensation used a change in overall list height, including a growing final answer below the viewport. A real browser fixture reproduced this even with `followOutput={false}`.

`ChatVirtualList` now uses TanStack Virtual for row measurement and visible-range rendering. It allows scroll-position correction only when the changed row is wholly above the viewport. It disables native CSS scroll anchoring and cancels pending programmatic seek reconciliation when the reader scrolls away.

`bindChatTailScroll` owns automatic tail following. Upward wheel, touch or keyboard input releases it before the browser scrolls and cancels any queued animation frame. Offset changes alone do not establish user intent: initial row measurement and content collapse can change the offset too. Following resumes after a deliberate downward scroll reaches the 24 px bottom zone (allowing a last token to settle in the same frame), or an explicit send / return-to-bottom action. Search and turn navigation release following.

The controller observes content and viewport height even after streaming ends, so final markdown, image loading, activity collapse, and composer resizing use the same rules. The return-to-bottom button observes content growth while the reader is paused.

Reading positions retain both the scroll offset and measured sizes, keyed by conversation with a bounded in-memory LRU. The new list preserves the existing `data-find-row` search contract and keeps thinking/error indicators in the measured rows.

## Local Codex App reference

Read-only inspection on 2026-09-09 found the app at `/Applications/ChatGPT.app`, with bundle identifier `com.openai.codex` and version `26.730.61309`.

The bundled frontend does use custom turn virtualization. Evidence in `Contents/Resources/app.asar`:

- `webview/assets/thread-virtualizer-D5BSbZuA.js`: measured/estimated turn heights, prefix offsets, visible ranges with overscan, stable turn-key anchors, and height-change anchor adjustment.
- `webview/assets/conversation-source-D8TKw_vS.js`: consumes the virtualizer and scroll controller together.
- `webview/assets/thread-scroll-layout-CqUYT56o.js`: independent user-scroll and system-scroll handling, wheel/touch/keyboard intent, resize compensation, cancellable return-to-bottom animation, and `overflow-anchor: none`.

That version uses a reverse-flex scroll container and distance from the bottom. Cetus retains normal top-down scrolling for its existing search and navigation APIs. The shared principle is explicit ownership of user intent, virtualization, and layout compensation. No Codex code is copied into Cetus. These observations describe the inspected build, not every Codex release.

TanStack's public APIs used here are documented at https://tanstack.com/virtual/latest/docs/api/virtualizer (measurement correction, snapshots, and index navigation).

## Verification

Unit and related behavior tests:

```sh
bun test src/lib/chat-tail-scroll.test.js src/lib/message-search.test.js src/lib/assistant-segments.test.js src/lib/disclosure-state.test.js
pnpm lint
pnpm build
```

Real browser tests mount the production list and controller with 160 variable-height messages and output growing every 16 ms, without Tauri or user conversation data:

```sh
# Use installed Google Chrome, or install Playwright Chromium and omit the channel.
CETUS_TEST_BROWSER_CHANNEL=chrome pnpm test:chat-scroll

# WebKit provides coverage closer to macOS Tauri's webview engine.
pnpm exec playwright install webkit
CETUS_TEST_BROWSER=webkit pnpm test:chat-scroll
```

The browser suite covers upward wheel input during output, small upward nudges, appended rows, viewport shrink, explicit resume, deliberate return to bottom, restoring virtualized history, and height changes above versus below the visible message. It is not a substitute for an installed Tauri app smoke test.

Validation on 2026-09-09: 9 controller unit tests passed; related search/segmentation/disclosure tests passed; Chrome passed all 3 browser scenarios; WebKit passed all 3 scenarios across 3 consecutive runs (9 passes). Type checking and the production build passed. The build still reports existing CSS parser warnings for `::highlight`. The installed Cetus application has not been rebuilt/replaced as part of this change.
