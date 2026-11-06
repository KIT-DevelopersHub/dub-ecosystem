// スプレッドシートの取り込み: 表を貼り付け → 件数と読み取れない値を確認 → 取り込む。
// 登録済みの企業は飛ばすので、途中で失敗しても同じ表を貼り直せばよい。
import { useMemo, useState } from "react";
import { Button, FormField, Modal, Stack, Textarea } from "@dub/ui";
import { DialogActions } from "@dub/app-ui";
import { sponsor } from "@dub/types";
import { useImportLeads } from "./leadHooks.ts";
import { parseLeadSheet } from "./leadImport.ts";
import styles from "./sponsor.module.css";

const WARNINGS_SHOWN = 5;

export function LeadImportDialog({ open, onClose, existing }: { open: boolean; onClose: () => void; existing: readonly sponsor.SponsorLead[] }): JSX.Element {
  const importLeads = useImportLeads();
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() === "" ? null : parseLeadSheet(text)), [text]);
  const fresh = useMemo(() => {
    const seen = new Set(existing.map((l) => sponsor.companyKey(l.companyName)));
    return (parsed?.leads ?? []).filter((l) => {
      const key = sponsor.companyKey(l.companyName);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [parsed, existing]);
  const skipped = (parsed?.leads.length ?? 0) - fresh.length;
  const tooMany = fresh.length > sponsor.LEAD_IMPORT_MAX;
  const errors = parsed?.errors ?? [];

  const close = () => {
    setText("");
    onClose();
  };

  return (
    <Modal testId="fe2-sponsor-lead-import" open={open} onClose={close} title="スプレッドシートから取り込む" size="lg">
      <Stack gap={4}>
        <p className={styles.note}>
          「02_営業管理」シートを見出しの行ごと全部選んでコピーし、下に貼り付けてください。列は見出しの名前で読み取ります。
          企業名が空の行と、登録済みの企業は取り込みません。
        </p>
        <FormField label="貼り付ける表" htmlFor="sponsor-lead-import-text">
          <Textarea id="sponsor-lead-import-text" testId="fe2-sponsor-lead-import-text" rows={8} value={text} onChange={setText} />
        </FormField>
        {parsed?.noHeader ? (
          <p className={styles.note} role="alert" data-testid="fe2-sponsor-lead-import-noheader">
            「企業名」の見出しが見つかりません。見出しの行も含めてコピーしてください。
          </p>
        ) : null}
        {parsed && !parsed.noHeader ? (
          <div data-testid="fe2-sponsor-lead-import-preview">
            <p className={styles.note}>
              {fresh.length} 社を追加します{skipped > 0 ? `（登録済みの ${skipped} 社は飛ばします）` : ""}。
              {tooMany ? ` 一度に取り込めるのは ${sponsor.LEAD_IMPORT_MAX} 社までです。` : ""}
            </p>
            {errors.length > 0 ? (
              <ul className={styles.importErrors} role="alert" data-testid="fe2-sponsor-lead-import-errors">
                {errors.slice(0, WARNINGS_SHOWN).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {errors.length > WARNINGS_SHOWN ? <li>ほか {errors.length - WARNINGS_SHOWN} 件</li> : null}
                <li>シート側で短くしてから貼り直してください。</li>
              </ul>
            ) : null}
            {parsed.warnings.length > 0 ? (
              <ul className={styles.importWarnings} data-testid="fe2-sponsor-lead-import-warnings">
                {parsed.warnings.slice(0, WARNINGS_SHOWN).map((w) => (
                  <li key={w}>{w}</li>
                ))}
                {parsed.warnings.length > WARNINGS_SHOWN ? <li>ほか {parsed.warnings.length - WARNINGS_SHOWN} 件</li> : null}
              </ul>
            ) : null}
          </div>
        ) : null}
        <DialogActions>
          <Button variant="secondary" size="lg" testId="fe2-sponsor-lead-import-cancel" onClick={close}>
            キャンセル
          </Button>
          <Button
            size="lg"
            testId="fe2-sponsor-lead-import-submit"
            disabled={fresh.length === 0 || tooMany || errors.length > 0 || importLeads.isPending}
            onClick={() => importLeads.mutate(fresh, { onSuccess: close })}
          >
            {importLeads.isPending ? "取り込み中…" : `${fresh.length} 社を取り込む`}
          </Button>
        </DialogActions>
      </Stack>
    </Modal>
  );
}
