import { describe, it, expect, beforeEach } from "vitest";
import {
  CONNECTION_KEY,
  clientsFor,
  isAllowedUrl,
  loadConnection,
  saveConnection,
} from "./connection.ts";

const REMOTE = {
  daemonUrl: "https://commander-daemon.example.jp/",
  apiUrl: " https://commander-api.example.jp ",
  token: " secret ",
};

describe("isAllowedUrl", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(isAllowedUrl("https://commander-api.example.jp")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:8798")).toBe(true);
    expect(isAllowedUrl("http://localhost:4319")).toBe(true);
  });
  it("rejects plain http to a remote host (the token would travel in clear)", () => {
    expect(isAllowedUrl("http://commander-api.example.jp")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
  });
});

describe("save/load connection", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a normalized connection", () => {
    saveConnection(REMOTE);
    expect(loadConnection()).toEqual({
      daemonUrl: "https://commander-daemon.example.jp",
      apiUrl: "https://commander-api.example.jp",
      token: "secret",
    });
  });

  it("returns null when nothing or garbage is stored", () => {
    expect(loadConnection()).toBeNull();
    localStorage.setItem(CONNECTION_KEY, "{bad json");
    expect(loadConnection()).toBeNull();
    localStorage.setItem(CONNECTION_KEY, JSON.stringify({ daemonUrl: "http://evil.example", apiUrl: "https://a.jp", token: "x" }));
    expect(loadConnection()).toBeNull();
  });

  it("clears back to the loopback default", () => {
    saveConnection(REMOTE);
    saveConnection(null);
    expect(loadConnection()).toBeNull();
    expect(clientsFor(null)).toEqual({});
  });
});

describe("clientsFor", () => {
  it("sends the token to the remote service", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const { api } = clientsFor({ daemonUrl: "https://d.example.jp", apiUrl: "https://a.example.jp/", token: "tok" });
      await api!.listBoard();
    } finally {
      globalThis.fetch = orig;
    }
    expect(calls[0]?.url).toBe("https://a.example.jp/tasks");
    expect(calls[0]?.headers["x-commander-token"]).toBe("tok");
  });
});
