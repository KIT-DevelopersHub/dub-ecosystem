// Compose window drag-to-move (下書きウィンドウを移動できるように): the header is a drag
// handle on desktop; the window stays inside the viewport, keeps minimize/maximize/close
// working, remembers its spot for the session, and is full-width (no drag) on phones.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailApi } from "../mailApi.tsx";
import { MailApiProvider } from "../MailProvider.tsx";
import { GmailApp } from "./GmailApp.tsx";
import { COMPOSE_POSITION_KEY, clampPos } from "./useDraggableWindow.ts";

function fakeApi(over: Partial<MailApi> = {}): MailApi {
  return {
    send: vi.fn().mockResolvedValue({ messageId: "m", provider: "resend", acceptedAt: "t" }),
    listInbox: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    markRead: vi.fn().mockResolvedValue({ read: true }),
    listSent: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getSent: vi.fn(),
    downloadAttachment: vi.fn().mockResolvedValue(new Blob(["x"])),
    listFlags: vi.fn().mockResolvedValue([]),
    setFlags: vi.fn().mockResolvedValue({ threadId: "t", starred: false, archived: false, trashed: false, purged: false }),
    schedule: vi.fn().mockResolvedValue({ id: "sch", scheduledAt: "2099-01-01T00:00:00.000Z", status: "scheduled" }),
    listScheduled: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    updateScheduled: vi.fn().mockResolvedValue({ id: "sch", to: [], subject: "s", snippet: "", scheduledAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", status: "scheduled", textBody: "b" }),
    cancelScheduled: vi.fn().mockResolvedValue({ id: "sch", status: "canceled" }),
    setReadState: vi.fn().mockResolvedValue(undefined),
    markFolderRead: vi.fn().mockResolvedValue(undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockImplementation((id: string, d: object) => Promise.resolve({ ...d, id, updatedAt: "2026-01-01T00:00:00.000Z", attachments: [] })),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
    addDraftAttachment: vi.fn().mockResolvedValue({ id: "datt", filename: "f", contentType: "text/plain", sizeBytes: 1 }),
    removeDraftAttachment: vi.fn().mockResolvedValue(undefined),
    listBlocks: vi.fn().mockResolvedValue([]),
    addBlock: vi.fn().mockImplementation((req: { value: string; kind?: "address" | "domain" }) => Promise.resolve({ value: req.value.toLowerCase(), kind: req.kind ?? "address", createdAt: "2026-01-01T00:00:00.000Z" })),
    getForward: vi.fn().mockResolvedValue({ target: null, status: "none", enabled: false, active: false, available: true, requestedAt: null, verifiedAt: null, lastResult: null, lastError: null, lastAt: null }),
    registerForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    avatars: vi.fn().mockResolvedValue({ avatars: {} }),
    removeBlock: vi.fn().mockImplementation((value: string) => Promise.resolve({ value, blocked: false })),
    counts: vi.fn().mockRejectedValue(new Error("no counts")),
    ...over,
  };
}

function wrap(ui: ReactNode, api: MailApi = fakeApi()): JSX.Element {
  return <MailApiProvider value={api}>{ui}</MailApiProvider>;
}

async function openCompose(): Promise<HTMLElement> {
  if (!screen.queryByTestId("fe2-mail-compose-open")) render(wrap(<GmailApp />));
  await userEvent.click(await screen.findByTestId("fe2-mail-compose-open"));
  return screen.findByTestId("fe2-mail-compose-window");
}

function pointer(target: EventTarget, type: string, x: number, y: number): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  });
}

