# Release builds for Linux and Windows

## Context
Pitaka can only be installed by building it from source, which needs Rust, Node and (on Windows) Visual Studio Build Tools. That's a non-starter for most readers. The GitHub releases so far (`v0.1.0`, `v0.2.0`) are tags with notes copied from `CHANGELOG.md` and no files attached; their notes end "There are no prebuilt binaries yet". This is the roadmap item "Release builds for Linux, macOS and Windows", cut down to Linux and Windows for this iteration.

When it's done, pushing a version tag builds the installers on GitHub Actions and attaches them to a draft release, with the version's CHANGELOG section as its notes. Nothing goes public until the draft has been tested and published by hand.

This builds on the Windows support merged in PR #20: the `rust-windows` CI job, the Windows install notes in the README, and a manual test on Windows in which the MSI and NSIS installers from `npm run tauri build` both installed and launched.

Out of scope:
- macOS: it needs an Apple Developer account ($99/year) for signing and notarization, or Gatekeeper blocks the app. It's a later iteration, and the roadmap item stays open until then.
- Windows code signing: section 6 sets out the options. This iteration ships unsigned, with the workflow arranged so signing slots in as one step later.
- The in-app updater (`tauri-plugin-updater`): it needs its own signing key and a check-for-updates UI. Users download each new version from the Releases page.
- The Microsoft Store, winget, Flathub, the AUR.

Ruled out:
- Building installers in `ci.yml` on every push: a release build with the workspace's LTO profile takes minutes per OS, and nobody installs a build of an arbitrary commit.
- A `release` branch as the trigger, as in `tauri-action`'s example: tags already mark versions here (`v0.1.0`, `v0.2.0`), and a tag pins exactly which commit was built.
- Letting `tauri-action` create the release itself: it can't take the notes from `CHANGELOG.md`, and with two build jobs, whichever finished first would create the release. A first job creates the draft; the build jobs only upload to it.

