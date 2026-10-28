// Loopback harness for the send-pattern matrix. Every step goes through the real Worker
// code: internal senders hit POST /mail/outbox (validation, From, archive CC, send core),
// and every internal envelope recipient gets its own handler.email() call, the way
// Cloudflare Email Routing delivers one copy per RCPT TO. Mailboxes are read back through
// GET /mail/messages, /mail/sent and the detail routes. D1 = in-memory SQLite (test/d1.ts).
import { expect, vi } from "vitest";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types";
import type { mail } from "@dub/types";
import handler from "../../src/index";
import { MockMailProvider, type OutboundMail } from "../../src/provider";
import { b64encodeUtf8 } from "../../src/mime";
import { fakeIdentityFetcher, makeEnv } from "../helpers";
import { A, B, C, INFO, isInternal, type AttachmentKind, type MailPattern, type MailStep, type SubjectKind } from "./types";

const ARCHIVE = "archive@developershub.jp";
const ROSTER: Record<string, { email: string; displayName: string }> = {
  usr_alice: { email: A, displayName: "Alice" },
  usr_bob: { email: B, displayName: "Bob" },
  usr_carol: { email: C, displayName: "Carol" },
  usr_info: { email: INFO, displayName: "Info" },
};
const userIdOf = (addr: string): string | undefined =>
  Object.entries(ROSTER).find(([, u]) => u.email === addr.toLowerCase())?.[0];

// ---- fixtures --------------------------------------------------------------------
const SUBJECTS: Record<SubjectKind, { raw: string; decoded: string }> = {
  ascii: { raw: "Quarterly report", decoded: "Quarterly report" },
  "utf8-b": { raw: `=?UTF-8?B?${b64encodeUtf8("見積もりのご相談")}?=`, decoded: "見積もりのご相談" },
  "utf8-q": { raw: "=?UTF-8?Q?Caf=C3=A9_menu?=", decoded: "Café menu" },
  // RFC 2047 §6.2: whitespace between adjacent encoded-words is dropped on display.
  "split-words": { raw: `=?UTF-8?B?${b64encodeUtf8("打ち合わせ")}?= =?UTF-8?B?${b64encodeUtf8("日程")}?=`, decoded: "打ち合わせ日程" },
  "iso-2022-jp": { raw: "=?ISO-2022-JP?B?GyRCJUYlOSVIGyhC?=", decoded: "テスト" },
  // SMTPUTF8 (RFC 6532): raw UTF-8 in the header.
  "utf8-raw": { raw: "請求書の送付", decoded: "請求書の送付" },
};

interface AttachmentFixture { filename: string; contentType: string; size: number; inline?: boolean; status: "stored" | "dropped_too_large" }
const ATTACHMENTS: Record<AttachmentKind, AttachmentFixture> = {
  small: { filename: "invoice.pdf", contentType: "application/pdf", size: 2_048, status: "stored" },
  large: { filename: "deck.pptx", contentType: "application/octet-stream", size: 5 * 1024 * 1024, status: "stored" },
  oversize: { filename: "video.mp4", contentType: "video/mp4", size: 21 * 1024 * 1024, status: "dropped_too_large" },
  inline: { filename: "logo.png", contentType: "image/png", size: 1_024, inline: true, status: "stored" },
};
const bytesB64 = (size: number): string => Buffer.alloc(size, 0x5a).toString("base64");
const wrap76 = (s: string): string => (s.match(/.{1,76}/g) ?? [s]).join("\r\n");

