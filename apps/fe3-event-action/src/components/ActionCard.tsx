import type { event } from "@dub/types";
import { Icon, type IconName } from "@dub/ui";
import { useActionRegistry } from "../context/ApiContext";
import styles from "./components.module.css";

export function ActionCard({
  action,
  onOpen,
}: {
  action: event.DubAction;
  onOpen?: (id: string) => void;
}) {
  const registry = useActionRegistry();
  const plugin = registry.resolve(action.kind);
  const icon: IconName = registry.has(action.kind) ? plugin.icon : "check-square";
  const CardExtra = plugin.CardExtra;

  return (
    <div className={styles.actionRow} data-testid={`fe3-actionboard-card-${action.id}`}>
      <Icon name={icon} />
      <button
        type="button"
        className={styles.actionTitle}
        style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer" }}
        onClick={() => onOpen?.(action.id)}
      >
        {action.title}
      </button>
      <span className={styles.badge}>{action.kind}</span>
      {CardExtra ? <CardExtra action={action} /> : null}
    </div>
  );
}
