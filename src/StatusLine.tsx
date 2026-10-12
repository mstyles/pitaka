import { AlertIcon, CheckIcon } from "./icons";

/** An outcome to report: work in progress, finished, failed, or just news. */
export type Status = { kind: "busy" | "done" | "error" | "info"; text: string };

export const busy = (text: string): Status => ({ kind: "busy", text });
export const done = (text: string): Status => ({ kind: "done", text });
export const failed = (text: string): Status => ({ kind: "error", text });
export const info = (text: string): Status => ({ kind: "info", text });

function StatusIcon({ kind }: { kind: Status["kind"] }) {
  if (kind === "busy") return <span className="spinner" />;
  if (kind === "done") return <CheckIcon size={14} />;
  if (kind === "error") return <AlertIcon size={14} />;
  return null;
}

/**
 * One line of status, announced to screen readers. It's rendered even when
 * empty, so the live region exists before its first message.
 */
function StatusLine({ status, className }: { status: Status | null; className?: string }) {
  const classes = ["status-line", status && `status-${status.kind}`, className].filter(Boolean);
  return (
    <p
      className={classes.join(" ")}
      role={status?.kind === "error" ? "alert" : "status"}
      aria-live={status?.kind === "error" ? "assertive" : "polite"}
    >
      {status && (
        <>
          {status.kind !== "info" && (
            <span className="status-icon" aria-hidden="true">
              <StatusIcon kind={status.kind} />
            </span>
          )}
          {/* Keyed, so a new message fades in. */}
          <span key={status.text}>{status.text}</span>
        </>
      )}
    </p>
  );
}

export default StatusLine;
