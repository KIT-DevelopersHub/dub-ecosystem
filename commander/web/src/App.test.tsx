import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App, CommanderWorkspace } from "./App.tsx";
import { makeFakeApi, makeFakeClient } from "./test/fakes.ts";

describe("<App>", () => {
  it("mounts the board (composer entry + lanes)", async () => {
    render(<App client={makeFakeClient()} api={makeFakeApi([])} />);
    expect(screen.getByTestId("open-composer")).toBeInTheDocument();
    expect(await screen.findByTestId("board-lanes")).toBeInTheDocument();
  });
});

describe("<CommanderWorkspace>", () => {
  it("renders the same tabs as the standalone page without its chrome and switches panels", async () => {
    render(<CommanderWorkspace client={makeFakeClient()} api={makeFakeApi([])} />);
    expect(screen.queryByRole("heading", { name: "Commander" })).toBeNull();
    expect(await screen.findByTestId("board-lanes")).toBeInTheDocument();
    expect(screen.getByTestId("panel-board")).toBeVisible();
    expect(screen.getByTestId("panel-ask")).not.toBeVisible();

    await userEvent.click(screen.getByTestId("tab-ask"));
    expect(screen.getByTestId("tab-ask")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("panel-ask")).toBeVisible();
    expect(screen.getByTestId("panel-board")).not.toBeVisible();
  });
});
