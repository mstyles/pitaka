# Feedback links

## Context
The project page, the README and the app give no way to report a bug or send an idea. The page's only route is "View on GitHub", where a reader has to find the Issues tab themselves. The README's Contributing section links CONTRIBUTING.md, which is written for developers. Inside the app there's nothing. Many of the readers this is for don't have a GitHub account, so an issue form alone shuts them out.

This plan adds three routes, worded the same everywhere:
- **Report a bug**: a new issue from the existing bug-report template.
- **Suggest an idea**: a new issue from a new ideas-and-feedback template.
- **Email**: `mailto:mstyleshk@gmail.com?subject=Pitaka%20feedback`, for anyone without a GitHub account. This address is already public in every commit.

They appear on the project page, in the README and CONTRIBUTING.md, on the app's Home screen (so also in the browser demo and `dev:mock`), and in the desktop-shell plan's Help menu.

Out of scope:
- A tip jar or sponsor link. It was considered and dropped.
- Attaching logs, the app version or OS to a report automatically. The bug template asks for them.
- GitHub Discussions. Issues hold both bugs and ideas, told apart by label.

Ruled out:
- A hosted form (Formspree, Google Forms). It's a third-party service holding readers' messages, and a form to keep free of spam. Email covers the same people.
- Opening the links with `<a target="_blank">` inside the Tauri window. The webview doesn't hand new windows to the system browser, so the links would do nothing. §4 uses the opener plugin instead.

Checked:
- `tauri-plugin-opener` 2.7.0's `opener:default` permission, which `src-tauri/capabilities/default.json` already grants, includes `allow-default-urls`. That scope allows `https://`, `http://` and `mailto:` (`permissions/allow-default-urls.toml`), so no capability change is needed. `@tauri-apps/plugin-opener` is already in `package.json`, though nothing imports it yet. `openUrl(url)` invokes `plugin:opener|open_url` with `{ url, with: undefined }`.
- `isTauri()` from `@tauri-apps/api/core` reads `globalThis.isTauri`. The Tauri window sets it, but `mockIPC` doesn't, so `dev:mock`, the demo and the tests see `false`.
- `https://github.com/mstyles/pitaka/issues/new?template=bug_report.md` returns 302 when logged out: GitHub sends the visitor to sign in, then on to the form. The repo is public with issues on and Discussions off.
- The repo already has `bug` and `enhancement` labels, so the templates don't need a new label.

Order: build this after `docs/plans/desktop-shell.md`, which creates `menu.rs` and its Help menu. Sections 1–4 don't depend on it. If this lands first, §5 is left for the desktop-shell PR, and its Help menu entry is edited to match.

## 1. Issue templates: `.github/ISSUE_TEMPLATE/`
- New `feedback.md`. Front matter: `name: Idea or feedback`, `about: Suggest a feature, or tell me what's working and what isn't`, `labels: enhancement`. The body has three prompts, written as HTML comments like the bug template's:
  - **What you'd like**: what you were trying to do, and what would make it easier.
  - **How you use Pitaka**: what kinds of books, and roughly how many. This is optional.
  - **Anything else**.
- `bug_report.md`, Environment: replace "Pitaka commit (`git rev-parse --short HEAD`)" with "Pitaka version (the release you downloaded, or `git rev-parse --short HEAD` if you built it)". Releases exist now, and most reporters won't have a checkout.
- `config.yml` doesn't change. The security link stays, and blank issues stay enabled.

## 2. Shared links: new `src/feedback.tsx`
- `export const FEEDBACK_LINKS = { bug: "https://github.com/mstyles/pitaka/issues/new?template=bug_report.md", idea: "https://github.com/mstyles/pitaka/issues/new?template=feedback.md", email: "mailto:mstyleshk@gmail.com?subject=Pitaka%20feedback" } as const;`. This is the one copy for the frontend. `site/index.html` and `menu.rs` write the same strings out, each with a comment pointing back here.
- `export function ExternalLink({ href, children }: { href: string; children: ReactNode })` renders `<a href={href} target="_blank" rel="noreferrer">`. When `isTauri()` is true, its `onClick` calls `preventDefault()` and then `openUrl(href)`. A rejection is logged with `console.error`, since there's no screen-level status to report it to. In the browser it's a plain link.

## 3. Mock backend: `src/test/mockBackend.ts`
- Add a route for `plugin:opener|open_url` that records the `url` argument in a new `openedUrls: string[]` on the mock's returned handle and resolves `undefined`. Nothing calls it unless a test sets `globalThis.isTauri`. Without the route, the mock throws on the unknown command.

