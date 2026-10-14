import { describe, it, expect } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { ToastProvider } from "@dub/ui";
import { MockChatClient } from "../api/mock-client";
import { ChatApiError } from "../api/client";
import { demoSeed } from "../dev/seed";
import { useChatSections } from "./useChatSections";

const GENERAL = "chn_general00000000000000000";
const wrapper = ({ children }: { children: ReactNode }) => <ToastProvider>{children}</ToastProvider>;
const boom = () => new ChatApiError(500, { error: { code: "INTERNAL", message: "x", retryable: true } });

async function setup() {
  const api = new MockChatClient(demoSeed());
  const hook = renderHook(() => useChatSections(api), { wrapper });
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return { api, hook };
}

describe("useChatSections", () => {
  it("applies a move optimistically and rolls it back on failure", async () => {
    const { api, hook } = await setup();
    api.latencyMs = 20;
    api.nextError = boom();
    act(() => hook.result.current.move(GENERAL, "sec_seed_ops"));
    expect(hook.result.current.assignments[GENERAL]).toBe("sec_seed_ops"); // immediate
    await waitFor(() => expect(hook.result.current.assignments[GENERAL]).toBeUndefined());
  });

  it("creates with a temp section, swaps in the server id, and assigns the channel", async () => {
    const { api, hook } = await setup();
    act(() => hook.result.current.create("広報", GENERAL));
    expect(hook.result.current.sections.at(-1)!.name).toBe("広報");
    await waitFor(() => expect(hook.result.current.sections.at(-1)!.id.startsWith("sec_mock")).toBe(true));
    const realId = hook.result.current.sections.at(-1)!.id;
    expect(hook.result.current.assignments[GENERAL]).toBe(realId);
    await waitFor(async () => expect((await api.listSections()).assignments[GENERAL]).toBe(realId));
  });

  it("restores a deleted section and its channels when the delete fails", async () => {
    const { api, hook } = await setup();
    const before = hook.result.current.assignments;
    api.nextError = boom();
    act(() => hook.result.current.remove("sec_seed_ops"));
    await waitFor(() => expect(hook.result.current.sections.map((s) => s.id)).toEqual(["sec_seed_ops"]));
    expect(hook.result.current.assignments).toEqual(before);
  });
});
