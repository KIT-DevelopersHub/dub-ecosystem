// まとめてスキャンの確認: 撮った名刺を 1 行ずつ並べ、裏で 1 枚ずつ文字を読み取って各名刺の項目を埋める。
// 行を開くと項目を直せる (読み取り中に直した値は上書きしない)。読み終わったら「N 枚を保存」で一括保存する
// (保存は 1 枚ずつのときと同じく楽観的: 一覧に先に足してすぐ戻り、裏で登録 → 写真を送信)。
import { useEffect, useRef, useState } from "react";
import { Badge, Button, IconButton, Skeleton, Spinner } from "@dub/ui";
import { readCard } from "./cardOcr.ts";
import { mergeDraft } from "./parseCardText.ts";
import { useObjectUrl } from "./sponsorHooks.ts";
import { CardForm, EMPTY_FORM, type CardFormValues } from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

type ItemOcr = { kind: "queued" } | { kind: "reading"; progress: number } | { kind: "done" } | { kind: "failed" };

export interface BatchItem {
  id: number;
  image: Blob;
  form: CardFormValues;
  ocr: ItemOcr;
}

export function newBatch(images: Blob[]): BatchItem[] {
  return images.map((image, id) => ({ id, image, form: EMPTY_FORM, ocr: { kind: "queued" } }));
}

const waiting = (i: BatchItem): boolean => i.ocr.kind === "queued" || i.ocr.kind === "reading";

/** 待っている名刺を先頭から 1 枚ずつ読む (読み取りエンジンは 1 つ)。外した名刺・画面を離れたときは中断する。 */
function useBatchOcr(items: BatchItem[], setItems: (f: (items: BatchItem[]) => BatchItem[]) => void): void {
  const headId = items.find(waiting)?.id ?? null;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  useEffect(() => {
    if (headId === null) return;
    const item = itemsRef.current.find((i) => i.id === headId);
    if (!item) return;
    const ac = new AbortController();
    const update = (f: (i: BatchItem) => BatchItem) => {
      if (!ac.signal.aborted) setItems((all) => all.map((i) => (i.id === headId ? f(i) : i)));
    };
    update((i) => ({ ...i, ocr: { kind: "reading", progress: 0 } }));
    readCard(item.image, (progress) => update((i) => ({ ...i, ocr: { kind: "reading", progress } })), ac.signal).then(
      ({ draft }) =>
        update((i) => ({
          ...i,
          form: mergeDraft(i.form, draft).next,
          ocr: Object.keys(draft).length > 0 ? { kind: "done" } : { kind: "failed" },
        })),
      () => update((i) => ({ ...i, ocr: { kind: "failed" } })),
    );
    return () => ac.abort();
  }, [headId, setItems]);
}

function OcrBadge({ ocr, testId }: { ocr: ItemOcr; testId: string }): JSX.Element {
  if (ocr.kind === "reading") {
    return (
      <span className={styles.batchReading} data-testid={testId}>
        <Spinner size="sm" aria-label="読み取り中" />
        {Math.round(ocr.progress * 100)}%
      </span>
    );
  }
  if (ocr.kind === "queued") return <Badge tone="neutral" testId={testId}>待機中</Badge>;
  if (ocr.kind === "done") return <Badge tone="success" testId={testId}>読み取り済み</Badge>;
  return <Badge tone="warning" testId={testId}>読めませんでした</Badge>;
}

