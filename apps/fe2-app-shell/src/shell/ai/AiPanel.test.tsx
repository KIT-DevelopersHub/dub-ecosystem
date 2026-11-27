// The header AI button + right-side AI panel: open/close (button, ⌘J, ×), remembered in
// localStorage, the 公開予定 notice with a disabled input, the event context + its
// 「AI のまとめ」 preview, and the phone-width sheet closing when a link navigates away.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { event, gateway } from "@dub/types";
import { createMockEventApi, useCurrentEventStore, type EventApi } from "@dub/fe3-event-action";
import type { ApiClient } from "../../lib/api-client.tsx";
import { AuthProvider } from "../../auth/AuthProvider.tsx";
import { AppShellLayout } from "../AppShellLayout.tsx";
import { useUiStore } from "../../store/uiStore.tsx";
import type { NavEntry } from "../../modules/types.tsx";
import { AiPanelHost } from "./AiPanelHost.tsx";

const ME: gateway.MeResponse = {
  user: { id: "usr_1", displayName: "Kota", avatarUrl: null, email: "kota@developershub.jp" },
  orgId: "org_devhub",
  permissions: [],
  sessionExpiresAt: Date.now() + 60_000,
};
const NAV: NavEntry[] = [
  { label: "イベント", path: "/events", icon: "calendar", order: 10 },
  { label: "メール", path: "/mail", icon: "inbox", order: 20 },
];
const api = { auth: { me: () => Promise.resolve(ME) } } as unknown as ApiClient;

function renderShell(pathname = "/mail") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider api={api}>
        <AppShellLayout navEntries={NAV} pathname={pathname}>
          <div data-testid="outlet">content</div>
        </AppShellLayout>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const PREVIEW: event.EventDigestPreview = {
  lines: [{ text: "イベント「北陸ITカンファレンス」・定員 300人", source: "event", link: "/events/evt_1" }],
  discrepancies: [],
  collectedAt: "2026-11-26T00:00:00.000Z",
};
function eventApiWith(title: string): EventApi {
  const base = createMockEventApi();
  return {
    ...base,
    getEvent: async (id) => ({ ...(await base.getEvent(id).catch(() => ({}) as event.GetEventResponse)), id, title }) as event.GetEventResponse,
    getEventDigest: async () => ({
      enabled: false,
      provider: { id: "offline", status: "disabled" as const },
      digest: null,
      preview: PREVIEW,
    }),
  };
}

function renderHost(props: Partial<Parameters<typeof AiPanelHost>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiPanelHost pathname="/events/evt_1" navEntries={NAV} onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ aiPanelOpen: false });
  useCurrentEventStore.setState({ eventId: null });
});

describe("AI side panel in the shell", () => {
  it("the header AI button opens and closes the panel and remembers the state", async () => {
    renderShell();
    const toggle = await screen.findByTestId("fe2-ai-panel-toggle");
    expect(screen.queryByTestId("fe2-ai-panel")).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByTestId("fe2-ai-panel")).toBeInTheDocument();
    expect(localStorage.getItem("dub.ui.aiPanel")).toBe("open");
    await userEvent.click(screen.getByTestId("fe2-ai-panel-close"));
    expect(screen.queryByTestId("fe2-ai-panel")).toBeNull();
    expect(localStorage.getItem("dub.ui.aiPanel")).toBe("closed");
  });

  it("Cmd/Ctrl+J toggles the panel", async () => {
    renderShell();
    await screen.findByTestId("fe2-ai-panel-toggle");
    act(() => {
      fireEvent.keyDown(document, { key: "j", metaKey: true });
    });
    expect(screen.getByTestId("fe2-ai-panel")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: "j", ctrlKey: true });
    });
    expect(screen.queryByTestId("fe2-ai-panel")).toBeNull();
  });

  it("re-opens on the next visit when it was left open", async () => {
    localStorage.setItem("dub.ui.aiPanel", "open");
    // The store reads storage at module load; simulate a fresh load by re-reading it.
    useUiStore.setState({ aiPanelOpen: localStorage.getItem("dub.ui.aiPanel") === "open" });
    renderShell();
    expect(await screen.findByTestId("fe2-ai-panel")).toBeInTheDocument();
  });

  it("while the AI is off: input disabled + 「現在は利用できません。12/3 公開予定です。」, and the open app as context", async () => {
    useUiStore.setState({ aiPanelOpen: true });
    renderShell("/mail");
    await screen.findByTestId("fe2-ai-panel");
    expect(screen.getByTestId("fe2-ai-panel-unavailable")).toHaveTextContent("現在は利用できません。12/3 公開予定です。");
    expect(screen.getByTestId("fe2-ai-panel-input")).toBeDisabled();
    expect(screen.getByTestId("fe2-ai-panel-send")).toBeDisabled();
    expect(screen.getByTestId("fe2-ai-panel-context")).toHaveTextContent("メール");
    expect(screen.getByTestId("fe2-ai-panel-hint")).toBeInTheDocument();
  });

  it("with an event in focus: shows the event name and its 「AI のまとめ」 preview", async () => {
    renderHost({ eventApi: eventApiWith("北陸ITカンファレンス 2026") });
    await waitFor(() => expect(screen.getByTestId("fe2-ai-panel-context")).toHaveTextContent("北陸ITカンファレンス 2026"));
    await waitFor(() => expect(screen.getByTestId("fe2-ai-panel-digest-preview-lines")).toHaveTextContent("定員 300人"));
    expect(screen.getByTestId("fe2-ai-panel-input")).toBeDisabled();
  });

  it("the header-selected event is the context on the events hub", async () => {
    useCurrentEventStore.setState({ eventId: "evt_9" });
    renderHost({ pathname: "/events", eventApi: eventApiWith("選んだイベント") });
    await waitFor(() => expect(screen.getByTestId("fe2-ai-panel-context")).toHaveTextContent("選んだイベント"));
  });

  it("on a phone the sheet closes when a source link navigates", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 640px"),
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const onClose = vi.fn();
      const onNavigate = vi.fn();
      renderHost({ eventApi: eventApiWith("北陸ITカンファレンス"), onClose, onNavigate });
      const lines = await screen.findByTestId("fe2-ai-panel-digest-preview-lines");
      await userEvent.click(lines.querySelector("button")!);
      expect(onNavigate).toHaveBeenCalledWith("/events/evt_1");
      expect(onClose).toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("the send function is injectable: once wired, an answer appears in the panel", async () => {
    const sender = vi.fn().mockResolvedValue({ status: "answered", answer: "済んでいます", sources: [] });
    renderHost({ eventApi: eventApiWith("北陸ITカンファレンス"), sender });
    const input = await screen.findByTestId("fe2-ai-panel-input");
    fireEvent.change(input, { target: { value: "会場は？" } });
    await userEvent.click(screen.getByTestId("fe2-ai-panel-send"));
    expect(sender).toHaveBeenCalledWith("会場は？");
    expect(await screen.findByTestId("fe2-ai-panel-answers")).toHaveTextContent("済んでいます");
  });
});
