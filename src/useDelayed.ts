import { useEffect, useState } from "react";

/**
 * True once `active` has stayed true for `ms`. Local SQLite usually answers
 * in a few milliseconds, and a skeleton that flashes for one frame looks
 * worse than nothing, so loading states wait for this.
 */
export function useDelayed(active: boolean, ms = 200): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!active) return;
    const t = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(t);
  }, [active, ms]);
  return active && elapsed;
}
