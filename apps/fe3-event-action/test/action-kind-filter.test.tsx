// #934: picking a kind must not shrink the kind options to that kind only.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { renderWithProviders, setAuth, resetAuth, newQueryClient } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { ActionBoard } from "../src/components/ActionBoard";
import { eventKeys } from "../src/lib/queryKeys";

beforeEach(() => resetAuth());
afterEach(() => resetAuth());

function optionValues(): string[] {
  const select = screen.getByTestId("fe3-actionboard-kind-filter");
  return within(select)
    .getAllByRole("option")
    .map((o) => (o as HTMLOptionElement).value);
}

describe("ActionBoard kind filter (#934)", () => {
  it("keeps every kind selectable while filtered, also after a refetch", async () => {
    setAuth(["event:read"]);
    const api = createMockEventApi({ events: 1, actionsPerEvent: 3 });
    const [ev] = (await api.listEvents({ includeArchived: false })).items;
    const all = (await api.listActions(ev!.id)).items;
    const target = all.find((a) => a.kind === "announcement")!;
    const qc = newQueryClient();
    renderWithProviders(<ActionBoard eventId={ev!.id} canWrite={false} />, { api, queryClient: qc });

    await screen.findByTestId(`fe3-actionboard-card-${target.id}`);
    const expected = ["", "task_management", "announcement", "custom_survey"];
    expect(optionValues()).toEqual(expected);

    fireEvent.change(screen.getByTestId("fe3-actionboard-kind-filter"), { target: { value: "announcement" } });

    // The list narrows right away…
    await waitFor(() => {
      for (const a of all) {
        const card = screen.queryByTestId(`fe3-actionboard-card-${a.id}`);
        if (a.kind === "announcement") expect(card).not.toBeNull();
        else expect(card).toBeNull();
      }
    });
    expect(optionValues()).toEqual(expected);

    // …and the options survive a refetch (e.g. after a mutation invalidates the list).
    await qc.invalidateQueries({ queryKey: eventKeys.actions(ev!.id) });
    await waitFor(() => expect(optionValues()).toEqual(expected));
    expect(screen.getByTestId(`fe3-actionboard-card-${target.id}`)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("fe3-actionboard-kind-filter"), { target: { value: "custom_survey" } });
    const survey = all.find((a) => a.kind === "custom_survey")!;
    await screen.findByTestId(`fe3-actionboard-card-${survey.id}`);
    expect(screen.queryByTestId(`fe3-actionboard-card-${target.id}`)).toBeNull();
  });
});
