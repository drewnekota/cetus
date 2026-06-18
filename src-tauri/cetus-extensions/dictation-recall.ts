/**
 * cetus dictation-recall — lets the agent read the user's voice-dictation history.
 *
 * When the user enables "dictation history" (Voice settings), cetus appends every
 * finalized transcript to a JSON store and exports its path as
 * `CETUS_DICTATION_PATH` (see src-tauri/src/transcripts.rs + lib.rs). This tool
 * reads that same file so the agent can recall what the user recently spoke —
 * useful context for follow-ups, summaries, or "what did I just dictate".
 *
 * Gated by the user's master switch: if history is off, the tool returns nothing
 * (the toggle governs the agent's read access too, by design).
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

interface Entry {
  id?: string;
  text?: string;
  target?: string;
  createdAt?: number;
}
interface Store {
  enabled?: boolean;
  entries?: Entry[];
}

function load(): Store {
  const path = process.env.CETUS_DICTATION_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "recall_dictation",
    label: "Recall dictation history",
    description:
      "Read the user's recent voice-dictation transcripts — what they spoke " +
      "into the microphone (composer, quick panel, or system-wide dictation). " +
      "Useful as context for what the user recently said or asked by voice. " +
      "Returns most-recent-first. Empty when the user hasn't enabled dictation " +
      "history.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: "Max entries to return (default 20, max 200)." }),
      ),
      query: Type.Optional(
        Type.String({ description: "Optional case-insensitive substring filter." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const store = load();
      if (!store.enabled) {
        return {
          content: [
            { type: "text", text: "Dictation history is off (the user hasn't enabled it)." },
          ],
        };
      }
      const all = (store.entries ?? []).filter(
        (e) => e && typeof e.text === "string" && e.text.trim().length > 0,
      );
      const q = typeof params.query === "string" ? params.query.toLowerCase().trim() : "";
      const limit =
        typeof params.limit === "number" && params.limit > 0
          ? Math.min(Math.floor(params.limit), 200)
          : 20;
      let list = q ? all.filter((e) => (e.text as string).toLowerCase().includes(q)) : all;
      list = list.slice(-limit).reverse(); // most recent first
      if (list.length === 0) {
        return {
          content: [
            { type: "text", text: q ? `No dictation matching "${q}".` : "No dictation history yet." },
          ],
        };
      }
      const lines = list.map((e) => {
        const ts = e.createdAt ? new Date(e.createdAt).toISOString() : "";
        return ts ? `[${ts}] ${e.text}` : (e.text as string);
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
