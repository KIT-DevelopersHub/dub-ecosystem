// Regression (⑤ 判断88): when GET /events/:id/details fails (e.g. the detail store
// isn't provisioned yet), the hub panel must NOT hang on the skeleton forever. It
// degrades to the empty「未記入」view so everything below the title stays usable.
import { waitFor, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EventDetailsPanel } from "../src/components/EventDetailsPanel";
import { createMockEventApi } from "../src/api/mockData";
import type { EventApi } from "../src/api/eventApi";
import { renderWithProviders, setAuth, resetAuth, newQueryClient } from "./util";

afterEach(() => resetAuth());

function apiWithFailingDetails(): EventApi {
  const base = createMockEventApi({ events: 1, actionsPerEvent: 0 });
  return { ...base, getEventDetails: vi.fn().mockRejectedValue(new Error("details store unavailable")) };
}

test("details panel degrades to the empty view when the details fetch fails (no infinite skeleton)", async () => {
  setAuth(["event:read", "event:write"]);
  renderWithProviders(<EventDetailsPanel eventId={"evt_x"} canWrite />, {
    api: apiWithFailingDetails(),
    queryClient: newQueryClient(),
  });

  // Settles to the view (not the perpetual skeleton) and surfaces the load-error hint.
  // Allow for the single retry's back-off before the query settles to isError.
  await waitFor(() => expect(screen.getByTestId("fe3-details")).toBeInTheDocument(), { timeout: 4000 });
  expect(screen.queryByTestId("fe3-details-skeleton")).toBeNull();
  expect(screen.getByTestId("fe3-details-load-error")).toBeInTheDocument();
  // Empty sections render their placeholder rather than hanging.
  expect(screen.getByText("概要は未記入です。")).toBeInTheDocument();
});
