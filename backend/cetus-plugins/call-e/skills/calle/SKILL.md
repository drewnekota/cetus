---
name: calle
description: Set up and use CALL-E for real outbound phone calls through the CALL-E CLI and MCP tools.
---

# CALL-E

Use this skill when the user wants the agent to make, plan, check, or set up real phone calls through CALL-E.

## Setup

CALL-E requires Node.js with `npm` and `npx`, browser access for authorization, and a local token cache.

Check the CLI:

```bash
npx -y @call-e/cli --help
```

Start login:

```bash
npx -y @call-e/cli auth login
```

If the environment cannot open a browser, show the user the authorization link:

```bash
npx -y @call-e/cli auth login --start-only --no-browser-open
```

After the user confirms authorization is complete, finish the pending login:

```bash
npx -y @call-e/cli auth login --no-browser-open
```

Verify without placing a call:

```bash
npx -y @call-e/cli auth status
npx -y @call-e/cli mcp tools
```

The tool list should include `plan_call`, `run_call`, and `get_call_run`.

## Calling Workflow

Never start a call during setup or verification.

For real calls, use a two-step flow:

1. Plan the call with the recipient phone number, goal, language, region, and timezone when known.
2. Show the plan to the user and ask for explicit confirmation before running the call.
3. Run the call only after confirmation.
4. Check the result and summarize status, transcript, outcome, and next steps.

Do not invent missing phone numbers or personal details. Ask for the missing information instead.
