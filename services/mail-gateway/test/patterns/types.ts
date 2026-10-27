// Send-pattern matrix schema. One MailPattern row = one regression case; the harness
// (loopback.ts) sends every step through the real gateway code and checks the invariants.

/** Roster users (internal, owns an inbox). */
export const A = "alice@developershub.jp";
export const B = "bob@developershub.jp";
export const C = "carol@developershub.jp";
/** Shared system inbox (a roster account too). */
export const INFO = "info@developershub.jp";
/** Internal domain, but no roster user behind it. */
export const UNKNOWN = "nobody@developershub.jp";
/** External correspondents. */
export const X = "xavier@partner.example";
export const Y = "yuki@client.example";
export const Z = "zoe@vendor.example";

export type BodyKind = "text" | "html" | "multipart";
export type SubjectKind = "ascii" | "utf8-b" | "utf8-q" | "split-words" | "iso-2022-jp" | "utf8-raw";
export type AttachmentKind = "small" | "large" | "oversize" | "inline";

export interface MailStep {
  /** Internal sender -> POST /mail/outbox as that user; external -> raw MIME into email(). */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  kind?: "new" | "reply" | "reply-all" | "forward";
  /** Index of the earlier step this one replies to / forwards. */
  parent?: number;
  /** External replies only: full RFC 5322 chain (default) or just the parent id. */
  references?: "chain" | "parent-only";
  body?: BodyKind;
  subject?: SubjectKind;
  attachments?: AttachmentKind[];
  /** How many times Email Routing hands each copy to the Worker (redelivery). Default 1. */
  deliveries?: number;
  /** Envelope delivery order. "archive-first" delivers the archive@ copy before the rest. */
  order?: "envelope" | "archive-first";
}

export interface KnownIssue {
  /** Where the root cause is tracked (PR "Known failures" section until an issue exists). */
  ref: string;
  why: string;
}

export interface MailPattern {
  id: string;
  title: string;
  steps: MailStep[];
  /** Assert our outbound replies carry the full RFC 5322 References chain. */
  rfcReferences?: boolean;
  /** Fails today for a known reason -> run as it.fails so a behaviour change flips CI red. */
  knownIssue?: KnownIssue;
}

export const isInternal = (addr: string): boolean => addr.toLowerCase().endsWith("@developershub.jp");
