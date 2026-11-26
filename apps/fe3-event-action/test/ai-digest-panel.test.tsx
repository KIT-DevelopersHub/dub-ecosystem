// 「AI のまとめ」 panel (#879): release gate (admins only), 停止中 states (flag OFF /
// Mac mini offline), cited lines + 食い違い banner, and the venue/capacity input parser.
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { event } from "@dub/types";
import { EventAiDigestPanel } from "../src/components/EventAiDigestPanel";
import { parseCapacityInput } from "../src/components/EventEditForm";
import { createMockEventApi } from "../src/api/mockData";
import type { EventApi } from "../src/api/eventApi";
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
  it("is hidden from non-admin members while unreleased", () => {
    setAuth(["event:read", "event:write"]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, {
      api: apiWith({ enabled: true, provider: { id: "fake", status: "online" }, digest: DIGEST }),
    });
    expect(screen.queryByTestId("fe3-ai-digest")).toBeNull();
  });

  it("shows a skeleton first, then 停止中 when the feature flag is OFF (run + ask disabled)", async () => {
    setAuth([...ADMIN]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun />, {
      api: apiWith({ enabled: false, provider: { id: "local:mac-mini", status: "disabled" }, digest: null }),
    });
    expect(screen.getByTestId("fe3-ai-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("fe3-ai-stopped").textContent).toContain("停止中"));
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

  it("an online ask that the server reports offline shows 停止中 instead of an answer", async () => {
    setAuth([...ADMIN]);
    renderWithProviders(<EventAiDigestPanel eventId="evt_1" canRun={false} />, {
      api: apiWith({ enabled: true, provider: { id: "fake", status: "online" }, digest: DIGEST }),
    });
    await waitFor(() => expect(screen.getByTestId("fe3-ai-lines")).toBeTruthy());
    expect(screen.queryByTestId("fe3-ai-run")).toBeNull(); // canRun=false: no 今すぐ要約
    fireEvent.change(screen.getByTestId("fe3-ai-ask-input"), { target: { value: "会場は？" } });
    fireEvent.click(screen.getByTestId("fe3-ai-ask-submit"));
    await waitFor(() => expect(screen.getByTestId("fe3-ai-stopped")).toBeTruthy());
    expect(screen.queryByTestId("fe3-ai-answer")).toBeNull();
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
