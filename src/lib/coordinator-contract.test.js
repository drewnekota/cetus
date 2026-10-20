// Cetus only opens threads and passes them the user's follow-ups; nothing a
// thread does is written back into Cetus's conversation (the user reads each
// thread on its card).
import { afterAll, describe, expect, mock, test } from "bun:test";

// --- the pi extension: tool set and brief ----------------------------------

mock.module("typebox", () => {
  const any = () => ({});
  return { Type: { Object: any, String: any, Optional: any } };
});

describe("coordinator-tools extension", () => {
  const prev = process.env.CETUS_COORDINATOR;
  afterAll(() => {
    if (prev === undefined) delete process.env.CETUS_COORDINATOR;
    else process.env.CETUS_COORDINATOR = prev;
  });

  async function load() {
    process.env.CETUS_COORDINATOR = "1";
    const { default: register } = await import(
      "../../src-tauri/cetus-extensions/coordinator-tools.ts"
    );
    const tools = [];
    const commands = [];
    const hooks = {};
    register({
      registerTool: (t) => tools.push(t.name),
      registerCommand: (name) => commands.push(name),
      on: (event, fn) => (hooks[event] = fn),
    });
    const { systemPrompt } = await hooks.before_agent_start({ systemPrompt: "" });
    return { tools, commands, systemPrompt };
  }

  test("Cetus can only start threads and send them follow-ups", async () => {
    const { tools, commands } = await load();
    expect(tools).toEqual(["thread_start", "thread_send"]);
    expect(commands).toEqual([]);
  });

  test("the brief never tells Cetus to expect or relay thread results", async () => {
    const { systemPrompt } = await load();
    expect(systemPrompt).toContain("thread_start");
    expect(systemPrompt).toContain("thread_send");
    expect(systemPrompt).not.toContain("thread-report");
    expect(systemPrompt).not.toContain("thread_list");
    expect(systemPrompt).not.toContain("thread_read");
    expect(systemPrompt).not.toMatch(/report when it'?s done|relay/i);
  });
});

// --- the hook: a thread's turn ending appends nothing to Cetus ---------------

const sendPrompt = mock(async () => {});
const appListeners = [];
const replies = [];
mock.module("@/lib/tauri", () => ({
  api: {
    sendPrompt,
    extensionUiRespond: async (_cid, _rid, { value }) => replies.push(JSON.parse(value)),
    coordinatorRegistry: async () => ({ coordinators: {}, threads: {} }),
    coordinatorLinkThread: async (tid, coordId) => ({
      coordinators: { "/repo": coordId },
      threads: { [tid]: coordId },
    }),
  },
  onAppEvent: async (fn) => {
    appListeners.push(fn);
    return () => {};
  },
}));
mock.module("@/lib/chat-store", () => ({ loadCachedMessages: async () => null }));
mock.module("@/app/home/home-utils", () => ({ mergeConversation: (cs) => cs }));
mock.module("./home-utils", () => ({ mergeConversation: (cs) => cs }));
// Effects run on "mount", refs are plain objects: enough to drive the hook
// outside React.
const fakeReact = {
  useEffect: (fn) => void fn(),
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useDebugValue: () => {},
  useSyncExternalStore: (_subscribe, get) => get(),
};
mock.module("react", () => ({ ...fakeReact, default: fakeReact }));

describe("useCoordinator", () => {
  test("a thread finishing, failing or asking the user writes nothing into Cetus", async () => {
    const { useCoordinator } = await import("../app/home/use-coordinator.tsx");
    const { useCoordinatorStore } = await import("./coordinator.ts");
    const { create } = await import("zustand");

    const chatStore = create(() => ({
      streamingIds: new Set(),
      controlRequests: {},
      backgroundTasks: {},
      chats: {},
    }));
    const conversations = [
      { id: "cetus", workspaceDir: "/repo", title: "Cetus", backend: "pi" },
    ];
    const enqueueMessage = mock(() => {});
    const createThread = mock(async (_text, _att, _dir, opts) => {
      conversations.push({ id: "t1", workspaceDir: "/repo", title: "Fix it", backend: "codex" });
      await opts.beforeSend("t1");
      return "t1";
    });
    useCoordinator({
      chatStore,
      conversationsRef: { current: conversations },
      setConversations: () => {},
      createThread,
      enqueueMessage,
      defaultBackendRef: { current: "codex" },
    });

    // Cetus starts a thread through its tool tunnel.
    replies.length = 0;
    for (const fn of appListeners) {
      fn({
        type: "coordinator_tool_request",
        conversationId: "cetus",
        requestId: "r1",
        params: { op: "start", task: "Fix the login bug" },
      });
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(replies[0]).toMatchObject({ ok: true, thread_id: "t1" });
    useCoordinatorStore.getState().setRegistry({
      coordinators: { "/repo": "cetus" },
      threads: { t1: "cetus" },
    });

    // The thread works, asks the user something, then finishes and errors.
    chatStore.setState({ streamingIds: new Set(["t1"]) });
    chatStore.setState({ controlRequests: { t1: [{ toolName: "AskUserQuestion", input: {} }] } });
    chatStore.setState({ controlRequests: {} });
    chatStore.setState({
      streamingIds: new Set(),
      chats: { t1: { messages: [{ role: "assistant", blocks: [{ kind: "text", text: "Done." }] }] } },
    });
    chatStore.setState({ chats: { t1: { error: "boom", messages: [] } } });
    await new Promise((r) => setTimeout(r, 1700));

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(enqueueMessage).not.toHaveBeenCalled();
  });
});
