import { describe, it, expect, vi } from "vitest";
import { MobileBffClient } from "../src/bff-client";
import { HomeViewModel } from "../src/home-view-model";
import { InMemorySessionStore } from "../src/session-store";
import { makeMockServer, errorBody } from "./helpers";

function setup(server = makeMockServer()) {
  const store = new InMemorySessionStore();
  store.setSession("tok_1", "r_1");
  const client = new MobileBffClient({ fetchFn: server.fetch, store, onLogout: vi.fn() });
  return { vm: new HomeViewModel(client), server };
}

describe("HomeViewModel — UiState transitions (§2-2 MVI, §7)", () => {
  it("load success -> content (non-empty)", async () => {
    const server = makeMockServer({
      status: 200,
      body: { upcomingEvents: [{ id: "evt_1", title: "E", phase: "open", startsAt: null }], myTasks: [], unreadCount: 2 },
    });
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    expect(vm.uiState.status).toBe("content");
    if (vm.uiState.status === "content") {
      expect(vm.uiState.isEmpty).toBe(false);
      expect(vm.uiState.home.unreadCount).toBe(2);
    }
  });

  it("empty payload -> content with isEmpty=true", async () => {
    const server = makeMockServer({ status: 200, body: { upcomingEvents: [], myTasks: [], unreadCount: 0 } });
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    if (vm.uiState.status === "content") expect(vm.uiState.isEmpty).toBe(true);
    else throw new Error("expected content");
  });

  it("error keeps last-good cache for stale-while-error banner", async () => {
    const server = makeMockServer(
      { status: 200, body: { upcomingEvents: [], myTasks: [], unreadCount: 1 } }, // first load ok
      { status: 500, body: errorBody("INTERNAL") }, // refresh fails
    );
    const { vm } = setup(server);
    await vm.onEvent({ type: "load" });
    await vm.onEvent({ type: "refresh" });
    expect(vm.uiState.status).toBe("error");
    if (vm.uiState.status === "error") {
      expect(vm.uiState.error.kind).toBe("Server");
      expect(vm.uiState.cached?.unreadCount).toBe(1); // cached good state retained
    }
  });

  it("emits loading before first content", async () => {
    const server = makeMockServer({ status: 200, body: { upcomingEvents: [], myTasks: [], unreadCount: 0 } });
    const { vm } = setup(server);
    const statuses: string[] = [];
    vm.subscribe((s) => statuses.push(s.status));
    await vm.onEvent({ type: "load" });
    expect(statuses[0]).toBe("loading");
    expect(statuses.at(-1)).toBe("content");
  });
});
