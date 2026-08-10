# @dub/observability

Cloudflare Workers–safe observability primitives for the Dub ecosystem: a
structured **logger** with request-id correlation, **request-correlation helpers**
for propagating `x-dub-*` headers, and **lightweight metrics**. Zero runtime
dependencies; secrets are redacted before anything leaves the process.

## Why

Every Worker needs the same three things and should not reinvent them:

1. **Structured logs** that carry the caller's `requestId` so one trace can be
   reconstructed across service hops.
2. **Correlation propagation** — read the incoming `x-dub-request-id` / `x-dub-user-id`
   / `x-dub-caller` and re-attach them to downstream fetches.
3. **Cheap metrics** (counters / gauges / timings) emitted on the log pipeline the
   Worker already has — no external agent, no background timers.

`requestId` **minting** is intentionally NOT here — that is `@dub/http`'s job (the
single ULID entrypoint minter). This package only *reads* and *carries* an id.

## API

```ts
import {
  createLogger, requestLogger,          // structured logger
  readCorrelation, correlationHeaders,  // propagate x-dub-* headers
  createMetrics, metricsFor,            // counters / gauges / timings
} from "@dub/observability";
```

### Logger

```ts
const log = createLogger({ requestId: "r1", userId: "u1", caller: "api-gateway" });
log.info("handling request", { path: "/me" });
log.warn("slow upstream", { ms: 1200 });
log.error("upstream failed", { status: 502 });

const child = log.child({ route: "/me" }); // permanently-bound extra fields
```

Each call emits one JSON line: `{ level, message, time, requestId, userId, caller,
service, fields }`. Fields are deep-redacted (`token`, `password`, `authorization`,
… → `[REDACTED]`) before hitting the sink. Options: `minLevel`, custom `sink`,
`redactKeys`, `fields`.

### Request correlation

```ts
// inbound Worker handler
const cx = readCorrelation(request);              // { requestId?, userId?, caller? }
const log = requestLogger(request, { service: "task-service" });

// outbound call to another internal service
await fetch(url, { headers: { ...correlationHeaders(cx), ...more } });
```

`readHeader` / `readRequestId` accept a `Headers`, a `Request`, or a plain object,
case-insensitively.

### Metrics

```ts
const metrics = createMetrics({ requestId: cx.requestId, service: "task-service" });
metrics.count("request", 1, { route: "/me" });
metrics.gauge("queue.depth", 12);

const stop = metrics.startTimer("db.query.ms", { table: "tasks" });
// ... work ...
stop(); // records the elapsed timing

// or straight from a correlation triplet:
const m = metricsFor(cx, { service: "task-service" });
```

Each metric is one JSON line under a `metric` key. Swap the destination with a
custom `sink` (e.g. forward to Analytics Engine / Logpush).

## Adopting in a service (later, per service — no service is changed by this package)

1. Add the workspace dependency (already resolvable via the `@dub/observability`
   path alias in `tsconfig.base.json`):

   ```jsonc
   // services/<svc>/package.json
   { "dependencies": { "@dub/observability": "workspace:*" } }
   ```

   and keep it in the service's `tsup.config.ts` `external` list (as the other
   services already do).

2. At the Worker entrypoint, derive a request-scoped logger + metrics once and pass
   them down (or stash on the Hono context):

   ```ts
   app.use("*", async (c, next) => {
     const cx = readCorrelation(c.req.raw);
     c.set("log", requestLogger(c.req.raw, { service: "task-service" }));
     c.set("metrics", metricsFor(cx, { service: "task-service" }));
     await next();
   });
   ```

3. On outbound internal calls, spread `correlationHeaders(cx)` so the trace
   continues downstream.

Services that only need the header constants / `redactSecrets` / `consoleSink`
keep importing exactly what they do today — those exports are unchanged.