function memR2() {
  const store = new Map<string, { body: ArrayBuffer; ct: string }>();
  return {
    async put(key: string, body: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      store.set(key, { body, ct: opts?.httpMetadata?.contentType ?? "application/octet-stream" });
    },
    async get(key: string) {
      const o = store.get(key);
      return o ? { arrayBuffer: async () => o.body, size: o.body.byteLength, httpMetadata: { contentType: o.ct } } : null;
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

// ---- external MIME builder ---------------------------------------------------------
function externalMime(p: {
  from: string; to: string[]; cc: string[]; subject: string; messageId: string;
  inReplyTo?: string; references?: string[]; body: MailStep["body"]; marker: string; atts: AttachmentFixture[];
}): string {
  const text = `Hello from the matrix.\r\n${p.marker}`;
  const html = `<p>Hello from the matrix.</p><p>${p.marker}</p>`;
  const b64 = (s: string) => wrap76(b64encodeUtf8(s));
  const leaf = (ct: string, s: string) => `Content-Type: ${ct}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(s)}\r\n`;
  const multipart = (type: string, b: string, parts: string[]) =>
    `Content-Type: multipart/${type}; boundary="${b}"\r\n\r\n${parts.map((x) => `--${b}\r\n${x}`).join("")}--${b}--\r\n`;
  const attPart = (a: AttachmentFixture) =>
    `Content-Type: ${a.contentType}; name="${a.filename}"\r\nContent-Transfer-Encoding: base64\r\n` +
    (a.inline ? `Content-ID: <${a.filename}@cid>\r\nContent-Disposition: inline; filename="${a.filename}"\r\n` : `Content-Disposition: attachment; filename="${a.filename}"\r\n`) +
    `\r\n${wrap76(bytesB64(a.size))}\r\n`;

  let body =
    p.body === "html" ? leaf("text/html", html)
    : p.body === "multipart" ? multipart("alternative", "alt-b", [leaf("text/plain", text), leaf("text/html", html)])
    : leaf("text/plain", text);
  const inline = p.atts.filter((a) => a.inline);
  const files = p.atts.filter((a) => !a.inline);
  if (inline.length > 0) body = multipart("related", "rel-b", [body, ...inline.map(attPart)]);
  if (files.length > 0) body = multipart("mixed", "mix-b", [body, ...files.map(attPart)]);

  const h = [
    `From: Matrix Sender <${p.from}>`,
    `To: ${p.to.join(", ")}`,
    ...(p.cc.length > 0 ? [`Cc: ${p.cc.join(", ")}`] : []),
    `Subject: ${p.subject}`,
    `Message-ID: <${p.messageId}>`,
    `Date: Tue, 27 Oct 2026 01:00:00 +0000`,
    ...(p.inReplyTo ? [`In-Reply-To: <${p.inReplyTo}>`] : []),
    ...(p.references && p.references.length > 0 ? [`References: ${p.references.map((r) => `<${r}>`).join(" ")}`] : []),
    "MIME-Version: 1.0",
  ];
  return `${h.join("\r\n")}\r\n${body}`;
}

/** Unfolded, lowercased header block of a raw message (the bit CF exposes as .headers). */
function headerMap(raw: string): Map<string, string> {
  const block = raw.slice(0, raw.search(/\r?\n\r?\n/)).replace(/\r?\n[ \t]+/g, " ");
  const m = new Map<string, string>();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    m.set(k, m.has(k) ? `${m.get(k)}, ${v}` : v);
  }
  return m;
}

function emailMessage(envelopeFrom: string, rcpt: string, raw: string): ForwardableEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  const headers = headerMap(raw);
  return {
    from: envelopeFrom,
    to: rcpt,
    headers: { forEach: (cb: (v: string, k: string) => void) => headers.forEach((v, k) => cb(v, k)), get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    rawSize: bytes.byteLength,
    setReject() {},
    async forward() {},
    async reply() {},
  } as unknown as ForwardableEmailMessage;
}

// ---- runner -----------------------------------------------------------------------
interface StepResult {
  step: MailStep;
  messageId: string;
  subject: string;
  marker: string;
  atts: AttachmentFixture[];
  outbound?: OutboundMail;
  sentId?: string;
  /** Every RFC Message-Id that this step's References should carry (root..parent). */
  ancestry: string[];
}

export async function runPattern(p: MailPattern): Promise<void> {
  const r2 = memR2();
  const { env, raw: db } = makeEnv({ SVC_IDENTITY: fakeIdentityFetcher(true, ROSTER), R2_MAIL: r2 as never });
  const captured: OutboundMail[] = [];
  const spy = vi.spyOn(MockMailProvider.prototype, "send").mockImplementation(async (m: OutboundMail) => {
    captured.push(m);
    return { providerMessageId: `mock-${m.messageId}` };
  });
  const call = async (path: string, user: string, init: RequestInit = {}): Promise<Response> =>
    handler.fetch(
      new Request(`https://svc${path}`, { ...init, headers: { "content-type": "application/json", "x-dub-request-id": "req_matrix", "x-dub-user-id": user } }),
      env,
      {} as never,
    );

  try {
    const results: StepResult[] = [];
    for (const [i, step] of p.steps.entries()) {
      const parent = step.parent !== undefined ? results[step.parent] : undefined;
      const isReply = step.kind === "reply" || step.kind === "reply-all";
      const subj = SUBJECTS[step.subject ?? "ascii"];
      const prefix = isReply ? "Re: " : step.kind === "forward" ? "Fwd: " : "";
      const marker = `marker-${p.id}-${i}`;
      const atts = (step.attachments ?? []).map((k) => ATTACHMENTS[k]);
      const ancestry = parent && isReply ? [...parent.ancestry, parent.messageId] : [];
      const cc = step.cc ?? [];
      const bcc = step.bcc ?? [];
      let res: StepResult;
      let rawMime: string;
      let envelope: string[];

      if (isInternal(step.from)) {
        const user = userIdOf(step.from);
        if (!user) throw new Error(`internal sender ${step.from} is not on the test roster`);
        const before = captured.length;
        const r = await call("/mail/outbox", user, {
          method: "POST",
          body: JSON.stringify({
            to: step.to.map((email) => ({ email })),
            ...(cc.length > 0 ? { cc: cc.map((email) => ({ email })) } : {}),
            // Not in the frozen SendMailRequest — sent the way a Bcc field in the UI would.
            ...(bcc.length > 0 ? { bcc: bcc.map((email) => ({ email })) } : {}),
            subject: prefix + subj.decoded,
            textBody: `Hello from the matrix.\n${marker}`,
            ...(step.body === "html" || step.body === "multipart" ? { htmlBody: `<p>${marker}</p>` } : {}),
            ...(parent && isReply ? { inReplyTo: parent.messageId } : {}),
            ...(atts.length > 0 ? { attachments: atts.map((a) => ({ filename: a.filename, contentType: a.contentType, contentBase64: bytesB64(a.size) })) } : {}),
          }),
        });
        expect(r.status, `${p.id} step ${i}: POST /mail/outbox`).toBe(202);
        const { messageId } = (await r.json()) as mail.SendMailResponse;
        const outbound = captured[before];
        expect(outbound, `${p.id} step ${i}: provider received the send`).toBeDefined();
        rawMime = outbound!.mime;
        // Envelope = exactly what the provider was asked to deliver (OutboundMail has no bcc).
        envelope = [...outbound!.to, ...outbound!.cc, ...((outbound as { bcc?: mail.MailAddress[] }).bcc ?? [])].map((a) => a.email);
        res = { step, messageId, subject: prefix + subj.decoded, marker, atts, outbound, sentId: messageId.split("@")[0]!, ancestry };
      } else {
        const messageId = `${p.id.replace(/\W+/g, "-")}-${i}@${step.from.split("@")[1]}`;
        const refs = parent && isReply ? (step.references === "parent-only" ? [parent.messageId] : ancestry) : undefined;
        rawMime = externalMime({
          from: step.from, to: step.to, cc, subject: (prefix ? prefix : "") + subj.raw, messageId,
          ...(parent && isReply ? { inReplyTo: parent.messageId } : {}),
          ...(refs ? { references: refs } : {}),
          body: step.body, marker, atts,
        });
        envelope = [...step.to, ...cc, ...bcc];
        res = { step, messageId, subject: prefix + subj.decoded, marker, atts, ancestry };
      }

      // Email Routing: one email() call per internal RCPT TO (archive@ included).
      let rcpts = [...new Set(envelope.map((e) => e.toLowerCase()))].filter(isInternal);
      if (step.order === "archive-first") rcpts = [...rcpts.filter((e) => e === ARCHIVE), ...rcpts.filter((e) => e !== ARCHIVE)];
      for (let n = 0; n < (step.deliveries ?? 1); n++) {
        for (const rcpt of rcpts) await handler.email(emailMessage(step.from, rcpt, rawMime), env);
      }
      results.push(res);
    }

    await assertInvariants(p, results, call, db);
  } finally {
    spy.mockRestore();
  }
}

type Call = (path: string, user: string, init?: RequestInit) => Promise<Response>;

async function assertInvariants(p: MailPattern, results: StepResult[], call: Call, db: ReturnType<typeof makeEnv>["raw"]): Promise<void> {
  const problems: string[] = [];
  const inboundThread = (mid: string) =>
    (db.prepare(`SELECT thread_id FROM mail_inbound WHERE message_id = ?`).get(mid) as { thread_id: string } | undefined)?.thread_id;
  const rootThread = inboundThread(results[0]!.messageId) ?? results[0]!.messageId;

  for (const [i, r] of results.entries()) {
    const tag = `step ${i}`;
    const { step } = r;
    const internalRcpts = [...new Set([...step.to, ...(step.cc ?? []), ...(step.bcc ?? [])].map((e) => e.toLowerCase()).filter(isInternal))];
    const bccSet = new Set((step.bcc ?? []).map((e) => e.toLowerCase()));
    const threaded = step.kind === "reply" || step.kind === "reply-all";

    // 1) Nothing lost: any internal delivery leaves a stored row.
    const rows = (db.prepare(`SELECT COUNT(*) AS c FROM mail_inbound WHERE message_id = ?`).get(r.messageId) as { c: number }).c;
    if (internalRcpts.length > 0 && rows === 0) problems.push(`${tag}: no mail_inbound row stored`);

    // 2) Internal sender sees it in Sent (and threading of our own reply).
    if (r.sentId) {
      const user = userIdOf(step.from)!;
      const res = await call(`/mail/sent/${r.sentId}`, user);
      if (res.status !== 200) problems.push(`${tag}: sender ${step.from} cannot open it in Sent (${res.status})`);
      else {
        const sent = (await res.json()) as mail.MailSentDetail;
        if (threaded && sent.threadId !== rootThread) problems.push(`${tag}: Sent threadId ${sent.threadId} != root ${rootThread}`);
        const files = (sent.attachments ?? []).map((a) => a.filename).sort();
        const want = r.atts.map((a) => a.filename).sort();
        if (JSON.stringify(files) !== JSON.stringify(want)) problems.push(`${tag}: Sent attachments ${files} != ${want}`);
      }
      // 3) BCC never appears in the outgoing headers.
      // Unfolded (RFC 5322 §2.2.3) so a folded References/To is read as one logical line.
      const head = r.outbound!.mime.slice(0, r.outbound!.mime.search(/\r?\n\r?\n/)).replace(/\r?\n[ \t]+/g, " ").toLowerCase();
      if (/^bcc:/m.test(head)) problems.push(`${tag}: outbound MIME carries a Bcc header`);
      for (const b of bccSet) if (head.includes(b)) problems.push(`${tag}: BCC ${b} leaked into outbound headers`);
      // 4) RFC 5322 §3.6.4: References = parent's References + parent id.
      if (p.rfcReferences && threaded) {
        const refs = /^references:(.*)$/m.exec(head)?.[1] ?? "";
        for (const id of r.ancestry) if (!refs.includes(id.toLowerCase())) problems.push(`${tag}: outbound References misses ancestor ${id}`);
      }
    }

    // 5) Every roster recipient (To/CC/BCC) sees it exactly once in their own inbox.
    for (const rcpt of internalRcpts) {
      const user = userIdOf(rcpt);
      if (!user) continue; // no account behind the address: covered by "nothing lost"
      const list = (await (await call("/mail/messages?limit=200", user)).json()) as { items: mail.MailMessageListItem[] };
      const mine = list.items.filter((m) => m.messageId === r.messageId);
      if (mine.length !== 1) {
        problems.push(`${tag}: ${rcpt} sees ${mine.length} copies (want 1)`);
        continue;
      }
      const item = mine[0]!;
      for (const a of [...item.to, ...(item.cc ?? [])]) {
        const e = a.email.toLowerCase();
        if (bccSet.has(e) && e !== rcpt) problems.push(`${tag}: BCC ${e} visible to ${rcpt}`);
      }
      if (threaded && item.threadId !== rootThread) problems.push(`${tag}: ${rcpt} threadId ${item.threadId} != root ${rootThread}`);
      const detail = (await (await call(`/mail/messages/${item.id}`, user)).json()) as mail.MailMessageDetail;
      if (detail.subject !== r.subject) problems.push(`${tag}: ${rcpt} subject ${JSON.stringify(detail.subject)} != ${JSON.stringify(r.subject)}`);
      if (!detail.textBody.includes(r.marker)) problems.push(`${tag}: ${rcpt} body lost the marker`);
      const got = (detail.attachments ?? []).map((a) => `${a.filename}:${a.status ?? "stored"}`).sort();
      const want = r.atts.map((a) => `${a.filename}:${a.status}`).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${tag}: ${rcpt} attachments ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
  }
  expect(problems, `${p.id}: ${p.title}`).toEqual([]);
}
