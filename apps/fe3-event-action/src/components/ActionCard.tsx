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
    <div className={`${styles.actionRow} ${styles.actionCard}`} data-testid={`fe3-actionboard-card-${action.id}`}>
      <Icon name={icon} />
      {/* The title button stretches over the whole card (::after), so the row is one
          click target while keyboard/screen readers still get a single button. */}
      <button
        type="button"
        className={`${styles.actionTitle} ${styles.actionOpen}`}
        onClick={() => onOpen?.(action.id)}
      >
        {action.title}
      </button>
      {/* Registered kinds show their label; unknown kinds get the generic plugin's. */}
      <span className={styles.badge} title={action.kind} data-testid={`fe3-actionboard-kindbadge-${action.id}`}>
        {plugin.label}
      </span>
      {CardExtra ? (
        <div className={styles.actionCardExtra}>
          <CardExtra action={action} />
        </div>
      ) : null}
    </div>
  );
}
