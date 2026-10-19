import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_QUICK_REACTIONS, partitionDue, reminderDueAt, topReactions, useMessagePrefs } from "./message-prefs";
import { buildForwardBody, countUnreadAfter, messagePermalink, unreadMarkerFor, BEFORE_FIRST_MESSAGE_ID } from "./forward";

const ref = { messageId: "msg_1", channelId: "chn_1", authorId: "usr_a", excerpt: "hello" };

describe("topReactions", () => {
  it("falls back to the defaults with no history", () => {
    expect(topReactions({})).toEqual(DEFAULT_QUICK_REACTIONS);
  });
  it("puts the most used first and fills the rest from the defaults", () => {
    expect(topReactions({ "🔥": 5, "👀": 2 })).toEqual(["🔥", "👀", "👍"]);
    expect(topReactions({ "👍": 1, "🔥": 3 })).toEqual(["🔥", "👍", "🎉"]);
  });
});

describe("reminderDueAt", () => {
  const now = new Date(2026, 9, 19, 14, 30); // Mon
  it("adds fixed offsets", () => {
    expect(reminderDueAt("20m", now).getTime() - now.getTime()).toBe(20 * 60_000);
    expect(reminderDueAt("3h", now).getHours()).toBe(17);
  });
  it("tomorrow and next Monday land on 9:00", () => {
    const t = reminderDueAt("tomorrow", now);
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([20, 9, 0]);
    const w = reminderDueAt("nextWeek", now);
    expect([w.getDay(), w.getDate(), w.getHours()]).toEqual([1, 26, 9]);
  });
  it("partitions due reminders", () => {
    const r = (id: string, dueAt: string) => ({ ...ref, id, dueAt });
    const { due, rest } = partitionDue([r("a", "2026-01-01T00:00:00Z"), r("b", "2099-01-01T00:00:00Z")], new Date());
    expect(due.map((x) => x.id)).toEqual(["a"]);
    expect(rest.map((x) => x.id)).toEqual(["b"]);
  });
});

describe("useMessagePrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    useMessagePrefs.setState({ userId: null, reactionUsage: {}, bookmarks: [], reminders: [], follows: [] });
  });

  it("persists per user and reloads on hydrate", () => {
    const s = useMessagePrefs.getState();
    s.hydrate("usr_me");
    expect(useMessagePrefs.getState().toggleBookmark(ref)).toBe(true);
    useMessagePrefs.getState().recordReaction("🔥");
    useMessagePrefs.getState().toggleFollow("msg_1");

    useMessagePrefs.setState({ userId: null, reactionUsage: {}, bookmarks: [], follows: [] });
    useMessagePrefs.getState().hydrate("usr_me");
    const after = useMessagePrefs.getState();
    expect(after.bookmarks.map((b) => b.messageId)).toEqual(["msg_1"]);
    expect(after.reactionUsage).toEqual({ "🔥": 1 });
    expect(after.follows).toEqual(["msg_1"]);

    useMessagePrefs.getState().hydrate("usr_other");
    expect(useMessagePrefs.getState().bookmarks).toEqual([]);
  });

  it("toggles bookmark and follow off again", () => {
    useMessagePrefs.getState().hydrate("usr_me");
    useMessagePrefs.getState().toggleBookmark(ref);
    expect(useMessagePrefs.getState().toggleBookmark(ref)).toBe(false);
    useMessagePrefs.getState().toggleFollow("msg_1");
    expect(useMessagePrefs.getState().toggleFollow("msg_1")).toBe(false);
    expect(useMessagePrefs.getState().bookmarks).toEqual([]);
  });

  it("adds and removes reminders", () => {
    useMessagePrefs.getState().hydrate("usr_me");
    useMessagePrefs.getState().addReminder(ref, new Date("2099-01-01T00:00:00Z"));
    const [r] = useMessagePrefs.getState().reminders;
    expect(r?.dueAt).toBe("2099-01-01T00:00:00.000Z");
    expect(useMessagePrefs.getState().takeDueReminders(new Date("2026-01-01T00:00:00Z"))).toEqual([]);
    expect(useMessagePrefs.getState().takeDueReminders(new Date("2099-01-02T00:00:00Z")).map((x) => x.id)).toEqual([r!.id]);
    // already taken (e.g. by another tab): never fires twice
    expect(useMessagePrefs.getState().takeDueReminders(new Date("2099-01-02T00:00:00Z"))).toEqual([]);
    expect(useMessagePrefs.getState().reminders).toEqual([]);
  });

  it("merges with what another tab saved instead of overwriting it", () => {
    useMessagePrefs.getState().hydrate("usr_me");
    useMessagePrefs.getState().toggleBookmark(ref);
    // another tab adds a second bookmark straight into storage
    const raw = JSON.parse(localStorage.getItem("dub.chat.prefs.usr_me")!);
    raw.bookmarks.push({ ...ref, messageId: "msg_2", savedAt: "x" });
    localStorage.setItem("dub.chat.prefs.usr_me", JSON.stringify(raw));
    useMessagePrefs.getState().recordReaction("🔥");
    expect(useMessagePrefs.getState().bookmarks.map((b) => b.messageId)).toEqual(["msg_1", "msg_2"]);
  });
});

describe("forward / unread / permalink helpers", () => {
  it("quotes the flattened text with author and source channel", () => {
    expect(buildForwardBody({ comment: " 見て ", text: "a\nb", authorName: "Alice", sourceChannelName: "#general" })).toBe(
      "見て\n\n> a\n> b\n> — Alice #general から転送",
    );
    expect(buildForwardBody({ comment: "", text: "", authorName: "Bob", sourceChannelName: "#x" })).toBe(
      "> (添付ファイル)\n> — Bob #x から転送",
    );
  });

  it("marks unread from the chosen message", () => {
    const msgs = [{ id: "01A" }, { id: "01B" }, { id: "01C" }];
    expect(unreadMarkerFor(msgs, "01B")).toBe("01A");
    expect(unreadMarkerFor(msgs, "01A")).toBe(BEFORE_FIRST_MESSAGE_ID);
    const withAuthors = [
      { id: "01A", authorId: "usr_x" },
      { id: "01B", authorId: "usr_me" },
      { id: "01C", authorId: "usr_x" },
    ];
    expect(countUnreadAfter(withAuthors, BEFORE_FIRST_MESSAGE_ID, "usr_me")).toBe(2);
  });

  it("builds a deep link under the app's /chat base", () => {
    expect(messagePermalink({ origin: "https://x.dev", pathname: "/chat/channels/c1" }, "c2", "m9")).toBe(
      "https://x.dev/chat/channels/c2?message=m9",
    );
    expect(messagePermalink({ origin: "https://x.dev", pathname: "/app/chat" }, "c2", "m9")).toBe(
      "https://x.dev/app/chat/channels/c2?message=m9",
    );
  });
});
