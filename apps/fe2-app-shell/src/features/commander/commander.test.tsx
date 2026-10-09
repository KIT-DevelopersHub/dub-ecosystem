import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./CommanderScreen.tsx";

describe("isLoopbackHost", () => {
  it("keeps the direct 127.0.0.1 transport only on the operator's own machine", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    // Everything else (the deployed Dub app, a phone on the LAN) goes through the relay.
    expect(isLoopbackHost("dub-fe2-app-shell.developershub-site.workers.dev")).toBe(false);
    expect(isLoopbackHost("relay.localhost")).toBe(false);
    expect(isLoopbackHost("192.168.0.10")).toBe(false);
  });
});
