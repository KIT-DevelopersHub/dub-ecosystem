import styles from "../styles/app.module.css";

export type TaskView = "list" | "board" | "gantt";

const VIEWS: { key: TaskView; label: string }[] = [
  { key: "list", label: "一覧" },
  { key: "board", label: "ボード" },
  { key: "gantt", label: "ガント" },
];

export function ViewSwitcher({ value, onChange }: { value: TaskView; onChange: (v: TaskView) => void }) {
  return (
    <div className={styles.switcher} role="tablist" data-testid="fe4-view-switcher">
      {VIEWS.map((v) => (
        <button
          key={v.key}
          role="tab"
          aria-selected={value === v.key}
          className={`${styles.switcherBtn} ${value === v.key ? styles.switcherBtnActive : ""}`}
          onClick={() => onChange(v.key)}
          data-testid={`fe4-view-${v.key}`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
