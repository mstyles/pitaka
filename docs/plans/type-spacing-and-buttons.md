# Type scale, spacing scale and button styles

## Context
The Paper style (`docs/plans/paper-style.md`) made every colour a token, but sizes and spacing are still written by hand in `src/App.css`. `font-size` appears 33 times with 14 different written values, in px and em mixed. Because em compounds, these work out to 18 different sizes on screen: 12, 12.75, 13, 13.5, 13.6, 14, 14.4, 15, 16, 16.8, 18, 19, 20, 22.4, 24, 25.6, 36 and 56px. Meta lines are 14.4px on the Books screen but the sidebar's author is 13px. `.selection-toolbar-error` is 12.75px only because it sits inside a 15px toolbar. Small buttons are 30, 32 or 36px tall depending on the screen. Padding, margin and gap mix em and px the same way (0.35em, 0.6em, 20px 16px, 48px 32px 48px 48px), so edges and gaps don't line up between screens.

Buttons also have no hierarchy. Apart from four `.button-primary` uses, every button is the same outlined box. The row actions Index and Remove look like the Import book button, and back links look like commands. `.button-primary` has no hover state of its own: `button:hover` only sets its border to the accent it already has. `.button-danger` draws a red border all the time, even on a Remove you only reach by hovering a row.

This pass adds type, line-height, spacing and control-height tokens to `:root`, rewrites every size in `App.css` with them, and adds three button styles (quiet, danger and small) next to the existing primary and the default, which becomes "secondary". It's CSS plus `className` changes only. There are no new dependencies and no Rust changes. It isn't a README roadmap item. It follows on from the ticked Paper item.

Build it after the edit-book-details and backup-and-restore branches merge. Both add buttons to `BooksView.tsx` (the row's Edit, the edit form's Save/Cancel, and Back up/Restore), and this pass styles those buttons too.

Out of scope:
- New colours other than the two in §2, layout changes (widths, the 1280px margin column, breakpoints), icons, motion, toasts and empty or loading states. Those were the other suggestions, and each gets its own plan.
- Reader settings (text size, column width). The reader's 19px gets its own token, `--text-read`, so that change has one place to start from.
- The special-purpose buttons that already reset their look: nav tabs, home cards, home recent rows and "All N books →", chapter-list items, the Passages/Chapters and sort segmented toggles, swatches, and the margin bookmark, note and pen icons. Only their sizes move onto tokens.
- `site/`. The public demo is built from `src/`, so it picks up the new look when this merges. That's styling, not new-feature copy, so the site-copy rule doesn't apply.

Ruled out:
- em-based tokens. They compound, which is the cause of the 12.75px and 13.6px sizes. Everything moves to rem. The exceptions are the reader offsets that have to track the reading text (§3).
- `color-mix()` to derive hover colours. WebKitGTK 2.52 supports it (checked while planning reader settings), but explicit tokens work on any webview version and their contrast is computed below, so the two hover colours are explicit tokens.
- A class on every button. Unclassed buttons stay the secondary style, so only the buttons that change get a class.
- Stylelint or another linter. That would be a new dependency. A Vitest test reads `App.css` the way `src/fonts.test.ts` reads `fonts.css` (§6).

Checked:
- Every computed size listed above, worked out from `App.css` with the 16px root and each element's parent: `.selection-toolbar` 15px × 0.85em = 12.75px, `.note-card-actions button` 15px × 0.9em = 13.5px, and so on.
- WCAG contrast ratios of the new combinations, worked out in Python from the hex values:
  - on-accent on `--accent-strong`: 7.8:1 light, 9.1:1 dark (6.1:1 and 7.5:1 on `--accent` today);
  - `--danger` on `--surface`: 6.4:1 light, 5.5:1 dark;
  - `--muted` on the `--hover` wash: 5.0:1 light, 5.8:1 dark.
- No test depends on the class names that change. Tests query by role and name. `Demo.test.tsx:27` compares a chapter-list button's `className`, but that button is out of scope.

