import { afterEach, expect, test } from "bun:test";
import { bindChatTailScroll } from "./chat-tail-scroll.ts";

const original = {
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
let cleanup;
afterEach(() => {
  cleanup?.();
  Object.assign(globalThis, original);
});

function setup(following = true) {
  const frames = new Map();
  let frameId = 0;
  let resize;
  let searching = false;
  let releases = 0;
  let writes = 0;
  let top = 500;
  globalThis.requestAnimationFrame = (cb) => { frames.set(++frameId, cb); return frameId; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.ResizeObserver = class {
    constructor(cb) { resize = cb; }
    observe() {}
    disconnect() {}
  };
  const scroller = new EventTarget();
  Object.assign(scroller, { scrollHeight: 1000, clientHeight: 500, querySelector: () => ({}), closest: () => null });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => top,
    set: (value) => { writes++; top = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight)); },
  });
  const binding = bindChatTailScroll(scroller, {
    isFollowing: () => following,
    setFollowing: (value) => { following = value; },
    isSearching: () => searching,
    onRelease: () => { releases++; },
  });
  cleanup = binding.dispose;
  const emit = (type, props = {}) => scroller.dispatchEvent(Object.assign(new Event(type), props));
  const flush = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach((cb) => cb()); };
  return {
    scroller, emit, flush, resize: () => resize(),
    move: (value) => { top = value; emit("scroll"); },
    following: () => following, writes: () => writes, releases: () => releases,
    search: (value) => { searching = value; },
    resume: () => { following = true; },
  };
}

test("an upward wheel cancels an already queued resize follow before native scrolling", () => {
  const h = setup();
  h.scroller.scrollHeight += 20;
  h.resize();
  h.emit("wheel", { deltaY: -4 });
  h.flush();
  expect(h.writes()).toBe(0);
  expect(h.following()).toBe(false);
  expect(h.releases()).toBe(1);
});

test("queued bottom scrolls cannot re-arm follow after an upward wheel", () => {
  const h = setup();
  h.emit("wheel", { deltaY: -1 });
  h.move(500); // delayed programmatic scroll, before the wheel's default action
  h.move(499.5); // high resolution touchpad, still within the old 32px threshold
  h.move(500); // resize/anchoring puts us back at the bottom
  h.scroller.scrollHeight += 100;
  h.resize(); h.flush();
  expect(h.following()).toBe(false);
  expect(h.writes()).toBe(0);
});

test("only deliberate downward scrolling into the bottom zone resumes follow", () => {
  const h = setup();
  h.emit("wheel", { deltaY: -100 }); h.move(400);
  h.emit("wheel", { deltaY: 60 }); h.move(460);
  expect(h.following()).toBe(false);
  h.emit("wheel", { deltaY: 40 }); h.move(500);
  expect(h.following()).toBe(true);
  h.scroller.scrollHeight += 40; h.resize(); h.flush();
  expect(h.scroller.scrollTop).toBe(540);
});

test("viewport shrink and final content resize obey a paused/restored reading position", () => {
  const h = setup(false);
  h.scroller.clientHeight = 300;
  h.resize(); h.flush();
  h.scroller.scrollHeight += 100;
  h.resize(); h.flush();
  expect(h.writes()).toBe(0);
  h.resume(); h.resize(); h.flush();
  expect(h.scroller.scrollTop).toBe(800);
});

test("search opening after scheduling blocks the pending follow", () => {
  const h = setup();
  h.resize(); h.search(true); h.flush();
  expect(h.writes()).toBe(0);
});

test("touch scrolling and Shift+Space release follow before the scroll event", () => {
  const h = setup();
  h.emit("touchstart", { touches: [{ clientY: 100 }] });
  h.emit("touchmove", { touches: [{ clientY: 120 }] });
  expect(h.following()).toBe(false);
  h.resume();
  h.emit("keydown", { key: " ", shiftKey: true });
  expect(h.following()).toBe(false);
});

test("cleanup cancels pending frames when switching conversations", () => {
  const h = setup();
  h.resize(); cleanup(); h.flush();
  expect(h.writes()).toBe(0);
});


test("a final token landing before the downward scroll event still resumes follow", () => {
  const h = setup(false);
  h.move(400);
  h.emit("wheel", { deltaY: 100 });
  h.scroller.scrollHeight += 7;
  h.move(500); // browser reached the old bottom; final layout added seven pixels
  expect(h.following()).toBe(true);
  h.flush();
  expect(h.scroller.scrollTop).toBe(507);
});

test("measurement corrections moving upward do not detach an untouched tail", () => {
  const h = setup();
  h.scroller.scrollHeight = 950;
  h.move(450);
  expect(h.following()).toBe(true);
});
