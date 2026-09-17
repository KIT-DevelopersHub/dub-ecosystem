import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.tsx";
import { makeFakeApi, makeFakeClient } from "./test/fakes.ts";

describe("<App>", () => {
  it("mounts the board (composer entry + lanes)", async () => {
    render(<App client={makeFakeClient()} api={makeFakeApi([])} />);
    expect(screen.getByTestId("open-composer")).toBeInTheDocument();
    expect(await screen.findByTestId("board-lanes")).toBeInTheDocument();
  });
});
