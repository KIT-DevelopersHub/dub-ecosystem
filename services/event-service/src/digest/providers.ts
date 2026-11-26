// LLM providers. Exactly three, and none of them calls an external LLM API (#879 owner
// decision: no external LLM; Mac mini down => 「停止中」, no fallback).
//   offline  — the production default while the Mac mini is not installed
//   fake     — deterministic, for tests and the demo (no model at all)
//   relay    — the Mac mini local model behind the EventDigestHub DO (relay-provider.ts)
import type { event } from "@dub/types";
import { ProviderOfflineError, type AskInput, type AskOutput, type LlmProvider, type SummarizeInput } from "./types";

export function createOfflineProvider(id = "local:mac-mini"): LlmProvider {
  return {
    id,
    async status() {
      return "offline";
    },
    async summarize(): Promise<event.EventDigestLine[]> {
      throw new ProviderOfflineError();
    },
    async ask(): Promise<AskOutput> {
      throw new ProviderOfflineError();
    },
  };
}

/** Restates collected items verbatim (each with its own link). No model. */
export function createFakeProvider(): LlmProvider {
  return {
    id: "fake",
    async status() {
      return "online";
    },
    async summarize(input: SummarizeInput): Promise<event.EventDigestLine[]> {
      return input.all.flatMap((s) => s.items.slice(0, 5).map((i) => ({ text: i.text, source: i.source, link: i.link })));
    },
    async ask(input: AskInput): Promise<AskOutput> {
      const words = input.question.split(/[\s、。？?]+/).filter((w) => w.length >= 2);
      const hits = (await input.context())
        .flatMap((s) => s.items)
        .filter((i) => words.some((w) => i.text.includes(w)))
        .slice(0, 3);
      if (hits.length === 0) return { answer: "手元の情報には見つかりませんでした。", sources: [] };
      return { answer: hits.map((h) => h.text).join(" / "), sources: hits.map((h) => ({ label: h.text.slice(0, 40), link: h.link })) };
    },
  };
}