## 1. App identity: `src-tauri/tauri.conf.json`
These values become part of every install, so they have to be right before the first installer ships.
- `productName`: `"pitaka"` → `"Pitaka"`. On Windows it names the installers, the install folder, the Start Menu entry and the entry in Settings → Apps. On Linux it becomes the desktop file's `Name`, and the `.deb`/`.rpm` package names are its kebab-case form, so they stay `pitaka`. The data folder comes from `identifier` (`com.pitaka.app`), which doesn't change, so existing libraries are found as before. Checked in `tauri-utils` 2.10's config docs.
- `bundle.windows.wix.upgradeCode`: pin it explicitly. By default Tauri derives it from `productName` (`tauri inspect wix-upgrade-code` prints `3636ce6f-08e6-5e32-af3c-38db36e0906e` for today's `pitaka`). If it ever changes, Windows treats the next MSI as a different app and users end up with two copies. Pin whatever the command prints after the rename. JSON can't carry a comment, so the README's architecture section says why it must never change.
- `app.windows[0].title`: `"pitaka"` → `"Pitaka"`, to match.
- `version`: remove it. Tauri then takes the version from `src-tauri/Cargo.toml`, leaving one fewer place for the version to drift.
- `bundle.targets` stays `"all"`: on Linux that's `.deb`, `.rpm` and `.AppImage`; on Windows, the NSIS `-setup.exe` and the `.msi`. The README says which to pick (section 5).
- `bundle.publisher`, `bundle.shortDescription`, `bundle.homepage`: set to `"Matt Styles"`, the `description` from `src-tauri/Cargo.toml`, and `https://mstyles.github.io/pitaka/`. They show up in Settings → Apps and in the package metadata. Today they're blank or derived.

## 2. Version check and release notes: `scripts/release-check.mjs` (new)
A Node script with no dependencies, run as `node scripts/release-check.mjs v0.3.0`:
- It strips the `v` and checks the version against `package.json`'s `version`, `src-tauri/Cargo.toml`'s and `ebook_research_core/Cargo.toml`'s `[package] version` (read with a regex on the first `version = "…"` line). On a mismatch it exits 1 with `version mismatch: tag v0.3.0, package.json 0.2.0` (one line per file that differs).
- It prints the body of the CHANGELOG's `## [0.3.0] - <date>` section to stdout: everything up to the next `## [` heading, trimmed. If there's no such section, or it's empty, it exits 1 with `CHANGELOG.md has no notes for 0.3.0`. That guards against tagging before moving `[Unreleased]` into a version.
- Then it appends a fixed footer: which file to download for each OS, and that the Windows installers aren't signed yet, so SmartScreen will warn (copy in section 5).
- `Cargo.lock` isn't checked: `cargo build --locked` in the workflow fails if it disagrees with `Cargo.toml`.

## 3. Release workflow: `.github/workflows/release.yml` (new)
Triggered by `push: tags: ['v*']` and by `workflow_dispatch`. Actions are pinned by SHA, as in `ci.yml`: the same `checkout`, `rust-toolchain`, `rust-cache` and `setup-node` pins, plus `tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f # action-v1.0.0`. The workflow-level permission is `contents: read`; only the two jobs that write to the release get `contents: write`.

1. **`draft`** (ubuntu-24.04, tag pushes only): runs `node scripts/release-check.mjs "$GITHUB_REF_NAME" > notes.md`, then `gh release create "$GITHUB_REF_NAME" --draft --verify-tag --title "Pitaka ${GITHUB_REF_NAME#v}" --notes-file notes.md`. It outputs the release id for the build jobs.
2. **`build`**, a matrix with `fail-fast: false`:
   - `ubuntu-22.04`, not CI's 24.04: an AppImage or `.deb` only runs on systems whose glibc is at least as new as the build machine's, so building on 22.04 covers Ubuntu 22.04+, Debian 12+ and their peers. Installs the same apt packages as `ci.yml` plus `patchelf` (which the AppImage step needs). If GitHub has retired the 22.04 image by the time this is built, use 24.04 and say so in the README.
   - `windows-2025`, as in `rust-windows`.
   - Steps: checkout, Node 24 + `npm ci`, Rust stable, `rust-cache`, then `tauri-action` with `releaseId` from `draft` and `args: --features semantic -- --locked` (section 4). `tauri-action` runs `tauri build`, whose `beforeBuildCommand` already runs `npm run build`, and uploads each bundle to the draft.
   - On `workflow_dispatch` there's no release: `tauri-action` gets no `releaseId`, and an `actions/upload-artifact` step (pinned by SHA) uploads `target/release/bundle/**` as a workflow artifact instead. That's how the workflow gets tested from the PR branch without a tag.
3. **`checksums`** (ubuntu-24.04, tag pushes only, after `build`): downloads the draft's assets with `gh release download`, writes `SHA256SUMS` with `sha256sum`, and uploads it to the draft. Linux users have a way to verify a download without signing, and the file states which bytes were published.

Publishing stays manual: after testing the draft (section 7), publish it in the GitHub UI or with `gh release edit v0.3.0 --draft=false`.

## 4. Chapter search is in the release build
The installers are built with `--features semantic`. Chapter search is the headline feature of 0.2.0, and someone who downloads an installer can't rebuild with a flag. The `rust-windows` job already proves the feature links with MSVC.
- Cost: the installer is larger because of candle and `tokenizers`. Record the actual sizes from the first draft in this plan and the README. A local Linux build gave a 16 MB binary, 6.7 MB `.deb`/`.rpm` and an 86 MB AppImage (most of which is the bundled WebKit and GTK). The model (about 130 MB) still downloads on first use, not with the installer.
- One installer per format, not a lean and a chapter-search edition side by side. Two editions double the build jobs and the manual testing. They also make users choose up front, and switching from lean to full later doesn't index books already in the library (limitation 9). Without a re-import, which deletes bookmarks, those books stay out of chapter search. The model download is already deferred to first use, so a lean edition would only save the candle and `tokenizers` code. If the first draft shows that's large, the fix is the roadmap's "Index this book" action plus an opt-in setting, not a second installer.

## 5. Docs: `README.md`, `CHANGELOG.md`, `site/index.html`, `CONTRIBUTING.md`
- **README Install**: lead with downloading from the [Releases](https://github.com/mstyles/pitaka/releases) page. Windows: the `-setup.exe` (per-user, no admin rights needed) or the `.msi`, plus what the SmartScreen warning looks like and "More info → Run anyway". Linux: the `.AppImage` (any distro: `chmod +x`, then run), the `.deb` (Debian/Ubuntu) or the `.rpm` (Fedora/openSUSE). macOS: build from source. The existing build steps move under "Build from source".
- **README "What's actually verified"**: what the release workflow does, plus the result of the first draft's manual test (section 7), saying which OS versions were tested.
- **README roadmap**: rename the item to "Release builds for macOS" and keep it under Later. Add a Done line: "Release builds for Linux and Windows: a version tag builds the installers and attaches them to a draft GitHub release". Add "Sign the Windows installers" under Later.
- **README Workflow section**: a "Releasing" step: move `[Unreleased]` into `## [x.y.z] - date`, bump the three version files, commit, tag `vx.y.z`, push the tag, test the draft, publish.
- **CHANGELOG.md**: the intro's "There are no release builds yet, so a version here is a tagged commit on `main` to build from" becomes "Each version is a GitHub release with installers for Linux and Windows".
- **site/index.html**: "There are no prebuilt downloads yet, so for now it's built from source" becomes a link to the latest release for Linux and Windows. Line 127's "Chapter search by meaning is switched on when building" becomes "is included in the installers".
- **CONTRIBUTING.md**: a line pointing at the Releasing step.
- The release-note footer from section 2: "**Downloads**: Windows: `Pitaka_x.y.z_x64-setup.exe`. Linux: the `.AppImage`, or the `.deb`/`.rpm` for your distro. The Windows installers aren't code-signed yet, so Windows SmartScreen will warn before running them; choose More info → Run anyway. `SHA256SUMS` lists each file's checksum."

## 6. Windows code signing: options, and a recommendation
Unsigned installers get Windows SmartScreen's "Windows protected your PC" warning, and some antivirus and enterprise policies block them outright. Since 2024 no certificate removes that warning straight away: SmartScreen reputation builds up as signed releases are downloaded, and EV certificates no longer skip that step ([Microsoft's comparison](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), updated 2026-08-29). Signing gets you a named publisher and a warning that fades as reputation builds; unsigned never stops warning.

