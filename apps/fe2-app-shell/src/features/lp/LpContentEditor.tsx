// LP管理 → 公開設定 → 中身のセクション（協力団体ロゴ・お知らせ・登壇者情報・スポンサー）の項目エディタ。
// 1 つのモーダルの中で「一覧（並べ替え・削除）」と「1 項目のフォーム（追加・編集）」を切り替える
// （モーダルを重ねない: Esc で両方閉じる・フォーカスが二重に捕まるのを避ける）。
// 変更は確定した瞬間に onChange で親へ渡す: 下書きタブは楽観的に自動保存（失敗で戻す）、本番タブは未反映の変更にためる。
// 欄は @dub/types の LP_CONTENT_FIELDS から汎用に描く。モーダルは body へ portal されるので --dub-* トークンだけで描く。
import { useState } from "react";
import { lp } from "@dub/types";
import {
  Button,
  Checkbox,
  DatePicker,
  EmptyState,
  FormField,
  Icon,
  IconButton,
  Modal,
  Select,
  SortableList,
  Stack,
  TextField,
  Textarea,
} from "@dub/ui";
import {
  draftOf,
  draftToItem,
  emptyDraft,
  itemSummary,
  moveContent,
  newContentItemId,
  sortSponsors,
  type ContentDraft,
  type ContentItem,
} from "./lpContent.ts";
import styles from "./lpContent.module.css";

const TIER_OPTIONS = lp.LP_SPONSOR_TIERS.map((t) => ({ value: t as string, label: `${lp.LP_SPONSOR_TIER_LABELS[t]} プラン` }));

const NOTES: Record<lp.LpContentSectionId, string> = {
  partners: "ヒーローのすぐ下に丸いロゴで並びます。8 団体以上になるとロゴがゆっくり流れます。",
  news: "上から順に並びます（新しいお知らせを上へ）。「強調する」にした行は目印と下線が付きます。",
  speakers: "2 列のカードで並びます（スマホは 1 列）。メッセージは ▼ を押すと開きます。",
  sponsors: "プランごとにまとめて並びます（Title → Gold → Silver → Bronze）。説明が LP に出るのは Title だけです。",
};

/** 並べ替え後の一覧（スポンサーはプランの順を保つ）。 */
function arrange(section: lp.LpContentSectionId, items: ContentItem[]): ContentItem[] {
  return section === "sponsors" ? sortSponsors(items as lp.LpSponsorItem[]) : items;
}

type View = { kind: "list" } | { kind: "form"; id: string | null; draft: ContentDraft; errors: Record<string, string> };

