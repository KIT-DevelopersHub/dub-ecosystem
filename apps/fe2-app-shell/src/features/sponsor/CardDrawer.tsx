// 名刺の詳細ドロワー: 写真 (タップで拡大)・連絡先 (mailto / tel)・登録者。
// sponsor:write なら項目の編集 (楽観的・409 は読み直し) と写真の撮り直し、sponsor:admin なら削除。
// 閲覧のみの人には編集 UI を出さない。
import { useEffect, useState } from "react";
import { Button, ConfirmDialog, Drawer, Modal } from "@dub/ui";
import { DialogActions } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { CardCapture } from "./CardCapture.tsx";
import { useCompanies, useRemoveCard, useUpdateCard, useUploadImage } from "./sponsorHooks.ts";
import {
  CardForm,
  CardPhoto,
  formatDate,
  formFromCard,
  PhotoZoom,
  RetryUpload,
  useSponsorCapability,
  type CardFormValues,
} from "./SponsorShared.tsx";
import styles from "./sponsor.module.css";

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function CardDrawer({ cardId, onClose }: { cardId: string | null; onClose: () => void }): JSX.Element {
  const { list, companies } = useCompanies();
  const card = list.data?.cards.find((c) => c.id === cardId) ?? null;
  const { canWrite, canAdmin } = useSponsorCapability();
  const update = useUpdateCard();
  const remove = useRemoveCard();
  const upload = useUploadImage();
  const [editing, setEditing] = useState<CardFormValues | null>(null);
  const [zoom, setZoom] = useState(false);
  const [retake, setRetake] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // 別の名刺を開いたら編集状態を捨てる。
  useEffect(() => {
    setEditing(null);
    setZoom(false);
    setRetake(false);
  }, [cardId]);

  let body: JSX.Element | null = null;
  if (card) {
    const photoAction = canWrite ? (
      <Button variant="secondary" testId="fe2-sponsor-retake-photo" onClick={() => setRetake(true)}>
        {card.hasImage ? "写真を撮り直す" : "写真を撮る"}
      </Button>
    ) : null;
    body = (
      <div className={styles.detail} data-testid="fe2-sponsor-detail">
        <div className={styles.detailPhoto}>
          <CardPhoto card={card} size="large" onOpen={() => setZoom(true)} />
          <div className={styles.inlineActions}>
            <RetryUpload card={card} />
            {photoAction}
          </div>
        </div>

        {editing ? (
          <div className={styles.detailSection}>
            <CardForm idPrefix={`sponsor-edit-${card.id}`} value={editing} onChange={setEditing} companies={companies.map((c) => c.name)} />
            <DialogActions>
              <Button variant="secondary" size="lg" testId="fe2-sponsor-edit-cancel" onClick={() => setEditing(null)}>
                キャンセル
              </Button>
              <Button
                size="lg"
                testId="fe2-sponsor-edit-save"
                onClick={() => {
                  // 何も変えていなければ送らない (無駄な version 更新で他の人の編集を 409 にしない)。
                  const before = formFromCard(card);
                  const changed = (Object.keys(before) as (keyof CardFormValues)[]).some((k) => before[k].trim() !== editing[k].trim());
                  if (changed) update.mutate({ card, fields: editing });
                  setEditing(null);
                }}
              >
                保存する
              </Button>
            </DialogActions>
          </div>
        ) : (
          <div className={styles.detailSection}>
            <dl className={styles.fields}>
              <Field label="会社名">{card.companyName ?? "—"}</Field>
              <Field label="氏名">{card.personName ?? "—"}</Field>
              <Field label="部署">{card.department ?? "—"}</Field>
              <Field label="役職">{card.title ?? "—"}</Field>
              <Field label="メール">
                {card.email ? (
                  <a className={styles.contactLink} href={`mailto:${card.email}`} data-testid="fe2-sponsor-mailto">
                    {card.email}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="電話">
                {card.phone ? (
                  <a className={styles.contactLink} href={`tel:${card.phone.replace(/[^\d+]/g, "")}`} data-testid="fe2-sponsor-tel">
                    {card.phone}
                  </a>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="メモ">{card.note ?? "—"}</Field>
              <Field label="登録者">{card.createdByName ?? "—"}</Field>
              <Field label="登録日">{formatDate(card.createdAt)}</Field>
            </dl>
            {canWrite || canAdmin ? (
              <div className={styles.inlineActions}>
                {canWrite ? (
                  <Button testId="fe2-sponsor-edit" onClick={() => setEditing(formFromCard(card))}>
                    編集する
                  </Button>
                ) : null}
                {canAdmin ? (
                  <Button variant="danger" testId="fe2-sponsor-remove" onClick={() => setConfirmRemove(true)}>
                    削除する
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}

        <PhotoZoom card={card} open={zoom} onClose={() => setZoom(false)} />
        <Modal testId="fe2-sponsor-retake-modal" open={retake} onClose={() => setRetake(false)} title="写真を撮り直す" size="full">
          {retake ? (
            <CardCapture
              confirmLabel="この写真にする"
              onConfirm={(image) => {
                setRetake(false);
                void upload(card.id, image);
              }}
            />
          ) : null}
        </Modal>
        <ConfirmDialog
          testId="fe2-sponsor-remove-confirm"
          open={confirmRemove}
          danger
          title="名刺を削除しますか？"
          message={`「${sponsor.cardDisplayName(card)}」の名刺と写真を削除します。チームの全員の一覧から消え、元に戻せません。`}
          confirmLabel="削除する"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            onClose();
            remove.mutate(card);
          }}
        />
      </div>
    );
  }

  return (
    <Drawer testId="fe2-sponsor-drawer" open={card !== null} onClose={onClose} title={card ? sponsor.cardDisplayName(card) : "名刺"}>
      {body ?? <span />}
    </Drawer>
  );
}
