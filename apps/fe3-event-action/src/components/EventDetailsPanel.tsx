// EventDetailsPanel — the "何でも貯める" free-form store for the selected event.
// View mode renders the saved sections; edit mode lets the user change everything
// and save the whole document at once (optimistic, version-locked). Sections cover
// what event ops actually tracks:
//   概要 / 開催情報(会場・アクセス・定員・持ち物) / 当日(タイムテーブル・登壇者・運営フロー)
//   / 運営管理(予算・協賛・準備チェックリスト) / 記録・連絡(メモ・重要リンク・連絡先)
import { useState } from "react";
import { Button, Icon, SkeletonLoader, Badge } from "@dub/ui";
import type { IconName } from "@dub/ui";
import type { common } from "@dub/types";
import { useEventDetailsQuery } from "../hooks/useEventQueries";
import { useSaveEventDetails } from "../hooks/useEventMutations";
import {
  EMPTY_EVENT_DETAILS_DATA,
  emptyEventDetails,
  type EventDetailsData,
  type EventDetailLink,
  type EventDetailContact,
  type EventScheduleItem,
  type EventSpeaker,
  type EventChecklistItem,
  type EventSponsor,
} from "../api/detailsContracts";
import styles from "./components.module.css";

function Section({
  icon,
  title,
  count,
  wide,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  count?: string;
  wide?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={wide ? `${styles.section} ${styles.sectionWide}` : styles.section}>
      <div className={styles.sectionHead}>
        <Icon name={icon} />
        <span className={styles.sectionHeadTitle}>{title}</span>
        {count ? <span className={styles.countChip}>{count}</span> : null}
        <div className={styles.spacer} />
        {action}
      </div>
      {children}
    </section>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return <div className={styles.groupHeading}>{children}</div>;
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
  const { data, isPending, isError } = useEventDetailsQuery(eventId);
  const save = useSaveEventDetails(eventId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<EventDetailsData>(EMPTY_EVENT_DETAILS_DATA);

  // Skeleton ONLY on the first, still-pending fetch. Never gate on `!data`: if the
  // details request fails (e.g. store not yet provisioned), react-query settles to
  // isError with data=undefined — the old `!data` guard then held the skeleton
  // forever (⑤ 無限「読み込み中」). Fall back to an empty (never-saved) document so
  // the sections render their「未記入」state instead of hanging.
  if (isPending) {
    return (
      <div className={styles.detailGrid} data-testid="fe3-details-skeleton">
        {[0, 1, 2, 3].map((i) => (
          <section className={styles.section} key={i}>
            <SkeletonLoader lines={4} />
          </section>
        ))}
      </div>
    );
  }

  const details = data ?? emptyEventDetails(eventId);
  const d = details.data;
  const doneCount = d.checklist.filter((c) => c.done).length;

  const startEdit = () => {
    setDraft({
      ...EMPTY_EVENT_DETAILS_DATA,
      ...d,
      schedule: d.schedule.map((s) => ({ ...s })),
      speakers: d.speakers.map((s) => ({ ...s })),
      sponsors: d.sponsors.map((s) => ({ ...s })),
      checklist: d.checklist.map((c) => ({ ...c })),
      links: d.links.map((l) => ({ ...l })),
      contacts: d.contacts.map((c) => ({ ...c })),
    });
    setEditing(true);
  };

  const commit = () => {
    save.mutate({ data: draft, version: details.version }, { onSuccess: () => setEditing(false) });
  };

  // ---- read (view) mode ----
  if (!editing) {
    return (
      <div data-testid="fe3-details">
        <div className={styles.pageHeader}>
          <h2 className={styles.pageTitle}>イベント詳細</h2>
          <div className={styles.heroMeta}>
            {isError ? (
              <span className={styles.savedHint} data-testid="fe3-details-load-error">
                詳細を読み込めませんでした（未保存として表示）
              </span>
            ) : details.updatedAt ? (
              <span className={styles.savedHint} data-testid="fe3-details-updated">
                最終更新 {new Date(details.updatedAt).toLocaleString("ja-JP")}
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
          <Section icon="info" title="概要" wide>
            <TextBlock value={d.overview} placeholder="概要は未記入です。" />
          </Section>

          <GroupHeading>開催情報</GroupHeading>
          <Section icon="home" title="会場">
            <TextBlock value={d.venue} placeholder="会場は未記入です。" />
          </Section>
          <Section icon="pin" title="アクセス">
            <TextBlock value={d.access} placeholder="アクセス（交通・最寄り駅・駐車場）は未記入です。" />
          </Section>
          <Section icon="users" title="定員・参加予定">
            <TextBlock value={d.capacity} placeholder="定員・参加予定人数は未記入です。" />
          </Section>
          <Section icon="archive" title="持ち物・服装">
            <TextBlock value={d.belongings} placeholder="持ち物・服装は未記入です。" />
          </Section>

          <GroupHeading>当日運営</GroupHeading>
          <Section
            icon="clock"
            title="タイムテーブル"
            count={d.schedule.length ? `${d.schedule.length}件` : undefined}
            wide
          >
            {d.schedule.length === 0 ? (
              <div className={styles.sectionEmpty}>タイムテーブルは未登録です。</div>
            ) : (
              <div data-testid="fe3-details-schedule">
                {d.schedule.map((s, i) => (
                  <div className={styles.timeRow} key={i}>
                    <div className={styles.timeSlot}>{s.time || "—"}</div>
                    <div className={styles.timeMain}>
                      <span className={styles.timeTitle}>{s.title || "（無題）"}</span>
                      {s.note ? <span className={styles.timeNote}>{s.note}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section
            icon="megaphone"
            title="登壇者・ゲスト"
            count={d.speakers.length ? `${d.speakers.length}名` : undefined}
            wide
          >
            {d.speakers.length === 0 ? (
              <div className={styles.sectionEmpty}>登壇者は未登録です。</div>
            ) : (
              <div className={styles.recordList} data-testid="fe3-details-speakers">
                {d.speakers.map((s, i) => (
                  <div className={styles.recordItem} key={i}>
                    <div className={styles.recordTop}>
                      <span className={styles.recordName}>{s.name || "（氏名未記入）"}</span>
                      {s.role ? <Badge>{s.role}</Badge> : null}
                    </div>
                    {s.topic ? <span className={styles.recordSub}>{s.topic}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section icon="flag" title="当日運営フロー" wide>
            <TextBlock value={d.operations} placeholder="当日運営フロー・担当は未記入です。" />
          </Section>

          <GroupHeading>運営管理</GroupHeading>
          <Section icon="file" title="予算・収支メモ">
            <TextBlock value={d.budget} placeholder="予算・収支メモは未記入です。" />
          </Section>
          <Section
            icon="shield"
            title="協賛・スポンサー"
            count={d.sponsors.length ? `${d.sponsors.length}社` : undefined}
            wide
          >
            {d.sponsors.length === 0 ? (
              <div className={styles.sectionEmpty}>協賛・スポンサーは未登録です。</div>
            ) : (
              <div className={styles.recordList} data-testid="fe3-details-sponsors">
                {d.sponsors.map((s, i) => (
                  <div className={styles.recordItem} key={i}>
                    <div className={styles.recordTop}>
                      <span className={styles.recordName}>{s.name || "（社名未記入）"}</span>
                      {s.tier ? <Badge>{s.tier}</Badge> : null}
                      {s.status ? <span className={styles.recordSub}>{s.status}</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
          <Section
            icon="check-square"
            title="準備チェックリスト"
            count={d.checklist.length ? `${doneCount}/${d.checklist.length}` : undefined}
            wide
          >
            {d.checklist.length === 0 ? (
              <div className={styles.sectionEmpty}>チェックリストは未登録です。</div>
            ) : (
              <div className={styles.checkList} data-testid="fe3-details-checklist">
                {d.checklist.map((c, i) => (
                  <div
                    className={c.done ? `${styles.checkItem} ${styles.checkItemDone}` : styles.checkItem}
                    key={i}
                  >
                    {c.done ? (
                      <Icon name="check" className={`${styles.checkIcon} ${styles.checkIconDone}`} />
                    ) : (
                      <span className={styles.checkToggle} aria-hidden />
                    )}
                    <span>{c.label}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <GroupHeading>記録・連絡</GroupHeading>
          <Section icon="edit" title="メモ" wide>
            <TextBlock value={d.memo} placeholder="メモは未記入です。" />
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
  const updateAt = <T,>(key: keyof EventDetailsData, i: number, patch: Partial<T>) =>
    setDraft((p) => ({
      ...p,
      [key]: (p[key] as T[]).map((row, j) => (j === i ? { ...row, ...patch } : row)),
    }));
  const removeAt = (key: keyof EventDetailsData, i: number) =>
    setDraft((p) => ({ ...p, [key]: (p[key] as unknown[]).filter((_, j) => j !== i) }));
  const addTo = <T,>(key: keyof EventDetailsData, blank: T) =>
    setDraft((p) => ({ ...p, [key]: [...(p[key] as T[]), blank] }));

  const addBtn = (label: string, onClick: () => void, testId: string) => (
    <Button iconLeft={<Icon name="plus" />} variant="ghost" onClick={onClick} testId={testId}>
      {label}
    </Button>
  );
  const removeBtn = (onClick: () => void, testId: string) => (
    <Button iconLeft={<Icon name="trash" />} variant="ghost" onClick={onClick} testId={testId}>
      <span className="sr-only">削除</span>
    </Button>
  );

  const textEdit = (
    key: "overview" | "venue" | "access" | "capacity" | "belongings" | "budget" | "operations" | "memo",
    placeholder: string,
  ) => (
    <textarea
      className={styles.textarea}
      value={draft[key]}
      placeholder={placeholder}
      onChange={(e) => setField({ [key]: e.target.value } as Partial<EventDetailsData>)}
      data-testid={`fe3-edit-${key}`}
    />
  );

  return (
    <div data-testid="fe3-details-edit">
      <div className={styles.pageHeader}>
        <h2 className={styles.pageTitle}>イベント詳細を編集</h2>
      </div>

      <div className={styles.detailGrid}>
        <Section icon="info" title="概要" wide>
          {textEdit("overview", "イベントの概要を入力")}
        </Section>

        <GroupHeading>開催情報</GroupHeading>
        <Section icon="home" title="会場">
          {textEdit("venue", "会場名・住所")}
        </Section>
        <Section icon="pin" title="アクセス">
          {textEdit("access", "交通・最寄り駅・駐車場")}
        </Section>
        <Section icon="users" title="定員・参加予定">
          {textEdit("capacity", "定員・参加予定人数（運営/来場 など）")}
        </Section>
        <Section icon="archive" title="持ち物・服装">
          {textEdit("belongings", "持ち物・服装・名札 など")}
        </Section>

        <GroupHeading>当日運営</GroupHeading>
        <Section
          icon="clock"
          title="タイムテーブル"
          wide
          action={addBtn("行を追加", () => addTo<EventScheduleItem>("schedule", { time: "", title: "", note: "" }), "fe3-edit-add-schedule")}
        >
          <div className={styles.linkList}>
            {draft.schedule.map((s, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  style={{ maxWidth: 120 }}
                  value={s.time}
                  placeholder="10:00"
                  onChange={(e) => updateAt<EventScheduleItem>("schedule", i, { time: e.target.value })}
                  data-testid={`fe3-edit-schedule-time-${i}`}
                />
                <input
                  className={styles.input}
                  value={s.title}
                  placeholder="内容（例: 開場・受付）"
                  onChange={(e) => updateAt<EventScheduleItem>("schedule", i, { title: e.target.value })}
                  data-testid={`fe3-edit-schedule-title-${i}`}
                />
                <input
                  className={styles.input}
                  value={s.note}
                  placeholder="補足（担当・場所）"
                  onChange={(e) => updateAt<EventScheduleItem>("schedule", i, { note: e.target.value })}
                  data-testid={`fe3-edit-schedule-note-${i}`}
                />
                {removeBtn(() => removeAt("schedule", i), `fe3-edit-schedule-remove-${i}`)}
              </div>
            ))}
            {draft.schedule.length === 0 ? (
              <div className={styles.sectionEmpty}>「行を追加」でタイムテーブルを登録できます。</div>
            ) : null}
          </div>
        </Section>

        <Section
          icon="megaphone"
          title="登壇者・ゲスト"
          wide
          action={addBtn("追加", () => addTo<EventSpeaker>("speakers", { name: "", role: "", topic: "" }), "fe3-edit-add-speaker")}
        >
          <div className={styles.linkList}>
            {draft.speakers.map((s, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={s.name}
                  placeholder="氏名"
                  onChange={(e) => updateAt<EventSpeaker>("speakers", i, { name: e.target.value })}
                  data-testid={`fe3-edit-speaker-name-${i}`}
                />
                <input
                  className={styles.input}
                  style={{ maxWidth: 160 }}
                  value={s.role}
                  placeholder="肩書き・所属"
                  onChange={(e) => updateAt<EventSpeaker>("speakers", i, { role: e.target.value })}
                  data-testid={`fe3-edit-speaker-role-${i}`}
                />
                <input
                  className={styles.input}
                  value={s.topic}
                  placeholder="登壇テーマ"
                  onChange={(e) => updateAt<EventSpeaker>("speakers", i, { topic: e.target.value })}
                  data-testid={`fe3-edit-speaker-topic-${i}`}
                />
                {removeBtn(() => removeAt("speakers", i), `fe3-edit-speaker-remove-${i}`)}
              </div>
            ))}
            {draft.speakers.length === 0 ? (
              <div className={styles.sectionEmpty}>「追加」で登壇者を登録できます。</div>
            ) : null}
          </div>
        </Section>

        <Section icon="flag" title="当日運営フロー" wide>
          {textEdit("operations", "当日の動き・担当・時系列の運営フロー")}
        </Section>

        <GroupHeading>運営管理</GroupHeading>
        <Section icon="file" title="予算・収支メモ">
          {textEdit("budget", "予算・費目・収支の見込み")}
        </Section>
        <Section
          icon="shield"
          title="協賛・スポンサー"
          wide
          action={addBtn("追加", () => addTo<EventSponsor>("sponsors", { name: "", tier: "", status: "" }), "fe3-edit-add-sponsor")}
        >
          <div className={styles.linkList}>
            {draft.sponsors.map((s, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={s.name}
                  placeholder="社名・団体名"
                  onChange={(e) => updateAt<EventSponsor>("sponsors", i, { name: e.target.value })}
                  data-testid={`fe3-edit-sponsor-name-${i}`}
                />
                <input
                  className={styles.input}
                  style={{ maxWidth: 140 }}
                  value={s.tier}
                  placeholder="ティア（例: Gold）"
                  onChange={(e) => updateAt<EventSponsor>("sponsors", i, { tier: e.target.value })}
                  data-testid={`fe3-edit-sponsor-tier-${i}`}
                />
                <input
                  className={styles.input}
                  style={{ maxWidth: 160 }}
                  value={s.status}
                  placeholder="状況（打診中/契約済 等）"
                  onChange={(e) => updateAt<EventSponsor>("sponsors", i, { status: e.target.value })}
                  data-testid={`fe3-edit-sponsor-status-${i}`}
                />
                {removeBtn(() => removeAt("sponsors", i), `fe3-edit-sponsor-remove-${i}`)}
              </div>
            ))}
            {draft.sponsors.length === 0 ? (
              <div className={styles.sectionEmpty}>「追加」で協賛先を登録できます。</div>
            ) : null}
          </div>
        </Section>
        <Section
          icon="check-square"
          title="準備チェックリスト"
          wide
          action={addBtn("項目を追加", () => addTo<EventChecklistItem>("checklist", { label: "", done: false }), "fe3-edit-add-check")}
        >
          <div className={styles.linkList}>
            {draft.checklist.map((c, i) => (
              <div className={styles.editRow} key={i}>
                <button
                  type="button"
                  className={c.done ? `${styles.checkToggle} ${styles.checkToggleOn}` : styles.checkToggle}
                  onClick={() => updateAt<EventChecklistItem>("checklist", i, { done: !c.done })}
                  aria-pressed={c.done}
                  aria-label={c.done ? "完了を解除" : "完了にする"}
                  data-testid={`fe3-edit-check-toggle-${i}`}
                >
                  {c.done ? <Icon name="check" /> : null}
                </button>
                <input
                  className={styles.input}
                  value={c.label}
                  placeholder="準備項目（例: 会場鍵の受け取り）"
                  onChange={(e) => updateAt<EventChecklistItem>("checklist", i, { label: e.target.value })}
                  data-testid={`fe3-edit-check-label-${i}`}
                />
                {removeBtn(() => removeAt("checklist", i), `fe3-edit-check-remove-${i}`)}
              </div>
            ))}
            {draft.checklist.length === 0 ? (
              <div className={styles.sectionEmpty}>「項目を追加」で準備タスクを登録できます。</div>
            ) : null}
          </div>
        </Section>

        <GroupHeading>記録・連絡</GroupHeading>
        <Section icon="edit" title="メモ" wide>
          {textEdit("memo", "自由記述メモ（議事・ToDo・気づき など）")}
        </Section>
        <Section
          icon="external-link"
          title="重要リンク"
          action={addBtn("追加", () => addTo<EventDetailLink>("links", { label: "", url: "" }), "fe3-edit-add-link")}
        >
          <div className={styles.linkList}>
            {draft.links.map((l, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={l.label}
                  placeholder="ラベル（例: アジェンダ）"
                  onChange={(e) => updateAt<EventDetailLink>("links", i, { label: e.target.value })}
                  data-testid={`fe3-edit-link-label-${i}`}
                />
                <input
                  className={styles.input}
                  value={l.url}
                  placeholder="https://…"
                  onChange={(e) => updateAt<EventDetailLink>("links", i, { url: e.target.value })}
                  data-testid={`fe3-edit-link-url-${i}`}
                />
                {removeBtn(() => removeAt("links", i), `fe3-edit-link-remove-${i}`)}
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
          action={addBtn("追加", () => addTo<EventDetailContact>("contacts", { label: "", value: "" }), "fe3-edit-add-contact")}
        >
          <div className={styles.linkList}>
            {draft.contacts.map((c, i) => (
              <div className={styles.editRow} key={i}>
                <input
                  className={styles.input}
                  value={c.label}
                  placeholder="ラベル（例: 事務局）"
                  onChange={(e) => updateAt<EventDetailContact>("contacts", i, { label: e.target.value })}
                  data-testid={`fe3-edit-contact-label-${i}`}
                />
                <input
                  className={styles.input}
                  value={c.value}
                  placeholder="メール / 電話 / チャンネル"
                  onChange={(e) => updateAt<EventDetailContact>("contacts", i, { value: e.target.value })}
                  data-testid={`fe3-edit-contact-value-${i}`}
                />
                {removeBtn(() => removeAt("contacts", i), `fe3-edit-contact-remove-${i}`)}
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
        <Button variant="primary" onClick={commit} disabled={save.isPending} testId="fe3-details-save">
          保存
        </Button>
      </div>
    </div>
  );
}
