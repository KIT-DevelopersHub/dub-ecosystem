// The Mac mini provider: forwards summarize/ask to the EventDigestHub Durable Object,
// which relays them over the WebSocket the Mac mini dialed OUT (same shape as
// services/commander-relay — no inbound port on the Mac mini). No agent connected =>
// offline => the UI shows 「停止中」.
import type { event } from "@dub/types";
import { ProviderOfflineError, type AskInput, type AskOutput, type LlmProvider, type SummarizeInput } from "./types";

/** The slice of a DurableObjectStub this provider needs (fetch only; fakeable in tests). */
export interface HubStub {
  fetch(input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response>;
}

export function createRelayProvider(stub: HubStub, model = "local:mac-mini"): LlmProvider {
  async function rpc<T>(op: "summarize" | "ask", payload: unknown): Promise<T> {
    const res = await stub.fetch("https://event-digest-hub/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, payload }),
    });
    if (res.status === 503) throw new ProviderOfflineError();
    if (!res.ok) throw new Error(`relay ${op} failed: ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    id: model,
    async status() {
      try {
        const res = await stub.fetch("https://event-digest-hub/status");
        const body = (await res.json()) as { agentOnline?: boolean };
        return body.agentOnline ? "online" : "offline";
      } catch {
        return "offline";
      }
    },
    async summarize(input: SummarizeInput): Promise<event.EventDigestLine[]> {
      const r = await rpc<{ lines?: event.EventDigestLine[] }>("summarize", input);
      return Array.isArray(r.lines) ? r.lines : [];
    },
    async ask(input: AskInput): Promise<AskOutput> {
      // The Mac mini answers from its own local index; no Cloudflare-side context is sent.
      const r = await rpc<Partial<AskOutput>>("ask", { eventId: input.eventId, question: input.question });
      return { answer: typeof r.answer === "string" ? r.answer : "", sources: Array.isArray(r.sources) ? r.sources : [] };
    },
  };
}
