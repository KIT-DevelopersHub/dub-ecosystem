// Gmail-style "show details". The message header keeps a one-line recipient summary
// ("宛先: 自分, 伊藤 由紀 ▾"); the toggle opens a dialog listing From / Reply-To / To /
// Cc / date / subject / mailed-by / signed-by / security, every address copyable.
import { useEffect, useState, type CSSProperties } from "react";
import { Modal } from "@dub/ui";
import { displayName, fullDate, type MailMsg, type MailPerson, type MailThreadModel } from "./mailModel.ts";
import { MailIcon } from "./icons.tsx";

const norm = (email: string): string => email.trim().toLowerCase();

/** The viewer's own addresses as seen in this thread: our sends' From, and the envelope
 *  recipient of messages delivered to us (not ones visible only via oversight/sharing). */
export function ownAddresses(thread: MailThreadModel, me: MailPerson): Set<string> {
  const own = new Set<string>();
  if (me.email) own.add(norm(me.email));
  for (const m of thread.messages) {
    if (m.outbound && m.from.email) own.add(norm(m.from.email));
    if (m.mine !== false && m.headerMeta?.deliveredTo) own.add(norm(m.headerMeta.deliveredTo));
  }
  return own;
}

/** "自分, 伊藤 由紀, office@example.net" — To then Cc, deduped, own address as 自分. */
export function recipientSummary(msg: MailMsg, own: ReadonlySet<string>): string {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const p of [...msg.to, ...(msg.cc ?? [])]) {
    const key = norm(p.email);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(own.has(key) ? "自分" : displayName(p));
  }
  return names.length > 0 ? names.join(", ") : "(宛先なし)";
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId?: string }): JSX.Element {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      /* clipboard unavailable: the address text itself stays selectable */
    }
  };
  return (
    <button
      type="button"
      aria-label={done ? `${label}をコピーしました` : `${label}をコピー`}
      title={done ? "コピーしました" : "コピー"}
      {...(testId ? { "data-testid": testId } : {})}
      onClick={() => void copy()}
      style={{
        all: "unset",
        cursor: "pointer",
        display: "inline-flex",
        padding: "var(--dub-space-1)",
        borderRadius: "var(--dub-radius-sm)",
        color: done ? "var(--dub-color-success, var(--dub-color-text-secondary))" : "var(--dub-color-text-muted)",
        flexShrink: 0,
      }}
    >
      <MailIcon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}

const selectable: CSSProperties = { userSelect: "text", wordBreak: "break-all" };

function Address({ p, own }: { p: MailPerson; own: boolean }): JSX.Element {
  return (
    <div data-testid="fe2-mail-details-address" style={{ display: "flex", alignItems: "center", gap: "var(--dub-space-1)" }}>
      <span style={selectable}>
        {p.name ? (
          <>
            <strong style={{ fontWeight: 600 }}>{p.name}</strong> &lt;{p.email}&gt;
          </>
        ) : (
          p.email
        )}
        {own ? <span style={{ color: "var(--dub-color-text-muted)" }}>（自分）</span> : null}
      </span>
      <CopyButton text={p.email} label={p.email} />
    </div>
  );
}

function AddressList({ people, own, field }: { people: MailPerson[]; own: ReadonlySet<string>; field: string }): JSX.Element {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--dub-space-1)" }}>
      {people.map((p) => (
        <Address key={p.email} p={p} own={own.has(norm(p.email))} />
      ))}
      {people.length > 1 ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--dub-space-1)", color: "var(--dub-color-text-muted)" }}>
          {field} の {people.length} 件をまとめてコピー
          <CopyButton text={people.map((p) => p.email).join(", ")} label={`${field} の全アドレス`} testId={`fe2-mail-details-copy-all-${field.toLowerCase()}`} />
        </span>
      ) : null}
    </div>
  );
}

function security(tls: boolean | undefined): string | null {
  if (tls === undefined) return null;
  return tls ? "標準的な暗号化（TLS）" : "暗号化されていません";
}

export function MessageDetailsDialog({
  msg,
  subject,
  own,
  onClose,
}: {
  msg: MailMsg;
  subject: string;
  own: ReadonlySet<string>;
  onClose: () => void;
}): JSX.Element {
  const meta = msg.headerMeta;
  const rows: Array<[string, JSX.Element | string | null]> = [
    ["差出人", <Address p={msg.from} own={own.has(norm(msg.from.email))} />],
    ["返信先", meta?.replyTo && meta.replyTo.length > 0 ? <AddressList people={meta.replyTo} own={own} field="返信先" /> : null],
    ["宛先", msg.to.length > 0 ? <AddressList people={msg.to} own={own} field="To" /> : null],
    ["Cc", msg.cc && msg.cc.length > 0 ? <AddressList people={msg.cc} own={own} field="Cc" /> : null],
    ["日付", fullDate(msg.date)],
    ["件名", subject],
    ["送信元", meta?.mailedBy ?? null],
    ["署名元", meta?.signedBy ?? null],
    ["セキュリティ", security(meta?.tls)],
  ];
  return (
    <Modal open onClose={onClose} title="メッセージの詳細" size="md" testId="fe2-mail-details">
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0, 1fr)",
          columnGap: "var(--dub-space-4)",
          rowGap: "var(--dub-space-3)",
          margin: 0,
          fontSize: "var(--dub-font-size-sm)",
          color: "var(--dub-color-text-primary)",
        }}
      >
        {rows
          .filter(([, v]) => v !== null && v !== "")
          .map(([label, value]) => (
            <div key={label} data-testid={`fe2-mail-details-row-${label}`} style={{ display: "contents" }}>
              <dt style={{ color: "var(--dub-color-text-muted)", textAlign: "right" }}>{label}:</dt>
              <dd style={{ margin: 0, minWidth: 0, ...selectable }}>{value}</dd>
            </div>
          ))}
      </dl>
    </Modal>
  );
}
