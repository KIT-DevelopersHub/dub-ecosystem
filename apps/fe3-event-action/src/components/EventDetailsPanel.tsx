// EventDetailsPanel — the "何でも貯める" free-form store for the selected event.
// View mode renders the saved sections; edit mode lets the user change everything
// and save the whole document at once (optimistic, version-locked). Sections:
//   概要 / メモ / 会場 / 重要リンク / 連絡先
import { useState } from "react";
import { Button, Icon, SkeletonLoader, Badge } from "@dub/ui";
import type { IconName } from "@dub/ui";
import type { common } from "@dub/types";
import { useEventDetailsQuery } from "../hooks/useEventQueries";
import { useSaveEventDetails } from "../hooks/useEventMutations";
import {
  EMPTY_EVENT_DETAILS_DATA,
  type EventDetailsData,
  type EventDetailLink,
  type EventDetailContact,
} from "../api/detailsContracts";
import styles from "./components.module.css";

function Section({
  icon,
  title,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <Icon name={icon} />
        <span className={styles.sectionHeadTitle}>{title}</span>
        <div className={styles.spacer} />
        {action}
      </div>
      {children}
    </section>
  );
}

function TextBlock({ value, placeholder }: { value: string; placeholder: string }) {
  if (!value.trim()) return <div className={styles.sectionEmpty}>{placeholder}</div>;
  return <div className={styles.sectionBody}>{value}</div>;
}

