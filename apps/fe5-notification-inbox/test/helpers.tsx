import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { createNotificationApi, type NotificationApi } from "../src/api/client";
import { createMockApiClient, type MockSeed } from "../src/api/mock-client";
import { NotificationProvider, type NotificationDeps } from "../src/context";

export interface TestHarness {
  api: NotificationApi;
  store: { items: ReturnType<typeof createMockApiClient>["__store"] };
  navigate: ReturnType<typeof vi.fn>;
  toast: { show: ReturnType<typeof vi.fn> };
}

export function makeDeps(
  seed: MockSeed = {},
  extra: Partial<NotificationDeps> = {},
): { deps: NotificationDeps; harness: TestHarness } {
  const client = createMockApiClient(seed);
  const api = createNotificationApi(client);
  const navigate = vi.fn();
  const toast = { show: vi.fn() };
  const deps: NotificationDeps = {
    api,
    navigate,
    toast,
    pollIntervalMs: 10_000_000, // effectively disable interval churn in tests
    ...extra,
  };
  return {
    deps,
    harness: { api, store: { items: client.__store }, navigate, toast },
  };
}

export function renderWithDeps(ui: ReactElement, deps: NotificationDeps): RenderResult {
  return render(<NotificationProvider deps={deps}>{ui}</NotificationProvider>);
}
