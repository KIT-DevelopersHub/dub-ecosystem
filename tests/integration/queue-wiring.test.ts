// Queue-wiring conformance (wire/queue-wiring). Validates that every service's
// wrangler.toml Queue topology matches the frozen P0b catalog (dub-q- prefix,
// 12 contract queues + DLQ) and that producer binding->queue names agree with
// @dub/events CONSUMER_QUEUE_BINDINGS. This is a config-level guard for the class
// of bug where a producer publishes to `dub-q-notification` while the only
// consumer listens on `dub-q-evt-notification` (messages silently dropped).
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONSUMER_QUEUE_BINDINGS } from "@dub/events";

const SERVICES_DIR = join(process.cwd(), "services");

// Frozen queue catalog (P0b theme#1): 7 domain + 1 audit + 4 webhook contract
// queues, plus the deploy-service private job queue, plus all -dlq variants.
const DOMAIN_QUEUES = Object.values(CONSUMER_QUEUE_BINDINGS).map(
  (binding) => `dub-q-evt-${binding.replace(/^EVT_/, "").toLowerCase().replace(/_/g, "-")}`,
);
const CONTRACT_QUEUES = [
  ...DOMAIN_QUEUES,
  "dub-q-audit-record",
  "dub-q-wh-github",
  "dub-q-wh-google-drive",
  "dub-q-wh-gmail",
  "dub-q-wh-stripe",
];
const PRIVATE_QUEUES = ["dub-q-deploy-jobs"];
const ALLOWED_QUEUES = new Set([
  ...CONTRACT_QUEUES,
  ...PRIVATE_QUEUES,
  ...[...CONTRACT_QUEUES, ...PRIVATE_QUEUES].map((q) => `${q}-dlq`),
]);

// Expected binding -> queue-name map from the frozen catalog.
const EXPECTED_BINDING_QUEUE: Record<string, string> = {
  AUDIT_QUEUE: "dub-q-audit-record",
  WH_GITHUB: "dub-q-wh-github",
  WH_GOOGLE_DRIVE: "dub-q-wh-google-drive",
  WH_GMAIL: "dub-q-wh-gmail",
  WH_STRIPE: "dub-q-wh-stripe",
};
for (const [consumer, binding] of Object.entries(CONSUMER_QUEUE_BINDINGS)) {
  EXPECTED_BINDING_QUEUE[binding] = `dub-q-evt-${consumer}`;
}

interface QueueBlock {
  kind: "producer" | "consumer";
  binding?: string;
  queue?: string;
  dlq?: string;
}

// Minimal line-based reader for [[queues.producers]] / [[queues.consumers]]
// blocks. Ignores commented (#) lines so documentation stubs don't count.
function parseQueueBlocks(toml: string): QueueBlock[] {
  const blocks: QueueBlock[] = [];
  let cur: QueueBlock | null = null;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[[queues.producers]]")) {
      cur = { kind: "producer" };
      blocks.push(cur);
      continue;
    }
    if (line.startsWith("[[queues.consumers]]")) {
      cur = { kind: "consumer" };
      blocks.push(cur);
      continue;
    }
    if (line.startsWith("[")) {
      cur = null; // left the queue block
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^(binding|queue|dead_letter_queue)\s*=\s*"([^"]+)"/);
    if (!m) continue;
    if (m[1] === "binding") cur.binding = m[2];
    else if (m[1] === "queue") cur.queue = m[2];
    else if (m[1] === "dead_letter_queue") cur.dlq = m[2];
  }
  return blocks;
}

function loadServices(): { name: string; blocks: QueueBlock[] }[] {
  return readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, path: join(SERVICES_DIR, d.name, "wrangler.toml") }))
    .filter((s) => existsSync(s.path))
    .map((s) => ({ name: s.dir, blocks: parseQueueBlocks(readFileSync(s.path, "utf8")) }));
}

describe("queue-wiring: wrangler.toml conformance to the frozen catalog", () => {
  const services = loadServices();

  it("discovers wrangler.toml for every service", () => {
    expect(services.length).toBeGreaterThan(10);
  });

  it("every queue/DLQ name belongs to the frozen dub-q- catalog", () => {
    const offenders: string[] = [];
    for (const { name, blocks } of services) {
      for (const b of blocks) {
        for (const q of [b.queue, b.dlq]) {
          if (!q) continue;
          if (!q.startsWith("dub-q-")) offenders.push(`${name}: ${q} (missing dub-q- prefix)`);
          else if (!ALLOWED_QUEUES.has(q)) offenders.push(`${name}: ${q} (not in frozen catalog)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("producer binding -> queue name matches @dub/events CONSUMER_QUEUE_BINDINGS", () => {
    const offenders: string[] = [];
    for (const { name, blocks } of services) {
      for (const b of blocks) {
        if (b.kind !== "producer" || !b.binding || !b.queue) continue;
        const expected = EXPECTED_BINDING_QUEUE[b.binding];
        if (expected && b.queue !== expected) {
          offenders.push(`${name}: ${b.binding} -> "${b.queue}" (expected "${expected}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every consumer declares a dead_letter_queue (poison isolation)", () => {
    const offenders: string[] = [];
    for (const { name, blocks } of services) {
      for (const b of blocks) {
        if (b.kind === "consumer" && b.queue && !b.dlq) {
          offenders.push(`${name}: consumer ${b.queue} has no dead_letter_queue`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every domain-event consumer queue has a producer somewhere (no orphan lanes)", () => {
    const produced = new Set<string>();
    const consumed = new Set<string>();
    for (const { blocks } of services) {
      for (const b of blocks) {
        if (b.kind === "producer" && b.queue) produced.add(b.queue);
        if (b.kind === "consumer" && b.queue) consumed.add(b.queue);
      }
    }
    // Every consumed domain-event lane must have at least one publisher.
    const orphanConsumers = [...consumed].filter(
      (q) => q.startsWith("dub-q-evt-") && !produced.has(q),
    );
    expect(orphanConsumers).toEqual([]);
  });
});
