import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Where feedback goes. `site/index.html` and `src-tauri/src/menu.rs` write
 * the same URLs out; change them together.
 */
export const FEEDBACK_LINKS = {
  bug: "https://github.com/mstyles/pitaka/issues/new?template=bug_report.md",
  idea: "https://github.com/mstyles/pitaka/issues/new?template=feedback.md",
  email: "mailto:mstyleshk@gmail.com?subject=Pitaka%20feedback",
} as const;

/**
 * A link that opens outside the app. The Tauri webview doesn't hand new
 * windows to the system browser, so there it goes through the opener plugin.
 */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!isTauri()) return;
        e.preventDefault();
        openUrl(href).catch((err) => console.error(`Opening ${href} failed:`, err));
      }}
    >
      {children}
    </a>
  );
}
