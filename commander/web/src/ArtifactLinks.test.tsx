import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactLinks } from "./ArtifactLinks.tsx";

describe("<ArtifactLinks>", () => {
  it("renders clickable demo / staging / PR links in the drawer variant", () => {
    render(
      <ArtifactLinks
        variant="drawer"
        urls={{
          demoUrl: "https://dub-demo.example.workers.dev",
          stagingUrl: "https://staging.example.workers.dev",
          prUrl: "https://github.com/o/r/pull/1",
        }}
      />,
    );
    expect(screen.getByTestId("artifact-link-demo")).toHaveAttribute("href", "https://dub-demo.example.workers.dev");
    expect(screen.getByTestId("artifact-link-staging")).toHaveAttribute("href", "https://staging.example.workers.dev");
    expect(screen.getByTestId("artifact-link-pr")).toHaveAttribute("href", "https://github.com/o/r/pull/1");
    expect(screen.getByText("demoを確認")).toBeInTheDocument();
  });

  it("shows a URL待ち skeleton while running with no URL yet", () => {
    render(<ArtifactLinks variant="drawer" running urls={{ demoUrl: null, stagingUrl: null, prUrl: null }} />);
    expect(screen.getByTestId("artifact-skeleton")).toBeInTheDocument();
  });

  it("shows an empty note when not running and no URL", () => {
    render(<ArtifactLinks variant="drawer" urls={{ demoUrl: null, stagingUrl: null, prUrl: null }} />);
    expect(screen.getByTestId("artifact-empty")).toBeInTheDocument();
  });

  it("renders compact chips on a card and nothing when empty", () => {
    const { rerender } = render(
      <ArtifactLinks variant="card" urls={{ demoUrl: "https://d.workers.dev", stagingUrl: null, prUrl: null }} />,
    );
    expect(screen.getByTestId("artifact-chip-demo")).toHaveAttribute("href", "https://d.workers.dev");

    rerender(<ArtifactLinks variant="card" urls={{ demoUrl: null, stagingUrl: null, prUrl: null }} />);
    expect(screen.queryByTestId("artifact-chips")).not.toBeInTheDocument();
  });
});