export function LpContentEditor({
  section,
  items,
  open,
  disabled,
  onClose,
  onChange,
}: {
  section: lp.LpContentSectionId;
  items: readonly ContentItem[];
  open: boolean;
  disabled: boolean;
  onClose: () => void;
  onChange: (items: ContentItem[]) => void;
}): JSX.Element {
  const def: lp.LpSectionDef = lp.LP_SECTION_REGISTRY[section];
  const fields = lp.LP_CONTENT_FIELDS[section];
  const max = lp.LP_CONTENT_MAX_ITEMS[section];
  const [view, setView] = useState<View>({ kind: "list" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const P = `fe2-lp-content-${section}`;

  const close = (): void => {
    setView({ kind: "list" });
    setDeleting(null);
    onClose();
  };

  const startAdd = (): void => setView({ kind: "form", id: null, draft: emptyDraft(section), errors: {} });
  const startEdit = (item: ContentItem): void => setView({ kind: "form", id: item.id, draft: draftOf(section, item), errors: {} });

  const submit = (): void => {
    if (view.kind !== "form") return;
    const id = view.id ?? newContentItemId();
    const { item, errors } = draftToItem(section, id, view.draft);
    if (!item) {
      setView({ ...view, errors });
      return;
    }
    // 新しいお知らせは一番上（新しい順）、ほかは末尾に足す。
    const next = view.id
      ? items.map((x) => (x.id === view.id ? item : x))
      : section === "news"
        ? [item, ...items]
        : [...items, item];
    onChange(arrange(section, next));
    setView({ kind: "list" });
  };

  const remove = (id: string): void => {
    setDeleting(null);
    onChange(items.filter((x) => x.id !== id));
  };

  const setField = (key: string, value: string | boolean): void => {
    if (view.kind !== "form") return;
    const errors = { ...view.errors };
    delete errors[key];
    setView({ ...view, draft: { ...view.draft, [key]: value }, errors });
  };

  const formFooter =
    view.kind === "form" ? (
      <>
        <Button variant="secondary" onClick={() => setView({ kind: "list" })} testId={`${P}-form-cancel`}>
          一覧に戻る
        </Button>
        <Button variant="primary" onClick={submit} disabled={disabled} testId={`${P}-form-save`}>
          {view.id ? "変更を保存" : "追加する"}
        </Button>
      </>
    ) : (
      <Button variant="secondary" onClick={close} testId={`${P}-close`}>
        閉じる
      </Button>
    );

  return (
    <Modal
      open={open}
      onClose={close}
      size="md"
      title={view.kind === "form" ? `${def.label}: ${view.id ? "項目を編集" : "項目を追加"}` : `${def.label}の項目`}
      footer={formFooter}
      testId={P}
    >
      {view.kind === "form" ? (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          data-testid={`${P}-form`}
        >
          {fields.map((f) => (
            <ContentField
              key={f.key}
              section={section}
              field={f}
              value={view.draft[f.key]}
              error={view.errors[f.key]}
              disabled={disabled}
              onChange={(v) => setField(f.key, v)}
            />
          ))}
        </form>
      ) : (
        <Stack gap={4}>
          <p className={styles.note}>{NOTES[section]}</p>
          <div className={styles.listHead}>
            <span className={styles.count} data-testid={`${P}-count`}>
              {items.length} / {max} 件
            </span>
            <Button
              variant="primary"
              size="sm"
              iconLeft={<Icon name="plus" />}
              disabled={disabled || items.length >= max}
              onClick={startAdd}
              testId={`${P}-add`}
            >
              項目を追加
            </Button>
          </div>
          {items.length === 0 ? (
            <EmptyState
              icon="list"
              title="まだ項目がありません"
              description="項目が 0 件のあいだは、表示にしても LP には出ません。"
              testId={`${P}-empty`}
            />
          ) : (
            <SortableList<ContentItem>
              items={items}
              getItemId={(x) => x.id}
              disabled={disabled}
              aria-label={`${def.label}の項目（ドラッグで並べ替え）`}
              className={styles.list}
              testId={`${P}-list`}
              onReorder={({ oldIndex, newIndex }) => onChange(arrange(section, moveContent(items, oldIndex, newIndex)))}
              renderItem={(item, ctx) => {
                const s = itemSummary(section, item);
                const confirming = deleting === item.id;
                return (
                  <div className={styles.row} data-dragging={ctx.isDragging || undefined} data-testid={`${P}-item-${item.id}`}>
                    {!disabled ? (
                      <span className={styles.handle} aria-label="ドラッグして並べ替え" {...ctx.dragHandleProps}>
                        <Icon name="drag" />
                      </span>
                    ) : null}
                    {section !== "news" ? (
                      <span className={styles.thumb} data-shape={section === "sponsors" ? "wide" : section === "partners" ? "round" : "square"}>
                        {s.image ? <img src={s.image} alt="" loading="lazy" /> : <Icon name="file" />}
                      </span>
                    ) : null}
                    <span className={styles.rowText}>
                      <strong className={styles.rowTitle}>{s.title}</strong>
                      <span className={styles.rowSub}>{s.sub}</span>
                    </span>
                    {confirming ? (
                      <span className={styles.rowActions} role="group" aria-label="削除の確認">
                        <span className={styles.confirmText}>削除しますか？</span>
                        <Button variant="danger" size="sm" onClick={() => remove(item.id)} testId={`${P}-item-${item.id}-delete-confirm`}>
                          削除する
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(null)} testId={`${P}-item-${item.id}-delete-cancel`}>
                          やめる
                        </Button>
                      </span>
                    ) : (
                      <span className={styles.rowActions}>
                        <IconButton name="edit" aria-label={`${s.title}を編集`} size="sm" disabled={disabled} onClick={() => startEdit(item)} testId={`${P}-item-${item.id}-edit`} />
                        <IconButton name="trash" aria-label={`${s.title}を削除`} size="sm" disabled={disabled} onClick={() => setDeleting(item.id)} testId={`${P}-item-${item.id}-delete`} />
                      </span>
                    )}
                  </div>
                );
              }}
            />
          )}
        </Stack>
      )}
    </Modal>
  );
}

function ContentField({
  section,
  field: f,
  value,
  error,
  disabled,
  onChange,
}: {
  section: lp.LpContentSectionId;
  field: lp.LpContentFieldDef;
  value: string | boolean | undefined;
  error: string | undefined;
  disabled: boolean;
  onChange: (v: string | boolean) => void;
}): JSX.Element {
  const id = `fe2-lp-content-${section}-${f.key}`;
  const text = typeof value === "string" ? value : "";
  const count = f.max !== undefined ? `${text.length} / ${f.max} 文字` : undefined;
  const help = [f.hint, count].filter(Boolean).join("　") || undefined;
  if (f.kind === "boolean") {
    return (
      <div className={styles.checkRow}>
        <Checkbox id={id} testId={id} checked={value === true} disabled={disabled} label={f.label} onChange={onChange} />
        {f.hint ? <span className={styles.note}>{f.hint}</span> : null}
      </div>
    );
  }
  const preview = (f.kind === "image" && text && lp.isLpContentUrl(text)) ? text : null;
  return (
    <FormField label={f.label} htmlFor={id} required={f.required} {...(error ? { error } : {})} {...(help ? { help } : {})}>
      {f.kind === "textarea" ? (
        <Textarea id={id} testId={id} value={text} rows={4} invalid={!!error} disabled={disabled} onChange={onChange} />
      ) : f.kind === "date" ? (
        <DatePicker id={id} testId={id} value={text || null} invalid={!!error} disabled={disabled} onChange={(v) => onChange(v ?? "")} />
      ) : f.kind === "tier" ? (
        <Select id={id} testId={id} value={text || null} options={TIER_OPTIONS} invalid={!!error} disabled={disabled} onChange={onChange} />
      ) : (
        <div className={styles.urlRow}>
          <TextField
            id={id}
            testId={id}
            value={text}
            type={f.kind === "url" || f.kind === "image" ? "url" : "text"}
            placeholder={f.kind === "url" || f.kind === "image" ? "https://" : undefined}
            invalid={!!error}
            disabled={disabled}
            onChange={onChange}
          />
          {preview ? (
            <span className={styles.thumb} data-shape={section === "sponsors" ? "wide" : section === "partners" ? "round" : "square"}>
              <img src={preview} alt="" />
            </span>
          ) : null}
        </div>
      )}
    </FormField>
  );
}
