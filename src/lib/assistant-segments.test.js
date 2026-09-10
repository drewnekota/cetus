import { describe, expect, test } from "bun:test";
import { buildAssistantSegments } from "./assistant-segments.ts";
import { toolActivityStatus } from "./tool-status.ts";
import { chatReducer, emptyChatState } from "./chat-state.ts";

const text = (text, phase) => ({ kind: "text", text, ...(phase ? { phase } : {}) });
const thinking = (text = "Thinking") => ({ kind: "thinking", text });
const tool = (id, overrides = {}) => ({ kind: "tool_use", id, name: "shell", args: {}, result: { content: [], isError: false }, ...overrides });
const artifact = (id) => tool(id, { result: { content: [], isError: false, details: { kind: "artifact", path: "/tmp/report.pdf" } } });
const message = (blocks, key = "m", createdAt = 1000) => ({ key, role: "assistant", blocks, createdAt });
const build = (blocks, live = false) => buildAssistantSegments([message(blocks)], live);
const flattened = (segments) => segments.flatMap((s) => s.type === "answer" ? [s.block] : s.steps);
const visibleText = (segments) => segments.filter((s) => s.type === "answer" && s.block.kind === "text").map((s) => s.block.text);
const event = (state, event) => chatReducer(state, { type: "pi_event", event });

describe("runtime-independent folding", () => {
  test("keeps the latest progress and following tools, folding earlier history", () => {
    const segments = build([text("Earlier"), tool("a"), text("Waiting for CI"), tool("b"), tool("c")]);
    expect(segments.map((s) => s.type)).toEqual(["activity", "answer", "activity"]);
    expect(visibleText(segments)).toEqual(["Waiting for CI"]);
    expect(segments[0].defaultOpen).toBe(false);
    expect(segments[2].defaultOpen).toBe(true);
    expect(segments[2].steps.map((b) => b.id)).toEqual(["b", "c"]);
  });

  test("preserves a final reply split across multiple text blocks", () => {
    expect(visibleText(build([tool("a"), text("Summary"), text("Details"), text("  ")]))).toEqual(["Summary", "Details"]);
  });

  test("explicit final text survives later commentary and tools", () => {
    const segments = build([thinking(), text("Answer", "final_answer"), tool("a"), text("Cleanup", "commentary"), tool("b")]);
    expect(visibleText(segments)).toEqual(["Answer", "Cleanup"]);
  });

  test("live narration stays visible and completed replies fold only on settle", () => {
    const blocks = [thinking(), text("Progress"), tool("a"), text("Done", "final_answer")];
    expect(visibleText(build(blocks, true))).toEqual(["Progress", "Done"]);
    expect(visibleText(build(blocks))).toEqual(["Done"]);
  });

  test("artifacts and attachments are never hidden or reordered", () => {
    const blocks = [text("Earlier"), tool("a"), artifact("image"), text("More"), tool("b"), { kind: "file", path: "/tmp/a", name: "a" }, text("Done")];
    const segments = build(blocks);
    expect(flattened(segments)).toEqual(blocks);
    expect(segments.filter((s) => s.type === "answer").map((s) => s.block)).toContain(blocks[2]);
    expect(segments.filter((s) => s.type === "answer").map((s) => s.block)).toContain(blocks[5]);
  });

  test("tool-only turns keep their latest operation visible", () => {
    const segments = build([tool("a"), tool("b")]);
    expect(segments.map((s) => s.defaultOpen)).toEqual([false, true]);
    expect(segments[1].steps[0].id).toBe("b");
  });

  test("image-only and plain-text replies have no artificial process group", () => {
    expect(build([artifact("image")])[0].type).toBe("answer");
    expect(build([text("One"), text("Two")]).every((s) => s.type === "answer")).toBe(true);
    expect(build([thinking(""), text(" ")])).toEqual([]);
    expect(build([{ ...thinking(""), streaming: true }], true)).toHaveLength(1);
  });

  test.each([
    ["missing result", { result: null }, "incomplete"],
    ["background agent", { result: { content: [], details: { subagent: { status: "running" } } } }, "running"],
    ["cancelled agent", { result: { content: [], details: { subagent: { status: "cancelled" } } } }, "incomplete"],
  ])("keeps %s visible even before a final reply", (_, overrides, status) => {
    const block = tool("attention", overrides);
    const segments = build([tool("a"), block, text("Answer", "final_answer")]);
    const group = segments.find((s) => s.type === "activity" && s.steps.includes(block));
    expect(group.defaultOpen).toBe(true);
    expect(toolActivityStatus(block)).toBe(status);
  });

  test("failed attempts and retries stay in one collapsed history group", () => {
    const failed = tool("failed", { result: { content: [], isError: true } });
    const blocks = [tool("a"), failed, text("Retrying"), tool("retry"), text("Done", "final_answer")];
    const segments = build(blocks);
    expect(segments.map((s) => s.type)).toEqual(["activity", "answer"]);
    expect(segments[0].defaultOpen).toBe(false);
    expect(segments[0].steps).toEqual(blocks.slice(0, -1));
    expect(toolActivityStatus(failed)).toBe("error");
  });

  test("failed tools after the latest text follow the ordinary tail policy", () => {
    const failed = tool("failed", { result: { content: [], isError: true } });
    const segments = build([text("Trying again"), tool("a"), failed, tool("retry")]);
    expect(segments.map((s) => s.type)).toEqual(["answer", "activity"]);
    expect(segments[1].defaultOpen).toBe(true);
    expect(segments[1].steps.map((b) => b.id)).toEqual(["a", "failed", "retry"]);
  });

  test("stable block keys survive regrouping and do not collide across messages", () => {
    const messages = [message([text("Earlier"), tool("a")], "one"), message([tool("b"), text("Latest"), tool("c")], "two", 3000)];
    const live = buildAssistantSegments(messages, true), settled = buildAssistantSegments(messages, false);
    const keyFor = (segments, id) => segments.flatMap((s) => s.type === "activity" ? s.steps.map((b, i) => b.id === id ? s.stepKeys[i] : null) : []).filter(Boolean)[0];
    for (const id of ["a", "b", "c"]) expect(keyFor(live, id)).toBe(keyFor(settled, id));
    expect(new Set(settled.map((s) => s.key)).size).toBe(settled.length);
    expect(settled[0].durationMs).toBe(2000);
  });
});

