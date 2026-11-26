// 「AI のまとめ」 panel (#879): shown to every member, the chat closed with the 公開予定
// notice, the flag-OFF preview (or the notice when there is nothing to show), 停止中 when
// the Mac mini is offline, cited lines + 食い違い banner, and the venue/capacity parser.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { event } from "@dub/types";
import { EventAiDigestPanel } from "../src/components/EventAiDigestPanel";
import { parseCapacityInput } from "../src/components/EventEditForm";
import { createMockEventApi } from "../src/api/mockData";
import type { EventApi } from "../src/api/eventApi";
import { AI_RELEASE_DATE_LABEL } from "../src/lib/aiDigestRelease";
import { renderWithProviders, resetAuth, setAuth } from "./util";

const ADMIN = ["identity:admin", "event:read", "event:write", "event:admin"] as const;

function apiWith(state: event.GetEventDigestResponse, ask?: event.AskEventResponse): EventApi {
  const base = createMockEventApi();
  return {
    ...base,
    getEventDigest: async () => state,
    askEvent: async () => ask ?? { status: "offline", answer: null, sources: [] },
  };
}

const DIGEST: event.EventDigest = {
  eventId: "evt_1",
  lines: [
    { text: "タスク「会場予約」期限 2026-08-05（遅れ）", source: "tasks", link: "/tasks/t1" },
    { text: "LP お知らせ", source: "lp", link: "https://hokuriku-it-conf.com" },
  ],
  discrepancies: [{ field: "startsAt", eventValue: "2026-09-13", sourceValue: "2026-09-14", source: "lp", link: "https://hokuriku-it-conf.com" }],
  model: "fake",
  trigger: "manual",
  generatedAt: "2026-08-09T00:00:00.000Z",
};

afterEach(() => resetAuth());

describe("EventAiDigestPanel", () => {
  const MEMBER = ["event:read", "event:write"] as const;
  const PREVIEW: event.EventDigestPreview = {
    lines: [
      { text: "イベント「北陸ITカンファレンス」・定員 300人", source: "event", link: "/events?eventId=evt_1" },
      { text: "アクション「会場予約」", source: "actions", link: "/events/evt_1" },
    ],
    discrepancies: [{ field: "capacity", eventValue: "300", sourceValue: "250", source: "event", link: "/events?eventId=evt_1" }],
    collectedAt: "2026-11-26T00:00:00.000Z",
  };
  const OFF = { enabled: false, provider: { id: "offline", status: "disabled" as const }, digest: null };

  it("a member sees the panel and the chat; the chat cannot be sent and shows the 公開予定 notice", async () => {
    setAuth([...MEMBER]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, { api: apiWith({ ...OFF, preview: PREVIEW }) });
    expect(screen.getByTestId("fe3-ai-digest")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("fe3-ai-ask")).toBeTruthy());
    expect(screen.getByTestId("fe3-ai-chat-unavailable").textContent).toBe(`現在は利用できません。${AI_RELEASE_DATE_LABEL} 公開予定です。`);
    expect(AI_RELEASE_DATE_LABEL).toBe("12/3");
    const input = screen.getByTestId("fe3-ai-ask-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "会場は？" } });
    expect((screen.getByTestId("fe3-ai-ask-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("fe3-ai-run")).toBeNull();
  });

  it("flag OFF with a preview: shows the event's own lines + 食い違い, no AI badge, no 停止中", async () => {
    setAuth([...MEMBER]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, { api: apiWith({ ...OFF, preview: PREVIEW }) });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-preview-lines")).toBeTruthy());
    expect(screen.getByTestId("fe3-ai-discrepancy").textContent).toContain("250");
    expect(screen.getByTestId("fe3-ai-preview-meta").textContent).toContain("12/3 公開予定です。");
    expect(screen.queryByTestId("fe3-ai-stopped")).toBeNull();
    expect(screen.queryByTestId("fe3-ai-digest-coming-soon")).toBeNull();
    expect(screen.queryByText("AI が作った要約です")).toBeNull();
  });

  it("flag OFF with nothing to show: the まとめ欄 shows the same 公開予定 notice", async () => {
    setAuth([...MEMBER]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, { api: apiWith(OFF) });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-digest-coming-soon")).toBeTruthy());
    expect(screen.getByTestId("fe3-ai-digest-coming-soon").textContent).toContain("現在は利用できません。12/3 公開予定です。");
  });

  it("admin: skeleton first, then flag OFF keeps 今すぐ要約 and the chat disabled", async () => {
    setAuth([...ADMIN]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun />, {
      api: apiWith({ enabled: false, provider: { id: "local:mac-mini", status: "disabled" }, digest: null }),
    });
    expect(screen.getByTestId("fe3-ai-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("fe3-ai-digest-coming-soon")).toBeTruthy());
    expect((screen.getByTestId("fe3-ai-run") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("fe3-ai-ask-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("enabled but the Mac mini is offline: 停止中, previous digest still readable", async () => {
    setAuth([...ADMIN]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun />, {
      api: apiWith({ enabled: true, provider: { id: "local:mac-mini", status: "offline" }, digest: DIGEST }),
    });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-stopped").textContent).toContain("Mac mini"));
    expect(screen.getByTestId("fe3-ai-lines")).toBeTruthy();
  });

  it("renders cited lines and the 食い違い banner; in-app links navigate", async () => {
    setAuth([...ADMIN]);
    const r = renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun />, {
      api: apiWith({ enabled: true, provider: { id: "fake", status: "online" }, digest: DIGEST }),
    });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-lines")).toBeTruthy());
    expect(screen.getByTestId("fe3-ai-discrepancy").textContent).toContain("2026-09-14");
    expect(screen.queryByTestId("fe3-ai-stopped")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /タスク/ }));
    expect(r.navigate).toHaveBeenCalledWith("/tasks/t1");
    const ext = screen.getAllByRole("link")[0] as HTMLAnchorElement;
    expect(ext.getAttribute("target")).toBe("_blank");
  });

  it("canRun=false hides 今すぐ要約 even with a digest", async () => {
    setAuth([...ADMIN]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, {
      api: apiWith({ enabled: true, provider: { id: "fake", status: "online" }, digest: DIGEST }),
    });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-lines")).toBeTruthy());
    expect(screen.queryByTestId("fe3-ai-run")).toBeNull();
    expect((screen.getByTestId("fe3-ai-ask-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("parseCapacityInput", () => {
  it("accepts blank (clear) and whole numbers in range, rejects the rest", () => {
    expect(parseCapacityInput("")).toBeNull();
    expect(parseCapacityInput(" 300 ")).toBe(300);
    expect(parseCapacityInput("0")).toBe(0);
    expect(parseCapacityInput("-1")).toBe("invalid");
    expect(parseCapacityInput("1.5")).toBe("invalid");
    expect(parseCapacityInput("三百")).toBe("invalid");
    expect(parseCapacityInput("100001")).toBe("invalid");
  });
});