function drag(handle: HTMLElement, from: [number, number], to: [number, number]): void {
  pointer(handle, "pointerdown", ...from);
  pointer(window, "pointermove", (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
  pointer(window, "pointermove", ...to);
  pointer(window, "pointerup", ...to);
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("ComposeWindow drag-to-move", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    setViewport(1280, 860);
  });
  afterEach(() => setViewport(1024, 768));

  it("moves the window by dragging its header (jsdom rect is 0,0 so grab offset = pointer)", async () => {
    const win = await openCompose();
    const header = screen.getByTestId("fe2-mail-compose-header");
    expect(header.dataset.draggable).toBe("true");
    drag(header, [100, 10], [300, 210]);
    expect(win.style.left).toBe("200px");
    expect(win.style.top).toBe("200px");
    expect(win.style.right).toBe("");
    expect(JSON.parse(sessionStorage.getItem(COMPOSE_POSITION_KEY)!)).toEqual({ x: 200, y: 200 });
  });

  it("clamps the window inside the viewport", async () => {
    const win = await openCompose();
    const header = screen.getByTestId("fe2-mail-compose-header");
    drag(header, [0, 0], [5000, 5000]);
    expect(win.style.left).toBe(`${1280 - 500}px`);
    expect(win.style.top).toBe(`${860 - 460}px`);
    drag(header, [0, 0], [-900, -900]);
    expect(win.style.left).toBe("0px");
    expect(win.style.top).toBe("0px");
  });

  it("re-clamps when the viewport shrinks", async () => {
    const win = await openCompose();
    drag(screen.getByTestId("fe2-mail-compose-header"), [0, 0], [700, 380]);
    expect(win.style.left).toBe("700px");
    setViewport(1000, 700);
    expect(win.style.left).toBe("500px");
    expect(win.style.top).toBe("240px");
  });

  it("does not start a drag from the header buttons and keeps minimize / maximize / close working", async () => {
    const user = userEvent.setup();
    const win = await openCompose();
    const header = screen.getByTestId("fe2-mail-compose-header");
    const minimize = screen.getByRole("button", { name: "最小化" });
    pointer(minimize, "pointerdown", 10, 10);
    pointer(window, "pointermove", 400, 400);
    pointer(window, "pointerup", 400, 400);
    expect(win.style.left).toBe("");

    drag(header, [0, 0], [300, 100]);
    await user.click(minimize);
    // Minimized windows dock at the bottom edge and are not draggable.
    expect(win.style.bottom).toBe("0px");
    expect(win.style.height).toBe("40px");
    expect(header.dataset.draggable).toBe("false");
    await user.click(header);
    expect(win.style.left).toBe("300px");
    expect(win.style.top).toBe("100px");

    await user.click(screen.getByRole("button", { name: "全画面表示" }));
    expect(header.dataset.draggable).toBe("false");
    expect(win.style.inset).toBe("48px");
    await user.click(screen.getByRole("button", { name: "元のサイズに戻す" }));
    expect(win.style.left).toBe("300px");

    await user.click(screen.getByTestId("fe2-mail-compose-close"));
    expect(screen.queryByTestId("fe2-mail-compose-window")).toBeNull();
  });

  it("reopens at the remembered position for the session", async () => {
    const user = userEvent.setup();
    let win = await openCompose();
    drag(screen.getByTestId("fe2-mail-compose-header"), [0, 0], [250, 150]);
    await user.click(screen.getByTestId("fe2-mail-compose-close"));
    win = await openCompose();
    expect(win.style.left).toBe("250px");
    expect(win.style.top).toBe("150px");
  });

  it("is full-width and not draggable on a narrow (phone) viewport", async () => {
    setViewport(390, 844);
    const win = await openCompose();
    const header = screen.getByTestId("fe2-mail-compose-header");
    expect(header.dataset.draggable).toBe("false");
    expect(win.style.left).toBe("8px");
    expect(win.style.right).toBe("8px");
    drag(header, [0, 0], [200, 200]);
    expect(win.style.top).toBe("");
    fireEvent.click(header);
  });
});

describe("clampPos", () => {
  it("keeps the whole window inside the viewport, pinning to 0 when it does not fit", () => {
    const size = { width: 500, height: 460 };
    expect(clampPos({ x: -10, y: 20 }, size, { width: 1280, height: 860 })).toEqual({ x: 0, y: 20 });
    expect(clampPos({ x: 900, y: 500 }, size, { width: 1280, height: 860 })).toEqual({ x: 780, y: 400 });
    expect(clampPos({ x: 50, y: 50 }, size, { width: 400, height: 300 })).toEqual({ x: 0, y: 0 });
  });
});
