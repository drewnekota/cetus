import { expect, test } from "bun:test";
import { DisclosureState } from "./disclosure-state.ts";

test("untouched groups follow changing defaults, explicit choices do not", () => {
  const state = new DisclosureState();
  expect(state.get("tail", false)).toBe(false);
  expect(state.get("tail", true)).toBe(true);
  state.set("tail", false);
  expect(state.get("tail", true)).toBe(false);
});

test("the latest manual choice survives a merge or remount", () => {
  const state = new DisclosureState();
  state.set("live-a", true);
  expect(state.get("history", false, ["live-a", "live-b"])).toBe(true);
  state.set("live-b", false);
  expect(state.get("history", true, ["live-a", "live-b"])).toBe(false);
  state.set("history", true);
  expect(state.get("history", false, ["live-a", "live-b"])).toBe(true);
  expect(state.get("unrelated", false)).toBe(false);
});

test("reusing a mounted component with another id does not leak state", () => {
  const state = new DisclosureState();
  state.set("one", true);
  expect(state.get("one", false)).toBe(true);
  expect(state.get("two", false)).toBe(false);
});
