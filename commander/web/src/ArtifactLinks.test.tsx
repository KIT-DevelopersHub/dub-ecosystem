import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ArtifactLinks, primaryKey } from "./ArtifactLinks.tsx";

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

  describe("phase-aware primary env", () => {
    const all = {
      demoUrl: "https://d.workers.dev",
      stagingUrl: "https://s.workers.dev",
      prUrl: "https://github.com/o/r/pull/1",
    };

    it("primaryKey: demo phase → demo primary", () => {
      expect(primaryKey({ demoUrl: "https://d.workers.dev", stagingUrl: null, prUrl: null }, "demo_review")).toBe(
        "demo",
      );
    });

    it("primaryKey: staging phase → staging primary", () => {
      expect(primaryKey(all, "staging_review")).toBe("staging");
    });

    it("primaryKey: staging URL present promotes to staging even in demo phase", () => {
      expect(primaryKey(all, "demo_building")).toBe("staging");
    });

    it("primaryKey: prod phase → PR primary (shipped-record ref)", () => {
      expect(primaryKey(all, "prod_shipped")).toBe("pr");
    });

    it("primaryKey: degrades when the reached env's URL is missing", () => {
      // staging phase but no staging URL yet → fall back to demo
      expect(primaryKey({ demoUrl: "https://d.workers.dev", stagingUrl: null, prUrl: null }, "staging_deployed")).toBe(
        "demo",
      );
    });

    it("drawer: staging task shows staging as the primary (large) link, demo secondary/collapsed", () => {
      render(<ArtifactLinks variant="drawer" phase="staging_review" urls={all} />);
      expect(screen.getByTestId("artifact-link-staging")).toHaveAttribute("data-primary", "true");
      expect(screen.getByTestId("artifact-link-demo")).not.toHaveAttribute("data-primary");
      expect(screen.getByTestId("artifact-secondary")).toBeInTheDocument();
    });

    it("drawer: demo task shows demo as the primary link", () => {
      render(
        <ArtifactLinks
          variant="drawer"
          phase="demo_review"
          urls={{ demoUrl: "https://d.workers.dev", stagingUrl: null, prUrl: "https://github.com/o/r/pull/1" }}
        />,
      );
      expect(screen.getByTestId("artifact-link-demo")).toHaveAttribute("data-primary", "true");
    });

    it("card: staging task marks the staging chip as primary", () => {
      render(<ArtifactLinks variant="card" phase="staging_review" urls={all} />);
      expect(screen.getByTestId("artifact-chip-staging")).toHaveAttribute("data-primary", "true");
      expect(screen.getByTestId("artifact-chip-demo")).not.toHaveAttribute("data-primary");
    });
  });
});
