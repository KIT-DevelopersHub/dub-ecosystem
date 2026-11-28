// #930: the action list shows each kind's display label (not the internal kind)
// and the whole card opens the action, not just the title text.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { common } from "@dub/types";
import { renderWithProviders, setAuth, resetAuth } from "./util";
import { createMockEventApi } from "../src/api/mockData";
import { createActionTypeRegistry } from "../src/registry/ActionTypeRegistry";
import { genericActionPlugin } from "../src/components/GenericActionPanel";
import { ActionBoard } from "../src/components/ActionBoard";

function setup(onOpenAction = vi.fn()) {
  // Mock seeds kinds task_management / announcement / custom_survey per event.
  const api = createMockEventApi({ events: 1, actionsPerEvent: 3 });
  const registry = createActionTypeRegistry(genericActionPlugin);
  registry.register({ type: "task_management", label: "タスク管理", icon: "task", Panel: () => null });
  return { api, registry, onOpenAction };
}

async function renderBoard(onOpenAction = vi.fn()) {
  const { api, registry } = setup(onOpenAction);
  const { items } = await api.listEvents({});
  const eventId = items[0]!.id as common.EventId;
  renderWithProviders(<ActionBoard eventId={eventId} canWrite={false} onOpenAction={onOpenAction} />, { api, registry });
  await screen.findByText("アクション 1");
  const actions = (await api.listActions(eventId)).items;
  return { actions, onOpenAction };
}

describe("ActionBoard kind labels (#930)", () => {
  beforeEach(() => setAuth(["event:read"]));
  afterEach(() => resetAuth());

  it("shows the registered label, and the generic label for unknown kinds", async () => {
    const { actions } = await renderBoard();
    const byKind = Object.fromEntries(actions.map((a) => [a.kind, a.id]));
    expect(screen.getByTestId(`fe3-actionboard-kindbadge-${byKind.task_management}`)).toHaveTextContent("タスク管理");
    expect(screen.getByTestId(`fe3-actionboard-kindbadge-${byKind.announcement}`)).toHaveTextContent(genericActionPlugin.label);
    expect(screen.queryByText("task_management")).not.toBeInTheDocument();
  });

  it("lists labels in the kind filter, keeping unknown kinds distinct", async () => {
    await renderBoard();
    const filter = screen.getByTestId("fe3-actionboard-kind-filter");
    const options = within(filter).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "すべての種別",
      "タスク管理",
      `${genericActionPlugin.label}（announcement）`,
      `${genericActionPlugin.label}（custom_survey）`,
    ]);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["", "task_management", "announcement", "custom_survey"]);
  });

  // jsdom has no layout, so the stretched hit area (::after over the card) is checked
  // in a real browser; here we pin the single accessible open button per card.
  it("each card has one open button that opens the action", async () => {
    const { actions, onOpenAction } = await renderBoard();
    const target = actions[0]!;
    const card = screen.getByTestId(`fe3-actionboard-card-${target.id}`);
    const buttons = within(card).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    expect(onOpenAction).toHaveBeenCalledWith(target.id);
  });
});
