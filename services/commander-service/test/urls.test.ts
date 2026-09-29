import { describe, it, expect } from "vitest";
import { extractArtifactUrls, mergeUrls, eventText } from "../src/urls";

describe("extractArtifactUrls", () => {
  it("pulls a demo workers.dev URL", () => {
    const out = extractArtifactUrls("deployed to https://dub-demo-usage.example.workers.dev ✅");
    expect(out.demoUrl).toBe("https://dub-demo-usage.example.workers.dev");
    expect(out.stagingUrl).toBeUndefined();
  });

  it("classifies a staging URL by the 'staging' marker", () => {
    const out = extractArtifactUrls("https://fe2-staging.example.workers.dev is live");
    expect(out.stagingUrl).toBe("https://fe2-staging.example.workers.dev");
    expect(out.demoUrl).toBeUndefined();
  });

  it("captures a pages.dev deploy too", () => {
    const out = extractArtifactUrls("preview: https://abc123.dub-web.pages.dev/");
    expect(out.demoUrl).toBe("https://abc123.dub-web.pages.dev/");
  });

  it("extracts a GitHub PR URL and strips trailing punctuation", () => {
    const out = extractArtifactUrls("opened PR https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/431.");
    expect(out.prUrl).toBe("https://github.com/KIT-DevelopersHub/dub-ecosystem/pull/431");
  });

  it("latest-wins on repeated deploys of the same kind", () => {
    const out = extractArtifactUrls(
      "https://dub-demo-old.example.workers.dev\n...redeploy...\nhttps://dub-demo-new.example.workers.dev",
    );
    expect(out.demoUrl).toBe("https://dub-demo-new.example.workers.dev");
  });

  it("finds demo + staging + PR together", () => {
    const out = extractArtifactUrls(`
      demo:    https://dub-demo-x.example.workers.dev
      staging: https://staging-x.example.workers.dev
      PR:      https://github.com/o/r/pull/12
    `);
    expect(out.demoUrl).toBe("https://dub-demo-x.example.workers.dev");
    expect(out.stagingUrl).toBe("https://staging-x.example.workers.dev");
    expect(out.prUrl).toBe("https://github.com/o/r/pull/12");
  });

  it("returns nothing for plain text", () => {
    expect(extractArtifactUrls("just some log output, no urls here")).toEqual({});
  });
});

describe("mergeUrls", () => {
  it("keeps prior values when the new chunk lacks them", () => {
    const merged = mergeUrls(
      { demoUrl: "https://a.workers.dev" },
      { prUrl: "https://github.com/o/r/pull/1" },
    );
    expect(merged.demoUrl).toBe("https://a.workers.dev");
    expect(merged.prUrl).toBe("https://github.com/o/r/pull/1");
  });
});

describe("eventText", () => {
  it("reads url from a stdout line payload", () => {
    const text = eventText({ line: "https://dub-demo.example.workers.dev" });
    expect(extractArtifactUrls(text).demoUrl).toBe("https://dub-demo.example.workers.dev");
  });

  it("reads url from a claude result payload", () => {
    const text = eventText({ data: { type: "result", result: "PR: https://github.com/o/r/pull/7" } });
    expect(extractArtifactUrls(text).prUrl).toBe("https://github.com/o/r/pull/7");
  });
});
