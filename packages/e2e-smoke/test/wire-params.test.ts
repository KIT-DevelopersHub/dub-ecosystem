// Wire-parameter conformance: query-parameter NAMES reconciled across the three sides
// of every contract, so the `?event=` (fe) vs `?eventId=` (server) class of drift is
// caught in CI instead of in production.
//
//   SoT (@dub/types GANTT_WIRE)  ⟷  OpenAPI spec (docs/openapi/*.yaml)  ⟷  server reads
//
// The existing conformance.test.ts reconciles method+PATH only; this adds the query-key
// dimension it is blind to. gantt is the proof endpoint (the one that actually broke);
// docs/api-contracts/_wire-contract-enforcement.md documents extending this per service.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  gantt,
  event,
  fileMeta,
  webhook,
  githubSync,
  deploy,
  identity,
  mailAutomation,
  drive,
  auditLog,
  notification,
  mail,
  chat,
} from "@dub/types";
import { extractQueryParamsFromFile } from "../src/openapi";
import { specPathFor, appPathFor, type ServiceName } from "../src/conformance";

/** Every `.ts` under a service's src/ — some services read query params in sub-route
 *  files (e.g. deploy-service routes/deployments.ts), not just app.ts. `.req.query(` only
 *  appears in server-side handler code, so scanning the whole tree stays precise. */
function serviceSrcFiles(service: ServiceName): string[] {
  const srcDir = dirname(appPathFor(service));
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(srcDir);
  return out;
}

/** Every query-parameter name a service's app source actually consumes. Handles both
 *  read styles Dub services use:
 *    (a) keyed:        c.req.query("X")            -> "X"
 *    (b) destructured: const q = c.req.query(); q.X -> "X"
 *  so the "server reads == SoT" reconciliation works whether a handler pulls one key or
 *  destructures the whole query object. */
function serverQueryKeys(service: ServiceName): Set<string> {
  const keys = new Set<string>();
  const sources = serviceSrcFiles(service).map((f) => readFileSync(f, "utf8"));
  for (const src of sources) {
    // (a) keyed reads — single `c.req.query("x")` and repeatable `c.req.queries("x")`.
    const keyed = /\.req\.quer(?:y|ies)\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    for (let m; (m = keyed.exec(src)); ) keys.add(m[1]!);
    // (b) whole-object reads: each var bound to a no-arg `c.req.query()` in THIS file,
    //     then its `.prop` reads (kept per-file so bindings don't cross module boundaries).
    const bind = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$.]*\.req\.query\(\s*\)/g;
    const vars = new Set<string>();
    for (let m; (m = bind.exec(src)); ) vars.add(m[1]!);
    for (const v of vars) {
      const prop = new RegExp(`\\b${v}\\.([A-Za-z_$][\\w$]*)`, "g");
      for (let m; (m = prop.exec(src)); ) keys.add(m[1]!);
    }
  }
  // (c) parser reads: services that pass the whole query object to a validation parser
  //     (`parseX(c.req.query())`, parser defined in validation.ts) read the keys as
  //     `param.prop` inside the parser. Resolve each parser called with the raw query,
  //     then scan the file that DEFINES it for that param's property reads. These
  //     validation files are query-dedicated (their only `param.prop` reads are query
  //     keys), so scanning the whole defining file is robust and avoids brittle
  //     function-body brace matching (parser return types embed object literals).
  const all = sources.join("\n\n");
  const parsers = new Set<string>();
  const callRe = /([A-Za-z_$][\w$]*)\s*\(\s*[A-Za-z_$][\w$.]*\.req\.query\(\s*\)/g;
  for (let m; (m = callRe.exec(all)); ) parsers.add(m[1]!);
  for (const src of sources) {
    for (const name of parsers) {
      const defRe = new RegExp(
        `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?\\()\\s*([A-Za-z_$][\\w$]*)`,
      );
      const dm = defRe.exec(src);
      if (!dm) continue;
      const param = dm[1]!;
      const prop = new RegExp(`\\b${param}\\.([A-Za-z_$][\\w$]*)`, "g");
      for (let m; (m = prop.exec(src)); ) keys.add(m[1]!);
    }
  }
  return keys;
}