## 1. Tokens: `src/App.css` `:root`
- Type, all rem:
  - `--text-xs: 0.75rem` (12)
  - `--text-sm: 0.875rem` (14)
  - `--text-base: 1rem` (16)
  - `--text-md: 1.125rem` (18)
  - `--text-lg: 1.25rem` (20)
  - `--text-xl: 1.5rem` (24)
  - `--text-2xl: 2.25rem` (36)
  - `--text-display: 3.5rem` (56)
  - `--text-read: 1.1875rem` (19, the reader's text)
- Line height:
  - `--leading-tight: 1.2` for headings;
  - `--leading-ui: 1.5` for the root and controls;
  - `--leading-read: 1.75` for book text.
- Spacing, on a 4px grid: `--space-1: 0.25rem`, `--space-2: 0.5rem`, `--space-3: 0.75rem`, `--space-4: 1rem`, `--space-5: 1.25rem`, `--space-6: 1.5rem`, `--space-8: 2rem`, `--space-10: 2.5rem`, `--space-12: 3rem`.
- Controls: `--control-h: 2.5rem` (40) and `--control-h-sm: 2rem` (32).
- Colour, with a dark value in the `prefers-color-scheme: dark` block:
  - `--accent-strong`: `#823d15` light, `#eaae7c` dark;
  - `--hover`: `rgba(42, 36, 29, 0.06)` light, `rgba(237, 228, 211, 0.08)` dark. It's a translucent wash, so it works over both `--surface` and `--bg`.
- The comment at the top of the file becomes "Paper: every colour, size and space is a token here; dark mode only swaps colours."

## 2. Type: `src/App.css`
Each `font-size` becomes a token, chosen by role rather than by nearest pixel:
- **xs**: `.section-label` (12, unchanged). It's the only all-caps label.
- **sm, for secondary text, errors and small buttons**: these are 14px today, give or take a pixel and a half.
  - Meta and status lines: `.status`, `.home-card-detail`, `.home-recent-more`, `.book-meta`, `.import-failures`, `.index-coverage`, `.index-progress`, `.result-count`, `.result-meta`, `.folder-status`, `.folder-passage-meta`. Each is 14.4 or 13.6 today.
  - `.reader-book-author` (13) and `.demo-banner` (14).
  - `.bookmark-popover-heading` and `.bookmark-popover-error` (13.6), and `.selection-toolbar-error` (12.75). All error lines are now one size.
  - `.button-sm` (§4).
- **base**: the root and controls (unchanged), plus the floating panels and note cards. `.bookmark-popover` stays at 16. `.selection-toolbar`, `.highlight-popover` and `.note-card` go from 15 to 16, so all panels over the text are the same size. Note cards in the 240px margin column wrap a little sooner; verification checks this.
- **md, for book titles everywhere**: `.book-title` (16.8) and `.reader-book-title` (18).
- **lg**: `.wordmark` (20).
- **xl, for screen and card headings**: `h2` (the browser's default 24, now set explicitly), `.folder-name` (25.6) and `.home-card-title` (22.4).
- **2xl**: `h1` (36). **display**: `.home h1` (56).
- **read**: `.reader-text` (19).

Line heights:
- `--leading-tight`: `h1, h2` (1.2) and `.reader-book-title` (1.3 → 1.2).
- `--leading-ui`: the root, plus `.selection-toolbar` and `.highlight-popover` (1.4) and `.note-card` (1.45).
- `--leading-read`: `.reader-text` (1.75), plus `.result-snippet` and `.folder-passage-text` (1.7). Book text now has one line height wherever it appears.

## 3. Spacing and control heights: `src/App.css`
- Each `padding`, `margin` and `gap` becomes the `--space-*` token nearest its computed px today. When a value falls between two tokens, it takes the nearer one. These change by more than 2px:
  - `.home-card` gap and `.search-mode` gap (0.35em = 5.6px) → `--space-1`.
  - `h1` margin-bottom (0.6em of 36 = 21.6px) → `--space-5`.
  - `.home h1` margin-bottom (33.6px) → `--space-8`.
  - `.annotated-books` margin-top (2.5em = 40px) is unchanged at `--space-10`.
- Every other value rounds by 2px or less. For example, control padding `0.45em 1em` becomes `var(--space-2) var(--space-4)`, and `.reader-content`'s `48px 32px 48px 48px` becomes `--space-12`/`--space-8`.
- Negative and combined values use the tokens:
  - `.book-index + .book-remove` uses `margin-left: calc(-1 * var(--space-2))`;
  - `.annotation-quote` padding-left is `var(--space-3)`, and `.annotation-note`'s is `calc(var(--space-3) + 3px)`, so the note stays aligned under the quote's text.
- Exempt, with a one-line comment: values in the reader that must scale with the 19px reading text stay in em. They are `.reader-paragraph` and `.note-margin` margins, `.note-hint` margin and padding, and `.result-snippet mark` padding. So do the `top`/`left` offsets of `.bookmark-toggle`, `.note-toggle` and `.bookmark-popover`, which aren't spacing properties anyway. `.scope-toggle`'s `-1px` overlap and borders also stay.
- Control heights:
  - inputs, selects and buttons use `min-height: var(--control-h)`;
  - all small controls use `--control-h-sm`: today's 32px row actions, the 30px toolbar, popover and note-card buttons, and the 36px `.bookmark-popover` input.
- Layout sizes stay as they are: `--content`, the 272px sidebar, the 640/240/24px reader grid and its comment's arithmetic, the 44px home-card icon, the 22px swatches and the 64px header.

## 4. Button styles: `src/App.css`
- Secondary: an unclassed `button`, which looks as it does today. Its `transition` gains `background-color 0.2s, color 0.2s`.
- `.button-primary` keeps its accent fill. On `:hover:not(:disabled)` its background and border become `--accent-strong`, so it finally has a hover state.
- `.button-quiet`:
  - normally: `border-color: transparent; background: none; color: var(--muted)`;
  - on hover: `color: var(--text); background: var(--hover)`, and the border stays transparent, overriding `button:hover`'s accent border.
  - It's for actions that are secondary to their row or screen.
- `.button-danger`:
  - normally: `color: var(--danger)` with the default border, so the red border no longer shows all the time;
  - on hover: `border-color: var(--danger); background-color: var(--bg)`, as today.
  - `.button-quiet.button-danger` is muted until hovered, then turns `--danger`, with a `--hover` background and no border.
- `.button-sm`: `min-height: var(--control-h-sm); padding: var(--space-1) var(--space-3); font-size: var(--text-sm)`. It replaces the size rules in these selectors:
  - `.book-index, .book-remove, .folder-passage-remove`;
  - `.selection-toolbar-note`;
  - `.highlight-popover-row button:not(.swatch)`;
  - `.note-card-actions button`.
  - `.reader-search-book` keeps its `inline-flex`, gap and margin-top, but drops its own padding, font-size and min-height.
- The row actions' show-on-hover rules (`opacity: 0` until the row is hovered or focused) are kept unchanged.

## 5. Applying them: the views
The rule is one primary action per screen or form. Actions that belong to a row or card, and back links, are quiet. A destructive action is danger, and quiet too when it sits in a row. Anything not listed keeps its current class.
- `BooksView.tsx`:
  - Import book stays primary.
  - Import folder, Index all books, Stop import, Stop indexing, Clear filter, Back up and Restore stay secondary.
  - Row Index: `book-index button-quiet button-sm`.
  - Row Edit: `button-quiet button-sm`, keeping its existing class.
  - Row Remove: `book-remove button-quiet button-danger button-sm`.
  - Edit form: Save is `button-primary`; Cancel stays secondary.
- `FolderView.tsx`:
  - "← Bookmarks": `button-quiet`.
  - The rename form's Save becomes `button-primary`; Cancel and Rename stay secondary; Delete stays `button-danger`.
  - Passage Remove: `folder-passage-remove button-quiet button-danger button-sm`.
- `BookAnnotationsView.tsx`: "← Bookmarks & notes": `button-quiet`.
- `BookmarksView.tsx`: Create stays primary.
- `SearchView.tsx`: Search stays primary.
- `ReaderView.tsx`:
  - `reader-back` gains `button-quiet`, keeping its ellipsis;
  - `reader-search-book` gains `button-sm`.
- `SelectionToolbar.tsx`: Add note becomes `button-sm`, replacing `selection-toolbar-note`, whose rule is removed.
- `HighlightPopover.tsx`: Add note becomes `button-sm`; Remove becomes `button-danger button-sm`.
- `NoteCard.tsx`:
  - Viewing: Edit and Hide are `button-quiet button-sm`.
  - Editing: Save is `button-primary button-sm`, Cancel is `button-sm`, and Delete is `button-danger button-sm`.

## 6. Tests
- New `src/styles.test.ts`, which reads `src/App.css` from disk as `fonts.test.ts` does. It finds each innermost `selector { declarations }` block with `/([^{}]+)\{([^{}]*)\}/g`, so rules inside `@media` are included. It asserts:
  - `every font-size is a --text token`: outside `:root`, each `font-size` value matches `^var\(--text-[a-z0-9]+\)$`.
  - `every line-height is a --leading token`: the same check, with `0` allowed for the icon buttons (`line-height: 0`) and `1` for `.note-hint`.
  - `spacing uses --space tokens`: each `padding*`, `margin*` and `gap` value, split on spaces outside `calc()`, is one of:
    - `0`, `auto`, or a `var(--space-N)`;
    - a `calc()` containing only `--space-*` tokens, numbers and px borders;
    - for `selector`s on an explicit allowlist of the §3 exemptions (`.reader-paragraph`, `.note-margin`, `.note-hint`, `.result-snippet mark`, `.scope-toggle button:last-child`), anything.
    - So a new hand-written `0.6em` fails, with the selector in the message.
  - `every var() it uses is defined`: each `var(--x)` name appears as a `--x:` declaration in `:root`, so a typo like `--space-7` fails.
  - `every token has a dark value where it needs one`: each colour token in `:root` (`--bg` … `--rule-neutral`, `--accent-strong`, `--hover`) is also declared in the dark block.
- `src/Books.test.tsx`: one test that a row's Remove has the classes `button-quiet` and `button-danger`, and Import book has `button-primary`. This guards the hierarchy without snapshotting markup.
- Existing tests pass unchanged. They query by role and name. Run `src/Demo.test.tsx` to confirm the chapter-list `className` check.

## 7. README and CLAUDE.md
- README "What's actually verified": the `App.css` sentence ("Colours are tokens…") becomes:
  - colours, type sizes, line heights, spacing and control heights are tokens, enforced by `src/styles.test.ts`;
  - buttons come in four styles (primary, secondary, quiet, danger) plus small;
  - what was compared in the browser in light and dark, with the contrast ratios from Context.
- README project structure: `App.css <- Paper colour tokens and all styles` becomes `App.css <- Paper tokens (colour, type, spacing) and all styles`.
- README roadmap: add and tick "Type and spacing scales and a button hierarchy", under the Paper item.
- `CLAUDE.md` Architecture rules, Frontend bullet: add "Sizes in `App.css` use the `--text-*`, `--leading-*` and `--space-*` tokens (`src/styles.test.ts` checks); a new button is unclassed (secondary) unless it's the screen's main action (`button-primary`), a row action (`button-quiet button-sm`) or destructive (`button-danger`)."

## Verification
1. `npx tsc --noEmit`, `npm test`, `npm run format:check`. No Rust changes, but run `cargo test -p ebook_research_core` and clippy as usual.
2. Before and after screenshots in `npm run dev:mock` (Chrome), in light and dark, at 1366px and at 560px:
   - Home;
   - Books, with a row hovered and with the edit form open;
   - Search with passage results;
   - Bookmarks, and a folder with its rename form;
   - a book's Bookmarks & notes;
   - the reader with the selection toolbar, the highlight popover, the bookmark popover, and a note card in the 240px margin column, both reading and editing.

   Check that headings, meta lines and small buttons match across screens, that no text is clipped, and that note cards still wrap reasonably at 16px.
3. `npm run dev:demo`: the same reader checks on the Pali book, for diacritics at the new sizes.
4. `npm run tauri dev`: one pass through the Books screen and the reader in WebKitGTK, for hover states and the `--hover` wash.
