// The reader's display settings and the app's theme. They're display
// preferences for this computer, so they live in localStorage rather than
// the library: a restore doesn't replace them, and the browser demo gets
// them too.

export type Theme = "system" | "light" | "sepia" | "dark";
export type Leading = "tight" | "normal" | "loose";
export type Width = "narrow" | "medium" | "wide";

export type ReaderSettings = { size: number; leading: Leading; width: Width; theme: Theme };

/** Text sizes, in px. */
export const TEXT_SIZES = [16, 17, 19, 21, 23, 26];

export const LEADING: Record<Leading, number> = { tight: 1.55, normal: 1.75, loose: 1.95 };

/**
 * The column width, in em of the text size, so a line holds about as many
 * characters at any size. 34em at 19px is 646px.
 */
export const MEASURE: Record<Width, number> = { narrow: 28, medium: 34, wide: 40 };

export const THEMES: Theme[] = ["system", "light", "sepia", "dark"];

export const DEFAULTS: ReaderSettings = {
  size: 19,
  leading: "normal",
  width: "medium",
  theme: "system",
};

const KEY = "pitaka.reader-settings";
const VERSION = 1;

/** The stored settings; any field that isn't an allowed value takes its default. */
export function loadSettings(): ReaderSettings {
  let stored: Record<string, unknown>;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return DEFAULTS;
    stored = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (stored == null || typeof stored !== "object" || stored.v !== VERSION) return DEFAULTS;
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T) =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    size: pick(stored.size, TEXT_SIZES, DEFAULTS.size),
    leading: pick(stored.leading, Object.keys(LEADING) as Leading[], DEFAULTS.leading),
    width: pick(stored.width, Object.keys(MEASURE) as Width[], DEFAULTS.width),
    theme: pick(stored.theme, THEMES, DEFAULTS.theme),
  };
}

/** Stores the settings. A failure (a private window, a full store) is silent. */
export function saveSettings(s: ReaderSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, ...s }));
  } catch {
    // The settings then last until the window closes.
  }
}

function stepText(s: ReaderSettings, by: 1 | -1): ReaderSettings {
  const i = TEXT_SIZES.indexOf(s.size);
  const at = i === -1 ? TEXT_SIZES.indexOf(DEFAULTS.size) : i;
  const next = TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, at + by))];
  return next === s.size ? s : { ...s, size: next };
}

export const largerText = (s: ReaderSettings) => stepText(s, 1);
export const smallerText = (s: ReaderSettings) => stepText(s, -1);

/** Size, spacing and width back to the defaults; the theme stays. */
export function resetText(s: ReaderSettings): ReaderSettings {
  return { ...DEFAULTS, theme: s.theme };
}

/** Whether size, spacing and width are already the defaults. */
export function isDefaultText(s: ReaderSettings) {
  return s.size === DEFAULTS.size && s.leading === DEFAULTS.leading && s.width === DEFAULTS.width;
}

/** Sets the theme for the whole app; "system" follows prefers-color-scheme. */
export function applyTheme(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}