describe("gantt wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("gantt-service").file);
  const serverKeys = serverQueryKeys("gantt-service");

  // Union of every query key the SoT declares for gantt (here: just "eventId").
  const sotKeys = new Set<string>(Object.values(gantt.GANTT_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(gantt.GANTT_WIRE)) {
    it(`${op}: OpenAPI query params == GANTT_WIRE (${endpoint.query.join(",")})`, () => {
      // operationId in the spec matches the GANTT_WIRE key by construction.
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads only the SoT query keys (never a drifted alias like `event`)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `gantt-service reads c.req.query("${key}") not in the SoT`).toBe(true);
    }
    // and every SoT key is actually consumed by the server
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by gantt-service`).toBe(true);
    }
  });

  it("guards against the exact production regression (`event` is not a wire key anywhere)", () => {
    expect(sotKeys.has("event")).toBe(false);
    expect(serverKeys.has("event")).toBe(false);
    for (const params of Object.values(specParams)) expect(params).not.toContain("event");
  });
});

describe("event wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("event-service").file);
  const serverKeys = serverQueryKeys("event-service");

  // Union of every query key the SoT declares across event-service read endpoints.
  const sotKeys = new Set<string>(Object.values(event.EVENT_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(event.EVENT_WIRE)) {
    it(`${op}: OpenAPI query params == EVENT_WIRE (${endpoint.query.join(",")})`, () => {
      // operationId in the spec matches the EVENT_WIRE key by construction.
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `event-service reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by event-service`).toBe(true);
    }
  });
});

describe("file-meta wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("file-meta").file);
  const serverKeys = serverQueryKeys("file-meta");

  // Union of every query key the SoT declares across file-meta read endpoints.
  const sotKeys = new Set<string>(Object.values(fileMeta.FILE_META_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(fileMeta.FILE_META_WIRE)) {
    it(`${op}: OpenAPI query params == FILE_META_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `file-meta reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by file-meta`).toBe(true);
    }
  });
});

describe("webhook-ingest wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("webhook-ingest").file);
  const serverKeys = serverQueryKeys("webhook-ingest");

  const sotKeys = new Set<string>(Object.values(webhook.WEBHOOK_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(webhook.WEBHOOK_WIRE)) {
    it(`${op}: OpenAPI query params == WEBHOOK_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `webhook-ingest reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by webhook-ingest`).toBe(true);
    }
  });
});

describe("github-sync wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("github-sync").file);
  const serverKeys = serverQueryKeys("github-sync");

  const sotKeys = new Set<string>(Object.values(githubSync.GITHUB_SYNC_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(githubSync.GITHUB_SYNC_WIRE)) {
    it(`${op}: OpenAPI query params == GITHUB_SYNC_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (incl. repeatable syncState via c.req.queries)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `github-sync reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by github-sync`).toBe(true);
    }
  });
});

describe("deploy-service wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("deploy-service").file);
  const serverKeys = serverQueryKeys("deploy-service"); // reads routes/deployments.ts via the src-tree scan

  const sotKeys = new Set<string>(Object.values(deploy.DEPLOY_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(deploy.DEPLOY_WIRE)) {
    it(`${op}: OpenAPI query params == DEPLOY_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `deploy-service reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by deploy-service`).toBe(true);
    }
  });
});

describe("identity-roster wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("identity-roster").file);
  const serverKeys = serverQueryKeys("identity-roster");

  // Union across the public (/identity/*) read endpoints. `roleKey` is the accepted
  // deprecated alias of `role`; the internal /internal/users route reads a subset.
  const sotKeys = new Set<string>(Object.values(identity.IDENTITY_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(identity.IDENTITY_WIRE)) {
    it(`${op}: OpenAPI query params == IDENTITY_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (role canonical + roleKey deprecated alias, both accepted)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `identity-roster reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by identity-roster`).toBe(true);
    }
  });
});

