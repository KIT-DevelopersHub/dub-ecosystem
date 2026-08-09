import type { ActionPanelProps, ActionTypePlugin } from "../registry/ActionTypeRegistry";
import styles from "./components.module.css";

/** Fallback panel for unknown/unregistered action kinds. Never breaks the UI. */
export function GenericActionPanel({ action }: ActionPanelProps) {
  return (
    <div className={styles.panel} data-testid="fe3-action-generic-panel">
      <div className={styles.kv}>
        <span className={styles.kvLabel}>種別 (kind)</span>
        <span>{action.kind}</span>
        <span className={styles.kvLabel}>並び順</span>
        <span>{action.sortOrder}</span>
      </div>
      <p className={styles.kvLabel} style={{ marginTop: 12 }}>
        この種別 ({action.kind}) には専用パネルが登録されていません。汎用表示で開いています。
      </p>
    </div>
  );
}

/** The mandatory fallback plugin injected into the registry. */
export const genericActionPlugin: ActionTypePlugin = {
  type: "__generic__",
  label: "汎用アクション",
  icon: "check-square",
  Panel: GenericActionPanel,
};
