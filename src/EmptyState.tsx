import type { ReactNode } from "react";

type Props = {
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Left-aligned and unframed, for an empty case beside controls that already exist. */
  compact?: boolean;
};

/** What a screen or list shows when there's nothing in it yet, and what to do about it. */
function EmptyState({ icon, title, children, actions, compact }: Props) {
  return (
    <div className={compact ? "empty-state empty-state-compact" : "empty-state"}>
      {icon && !compact && (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {title && <h2 className="empty-state-title">{title}</h2>}
      <p className="empty-state-body">{children}</p>
      {actions && <div className="empty-state-actions row">{actions}</div>}
    </div>
  );
}

export default EmptyState;