describe("runtime event and historical parity", () => {
  test("unmarked historical transcripts from all adapters use the shared fallback", () => {
    const raw = [
      { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "toolCall", id: "a", name: "shell", arguments: {} }] },
      { role: "toolResult", toolCallId: "a", content: "ok" },
      { role: "assistant", content: [{ type: "text", text: "Latest" }, { type: "toolCall", id: "b", name: "shell", arguments: {} }] },
      { role: "toolResult", toolCallId: "b", content: "ok" },
    ];
    const state = chatReducer(emptyChatState, { type: "reset", messages: raw });
    const segments = buildAssistantSegments(state.messages, false);
    expect(visibleText(segments)).toEqual(["Latest"]);
    expect(segments.at(-1).defaultOpen).toBe(true);
  });

  test("Codex phase survives text_end and historical inflation", () => {
    let state = event(emptyChatState, { type: "message_start", message: { role: "assistant" } });
    for (const e of [
      { type: "text_start", contentIndex: 0 },
      { type: "text_delta", contentIndex: 0, delta: "Answer" },
      { type: "text_end", contentIndex: 0, content: "Answer", phase: "final_answer" },
    ]) state = event(state, { type: "message_update", assistantMessageEvent: e });
    const history = chatReducer(emptyChatState, { type: "reset", messages: [{ role: "assistant", content: [{ type: "text", text: "Answer", phase: "final_answer" }] }] });
    expect(state.messages[0].blocks[0].phase).toBe("final_answer");
    expect(history.messages[0].blocks[0].phase).toBe("final_answer");
  });

  test("retry/compaction continuation does not prematurely settle or clear live tools", () => {
    const state = { ...emptyChatState, isStreaming: true, messages: [message([tool("a", { streaming: true, result: null })])] };
    expect(event(state, { type: "agent_end", willRetry: true })).toBe(state);
    const ended = event(state, { type: "agent_settled" });
    expect(ended.isStreaming).toBe(false);
    expect(toolActivityStatus(ended.messages[0].blocks[0])).toBe("incomplete");
  });

  test("settlement clears orphan streams across the turn but keeps background status", () => {
    const state = { ...emptyChatState, isStreaming: true, messages: [
      message([tool("a", { streaming: true, result: null })], "a"),
      message([tool("agent", { streaming: true, result: { content: [], details: { subagent: { status: "running" } } } })], "b"),
    ] };
    const ended = event(state, { type: "agent_end" });
    expect(ended.messages.every((m) => m.blocks[0].streaming === false)).toBe(true);
    expect(toolActivityStatus(ended.messages[1].blocks[0])).toBe("running");
    expect(state.messages[0].blocks[0].streaming).toBe(true);
  });

  test("manual cancellation settles earlier tool messages without touching prior turns", () => {
    const prior = message([tool("prior", { streaming: true })], "prior");
    const state = { ...emptyChatState, isStreaming: true, activeAssistantIdx: 3, messages: [
      prior, { key: "user", role: "user", blocks: [text("Run checks")], createdAt: 0 },
      message([tool("earlier", { streaming: true, result: null })], "earlier"),
      message([text("Partial reply")], "current"),
    ] };
    const cancelled = chatReducer(state, { type: "end_stream", keepPartial: true });
    expect(cancelled.aborted).toBe(true);
    expect(cancelled.messages[0]).toBe(prior);
    expect(toolActivityStatus(cancelled.messages[2].blocks[0])).toBe("incomplete");
    expect(visibleText(buildAssistantSegments(cancelled.messages.slice(2), false))).toEqual(["Partial reply"]);
  });
});
