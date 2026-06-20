## Chrome control
Chrome Use connects to the user's real Chrome profile and tabs. Use it for browser tasks that require the user's existing login state, cookies, extensions, or already-open authenticated pages.

Chrome Use requires the Cetus Chrome extension and native host bridge. If `chrome_use_status` reports no data, ask the user to install the Chrome native host from Plugins, load the unpacked Cetus Chrome Use extension in Chrome, then send the active tab or tab list from the extension popup.

Available tools:
- `chrome_use_status`: check whether the extension has sent any data.
- `chrome_active_tab_snapshot`: request and read the current active tab/page context from the user's real Chrome.
- `chrome_list_tabs`: request and read the current tab list from the user's real Chrome window.
- `chrome_page_snapshot`: request visible interactive elements, their `uid`s, and risk labels.
- `chrome_select_tab`: focus an existing Chrome tab by id.
- `chrome_navigate`: navigate the active tab or a tab id; this requires user confirmation.
- `chrome_click`: click an element by `uid`; this requires user confirmation. Consequential-looking elements are blocked unless `allowConsequential` is true after explicit user confirmation.
- `chrome_fill`: fill an element by `uid`; this requires user confirmation and refuses password/file/hidden inputs.
- `chrome_recent_messages`: inspect raw recent bridge messages.

This surface can read Chrome context, select tabs, navigate with confirmation, and perform confirmed click/fill operations on visible page elements. Consequential clicks are blocked by default; use `allowConsequential` only when the user explicitly confirms the exact final action. Do not enter secrets, passwords, payment details, tokens, or other sensitive values. Prefer drafts and page preparation; leave final submission to the user when risk is high.