describe("mail-automation wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("mail-automation").file);
  const serverKeys = serverQueryKeys("mail-automation");

  const sotKeys = new Set<string>(Object.values(mailAutomation.MAIL_AUTOMATION_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(mailAutomation.MAIL_AUTOMATION_WIRE)) {
    it(`${op}: OpenAPI query params == MAIL_AUTOMATION_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (no drifted alias, no undocumented read)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `mail-automation reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by mail-automation`).toBe(true);
    }
  });
});

describe("drive-proxy wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("drive-proxy").file);
  const serverKeys = serverQueryKeys("drive-proxy");

  const sotKeys = new Set<string>(Object.values(drive.DRIVE_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(drive.DRIVE_WIRE)) {
    it(`${op}: OpenAPI query params == DRIVE_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (canonical folderId; parentId no longer a wire key)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `drive-proxy reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by drive-proxy`).toBe(true);
    }
    // the resolved drift: parentId is gone from the contract, folderId is canonical
    expect(sotKeys.has("parentId")).toBe(false);
    expect(sotKeys.has("folderId")).toBe(true);
  });
});

describe("audit-log wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("audit-log").file);
  const serverKeys = serverQueryKeys("audit-log"); // reads keys via parseAuditLogQuery in validation.ts

  const sotKeys = new Set<string>(Object.values(auditLog.AUDIT_LOG_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(auditLog.AUDIT_LOG_WIRE)) {
    it(`${op}: OpenAPI query params == AUDIT_LOG_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (via the validation.ts parser)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `audit-log reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by audit-log`).toBe(true);
    }
  });
});

describe("notification wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("notification").file);
  const serverKeys = serverQueryKeys("notification"); // reads via parseListInbox/Feedback/ManageQuery

  // Union across the spec'd read endpoints (listInbox/listFeedback). The admin /manage
  // parser reads only cursor/limit — a subset — so it needs no separate WIRE entry.
  const sotKeys = new Set<string>(Object.values(notification.NOTIFICATION_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(notification.NOTIFICATION_WIRE)) {
    it(`${op}: OpenAPI query params == NOTIFICATION_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (incl. the admin /manage parser's subset)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `notification reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by notification`).toBe(true);
    }
  });
});

describe("mail-gateway wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("mail-gateway").file);
  const serverKeys = serverQueryKeys("mail-gateway"); // reads via parseListMessagesQuery in validation.ts

  // /messages and /sent share parseListMessagesQuery, so the union is that one parser's keys.
  const sotKeys = new Set<string>(Object.values(mail.MAIL_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(mail.MAIL_WIRE)) {
    it(`${op}: OpenAPI query params == MAIL_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (via the validation.ts parser; /messages + /sent share it)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `mail-gateway reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by mail-gateway`).toBe(true);
    }
  });
});

describe("chat-service wire-contract: query keys agree across SoT ⟷ OpenAPI ⟷ server", () => {
  const specParams = extractQueryParamsFromFile(specPathFor("chat-service").file);
  const serverKeys = serverQueryKeys("chat-service"); // in-handler `const q = c.req.query()` reads

  // Union across the read endpoints. /chat/unread takes no query params.
  const sotKeys = new Set<string>(Object.values(chat.CHAT_WIRE).flatMap((e) => [...e.query]));

  for (const [op, endpoint] of Object.entries(chat.CHAT_WIRE)) {
    it(`${op}: OpenAPI query params == CHAT_WIRE (${endpoint.query.join(",")})`, () => {
      expect(specParams[op] ?? []).toEqual([...endpoint.query].sort());
    });
  }

  it("server reads exactly the SoT query keys (listChannels/listMessages/searchMessages)", () => {
    for (const key of serverKeys) {
      expect(sotKeys.has(key), `chat-service reads query key "${key}" not in the SoT`).toBe(true);
    }
    for (const key of sotKeys) {
      expect(serverKeys.has(key), `SoT key "${key}" is never read by chat-service`).toBe(true);
    }
  });
});
