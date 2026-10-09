import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_NOTIFY_CHANGE_EVENT,
  BROWSER_NOTIFY_PREF_KEY,
  createMentionNotifier,
  getBrowserNotifyEnabled,
  mentionNotice,
  setBrowserNotifyEnabled,
} from "../src/lib/browser-notify";
import type { InboxItem } from "../src/contracts/notification-api";

function mention(id: string, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    type: "chat.mention",
    title: "メンションされました",
    body: "",
    readAt: null,
    createdAt: "2026-10-10T00:00:00Z",
    resourceType: "channel",
    resourceId: "ch_1",
    ...extra,
  } as InboxItem;
}

function setup(initial: InboxItem[], opts: { active?: boolean; away?: boolean } = {}) {
  let items = initial;
  const notify = vi.fn();
  const notifier = createMentionNotifier({
    fetchUnread: async () => items,
    notify,
    isActive: () => opts.active ?? true,
    isAway: () => opts.away ?? true,
  });
  return { notifier, notify, setItems: (next: InboxItem[]) => (items = next) };
}

describe("createMentionNotifier", () => {
  it("does not notify mentions that were already unread at the first check", async () => {
    const { notifier, notify } = setup([mention("n1")]);
    await notifier.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies only mentions that appear after the baseline", async () => {
    const { notifier, notify, setItems } = setup([mention("n1")]);
    await notifier.check();
    setItems([mention("n2"), mention("n1")]);
    await notifier.check();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].id).toBe("n2");
    await notifier.check();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("ignores non-mention notifications", async () => {
    const { notifier, notify, setItems } = setup([]);
    await notifier.check();
    setItems([mention("t1", { type: "task.assigned" })]);
    await notifier.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent while the user is looking at the app, without replaying later", async () => {
    const state = { away: false };
    let items: InboxItem[] = [];
    const notify = vi.fn();
    const notifier = createMentionNotifier({
      fetchUnread: async () => items,
      notify,
      isActive: () => true,
      isAway: () => state.away,
    });
    await notifier.check();
    items = [mention("n1")];
    await notifier.check();
    state.away = true;
    await notifier.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("stays silent when the setting/permission is off", async () => {
    const { notifier, notify, setItems } = setup([], { active: false });
    await notifier.check();
    setItems([mention("n1")]);
    await notifier.check();
    expect(notify).not.toHaveBeenCalled();
  });

  it("serialises overlapping checks so one mention fires once", async () => {
    const { notifier, notify, setItems } = setup([]);
    await notifier.check();
    setItems([mention("n1")]);
    await Promise.all([notifier.check(), notifier.check()]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("survives a failed fetch", async () => {
    const notifier = createMentionNotifier({
      fetchUnread: () => Promise.reject(new Error("offline")),
      notify: vi.fn(),
      isActive: () => true,
      isAway: () => true,
    });
    await expect(notifier.check()).resolves.toBeUndefined();
  });
});

describe("browser notify setting", () => {
  afterEach(() => localStorage.clear());

  it("persists per device and announces the change", () => {
    const onChange = vi.fn();
    window.addEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
    expect(getBrowserNotifyEnabled()).toBe(false);
    setBrowserNotifyEnabled(true);
    expect(localStorage.getItem(BROWSER_NOTIFY_PREF_KEY)).toBe("1");
    expect(getBrowserNotifyEnabled()).toBe(true);
    setBrowserNotifyEnabled(false);
    expect(getBrowserNotifyEnabled()).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(BROWSER_NOTIFY_CHANGE_EVENT, onChange);
  });
});

describe("mentionNotice", () => {
  it("names the actor when known and tags by notification id", () => {
    expect(mentionNotice(mention("n9", { actorName: "山田" }))).toEqual({
      title: "山田 さんがあなたをメンションしました",
      body: "クリックしてチャットを開く",
      tag: "dub-notif-n9",
    });
    expect(mentionNotice(mention("n9")).title).toBe("メンションされました");
  });
});