## 4. Home screen: `src/HomeView.tsx`, `src/App.css`
- At the bottom of Home, after the recent books (and after desktop-shell's `home-hint`, if that has landed), add:
  `<p className="home-feedback">Found a bug, or have an idea? <ExternalLink href={FEEDBACK_LINKS.bug}>Report a bug</ExternalLink> · <ExternalLink href={FEEDBACK_LINKS.idea}>Suggest an idea</ExternalLink> · or <ExternalLink href={FEEDBACK_LINKS.email}>email me</ExternalLink>.</p>`
- `.home-feedback`: `--text-sm`, `--muted` text, `--accent` links, and the same top margin as `.home-recent`. It shows whether or not the library is empty.
- The demo banner doesn't change. It's already three sentences long, and the demo opens on Home, where this line is.

## 5. Help menu: `src-tauri/src/menu.rs`
This section changes desktop-shell's Help submenu, after its Pitaka website item:
- Report a bug (`report`, opens the bug template URL instead of `/issues`)
- Suggest an idea (`suggest`, opens the feedback template URL)
- Email feedback (`email`, opens the `mailto:` URL)

All three go through `OpenerExt::opener().open_url(url, None::<&str>)` in `handle`, like `website`. These ids are handled in Rust and never sent to the frontend, so they aren't added to `MENU_ACTIONS`. The URLs are `const`s at the top of `menu.rs`, with a comment naming `src/feedback.tsx`.

## 6. Project page: `site/index.html`, `site/style.css`
- A new `<section class="get" id="feedback">` after "Good to know":
  - `<h2>Feedback</h2>`
  - "Pitaka is made by one person, and hearing how you use it is the best way it gets better. If something doesn't work, or there's something you wish it did, let me know."
  - A `<p class="actions">` with three buttons: **Report a bug**, **Suggest an idea** and **Email me**. They use the §2 URLs and the existing `.button` style, with none of them primary.
  - A `.note`: "Reporting a bug or idea on GitHub needs a free account. Email works without one. For a security problem, please [report it privately](https://github.com/mstyles/pitaka/security/advisories/new)."
- Footer: add a first line, "[Send feedback](#feedback) · [GitHub](https://github.com/mstyles/pitaka)", above the licence text.
- No CSS changes are expected: `.get`, `.actions`, `.button` and `.note` already cover this. If the three buttons don't wrap cleanly at 390px, give `.get .actions` a `margin-top: 16px`.
- The site-copy memory holds back copy for unreleased features. This is copy about the project, not a feature, so it can go out with the merge. The page doesn't mention the in-app links.

## 7. README and CONTRIBUTING: `README.md`, `CONTRIBUTING.md`
- README, Contributing: open with "Found a bug, or have an idea? [Report a bug](…bug_report.md) or [suggest an idea](…feedback.md) on GitHub, or email mstyleshk@gmail.com if you don't have a GitHub account." The existing CONTRIBUTING/SECURITY/CHANGELOG sentence follows.
- CONTRIBUTING.md: rename "Reporting a bug" to "Reporting a bug or suggesting an idea". Add one sentence: ideas use the Idea or feedback template, and email is fine for either.
- "What's actually verified": one entry. `Home.test.tsx` covers the Home links in the browser and in Tauri mode, and the Help menu items were checked by hand in `npm run tauri dev` on Linux. Opening `mailto:` was checked only with Linux's default mail handler. The project page section was checked in Chrome at 390px and 1280px.
- Roadmap: add and tick "Feedback links on the website, the README, Home and the Help menu".
- `CHANGELOG.md` Unreleased: "Home and the Help menu link to bug reports, ideas and email feedback."

## 8. Tests
- `src/Home.test.tsx`:
  - Home shows links named "Report a bug", "Suggest an idea" and "email me", with `href`s equal to `FEEDBACK_LINKS.bug`, `.idea` and `.email`, each with `target="_blank"` and `rel="noreferrer"`.
  - The same with an empty library (the existing empty-library setup), where the line still shows.
  - In Tauri mode, with `globalThis.isTauri = true` set in the test and deleted in `afterEach`: clicking "Report a bug" records `openedUrls` equal to `[FEEDBACK_LINKS.bug]`, and the click event is `defaultPrevented`.
  - In browser mode, clicking a link calls no `plugin:opener|open_url`, so `openedUrls` stays empty.
- `src/Demo.test.tsx`: the demo's Home shows "Report a bug".
- Rust: no unit test for the menu items. As in desktop-shell §6, `tauri::test` isn't enabled, and the manual check covers them.
- Existing tests pass unchanged.

## Verification
1. `npx tsc --noEmit`, `npm test`, `npm run format:check`, `cargo clippy --workspace --all-targets`, `cargo test -p ebook_research_core`.
2. `npm run build:site`, then serve `site-build/` and open it in Chrome at 390px and 1280px, in light and dark. Click the three buttons: the bug and idea links reach GitHub's issue form with the right template, and Email opens a mail draft with the subject filled in.
3. `npm run dev:demo`: the Home line's links open in a new tab.
4. `npm run tauri dev` on Linux: the Home links and the three Help items open the system browser, or the mail client for Email, and the app window stays where it was.
5. After merging, check that a new issue from the Idea or feedback template gets the `enhancement` label.
