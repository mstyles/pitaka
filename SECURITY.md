# Security

## Reporting a vulnerability

Please report security problems privately through GitHub:
[Report a vulnerability](https://github.com/mstyles/pitaka/security/advisories/new)
(the **Security** tab → **Report a vulnerability**). Don't open a public
issue for them.

Include what an attacker needs (for example, a crafted EPUB the user
imports), what it lets them do, and steps or a file that reproduces it.
This is a one-person project, so expect an acknowledgement within a
week or so, not a formal SLA.

## Supported versions

Only the latest commit on `main` gets fixes. There are no release
builds yet.

## What's in scope

Pitaka is a local desktop app. It opens EPUB files you choose, stores
their text in a SQLite database on your computer, and doesn't send
anything over the network. The main thing that can attack it is a book's
content: a malicious EPUB that escapes the webview, reaches the app's
Tauri commands, or reads or writes files it shouldn't. Reports about
that kind of problem are the most useful.
