import { describe, expect, test } from "bun:test";
import { formatReport, latestReply, listedConversations, parseReport, resolveCliModel, runtimeToBackend, threadsOf } from "./coordinator.ts";

describe("thread reports", () => {
  test("format and parse round-trip, quotes and newlines in titles are neutralised", () => {
    const text = formatReport({ id: "t1", title: 'Fix "login"\nbug', runtime: "codex", status: "finished", body: "Done.\n\nTwo files changed." });
    const r = parseReport(text);
    expect(r).toEqual({ id: "t1", title: "Fix 'login' bug", runtime: "codex", status: "finished", body: "Done.\n\nTwo files changed." });
  });

  test("ordinary user text is not a report", () => {
    expect(parseReport("please fix the <thread-report> parser")).toBeNull();
  });
});

describe("helpers", () => {
  test("runtime names map to backends; unknown means default", () => {
    expect(runtimeToBackend("Claude Code")).toBe("claude-code");
    expect(runtimeToBackend("cetus")).toBe("pi");
    expect(runtimeToBackend("codex")).toBe("codex");
    expect(runtimeToBackend("")).toBeNull();
    expect(runtimeToBackend(undefined)).toBeNull();
  });

  test("latestReply only reads past the last user message", () => {
    const msg = (role, text) => ({ key: text, role, createdAt: 0, blocks: [{ kind: "text", text }] });
    expect(latestReply([msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2")])).toBe("");
    expect(latestReply([msg("user", "q1"), msg("assistant", "a1"), msg("assistant", "a2")])).toBe("a2");
  });

  test("threadsOf lists one coordinator's threads", () => {
    const reg = { coordinators: { "/w": "c1" }, threads: { t1: "c1", t2: "c2", t3: "c1" } };
    expect(threadsOf(reg, "c1")).toEqual(["t1", "t3"]);
  });
});

describe("resolveCliModel", () => {
  // Shapes of the real catalogs: aliases (newest) first, then pinned ids.
  const claude = [
    { id: "opus", label: "Opus 5.5" },
    { id: "sonnet", label: "Sonnet 5.5" },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { id: "claude-opus-5", label: "Opus 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ];
  const codex = [
    { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
    { id: "gpt-6-sol", label: "GPT-6-Sol" },
    { id: "gpt-6-luna", label: "GPT-6-Luna" },
  ];

  test("versions must match exactly, not as a prefix", () => {
    expect(resolveCliModel("Claude Opus 5.5", claude)).toEqual({ id: "opus" });
    expect(resolveCliModel("claude-opus-5-5", claude)).toEqual({ id: "opus" });
    expect(resolveCliModel("Opus 5", claude)).toEqual({ id: "claude-opus-5" });
    expect(resolveCliModel("haiku 4.5", claude)).toEqual({ id: "claude-haiku-4-5-20251001" });
    expect(resolveCliModel("gpt 6 sol", codex)).toEqual({ id: "gpt-6-sol" });
  });

  test("ids and labels match exactly; a bare family picks the newest", () => {
    expect(resolveCliModel("opus", claude)).toEqual({ id: "opus" });
    expect(resolveCliModel("SONNET", claude)).toEqual({ id: "sonnet" });
    expect(resolveCliModel("GPT-6.1-Sol", codex)).toEqual({ id: "gpt-6.1-sol" });
    expect(resolveCliModel("luna", codex)).toEqual({ id: "gpt-6-luna" });
  });

  test("unknown names list what's available", () => {
    const r = resolveCliModel("Opus 6", claude);
    expect(r.error).toContain("unknown model");
    expect(r.error).toContain("opus (Opus 5.5)");
    expect(resolveCliModel("gpt-7", codex).error).toContain("gpt-6-sol (GPT-6-Sol)");
  });
});

describe("listedConversations", () => {
  test("drops the folders' Cetus sessions and keeps the order", () => {
    const registry = { coordinators: { "/a": "c1", "/b": "c2" }, threads: {} };
    const all = [{ id: "x" }, { id: "c1" }, { id: "y" }, { id: "c2" }];
    expect(listedConversations(all, registry).map((c) => c.id)).toEqual(["x", "y"]);
  });

  test("returns the same array when there is no Cetus session", () => {
    const all = [{ id: "x" }];
    expect(listedConversations(all, { coordinators: {}, threads: {} })).toBe(all);
  });
});
