// The send-pattern matrix. Adding a case = adding one row. Rows with `knownIssue` fail
// today and run as it.fails (CI turns red once the behaviour changes — then drop the field).
import { A, B, C, INFO, UNKNOWN, X, Y, Z, type MailPattern } from "./types";

export const MATRIX: MailPattern[] = [
  // ---- inbound from an external sender: To / CC / BCC x internal counts ----
  { id: "in/to-1-internal", title: "external -> To: 1 internal", steps: [{ from: X, to: [A] }] },
  { id: "in/to-2-internal", title: "external -> To: 2 internal", steps: [{ from: X, to: [A, B] }] },
  { id: "in/to-3-internal", title: "external -> To: 3 internal", steps: [{ from: X, to: [A, B, C] }] },
  { id: "in/to-1-internal-2-external", title: "external -> To: 1 internal + 2 external", steps: [{ from: X, to: [Y, A, Z] }] },
  { id: "in/cc-1-internal", title: "external -> To: external, Cc: 1 internal", steps: [{ from: X, to: [Y], cc: [A] }] },
  { id: "in/cc-2-internal", title: "external -> To: external, Cc: 2 internal", steps: [{ from: X, to: [Y], cc: [A, B] }] },
  { id: "in/to-internal-cc-internal", title: "external -> To: internal, Cc: internal", steps: [{ from: X, to: [A], cc: [B] }] },
  { id: "in/to-internal-cc-external", title: "external -> To: internal, Cc: 2 external", steps: [{ from: X, to: [A], cc: [Y, Z] }] },
  { id: "in/bcc-1-internal", title: "external -> To: external, Bcc: 1 internal", steps: [{ from: X, to: [Y], bcc: [A] }] },
  { id: "in/to-internal-bcc-internal", title: "external -> To: internal, Bcc: internal", steps: [{ from: X, to: [A], bcc: [B] }] },
  { id: "in/bcc-2-internal", title: "external -> To: external, Bcc: 2 internal", steps: [{ from: X, to: [Y], bcc: [A, B] }] },
  { id: "in/mixed-all-fields", title: "external -> To: int+ext, Cc: int+ext, Bcc: int", steps: [{ from: X, to: [A, Y], cc: [B, Z], bcc: [C] }] },

  // ---- shared / unknown internal addresses ----
  { id: "in/shared-info", title: "external -> To: info@ (shared inbox)", steps: [{ from: X, to: [INFO] }] },
  { id: "in/shared-info-plus-individual", title: "external -> To: info@ + individual", steps: [{ from: X, to: [INFO, A] }] },
  { id: "in/unknown-internal", title: "external -> To: non-roster internal address (stored, owner-less)", steps: [{ from: X, to: [UNKNOWN] }] },
  { id: "in/unknown-plus-individual", title: "external -> To: non-roster + individual", steps: [{ from: X, to: [UNKNOWN, A] }] },

  // ---- delivery semantics ----
  { id: "in/duplicate-delivery", title: "Email Routing redelivers the same Message-ID", steps: [{ from: X, to: [A], deliveries: 2 }] },
  { id: "in/duplicate-delivery-multi", title: "redelivery of a 2-internal-recipient mail", steps: [{ from: X, to: [A], cc: [B], deliveries: 2 }] },

  // ---- body structure ----
  { id: "in/text-only", title: "text/plain only", steps: [{ from: X, to: [A], body: "text" }] },
  { id: "in/html-only", title: "text/html only", steps: [{ from: X, to: [A], body: "html" }] },
  { id: "in/multipart-alternative", title: "multipart/alternative (text + html)", steps: [{ from: X, to: [A], body: "multipart" }] },

  // ---- non-ASCII headers ----
  { id: "in/subject-utf8-b", title: "Japanese subject, UTF-8 B encoded-word", steps: [{ from: X, to: [A], subject: "utf8-b" }] },
  { id: "in/subject-utf8-q", title: "UTF-8 Q encoded-word subject", steps: [{ from: X, to: [A], subject: "utf8-q" }] },
  { id: "in/subject-utf8-raw", title: "raw UTF-8 subject (SMTPUTF8)", steps: [{ from: X, to: [A], subject: "utf8-raw" }] },
  { id: "in/subject-split-words", title: "subject split across adjacent encoded-words", steps: [{ from: X, to: [A], subject: "split-words" }] },
  { id: "in/subject-iso-2022-jp", title: "ISO-2022-JP encoded subject", steps: [{ from: X, to: [A], subject: "iso-2022-jp" }] },

  // ---- attachments ----
  { id: "in/attachment-small", title: "small attachment", steps: [{ from: X, to: [A], attachments: ["small"] }] },
  { id: "in/attachment-large", title: "5MB attachment", steps: [{ from: X, to: [A], attachments: ["large"] }] },
  { id: "in/attachment-oversize", title: "21MB attachment -> visible dropped stub", steps: [{ from: X, to: [A], attachments: ["oversize"] }] },
  { id: "in/attachment-inline", title: "inline image (multipart/related, Content-ID)", steps: [{ from: X, to: [A], body: "html", attachments: ["inline"] }] },
  { id: "in/attachment-mixed", title: "inline + file attachment", steps: [{ from: X, to: [A], body: "multipart", attachments: ["inline", "small"] }] },

  // ---- outbound from an internal sender (loopback for internal recipients) ----
  { id: "out/to-1-external", title: "internal -> To: 1 external", steps: [{ from: A, to: [X] }] },
  { id: "out/to-1-internal", title: "internal -> To: 1 internal", steps: [{ from: A, to: [B] }] },
  { id: "out/to-2-internal", title: "internal -> To: 2 internal", steps: [{ from: A, to: [B, C] }] },
  { id: "out/to-internal-cc-internal", title: "internal -> To: internal, Cc: internal", steps: [{ from: A, to: [B], cc: [C] }] },
  { id: "out/to-external-cc-internal", title: "internal -> To: external, Cc: internal", steps: [{ from: A, to: [X], cc: [B] }] },
  { id: "out/to-external-cc-internal-archive-first", title: "same, archive@ copy delivered first", steps: [{ from: A, to: [X], cc: [B], order: "archive-first" }] },
  { id: "out/mixed", title: "internal -> To: int + ext, Cc: ext", steps: [{ from: A, to: [B, X], cc: [Y] }] },
  // Provider suppressed every internal copy (Resend hard-bounce list): no email() call at all.
  { id: "out/to-external-cc-internal-suppressed", title: "same, internal copies never come back (local delivery only)", steps: [{ from: A, to: [X], cc: [B], deliveries: 0 }] },
  { id: "out/bcc-internal-suppressed", title: "internal -> To: external, Bcc: internal, no round trip", steps: [{ from: A, to: [X], bcc: [B], deliveries: 0 }] },
  { id: "out/bcc-internal", title: "internal -> To: external, Bcc: internal", steps: [{ from: A, to: [X], bcc: [B] }] },
  { id: "out/self", title: "self-addressed (To: me)", steps: [{ from: A, to: [A] }] },
  { id: "out/self-cc-plus-other", title: "internal -> To: other internal, Cc: me", steps: [{ from: A, to: [B], cc: [A] }] },
  { id: "out/html-multipart", title: "internal send with html body", steps: [{ from: A, to: [B], body: "multipart" }] },
  { id: "out/non-ascii-subject", title: "internal send with Japanese subject", steps: [{ from: A, to: [B], subject: "utf8-b" }] },
  { id: "out/attachment-small", title: "internal send with attachment", steps: [{ from: A, to: [B], attachments: ["small"] }] },

  // ---- reply / reply-all / forward / thread continuation ----
  {
    id: "thread/reply-roundtrip",
    title: "external -> A, A replies, external replies back (full References)",
    steps: [{ from: X, to: [A] }, { from: A, to: [X], kind: "reply", parent: 0 }, { from: X, to: [A], kind: "reply", parent: 1 }],
  },
  {
    id: "thread/trimmed-references",
    title: "3rd message carries only the parent in References",
    steps: [{ from: X, to: [A] }, { from: A, to: [X], kind: "reply", parent: 0 }, { from: X, to: [A], kind: "reply", parent: 1, references: "parent-only" }],
  },
  {
    id: "thread/reply-all-adds-colleague",
    title: "A reply-alls an external thread and Cc's colleague B",
    steps: [{ from: X, to: [A], cc: [Y] }, { from: A, to: [X], cc: [Y, B], kind: "reply-all", parent: 0 }, { from: X, to: [A], cc: [Y, B], kind: "reply-all", parent: 1 }],
  },
  {
    id: "thread/reply-all-external-only",
    title: "reply-all where every other party is external",
    steps: [{ from: X, to: [A], cc: [Y] }, { from: A, to: [X], cc: [Y], kind: "reply-all", parent: 0 }, { from: Y, to: [A], cc: [X], kind: "reply-all", parent: 1 }],
  },
  {
    id: "thread/internal-conversation",
    title: "A -> B, B replies, A replies again (all internal)",
    steps: [{ from: A, to: [B] }, { from: B, to: [A], kind: "reply", parent: 0 }, { from: A, to: [B], kind: "reply", parent: 1 }],
  },
  {
    id: "thread/forward-with-attachment",
    title: "A forwards an external mail with its attachment to B",
    steps: [{ from: X, to: [A], attachments: ["small"] }, { from: A, to: [B], kind: "forward", parent: 0, attachments: ["small"] }],
  },
  {
    id: "thread/outbound-references-chain",
    title: "our 2nd reply carries the full References chain",
    steps: [{ from: X, to: [A] }, { from: A, to: [X], kind: "reply", parent: 0 }, { from: X, to: [A], kind: "reply", parent: 1 }, { from: A, to: [X], kind: "reply", parent: 2 }],
    rfcReferences: true,
  },
];
