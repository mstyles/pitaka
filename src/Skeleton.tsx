/** Placeholder rows and cards for a list that's still loading; see `useDelayed`. */

/** Rows shaped like `.book-row`: a title bar and a meta bar. */
export function SkeletonRows({
  count,
  label,
  className,
}: {
  count: number;
  label: string;
  className: string;
}) {
  return (
    <ul className={className} aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="book-row skeleton-row">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-meta" />
        </li>
      ))}
    </ul>
  );
}

/** Cards shaped like `.folder-passage`: a meta bar and two lines of text. */
export function SkeletonPassages({ count, label }: { count: number; label: string }) {
  return (
    <ul className="folder-passages" aria-busy="true" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="folder-passage skeleton-card">
          <span className="skeleton skeleton-meta" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
        </li>
      ))}
    </ul>
  );
}
