// 「その他」の組織全体の設定 (Google アカウント等) をクリックして開くダイアログ。
// OtherDetailDialog と同じ枠 (タイトル + 本文 + 閉じる) に、orgSettingsPanels.tsx のパネルを入れる。
import { Button, Modal } from "@dub/ui";
import { orgSetting } from "./orgSettingsPanels";

export function OrgSettingDialog({
  settingId,
  onClose,
  idPrefix = "fe7",
}: {
  /** null = 閉じている. */
  settingId: string | null;
  onClose: () => void;
  idPrefix?: string;
}) {
  const setting = orgSetting(settingId);
  if (!setting) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={setting.label}
      size="lg"
      testId={`${idPrefix}-setting-dialog`}
      footer={
        <Button variant="primary" onClick={onClose} testId={`${idPrefix}-setting-dialog-close`}>
          閉じる
        </Button>
      }
    >
      <setting.Panel idPrefix={idPrefix} />
    </Modal>
  );
}
