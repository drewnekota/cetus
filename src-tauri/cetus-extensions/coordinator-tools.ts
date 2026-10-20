/**
 * cetus coordinator-tools — makes one conversation per folder "Cetus": the
 * conversation the user talks to in the Threads view.
 *
 * Cetus does small things itself (it keeps every normal tool) and hands long,
 * parallel, or runtime-specific work to threads: ordinary Cetus sessions in
 * the same folder, on whichever runtime (Cetus / Claude Code / Codex). Its
 * only thread tools are thread_start and thread_send. Nothing is reported
 * back into this conversation: the user reads each thread's status and reply
 * on its card in the Threads view.
 *
 * Inert unless the pi was spawned with CETUS_COORDINATOR=1 (set by
 * `AppState::pi_for` from the coordinator registry), so ordinary chats never
 * see these tools or the brief. Other runtimes reach the same operations
 * through `cetus thread …`.
 *
 * Sessions are owned by the frontend, so each tool tunnels its request through
 * a sentinel `ctx.ui.input` (title "__cetus_coordinator__") that Rust surfaces
 * as `AppEvent::CoordinatorToolRequest`; the frontend answers with
 * `extension_ui_respond`. Keep the op and field names in sync with
 * src/lib/coordinator.ts.
 */
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callHost, HOST_TUNNELS, toolResult, type HostTunnelContext } from "./bridge/protocol";

const brief = (instructions: string) => `

# You are Cetus

Language: always reply in the language of the user's own latest message (if they wrote Chinese, reply in Chinese), even though this brief and thread output are in English.

In this conversation you are Cetus, the agent the user talks to about the folder you are in. The user sends you a stream of requests here. You do small things yourself and run bigger work as threads: separate agent sessions in the same folder, each with its own context. The user follows each thread on its own card in the Threads view and opens it to read the result; nothing a thread does comes back to this conversation.

For each message from the user, decide where it goes:
- A question, or a small change you can finish in a few tool calls (look something up, a one-line fix, run one command): do it yourself, right here. Don't start a thread for it.
- Bigger work (a feature, a multi-file change, investigating a bug, research, writing a document, anything that will take more than a few minutes): call thread_start. One thread per independent task; several unrelated tasks in one message become several threads, which run in parallel.
- Work the user's standing instructions (below, when present) assign to a particular runtime or model: always a thread on that runtime, even when it's small.
- A follow-up, correction, or extra detail for work a thread is already doing: call thread_send on that thread (by the id thread_start returned) instead of starting a new one.
Don't edit files a running thread is working on; send the change to that thread instead.
${instructions}
Writing a task for thread_start: the thread can't see this conversation. Start with the user's request in their own words, quoted verbatim, then add only the context it needs from this conversation (decisions, constraints, file paths). Don't reinterpret or shrink what the user asked for.

After you start or message a thread, reply with one short sentence naming the thread, and stop. Don't wait for it, don't check on it, and don't summarize or guess at its result: the user reads that in the thread itself. If the user asks how a thread went, point them to its card.

Choosing a runtime and model for thread_start: when the user's message or their standing instructions name a runtime or model for this kind of work, passing that \`runtime\` and \`model\` is required. Pass only what was named: never pick a model yourself (a runtime named without a model means leave \`model\` unset, and the runtime's default is used). If thread_start rejects a model, it lists the available ones; pick from that list.

Keep every reply short.`;

/** The user's standing instructions, re-read every turn so edits in Cetus
 *  apply without restarting the coordinator. Placed right after the routing
 *  rules: appended at the end of the prompt, Flash read them but still left
 *  thread_start's runtime/model unset. */
function userInstructions(): string {
  const path = process.env.CETUS_COORDINATOR_INSTRUCTIONS;
  if (!path) return "";
  let text = "";
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
  if (!text) return "";
  return `
## The user's standing instructions

They override the defaults in this brief. Apply them to every thread_start: if they say which runtime or model a kind of work should use, pass \`runtime\` and \`model\` accordingly on that call.

<standing-instructions>
${text}
</standing-instructions>
`;
}

function hostCall(exCtx: unknown, payload: unknown) {
  // Starting a thread can wait on a cold pi spawn; give it more than the default.
  return callHost(exCtx as HostTunnelContext, HOST_TUNNELS.coordinator, payload, {
    timeout: 120_000,
  });
}

export default function (pi: ExtensionAPI) {
  if (process.env.CETUS_COORDINATOR !== "1") return;

  pi.registerTool({
    name: "thread_start",
    label: "Start thread",
    description:
      "Start a new thread: a full agent session in this folder that works on one task. " +
      "Returns the thread's id. The user follows it on its card; nothing is reported back " +
      "here. The thread can't see this conversation, so the task must stand on its own.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "Everything the thread needs: the user's request quoted verbatim first, then any " +
          "context from this conversation it can't otherwise know.",
      }),
      title: Type.Optional(
        Type.String({ description: "Short label for the thread (3-6 words)." }),
      ),
      runtime: Type.Optional(
        Type.String({
          description:
            "Agent that runs the thread: 'cetus', 'claude-code' or 'codex'. Leave unset " +
            "unless the user or their standing instructions ask for a specific one; the " +
            "user's default is used.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model for a 'claude-code' or 'codex' thread, by id or name (e.g. 'opus', " +
            "'Claude Opus 5.5'). Only a model the user or their standing instructions " +
            "named; otherwise leave unset for the runtime's default.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, exCtx) {
      return toolResult(await hostCall(exCtx, { op: "start", ...params }));
    },
  });

  pi.registerTool({
    name: "thread_send",
    label: "Message thread",
    description:
      "Send a follow-up, correction, or the user's answer to an existing thread. If the " +
      "thread is busy the message is queued and delivered when its current turn ends.",
    parameters: Type.Object({
      thread_id: Type.String({ description: "Id thread_start returned." }),
      message: Type.String({ description: "What to tell the thread." }),
    }),
    async execute(_id, params, _signal, _onUpdate, exCtx) {
      return toolResult(await hostCall(exCtx, { op: "send", ...params }));
    },
  });

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + brief(userInstructions()) };
  });
}
