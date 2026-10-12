import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  isDefaultText,
  largerText,
  type Leading,
  type ReaderSettings,
  resetText,
  smallerText,
  TEXT_SIZES,
  type Theme,
  THEMES,
  type Width,
} from "./readerSettings";

type Props = {
  settings: ReaderSettings;
  /** Takes an update, as setState does, so quick changes build on each other. */
  onChange: (update: (s: ReaderSettings) => ReaderSettings) => void;
  onClose: () => void;
  /** The button that opens the panel, whose own click toggles it. */
  buttonRef: RefObject<HTMLButtonElement | null>;
};

const LEADING_LABELS: [Leading, string][] = [
  ["tight", "Tight"],
  ["normal", "Normal"],
  ["loose", "Loose"],
];

const WIDTH_LABELS: [Width, string][] = [
  ["narrow", "Narrow"],
  ["medium", "Medium"],
  ["wide", "Wide"],
];

const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  sepia: "Sepia",
  dark: "Dark",
};

// Each theme's --bg and --border, for its swatch. System is split, light
// over dark.
const LIGHT_BG = "#f6f1e7";
const DARK_BG = "#1c1814";
const SWATCHES: Record<Theme, { background: string; borderColor: string }> = {
  system: {
    background: `linear-gradient(135deg, ${LIGHT_BG} 50%, ${DARK_BG} 50%)`,
    borderColor: "#e2d8c5",
  },
  light: { background: LIGHT_BG, borderColor: "#e2d8c5" },
  sepia: { background: "#efe2c8", borderColor: "#dcc8a3" },
  dark: { background: DARK_BG, borderColor: "#3a3228" },
};

/** A row of buttons, one pressed. */
function Choice<T extends string>({
  label,
  options,
  value,
  onPick,
  className,
}: {
  label: string;
  className?: string;
  options: [T, ReactNode][];
  value: T;
  onPick: (v: T) => void;
}) {
  const id = `reader-settings-${label.toLowerCase().replace(/ /g, "-")}`;
  return (
    <div className="reader-settings-row" role="group" aria-labelledby={id}>
      <div className="section-label" id={id}>
        {label}
      </div>
      <div className={className ? `scope-toggle ${className}` : "scope-toggle"}>
        {options.map(([v, content]) => (
          <button
            key={v}
            type="button"
            className="button-sm"
            aria-pressed={v === value}
            onClick={() => onPick(v)}
          >
            {content}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The reader's Display panel: text size, line spacing, width and theme. */
function ReaderSettingsPanel({ settings, onChange, onClose, buttonRef }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      // The Display button's own click closes the panel.
      if (buttonRef.current?.contains(target)) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose, buttonRef]);

  const { size } = settings;
  return (
    <div
      id="reader-settings"
      ref={ref}
      role="dialog"
      aria-label="Display settings"
      className="reader-settings"
    >
      <div className="reader-settings-row" role="group" aria-labelledby="reader-settings-size">
        <div className="section-label" id="reader-settings-size">
          Text size
        </div>
        <div className="reader-settings-size">
          <button
            type="button"
            className="button-sm"
            aria-label="Smaller text"
            disabled={size === TEXT_SIZES[0]}
            onClick={() => onChange(smallerText)}
          >
            −
          </button>
          <span className="reader-settings-size-value" aria-live="polite">
            {size}
          </span>
          <button
            type="button"
            className="button-sm"
            aria-label="Larger text"
            disabled={size === TEXT_SIZES[TEXT_SIZES.length - 1]}
            onClick={() => onChange(largerText)}
          >
            +
          </button>
        </div>
      </div>
      <Choice
        label="Line spacing"
        options={LEADING_LABELS}
        value={settings.leading}
        onPick={(leading) => onChange((s) => ({ ...s, leading }))}
      />
      <Choice
        label="Width"
        options={WIDTH_LABELS}
        value={settings.width}
        onPick={(width) => onChange((s) => ({ ...s, width }))}
      />
      <Choice
        label="Theme"
        className="reader-settings-themes"
        options={THEMES.map((t) => [
          t,
          <>
            <span className="reader-settings-swatch" aria-hidden="true" style={SWATCHES[t]} />
            {THEME_LABELS[t]}
          </>,
        ])}
        value={settings.theme}
        onPick={(theme) => onChange((s) => ({ ...s, theme }))}
      />
      <button
        type="button"
        className="button-quiet button-sm reader-settings-reset"
        disabled={isDefaultText(settings)}
        onClick={() => onChange(resetText)}
      >
        Default text settings
      </button>
    </div>
  );
}

export default ReaderSettingsPanel;
