# Demo book

`verses-of-the-senior-nuns.epub` is *Verses of the Senior Nuns*
(Therīgāthā), translated by Bhikkhu Sujato and published by
SuttaCentral, who dedicate it to the public domain under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

- Source: <https://github.com/suttacentral/editions>,
  `en/sujato/thig/epub/Verses-of-the-Senior-Nuns-sujato-2026-08-26.epub`
  (repository commit `0b7b11b`)
- Downloaded: 2026-09-21
- SHA-256: `3c810f7f73f89b1f321a96ec0b6a465dd52e3200a45a1a2a5d6fc217748db06c`

The core test `ui_fixtures_for_demo_are_current` imports it to write the
browser demo's data (`src/demo/library.json`). After a parser change,
regenerate that with
`UPDATE_UI_FIXTURES=1 cargo test -p ebook_research_core ui_fixtures`.
