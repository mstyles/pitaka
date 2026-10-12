import { useEffect } from "react";
import { XIcon } from "./icons";
import StatusLine, { type Status } from "./StatusLine";

export type Toast = Status & { id: number };

/** How long a done or info toast stays; an error stays until it's dismissed. */
const TOAST_MS = 6000;

type Props = {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  /** Goes to the Books screen, where the full summary is. */
  onShow: () => void;
};

function ToastCard({ toast, onDismiss, onShow }: Omit<Props, "toasts"> & { toast: Toast }) {
  useEffect(() => {
    if (toast.kind === "error") return;
    const t = setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast.id]);

  return (
    <div className="toast">
      <StatusLine status={toast} />
      <div className="toast-actions">
        <button className="button-quiet button-sm" onClick={onShow}>
          Show
        </button>
        <button
          className="button-quiet button-sm"
          aria-label="Dismiss"
          onClick={() => onDismiss(toast.id)}
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * News from background work (a folder import, chapter indexing) that ended
 * while the Books screen wasn't showing. Anything started on a screen reports
 * in that screen's own StatusLine instead.
 */
function Toaster({ toasts, onDismiss, onShow }: Props) {
  if (toasts.length === 0) return null;
  return (
    <section className="toaster" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} onShow={onShow} />
      ))}
    </section>
  );
}

export default Toaster;