function BatchRow({
  item,
  index,
  open,
  companies,
  onToggle,
  onChange,
  onRemove,
  onRetry,
}: {
  item: BatchItem;
  index: number;
  open: boolean;
  companies: string[];
  onToggle: () => void;
  onChange: (form: CardFormValues) => void;
  onRemove: () => void;
  onRetry: () => void;
}): JSX.Element {
  const url = useObjectUrl(item.image);
  const name = item.form.personName.trim();
  const company = item.form.companyName.trim();
  const pendingRead = waiting(item);
  return (
    <li className={styles.batchItem} data-testid={`fe2-sponsor-batch-item-${index}`}>
      <div className={styles.batchHead}>
        <button
          type="button"
          className={styles.batchToggle}
          aria-expanded={open}
          data-testid={`fe2-sponsor-batch-toggle-${index}`}
          onClick={onToggle}
        >
          <span className={styles.batchThumb}>
            {url ? <img src={url} alt={`${index + 1} 枚目の名刺`} /> : <Skeleton variant="rect" width="100%" height="100%" />}
          </span>
          <span className={styles.batchSummary}>
            <span className={styles.batchName} data-testid={`fe2-sponsor-batch-name-${index}`}>
              {name || (pendingRead ? "読み取り待ち" : "氏名なし")}
            </span>
            <span className={styles.batchCompany}>{company || (pendingRead ? "" : "会社名なし")}</span>
          </span>
          <OcrBadge ocr={item.ocr} testId={`fe2-sponsor-batch-status-${index}`} />
        </button>
        <IconButton name="trash" aria-label={`${index + 1} 枚目を外す`} testId={`fe2-sponsor-batch-remove-${index}`} onClick={onRemove} />
      </div>
      {open ? (
        <div className={styles.batchBody}>
          {item.ocr.kind === "failed" ? (
            <div className={styles.ocrStatus} data-tone="warning">
              <span className={styles.ocrText}>写真から文字を読み取れませんでした。手で入力してください。</span>
              <Button variant="secondary" size="sm" testId={`fe2-sponsor-batch-retry-${index}`} onClick={onRetry}>
                もう一度読み取る
              </Button>
            </div>
          ) : null}
          <CardForm idPrefix={`sponsor-batch-${item.id}`} value={item.form} onChange={onChange} companies={companies} />
        </div>
      ) : null}
    </li>
  );
}

export function SponsorBatchReview({
  initial,
  companies,
  onSave,
}: {
  initial: BatchItem[];
  companies: string[];
  /** 保存する名刺 (写真と項目)。呼んだ側が一覧へ戻る。 */
  onSave: (items: { form: CardFormValues; image: Blob }[]) => void;
}): JSX.Element {
  const [items, setItems] = useState(initial);
  const [openId, setOpenId] = useState<number | null>(null);
  useBatchOcr(items, setItems);
  const update = (id: number, f: (i: BatchItem) => BatchItem) => setItems((all) => all.map((i) => (i.id === id ? f(i) : i)));
  const left = items.filter(waiting).length;
  const read = items.length - left;

  return (
    <div className={styles.scanForm} data-testid="fe2-sponsor-batch">
      <p className={styles.note} role="status" data-testid="fe2-sponsor-batch-progress">
        {left > 0
          ? `${items.length} 枚中 ${read} 枚を読み取りました。読み取りが終わったものから、行を開いて写真と見比べてください。`
          : `${items.length} 枚を読み取りました。行を開いて写真と見比べ、必要なら直してから保存してください。`}
      </p>
      {items.length === 0 ? (
        <p className={styles.note}>名刺がありません。一覧へ戻って撮り直してください。</p>
      ) : (
        <ul className={styles.batchList} aria-label="撮った名刺">
          {items.map((item, index) => (
            <BatchRow
              key={item.id}
              item={item}
              index={index}
              open={openId === item.id}
              companies={companies}
              onToggle={() => setOpenId((id) => (id === item.id ? null : item.id))}
              onChange={(form) => update(item.id, (i) => ({ ...i, form }))}
              onRemove={() => setItems((all) => all.filter((i) => i.id !== item.id))}
              onRetry={() => update(item.id, (i) => ({ ...i, ocr: { kind: "queued" } }))}
            />
          ))}
        </ul>
      )}
      <div className={styles.submitBar}>
        <Button
          size="lg"
          testId="fe2-sponsor-batch-save"
          disabled={items.length === 0 || left > 0}
          onClick={() => onSave(items.map(({ form, image }) => ({ form, image })))}
        >
          {left > 0 ? `読み取り中…（${read}/${items.length}）` : `${items.length} 枚を保存`}
        </Button>
      </div>
    </div>
  );
}
