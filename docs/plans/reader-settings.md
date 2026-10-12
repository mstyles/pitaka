# Reader display settings and typography

## Context
The reader is where most time is spent, and none of it can be adjusted. The text is fixed at 19px Literata, a 1.75 line height and a 640px column. Colours follow the system theme, and there's no override. Someone reading on a laptop at arm's length, or in a dim room with a light system theme, has no recourse. The Paper plan left "A manual light/dark switch" out of scope. The text itself is set plainly too. Ragged right edges leave one-word last lines, numbers are lining figures in running text, and a chapter opens with its title as an ordinary 19px paragraph. That title is the first block in 1,613 of the real library's 2,356 chapters, and in 23 of the demo book's 24.

This adds a **Display** panel to the reader's sidebar. It has text size, line spacing, column width and a theme (System, Light, Sepia, Dark). The theme applies to the whole app. The text gets `text-wrap: pretty`, hanging punctuation, old-style figures and a chapter opening: the title block set as a heading, and the first line of the first real paragraph in small caps. It isn't a README roadmap item. It follows on from the ticked Paper item and depends on two others:
- **Type plan:** build this after `docs/plans/type-spacing-and-buttons.md`, whose `--text-read`, `--leading-read`, `--space-*`, `--accent-strong` and `--hover` tokens it uses, and after PRs #42 and #43.
- **Desktop shell:** `docs/plans/desktop-shell.md` reserves Ctrl/⌘ `=` `-` `0` (actions `text-larger`, `text-smaller` and `text-reset`), a "Text size" section in the shortcuts sheet, and View menu items. §4 says what this plan gives it, whichever lands first.

Out of scope:
- Choosing the reading font, or font weight. Literata is the only bundled reading face.
- A theme control on the main screens themselves (a header toggle). Outside the reader, the theme is changed from the desktop shell's View → Theme submenu (§4), which you chose over a header control.
- Per-book settings. Settings are global.
- Reading position and progress. That's `docs/plans/reading-progress.md`, which stores positions as paragraphs, so a change of text size can't break it.
- Justified text and hyphenation. `hyphens: auto` needs a hyphenation dictionary for the book's language, and Pali in Latin script has none in either engine.