| Option | Cost | Publisher shown | Who can get it | Fits CI? |
| --- | --- | --- | --- | --- |
| [SignPath Foundation](https://signpath.org/terms.html) | Free | "SignPath Foundation" | OSI-licensed open source projects with existing releases, a code signing policy page and 2FA on GitHub, after a review | Yes: its GitHub Actions integration signs artifacts built on GitHub's runners |
| [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) (was Trusted Signing) | $9.99/month | Your verified name | Individuals in the USA and Canada; organizations in the USA, Canada, EU and UK. Identity check takes a few business days | Yes: Tauri's `signCommand` with `artifact-signing-cli` |
| [Certum Open Source Code Signing](https://shop.certum.eu/open-source-code-signing-on-simplysign.html) | About €49–58/year | "Open Source Developer, <your name>" | Individual open source developers, worldwide | Awkward: the cloud key (SimplySign) is built around an interactive login |
| OV certificate (DigiCert, Sectigo, …) | About $150–300/year | Your name or company | Anyone, worldwide; the key has to be on a hardware token or cloud HSM | Only with the CA's cloud HSM, often at extra cost |
| EV certificate | $400+/year | Your company | Registered businesses | Same as OV; since 2024 it gets no SmartScreen advantage over OV |

**Recommendation**: ship 0.3.0 unsigned. Then:
- If you're in the USA or Canada, Azure Artifact Signing is the cleanest choice: $120 a year, your own name as publisher, and it plugs straight into this workflow.
- Otherwise, or if you'd rather not pay, apply to SignPath Foundation. Its terms ask for an existing release in the form to be signed, so 0.3.0 unsigned is the prerequisite either way. The catch is that "SignPath Foundation" is shown as the publisher, not you.

Signing is a follow-up plan, not part of this work. Either route adds one signing step to the Windows build job, and repo secrets for the credentials.

## 7. Tests and verification
- No Rust or Vitest changes. `cargo test -p ebook_research_core`, `cargo clippy --workspace --all-targets`, `npx tsc --noEmit` and `npm test` still pass, and `ci.yml` is untouched.
- `scripts/release-check.mjs`, run by hand: `v0.2.0` against today's files passes and prints the 0.2.0 notes plus the footer; `v0.2.1` fails with the mismatch message for all three files; a matching version with no CHANGELOG section fails with the "no notes" message.
- `workflow_dispatch` on the PR branch: both build jobs pass and the artifact contains `Pitaka_<v>_x64-setup.exe`, `Pitaka_<v>_x64_en-US.msi`, `Pitaka_<v>_amd64.deb`, `Pitaka-<v>-1.x86_64.rpm` and `Pitaka_<v>_amd64.AppImage`. The Linux names were checked in a local build (the `.deb`/`.rpm` files take `productName`, though the package inside is `pitaka`); the Windows names are still to check in the first run.
- After merging, tag `v0.3.0`: the draft release has the notes, five installers and `SHA256SUMS`.
- By hand on the draft's files, before publishing:
  1. **Windows**: on a Windows 11 VM that has never had Rust, Node or Visual Studio, download the `-setup.exe` from the draft. SmartScreen warns; run it anyway. The app is "Pitaka" in the Start Menu and launches. Go through step 5 of the Windows checklist on the installed app: import (including a folder), search, bookmarks, chapter search. `library.db` is in `%APPDATA%\com.pitaka.app\`. Then uninstall it from Settings → Apps.
  2. **Windows upgrade**: install the `.msi` for 0.3.0. Then build a local 0.3.1 MSI with the same `upgradeCode` and install it over the top. There's only one Pitaka in Settings → Apps, and the library is still there.
  3. **Linux**: on a stock Ubuntu 22.04 VM, run the AppImage (`chmod +x`) and install the `.deb` with `sudo apt install ./Pitaka_*.deb`. Both launch, import a book and search it.
  4. `sha256sum -c SHA256SUMS` passes on the downloaded files.
- Publish only after those pass, and record what was and wasn't tested (e.g. the `.rpm` and Windows 10) in "What's actually verified".
