import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBoard, stageOf } from "./StatusBoard.tsx";
import type { Feature, FeaturePhase } from "./lib/commanderApi.ts";

function feature(id: string, phase: FeaturePhase, title = id): Feature {
  return { id, title, phase, ledgerRef: null, createdAt: "t0", updatedAt: "t0" };
}

describe("stageOf — phase -> column mapping", () => {
  it("maps rejected/building phases to 実装中", () => {
    expect(stageOf("demo_building").key).toBe("building");
    expect(stageOf("demo_rejected").key).toBe("building");
    expect(stageOf("staging_rejected").key).toBe("building");
  });
  it("maps review/deployed/prod phases to their stage", () => {
    expect(stageOf("demo_review").key).toBe("demo");
    expect(stageOf("staging_deployed").key).toBe("staging");
    expect(stageOf("staging_review").key).toBe("staging");
    expect(stageOf("prod_shipped").key).toBe("prod");
  });
});

describe("<StatusBoard>", () => {
  const features = [
    feature("a", "demo_building"),
    feature("b", "demo_review"),
    feature("c", "staging_review"),
    feature("d", "prod_shipped"),
    feature("e", "demo_rejected"),
  ];

  it("groups every feature into the right column with counts", () => {
    render(<StatusBoard features={features} />);
    expect(screen.getByTestId("stage-count-building")).toHaveTextContent("2"); // a + e
    expect(screen.getByTestId("stage-count-demo")).toHaveTextContent("1");
    expect(screen.getByTestId("stage-count-staging")).toHaveTextContent("1");
    expect(screen.getByTestId("stage-count-prod")).toHaveTextContent("1");

    const building = screen.getByTestId("stage-building");
    expect(within(building).getByTestId("stage-card-a")).toBeInTheDocument();
    expect(within(building).getByTestId("stage-card-e")).toBeInTheDocument();
  });

  it("shows the precise phase label on each card", () => {
    render(<StatusBoard features={[feature("e", "demo_rejected")]} />);
    expect(screen.getByTestId("stage-card-e")).toHaveTextContent("demo却下(要修正)");
  });

  it("calls onSelect when a card is clicked", async () => {
    const onSelect = vi.fn();
    render(<StatusBoard features={features} onSelect={onSelect} />);
    await userEvent.click(screen.getByTestId("stage-card-c"));
    expect(onSelect).toHaveBeenCalledWith("c");
  });
});