Ruled out:
- **Storing settings in `library.db`** (a `settings` table and migration 007, with `get_settings` and `set_settings` commands). These are per-screen display preferences with no logic. Putting them in the database means a migration, two commands, mock routes and fixtures, and a demo route. It would also make a restore (#43) replace the display settings along with the library, and a laptop's size would follow the library to a desktop. `localStorage` gets settings to the browser demo for free.
  - Tauri's WebKitGTK keeps website data in the app's data folder; `~/.local/share/com.pitaka.app/storage/` already exists on this machine.
  - The cost: settings aren't in a backup, and `npm run tauri dev` (http://localhost:1420) and the release build are separate origins, so they don't share settings. Both go in Known limitations.
- **A drop cap.** In this library, 409 of the 2,356 chapters have no block of 100 or more characters in their first 12. Those are verses and short lines, where a drop cap reads badly. The others often start with a quote mark, a sutta number ("Thig 1.1") or a highlight that splits the first letter. WebKitGTK supports only the prefixed `-webkit-initial-letter`. A small-caps first line needs neither markup nor a prefix, and it fails gracefully (§5).
- **A boot script in `index.html`** to set `data-theme` before first paint. The CSP has no `'unsafe-inline'`. An external `public/` script would sit outside Vite's `base`, which the demo build sets to `/pitaka/demo/`. `main.tsx` sets the attribute synchronously before React renders. The `prefers-color-scheme` block still covers the first frame. The only possible flash is one frame of the system theme when an explicit theme is chosen, and the verification checks for it.
- **A CSS media query for the margin column**, as today. A media query can't read the custom properties that now set the column width (§3).

Checked:
- **CSS support in WebKitGTK.** I loaded a page in WebKitGTK 2.52.6, this machine's version, through PyGObject and called `CSS.supports`.
  - These returned true: `text-wrap: pretty`, `text-wrap-style: pretty`, `hanging-punctuation: first allow-end last`, `font-variant-numeric: oldstyle-nums`, `font-variant-caps: small-caps`, `font-synthesis-small-caps: none` and `-webkit-initial-letter`.
  - Unprefixed `initial-letter` returned false.
  - Also true: `color: color-mix(...)`. The type plan ruled `color-mix()` out because it wasn't sure of WebKitGTK support. It is supported here, but the type plan's explicit tokens are fine.
- **CSS support in WebView2 (Windows).** WebView2 is evergreen Chromium. From Chromium's release notes, `text-wrap: pretty` arrived in 117, and `hanging-punctuation` isn't implemented, so it is ignored. Not checked on a Windows machine.
- **The bundled Literata has neither old-style figures nor small caps.** I read the GSUB feature list of each woff2 with a small Node script, using `zlib.brotliDecompressSync` and the WOFF2 table directory.
  - `literata-latin-wght-normal.woff2` has `ccmp dnom frac liga locl numr pnum rvrn tnum`.
  - `literata-latin-ext-wght-normal.woff2` has `ccmp locl rvrn`.
  - fontsource strips `onum`, `smcp` and `c2sc`.
  - In WebKitGTK, with `font-synthesis: none` as `:root` has it, `small-caps` and `oldstyle-nums` leave the bundled file's widths unchanged ("the quick brown fox" 379.9px both ways, "1234567890" 208.4px both ways).
- **Upstream Literata has them.**
  - `google/fonts` `ofl/literata/Literata[opsz,wght].ttf` is the same version 3.103 as the bundled files.
  - Its GSUB has `c2sc onum smcp lnum pnum tnum`, among others.
  - Its default figures are lining: `one` has variants `one.osf` and `one.tf`.
  - It has 372 `.sc` glyphs, including `amacron.sc imacron.sc umacron.sc uni1E43.sc uni1E6D.sc uni1E0D.sc uni1E45.sc uni1E47.sc uni1E37.sc ntilde.sc`, so Pali letters have small caps.
  - In WebKitGTK the same spans measure 438.8px (small caps) and 216.6px (old-style), so both features apply.
  - Its axes are `opsz` 7–72 (default 12) and `wght` 200–900. The bundled files have only `wght`. At default `opsz` the upstream widths match the bundled ones to 0.3px, which suggests fontsource instanced it at 12.
- **Chapter openings in the real library**, from a read-only query of `library.db`: 54 books, 2,356 chapters. The first block equals the chapter title (case, whitespace and Unicode form ignored) in 1,613 of them. Among the first blocks that aren't the title, the median is 18 characters long: labels like "PART I". The first block of 100 or more characters, counting from just after the title block, is:
  - the first block in 1,165 chapters;
  - the second in 289, and the third in 284;
  - the fourth in 43, and later in 166;
  - not in the first 12 blocks in 409.
- **The fixtures:** "Chapter One: Beginnings" starts with its title (block 1) and has no block of 100+ characters. "Part One" has no title block, and its first block (block 8) is 120 characters.
- **Sepia contrast**, WCAG ratios computed in Python:
  - text on bg 10.6:1, and on surface 11.6:1;
  - muted on bg 5.4:1, on surface 5.9:1, and on the `--hover` wash over surface 5.3:1;
  - accent on bg 5.9:1, and on surface 6.5:1;
  - danger on surface 6.2:1, and on bg 5.7:1;
  - on-accent on accent 6.5:1, and on accent-strong 8.2:1;
  - text on each highlight colour over bg 8.2–9.4:1, and on `--mark` 8.5:1.

## 1. Fonts: `src/assets/fonts/literata-*.woff2`, `src/fonts.css`, new `scripts/subset-literata.sh`
- Replace both Literata files with subsets of upstream `Literata[opsz,wght].ttf` (google/fonts, pinned to a commit hash recorded in the script). The script does two things:
  1. Instance at `opsz=12` to match the current files: `fonttools varLib.instancer "Literata[opsz,wght].ttf" opsz=12 -o Literata-wght.ttf`.
  2. Subset each file:
     - `pyftsubset Literata-wght.ttf --flavor=woff2 --layout-features+=onum,lnum,smcp,c2sc --unicodes=<range> --output-file=src/assets/fonts/literata-{latin,latin-ext}-wght-normal.woff2`;
     - `<range>` is copied from the matching `@font-face` in `fonts.css`, so the latin file still leaves out U+0304.
     - pyftsubset follows the GSUB closure, so `amacron.sc` lands in the latin-ext file with "ā".
- **Approved on 2026-10-12.** The script needs `fonttools` and `brotli` for Python on the machine that runs it once (`apt install fonttools python3-brotli`, or `pipx install fonttools[woff]`). It's a one-off tool, not an npm or crate dependency, and CI doesn't run it. The output woff2 files are committed.
- File names and `@font-face` rules don't change. The comment at the top of `fonts.css` gains: "Literata is subset from upstream by `scripts/subset-literata.sh` instead, keeping old-style figures and small caps (`onum`, `smcp`, `c2sc`), which fontsource strips."
- **Size:** unmeasured, because fonttools isn't on this machine. Today's two files are 52 KB and 43 KB. Small caps and old-style figures for these ranges should add roughly 20–30%. The PR reports the real sizes, and if either file grows past 80 KB, raise it in review before going on.
- The licence is still OFL 1.1, and `OFL-Literata.txt` stays.

## 2. Settings and theme: new `src/readerSettings.ts`, `src/main.tsx`, `src/App.tsx`
- The types:
  - `export type Theme = "system" | "light" | "sepia" | "dark"`;
  - `export type ReaderSettings = { size: number; leading: "tight" | "normal" | "loose"; width: "narrow" | "medium" | "wide"; theme: Theme }`.
- Constants:
  - `TEXT_SIZES = [16, 17, 19, 21, 23, 26]` (px);
  - `LEADING = { tight: 1.55, normal: 1.75, loose: 1.95 }`;
  - `MEASURE = { narrow: 28, medium: 34, wide: 40 }` (em of the text size, so the line length in characters holds as the size changes; 34em at 19px is 646px, close to today's 640);
  - `DEFAULTS = { size: 19, leading: "normal", width: "medium", theme: "system" }`.
- `loadSettings(): ReaderSettings` reads `localStorage["pitaka.reader-settings"]`, inside `try`. It parses `{ "v": 1, ...ReaderSettings }` and keeps each field only if it's one of the allowed values. Otherwise that field takes the default. A missing key, bad JSON, a different `v` or a throwing `localStorage` all give `DEFAULTS`.
- `saveSettings(s)` writes the same JSON inside `try`/`catch`. A failure, such as a private window or a full store, is silent, and the settings last until the window closes.
- Size steps: `largerText(s)` and `smallerText(s)` move one step along `TEXT_SIZES`, and stop at the ends. `resetText(s)` puts size, leading and width back to the defaults and keeps the theme.
- `applyTheme(t)` sets `document.documentElement.dataset.theme = t`, or deletes the attribute for `"system"`.
- `main.tsx` calls `applyTheme(loadSettings().theme)` before `createRoot`.
- `App.tsx`:
  - `const [readerSettings, setReaderSettings] = useState(loadSettings)`;
  - one effect on `readerSettings` calls `saveSettings` and `applyTheme`;
  - passes `settings={readerSettings}` and `onSettingsChange={setReaderSettings}` to `ReaderView`.
  - App owns the state so that the desktop shell's `runAction` (§4) can change the size without the reader having to be open.

## 3. Applying settings: `src/ReaderView.tsx`, `src/App.css`
- Three new tokens in `:root`, which the type plan's `styles.test.ts` requires to be defined there:
  - `--reader-size: var(--text-read)`;
  - `--reader-leading: var(--leading-read)`;
  - `--reader-measure: 34em`.
- `<main className="reader">` gets `style={{ "--reader-size": \`${size}px\`, "--reader-leading": LEADING[leading], "--reader-measure": \`${MEASURE[width]}em\` }}`. React sets custom properties through the CSSOM, which the CSP's `style-src 'self'` allows, as with `SelectionToolbar`'s `top`/`left` today.
- `.reader-text`:
  - `font-size: var(--reader-size)`;
  - `line-height: var(--reader-leading)`;
  - `max-width: var(--reader-measure)`.
  - In em, the measure resolves against the reading size.
- `.reader-content`:
  - `padding-left: max(var(--space-12), calc(2.5 * var(--reader-size)))`, so the margin bookmark and note icons (`left: -2.25em` and `-2.1em`) aren't cut off at 26px.
- The margin column:
  - The `@media (min-width: 1280px)` block's three rules move under `.reader-text.with-margin`:
    - `.reader-text.with-margin` gets `max-width: calc(var(--reader-measure) + 24px + 240px)`;
    - `.with-margin .reader-block` gets `grid-template-columns: minmax(0, var(--reader-measure)) 240px`;
    - `.with-margin .note-margin` gets the margin-column rules.
  - The media query is removed.
  - A `useMarginColumn(contentRef, size * MEASURE[width])` hook in `ReaderView.tsx` returns `true` when there's room. It uses a `ResizeObserver` on `.reader-content`, and checks `clientWidth` minus the computed horizontal padding against `measurePx + 24 + 240`. jsdom has no `ResizeObserver`, so the hook returns `false` there, as the media query does in jsdom today.
  - The comment above it is rewritten with the new arithmetic. At the defaults the column appears from a 1,262px window instead of 1,280.
- When settings change:
  - Close the selection toolbar and highlight popover, because their stored `top`/`left` are stale after a reflow.
  - Keep the reader's place. Before the change, note the first `.reader-paragraph` whose bottom is below `.reader-content`'s top. After the re-render, use a `useLayoutEffect` on `[size, leading, width]` to scroll that paragraph back to the same offset from the top.
- Themes, in `App.css` after the dark block:
  - The dark media query becomes `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]):not([data-theme="sepia"]) { …dark tokens… } }`.
  - It's followed by `:root[data-theme="dark"] { …the same tokens…; color-scheme: dark }`.
  - Then `:root[data-theme="sepia"] { …; color-scheme: light }` with:
    - `--bg: #efe2c8`, `--surface: #f6ecd8`, `--text: #3a2b1c`, `--muted: #6a563f`, `--border: #dcc8a3`;
    - `--accent: #8a3d14`, `--accent-strong: #73320f`, `--on-accent: #f6ecd8`, `--danger: #9a3324`;
    - `--mark: #e8c98a`, `--flash: rgba(200, 140, 40, 0.25)`, `--rule-neutral: #c4ab80`, `--hover: rgba(58, 43, 28, 0.07)`;
    - the light values for the four `--hl-*` colours.
  - `[data-theme="light"]` needs no block: `:root` already holds the light tokens, and the `:not()` keeps the dark media query off.
  - The dark tokens are written twice, once in the media query and once in the attribute block. A test keeps the two identical (§7).

## 4. The Display panel: new `src/ReaderSettingsPanel.tsx`, `src/ReaderView.tsx`, `src/App.css`
- In the sidebar's `.reader-book`, after **Search this book**, add a `<button className="reader-display button-sm" aria-expanded={open} aria-controls="reader-settings">`. Its content is an "Aa" glyph set in Literata (`aria-hidden`), then the text "Display".
- `ReaderSettingsPanel({ settings, onChange, onClose })` renders `<div id="reader-settings" role="dialog" aria-label="Display settings" className="reader-settings">`. It sits below the button inside the sidebar, at 100% of the sidebar's inner width. It closes on Escape, or on a `mousedown` outside both the panel and its button, using the same `document` listeners as `BookmarkPopover.tsx`. Its rows, each labelled with a `.section-label`:
  - **Text size**: `−` (`aria-label="Smaller text"`), then the size as "19" in `aria-live="polite"`, then `+` (`aria-label="Larger text"`). Each is disabled at its end of the scale.
  - **Line spacing**: Tight / Normal / Loose.
  - **Width**: Narrow / Medium / Wide.
  - **Theme**: System / Light / Sepia / Dark. These four are a `.scope-toggle` segmented control with `aria-pressed`, like Line spacing and Width. Each Theme button has a 10px swatch of that theme's `--bg` with a `--border` ring, drawn as an inline `background` on a `<span aria-hidden>`. System's swatch is split diagonally, light and dark.
  - A quiet **Default text settings** button (`button-quiet button-sm`) calls `resetText`. It's disabled when size, leading and width are already the defaults.
- CSS:
  - `.reader-settings`: `margin-top: var(--space-3)`, `padding: var(--space-3)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`, `background: var(--bg)`, `font-size: var(--text-sm)`, and a flex column with `gap: var(--space-3)`.
  - The `.scope-toggle` buttons inside it are `flex: 1` with `button-sm` heights, so four theme buttons fit the sidebar's 240px.
- For the desktop shell, whichever plan lands second wires these up:
  - in `runAction`, `text-larger` becomes `setReaderSettings(largerText)`, `text-smaller` becomes `setReaderSettings(smallerText)`, and `text-reset` becomes `setReaderSettings(resetText)`;
  - the shortcuts sheet's "Text size" section lists them;
  - the View menu gets "Larger text", "Smaller text" and "Default text size" behind a separator;
  - the View menu also gets a **Theme** submenu with System, Light, Sepia and Dark. Their ids are four more `Action`s, `theme-system`, `theme-light`, `theme-sepia` and `theme-dark`, added to `MENU_ACTIONS` (so the shell's id-matching test covers them). In `runAction` each becomes `setReaderSettings((s) => ({ ...s, theme }))`, which also calls `applyTheme` and saves. They're plain items with no check mark: the menu is built in Rust and the theme lives in `localStorage`, so showing the current one would need the frontend to update the menu, which isn't worth it for four items. There are no keyboard shortcuts for the theme.
  - The three functions are pure and exported, which is all that wiring needs.

## 5. Typography: `src/App.css`, new `src/chapterOpening.ts`, `src/ReaderView.tsx`
- `.reader-paragraph`:
  - `text-wrap: pretty`, for fewer one-word last lines. It's ignored where unsupported.
  - `hanging-punctuation: first allow-end last`, so opening quotes and closing stops hang into the margin. It works in WebKitGTK and is ignored by WebView2. A hung quote takes about 0.4em, well clear of the bookmark icon at −2.25em.
- Old-style figures in book text: `font-variant-numeric: oldstyle-nums proportional-nums` on `.reader-text`, `.result-snippet`, `.folder-passage-text` and `.annotation-quote`. Book titles in lists (`.book-title`) and all UI text keep lining figures.
- **Chapter heading**: `export function chapterOpening(content: ChapterContent): { headingId: number | null; openingId: number | null }`.
  - `headingId` is the first block's id when its text equals `chapter_title` after `normalize("NFC")`, collapsing whitespace, trimming and lowercasing. Otherwise it's `null`.
  - `openingId` is the first block from the one after the heading (or from the first block, when there's no heading), looking at most 4 blocks ahead, whose text has at least `OPENING_MIN_CHARS = 100` characters. Otherwise it's `null`.
  - The thresholds come from the library counts in Checked: they skip the 18-character labels and leave verse chapters alone.
- `ReaderView` adds `reader-chapter-heading` and `reader-opening` to those blocks' `className`, alongside `reader-paragraph` and `flash`. The text and DOM are unchanged, so highlights, notes, bookmarks and `selectionOffsets` work as before.
- `.reader-chapter-heading`:
  - `font-family: var(--font-display); font-weight: 600; font-size: 1.5em; line-height: var(--leading-tight); text-wrap: balance; margin: 0 0 1em`.
  - It's in em, so it scales with the reading size. That makes it a §3 exemption in `styles.test.ts`, like `.reader-paragraph`.
- `.reader-opening::first-line`: `font-variant-caps: small-caps; letter-spacing: 0.04em`. With `font-synthesis: none`, a font without `smcp` shows the line unchanged rather than with fake small caps, so a missing or stale font file degrades to today's look.

## 6. Copy
- Sidebar button: "Display". Panel: "Display settings" (dialog name); section labels "Text size", "Line spacing", "Width", "Theme"; options as in §4; reset "Default text settings".
- No status messages. Every change is visible straight away, and a storage failure is silent (§2).

## 7. Tests
- New `src/readerSettings.test.ts`:
  - with empty `localStorage`, `loadSettings()` equals `DEFAULTS`;
  - stored `{"v":1,"size":23,"leading":"loose","width":"wide","theme":"sepia"}` loads as written;
  - `{"v":1,"size":99,"leading":"x","theme":"blue"}` gives size 19, leading "normal" and theme "system", and `"not json"` and `{"v":2,…}` give `DEFAULTS`;
  - with `vi.spyOn(Storage.prototype, "getItem")` throwing, it returns `DEFAULTS`, and `saveSettings` doesn't throw when `setItem` throws;
  - `largerText` at 26 stays 26, `smallerText` at 16 stays 16, `largerText` at 19 gives 21;
  - `resetText({ size: 23, leading: "loose", width: "wide", theme: "dark" })` gives `{ …DEFAULTS, theme: "dark" }`;
  - `emit("menu", "theme-sepia")` (desktop shell wiring, whichever plan lands second) sets `dataset.theme` to "sepia" on the Books screen, and the reader's Display panel then shows Sepia pressed;
  - `applyTheme("sepia")` sets `document.documentElement.dataset.theme` to "sepia", and `applyTheme("system")` removes it.
- New `src/chapterOpening.test.ts`:
  - title "Paṭācārā" given in NFD and first block "  paṭācārā " in NFC is a heading;
  - a first block of 120 characters right after the heading is the opening;
  - when the first two blocks after the heading are 18 and 40 characters and the third is 150, the opening is the third;
  - a 150-character block in the sixth position after the heading gives `openingId: null`;
  - `chapter_title: null` gives `headingId: null`;
  - an empty `blocks` gives both `null`.
- `src/ReaderView.test.tsx`, opening Test Book of Research from the Books screen:
  - "Chapter One: Beginnings": `#block-1` has class `reader-chapter-heading`, and no block has `reader-opening`. After choosing "Part One" in A Long Book for Scrolling, `#block-8` has `reader-opening` and no block has `reader-chapter-heading`.
  - **Display** opens a dialog named "Display settings".
  - **Larger text** sets the `.reader` element's `--reader-size` to `21px`, and the size reads "21".
  - **Loose** sets `--reader-leading` to `1.95`, and **Wide** sets `--reader-measure` to `40em`.
  - **Sepia** sets `document.documentElement.dataset.theme` to "sepia", and `aria-pressed` moves to it.
  - Unmounting and calling `renderApp()` again, then reopening the book, shows size "21" and Sepia pressed, read back from `localStorage`.
  - **Default text settings** restores 19 / Normal / Medium and leaves Sepia.
  - **Larger text** is disabled at 26.
  - Escape closes the dialog, and so does a `mousedown` on the reader text. Neither changes a setting.
  - With a selection toolbar showing, changing the size removes it.
- `src/test/setup.ts`: `afterEach` also calls `localStorage.clear()` and `delete document.documentElement.dataset.theme`.
- `src/styles.test.ts`, from the type plan:
  - `[data-theme="dark"]` declares the same colour tokens with the same values as the dark media query;
  - `[data-theme="sepia"]` declares every colour token in `:root`;
  - `--reader-size`, `--reader-leading` and `--reader-measure` are allowed as the `.reader-text` font-size, line height and max-width;
  - `.reader-content`'s `padding-left` and `.reader-chapter-heading` join the exemption list.
- `src/fonts.test.ts`: "Literata keeps old-style figures and small caps". A helper, `src/test/woff2Features.ts`, reads the WOFF2 header and table directory, inflates the table data with `node:zlib`'s `brotliDecompressSync` and returns the GSUB `FeatureList` tags. That's about 30 lines, the same approach as the check above. It asserts that both `literata-*.woff2` files include `onum` and `smcp`, so re-downloading the fontsource files would fail CI.
- `src/Demo.test.tsx`: unchanged, but run it, because the demo uses the same reader and fonts.

## 8. README
- Features: a bullet saying "**Make the reader yours**: text size, line spacing, column width and a Light, Sepia or Dark theme, remembered on this computer."
- "How it's built": the frontend entry for `ReaderView.tsx` names the Display panel, `readerSettings.ts` (stored in `localStorage`), `chapterOpening.ts`, and the margin column, now decided by `ResizeObserver` instead of a media query. The `fonts.css` entry notes Literata is subset from upstream by `scripts/subset-literata.sh`, keeping `onum`/`smcp`/`c2sc`.
- "What's actually verified": the tests above, the WebKitGTK `CSS.supports` and width checks from Context, the sepia contrast ratios, and what was walked in `npm run tauri dev`. Also: hanging punctuation isn't applied on Windows (WebView2 doesn't support it), and that wasn't checked on Windows.
- Known limitations, a new item: display settings live in the app's web storage, so they're per computer and aren't in a backup. The dev server and the installed app keep separate settings. The chapter heading and opening are guesses from the text (a first block equal to the title, a first paragraph of 100+ characters), because the parser drops heading markup (limitation 3).
- Roadmap: add and tick "Reader display settings (size, spacing, width, theme) and book typography", under the Paper item.
- `site/`: no change until the release that ships it (per the site-copy memory). The demo picks the panel up when this merges.

## Verification
1. `npx tsc --noEmit`, `npm test`, `npm run format:check`, plus `cargo test -p ebook_research_core` and clippy as usual (no Rust changes).
2. Run `scripts/subset-literata.sh`, and report both new file sizes in the PR.
3. `npm run dev:mock` in Chrome:
   - each size, spacing and width, with the margin column appearing and disappearing as the window is resized;
   - at 26px in a narrow window, the bookmark icon is fully visible;
   - all four themes on every screen, not just the reader;
   - with a note card open in the margin column, changing the size keeps the paragraph at the top in place;
   - reload: the settings persist.
4. `npm run dev:demo`: on the Pali book, the small-caps first line keeps its diacritics (ā ṭ ṃ) as small caps, not fallback glyphs, and figures are old-style in "Thig 1.1".
5. `npm run tauri dev`:
   - with the system set to dark, choose Light and Sepia, then quit and relaunch: the settings persist, and check for a first-frame flash;
   - the longest chapter in the library (the 8,071-character block): scrolling and resizing stay smooth with `text-wrap: pretty`;
   - hanging quotes are visible in WebKitGTK.
