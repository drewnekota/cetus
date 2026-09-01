// Smart routing (experimental): while the user types into an entry composer
// (hero / new-task dialog / quick launcher), a debounced utility-model call
// decides where the message should land — continue a recent conversation, or
// start a new one in the most relevant workspace. The decision is shown as a
// chip BEFORE send (click to override), so a wrong guess costs one click, not
// a polluted session. Uncertain → always "new": wrongly continuing an old
// session (and running in its repo) is far more expensive than a spare chat.

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/tauri";
import type { Conversation, ModelId, SmartRouteTarget } from "@/lib/types";
import type { ConvPreview } from "@/lib/chat-store";

// ---- Feature switch (Settings → General; shared across windows) -----------
// Off hides the whole affordance — no chips, no routing calls on any surface.

const TOGGLE_EVENT = "cetus:smartRoutingChanged";
const FEATURE_KEY = "cetus:smartRoutingFeature";

function subscribeToggle(cb: () => void): () => void {
  window.addEventListener(TOGGLE_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(TOGGLE_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

export function getSmartRoutingFeatureEnabled(): boolean {
  try {
    return localStorage.getItem(FEATURE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSmartRoutingFeatureEnabled(on: boolean) {
  try {
    localStorage.setItem(FEATURE_KEY, on ? "on" : "off");
  } catch {}
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

export function useSmartRoutingFeatureEnabled(): boolean {
  return useSyncExternalStore(
    subscribeToggle,
    getSmartRoutingFeatureEnabled,
    () => true,
  );
}

// ---- Candidates -----------------------------------------------------------

export interface RouteCandidate {
  id: string;
  title: string;
  workspaceDir: string;
  /** Epoch ms of last activity, for the "Nm ago" hint in the prompt. */
  updatedAt: number;
  /** Last assistant reply, whitespace-collapsed and capped — optional. */
  preview?: string;
}

/** How many recent conversations the model gets to choose from. */
const MAX_CANDIDATES = 20;

/** Trim the roster to what the routing prompt needs. `previews` (the board's
 *  IDB card cache) is optional — titles alone still route decently. */
export function buildRouteCandidates(
  conversations: Conversation[],
  previews?: Record<string, ConvPreview>,
): RouteCandidate[] {
  return conversations
    .filter((c) => !c.archivedAt)
    .slice(0, MAX_CANDIDATES)
    .map((c) => ({
      id: c.id,
      title: c.title.trim(),
      workspaceDir: c.workspaceDir,
      updatedAt: c.updatedAt,
      preview: previews?.[c.id]?.lastReply?.slice(0, 140) ?? undefined,
    }));
}

/** Last path segment; the default workspace reads as the general "Chat". */
export function workspaceShortName(
  dir: string | null,
  defaultWorkspace: string,
): string {
  if (!dir || dir === defaultWorkspace) return "Chat";
  const trimmed = dir.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

// ---- The routing call -----------------------------------------------------

export interface RouteDecision extends SmartRouteTarget {
  confidence: number;
}

/** Below this many typed characters there is no signal worth routing on. */
export const ROUTE_MIN_CHARS = 12;
/** Typing pause before a routing request fires. */
export const ROUTE_DEBOUNCE_MS = 800;
/** "continue" needs at least this much confidence; below it → "new". */
const CONTINUE_MIN_CONFIDENCE = 0.6;
/** Cap on the message excerpt sent to the router. */
const ROUTE_TEXT_CHARS = 600;

const ROUTE_SYSTEM_PROMPT = `You route a user's new message inside a desktop AI-agent app.
Given recent conversations and workspace folders, decide whether the message continues one of the conversations or starts a new one, and for a new one pick the most relevant workspace folder.

Reply with ONLY a JSON object, no prose:
{"action":"continue"|"new","session":<number|null>,"workspace":<string|null>,"confidence":<0..1>}

Rules:
- "session" is the number of the matching conversation from the list; null unless action is "continue".
- "workspace" is one of the listed folder names, or "Chat" for a general (non-project) message; null if unsure.
- Strongly prefer "new". Choose "continue" ONLY when the message clearly refers back to that conversation's specific topic or asks a follow-up about it. Greetings, new questions, and generic tasks are "new" even if a conversation shares keywords.
- Pick a project folder only when the message clearly concerns that project; otherwise "Chat".
- The message may be partially typed; judge what is there.`;

function minutesAgo(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function buildUserPrompt(
  text: string,
  candidates: RouteCandidate[],
  workspaces: string[],
  defaultWorkspace: string,
): string {
  const sessions = candidates
    .map((c, i) => {
      const parts = [
        `${i + 1}. ${c.title || "(untitled)"}`,
        `folder=${workspaceShortName(c.workspaceDir, defaultWorkspace)}`,
        minutesAgo(c.updatedAt),
      ];
      if (c.preview) parts.push(`last reply: ${c.preview}`);
      return parts.join(" | ");
    })
    .join("\n");
  const folders = [
    "Chat (general)",
    ...workspaces
      .filter((w) => w && w !== defaultWorkspace)
      .map((w) => workspaceShortName(w, defaultWorkspace)),
  ].join(", ");
  return `Recent conversations:\n${sessions || "(none)"}\n\nWorkspace folders: ${folders}\n\nMessage (may be partially typed):\n"""\n${text.slice(0, ROUTE_TEXT_CHARS)}\n"""`;
}

/** Map the user's pi model choice onto a DeepSeek override for the utility
 *  call — routing follows the model the user is on. Custom models keep the
 *  utility target's own default. */
function routeModelOverride(model?: ModelId): string | null {
  if (model === "flash") return "deepseek-v4-flash";
  if (model === "pro") return "deepseek-v4-pro";
  return null;
}

/** One routing request. Resolves to a validated decision, or null when the
 *  model (or its output) is unusable — callers treat null as "no routing". */
export async function routeInput(args: {
  text: string;
  candidates: RouteCandidate[];
  workspaces: string[];
  defaultWorkspace: string;
  model?: ModelId;
}): Promise<RouteDecision | null> {
  const { text, candidates, workspaces, defaultWorkspace } = args;
  let raw: string;
  try {
    raw = await api.utilityComplete({
      system: ROUTE_SYSTEM_PROMPT,
      user: buildUserPrompt(text, candidates, workspaces, defaultWorkspace),
      maxTokens: 2048,
      json: true,
      modelOverride: routeModelOverride(args.model),
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    // Some OpenAI-compatible endpoints ignore response_format and fence the
    // JSON anyway.
    parsed = JSON.parse(raw.replace(/```(?:json)?/g, "").trim());
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const confidence =
    typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1
      ? obj.confidence
      : 0;

  // Resolve the workspace short name back to a directory. Unknown → null
  // (keep the surface's current selection).
  let workspaceDir: string | null = null;
  if (typeof obj.workspace === "string" && obj.workspace) {
    if (obj.workspace === "Chat") workspaceDir = defaultWorkspace || null;
    else
      workspaceDir =
        workspaces.find(
          (w) => workspaceShortName(w, defaultWorkspace) === obj.workspace,
        ) ?? null;
  }

  if (obj.action === "continue") {
    const idx = typeof obj.session === "number" ? obj.session - 1 : -1;
    const target = candidates[idx];
    // Continuing needs a real target AND real confidence; anything less is a
    // new chat (the cheap kind of wrong).
    if (target && confidence >= CONTINUE_MIN_CONFIDENCE) {
      return {
        action: "continue",
        sessionId: target.id,
        workspaceDir: target.workspaceDir,
        confidence,
      };
    }
  }
  return { action: "new", sessionId: null, workspaceDir, confidence };
}

// ---- Debounced hook -------------------------------------------------------

export interface SmartRouteState {
  decision: RouteDecision | null;
  pending: boolean;
}

/** Route-as-you-type: debounce the draft, call the utility model, keep only
 *  the latest in-flight result. Disabled (or too-short) input clears the
 *  decision. Candidate/workspace lists ride in refs so their identity churn
 *  never re-fires the effect — only the text does. */
export function useSmartRoute(opts: {
  text: string;
  enabled: boolean;
  candidates: RouteCandidate[];
  workspaces: string[];
  defaultWorkspace: string;
  model?: ModelId;
}): SmartRouteState {
  const { text, enabled } = opts;
  const [decision, setDecision] = useState<RouteDecision | null>(null);
  const [pending, setPending] = useState(false);
  const runRef = useRef(0);
  const lastRoutedRef = useRef("");
  const argsRef = useRef(opts);
  argsRef.current = opts;

  useEffect(() => {
    const trimmed = text.trim();
    if (!enabled || trimmed.length < ROUTE_MIN_CHARS) {
      runRef.current++;
      lastRoutedRef.current = "";
      setDecision(null);
      setPending(false);
      return;
    }
    if (trimmed === lastRoutedRef.current) return;
    setPending(true);
    const timer = window.setTimeout(async () => {
      const run = ++runRef.current;
      const { candidates, workspaces, defaultWorkspace, model } = argsRef.current;
      const result = await routeInput({
        text: trimmed,
        candidates,
        workspaces,
        defaultWorkspace,
        model,
      });
      if (runRef.current !== run) return; // superseded by newer input
      lastRoutedRef.current = trimmed;
      setDecision(result);
      setPending(false);
    }, ROUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, enabled]);

  return { decision, pending };
}
