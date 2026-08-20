import { describe, it, expect } from "vitest";
import {
  chatDeleteRight,
  setChatDeleteRight,
  chatDeletionTier,
  chatDeleteChoice,
  applyChatDeleteChoice,
  CHAT_DELETE_KEYS,
} from "../src/lib/chatDeleteRight";
import type { identity } from "@dub/types";

const K = (arr: string[]) => arr as identity.PermissionKey[];

describe("chatDeleteRight", () => {
  it("derives the 3-choice from the key set (moderate wins over delete)", () => {
    expect(chatDeleteRight(K([]))).toBe("none");
    expect(chatDeleteRight(K(["chat:create"]))).toBe("none");
    expect(chatDeleteRight(K(["chat:delete"]))).toBe("own");
    expect(chatDeleteRight(K(["chat:moderate"]))).toBe("any");
    expect(chatDeleteRight(K(["chat:delete", "chat:moderate"]))).toBe("any");
  });

  it("sets the choice as mutually-exclusive keys, preserving others", () => {
    const base = K(["chat:create", "app:chat:view"]);
    expect(setChatDeleteRight(base, "none")).toEqual(K(["app:chat:view", "chat:create"]));
    expect(setChatDeleteRight(base, "own")).toEqual(K(["app:chat:view", "chat:create", "chat:delete"]));
    expect(setChatDeleteRight(base, "any")).toEqual(K(["app:chat:view", "chat:create", "chat:moderate"]));
    // switching replaces, never accumulates both delete keys
    expect(setChatDeleteRight(K(["chat:moderate"]), "own")).toEqual(K(["chat:delete"]));
    expect(setChatDeleteRight(K(["chat:delete"]), "any")).toEqual(K(["chat:moderate"]));
    expect(setChatDeleteRight(K(["chat:moderate"]), "none")).toEqual(K([]));
  });

  it("maps the right to the org policy tier", () => {
    expect(chatDeletionTier("any")).toBe("moderator");
    expect(chatDeletionTier("own")).toBe("member");
    expect(chatDeletionTier("none")).toBe("member");
  });

  it("owns exactly the two delete keys (hidden from the flat chat grid)", () => {
    expect([...CHAT_DELETE_KEYS].sort()).toEqual(K(["chat:delete", "chat:moderate"]));
  });
});

describe("chatDeleteChoice (4-step, folds protectReacted)", () => {
  it("splits the own tier on protectReacted; none/any ignore it", () => {
    expect(chatDeleteChoice(K([]), false)).toBe("none");
    expect(chatDeleteChoice(K([]), true)).toBe("none");
    expect(chatDeleteChoice(K(["chat:delete"]), false)).toBe("own");
    expect(chatDeleteChoice(K(["chat:delete"]), true)).toBe("own_protected");
    expect(chatDeleteChoice(K(["chat:moderate"]), false)).toBe("any");
    expect(chatDeleteChoice(K(["chat:moderate"]), true)).toBe("any");
  });
});

describe("applyChatDeleteChoice (resolves keys + workspace protectReacted)", () => {
  const base = K(["app:chat:view"]);

  it("none clears the keys and leaves protectReacted unchanged", () => {
    expect(applyChatDeleteChoice(base, "none", true)).toEqual({ keys: K(["app:chat:view"]), protectReacted: true });
    expect(applyChatDeleteChoice(base, "none", false)).toEqual({ keys: K(["app:chat:view"]), protectReacted: false });
  });

  it("own_protected grants chat:delete and turns protectReacted ON", () => {
    expect(applyChatDeleteChoice(base, "own_protected", false)).toEqual({
      keys: K(["app:chat:view", "chat:delete"]),
      protectReacted: true,
    });
  });

  it("own grants chat:delete and turns protectReacted OFF", () => {
    expect(applyChatDeleteChoice(base, "own", true)).toEqual({
      keys: K(["app:chat:view", "chat:delete"]),
      protectReacted: false,
    });
  });

  it("any grants chat:moderate and leaves protectReacted unchanged (moderators exempt)", () => {
    expect(applyChatDeleteChoice(base, "any", true)).toEqual({
      keys: K(["app:chat:view", "chat:moderate"]),
      protectReacted: true,
    });
    // switching away from moderate replaces the key, never accumulates both
    expect(applyChatDeleteChoice(K(["chat:moderate"]), "own_protected", false).keys).toEqual(K(["chat:delete"]));
  });
});