export function EventDetailsPanel({
  eventId,
  canWrite,
}: {
  eventId: common.EventId;
  canWrite: boolean;
}) {
  const { data, isLoading } = useEventDetailsQuery(eventId);
  const save = useSaveEventDetails(eventId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EventDetailsData>(EMPTY_EVENT_DETAILS_DATA);

  if (isLoading || !data) {
    return (
      <div className={styles.detailGrid} data-testid="fe3-details-skeleton">
        {[0, 1, 2].map((i) => (
          <section className={styles.section} key={i}>
            <SkeletonLoader lines={4} />
          </section>
        ))}
      </div>
    );
  }

  const d = data.data;

  const startEdit = () => {
    setDraft({
      ...EMPTY_EVENT_DETAILS_DATA,
      ...d,
      links: d.links.map((l) => ({ ...l })),
      contacts: d.contacts.map((c) => ({ ...c })),
    });
    setEditing(true);
  };

  const commit = () => {
    save.mutate(
      { data: draft, version: data.version },
      { onSuccess: () => setEditing(false) },
    );
  };

  // ---- read (view) mode ----
  if (!editing) {
    return (
      <div data-testid="fe3-details">
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>イベント詳細</h2>
          <div className={styles.heroMeta}>
            {data.updatedAt ? (
              <span className={styles.savedHint} data-testid="fe3-details-updated">
                最終更新 {new Date(data.updatedAt).toLocaleString("ja-JP")}
              </span>
            ) : (
              <Badge>未記入</Badge>
            )}
            {canWrite ? (
              <Button
                iconLeft={<Icon name="edit" />}
                variant="secondary"
                onClick={startEdit}
                testId="fe3-details-edit"
              >
                編集
              </Button>
            ) : null}
          </div>
        </div>

        <div className={styles.detailGrid}>
          <Section icon="info" title="概要">
            <TextBlock value={d.overview} placeholder="概要は未記入です。" />
          </Section>

          <Section icon="edit" title="メモ">
            <TextBlock value={d.memo} placeholder="メモは未記入です。" />
          </Section>

          <Section icon="calendar" title="会場・日程">
            <TextBlock value={d.venue} placeholder="会場情報は未記入です。" />
          </Section>

          <Section icon="external-link" title="重要リンク">
            {d.links.length === 0 ? (
              <div className={styles.sectionEmpty}>リンクは未登録です。</div>
            ) : (
              <div className={styles.linkList} data-testid="fe3-details-links">
                {d.links.map((l, i) => (
                  <div className={styles.linkItem} key={i}>
                    <Icon name="external-link" />
                    <a href={l.url} target="_blank" rel="noreferrer noopener">
                      {l.label || l.url}
                    </a>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section icon="user" title="連絡先">
            {d.contacts.length === 0 ? (
              <div className={styles.sectionEmpty}>連絡先は未登録です。</div>
            ) : (
              <div className={styles.linkList} data-testid="fe3-details-contacts">
                {d.contacts.map((c, i) => (
                  <div className={styles.kv} key={i}>
                    <span className={styles.kvLabel}>{c.label || "—"}</span>
                    <span>{c.value}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    );
  }

  // ---- edit mode ----
  const setField = (patch: Partial<EventDetailsData>) => setDraft((p) => ({ ...p, ...patch }));
  const updateLink = (i: number, patch: Partial<EventDetailLink>) =>
    setDraft((p) => ({ ...p, links: p.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const updateContact = (i: number, patch: Partial<EventDetailContact>) =>
    setDraft((p) => ({ ...p, contacts: p.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  return (
    <div data-testid="fe3-details-edit">
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>イベント詳細を編集</h2>
      </div>

      <div className={styles.detailGrid}>
        <Section icon="info" title="概要">
          <textarea
            className={styles.textarea}
            value={draft.overview}
            placeholder="イベントの概要を入力"
            onChange={(e) => setField({ overview: e.target.value })}
            data-testid="fe3-edit-overview"
          />
        </Section>

        <Section icon="edit" title="メモ">
          <textarea
            className={styles.textarea}
            value={draft.memo}
            placeholder="自由記述メモ（議事・ToDo・気づき など）"
            onChange={(e) => setField({ memo: e.target.value })}
            data-testid="fe3-edit-memo"
          />
        </Section>

        <Section icon="calendar" title="会場・日程">
          <textarea
            className={styles.textarea}
            value={draft.venue}
            placeholder="会場・アクセス・日程の補足"
            onChange={(e) => setField({ venue: e.target.value })}
            data-testid="fe3-edit-venue"
          />
        </Section>

        <Section
          icon="external-link"
          title="重要リンク"
          action={
            <Button
              iconLeft={<Icon name="plus" />}
              variant="ghost"
              onClick={() => setField({ links: [...draft.links, { label: "", url: "" }] })}
              testId="fe3-edit-add-link"
            >
              追加
            </Button>
          }
        >
          <div className={styles.linkList}>
            {draft.links.map((l, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={l.label}
                  placeholder="ラベル（例: アジェンダ）"
                  onChange={(e) => updateLink(i, { label: e.target.value })}
                  data-testid={`fe3-edit-link-label-${i}`}
                />
                <input
                  className={styles.input}
                  value={l.url}
                  placeholder="https://…"
                  onChange={(e) => updateLink(i, { url: e.target.value })}
                  data-testid={`fe3-edit-link-url-${i}`}
                />
                <Button
                  iconLeft={<Icon name="trash" />}
                  variant="ghost"
                  onClick={() => setField({ links: draft.links.filter((_, j) => j !== i) })}
                  testId={`fe3-edit-link-remove-${i}`}
                >
                  <span className="sr-only">削除</span>
                </Button>
              </div>
            ))}
            {draft.links.length === 0 ? (
              <div className={styles.sectionEmpty}>「追加」でリンクを登録できます。</div>
            ) : null}
          </div>
        </Section>

        <Section
          icon="user"
          title="連絡先"
          action={
            <Button
              iconLeft={<Icon name="plus" />}
              variant="ghost"
              onClick={() => setField({ contacts: [...draft.contacts, { label: "", value: "" }] })}
              testId="fe3-edit-add-contact"
            >
              追加
            </Button>
          }
        >
          <div className={styles.linkList}>
            {draft.contacts.map((c, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={c.label}
                  placeholder="ラベル（例: 事務局）"
                  onChange={(e) => updateContact(i, { label: e.target.value })}
                  data-testid={`fe3-edit-contact-label-${i}`}
                />
                <input
                  className={styles.input}
                  value={c.value}
                  placeholder="メール / 電話 / チャンネル"
                  onChange={(e) => updateContact(i, { value: e.target.value })}
                  data-testid={`fe3-edit-contact-value-${i}`}
                />
                <Button
                  iconLeft={<Icon name="trash" />}
                  variant="ghost"
                  onClick={() => setField({ contacts: draft.contacts.filter((_, j) => j !== i) })}
                  testId={`fe3-edit-contact-remove-${i}`}
                >
                  <span className="sr-only">削除</span>
                </Button>
              </div>
            ))}
            {draft.contacts.length === 0 ? (
              <div className={styles.sectionEmpty}>「追加」で連絡先を登録できます。</div>
            ) : null}
          </div>
        </Section>
      </div>

      <div className={styles.detailActions}>
        <Button variant="ghost" onClick={() => setEditing(false)} testId="fe3-details-cancel">
          キャンセル
        </Button>
        <Button
          variant="primary"
          onClick={commit}
          disabled={save.isPending}
          testId="fe3-details-save"
        >
          保存
        </Button>
      </div>
    </div>
  );
}
