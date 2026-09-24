import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChapterMatch, SearchMode, SearchResult, SemanticStatus } from "./types";

/** Where a result opens the reader: a passage hit or a chapter match. */
export type ResultTarget = Pick<SearchResult, "book_id" | "chapter_id" | "content_block_id">;

type Props = {
  /** False while another screen or the reader is showing; the view stays mounted. */
  active: boolean;
  /** Bumped when books are added or removed, so stale results get re-run. */
  libraryVersion: number;
  onOpenResult: (result: ResultTarget) => void;
};

/** Passages are keyword hits in paragraphs; chapters are matches by meaning. */
type Scope = "passages" | "chapters";

type LastSearch = { query: string; exact: boolean; scope: Scope; version: number };

/**
 * Renders a snippet as text, with the words snippet() wrapped in `[`/`]`
 * as <mark>s. Built as React nodes rather than HTML so the book's own
 * text is never parsed as markup.
 */
function highlight(snippet: string) {
  return snippet
    .split(/(\[[^\]]*\])/)
    .map((part, i) =>
      i % 2 === 1 ? <mark key={i}>{part.slice(1, -1)}</mark> : part,
    );
}

function SearchView({ active, libraryVersion, onOpenResult }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [chapterResults, setChapterResults] = useState<ChapterMatch[]>([]);
  const [scope, setScope] = useState<Scope>("passages");
  // Null until known; chapter search is offered only when it's available.
  const [semantic, setSemantic] = useState<SemanticStatus | null>(null);
  const [searching, setSearching] = useState(false);
  const [exactWords, setExactWords] = useState(false);
  const [status, setStatus] = useState("");
  // False until the first search returns, so the count line doesn't say "No results" up front.
  const [searched, setSearched] = useState(false);
  const lastSearch = useRef<LastSearch | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function refreshSemantic() {
    try {
      setSemantic(await invoke<SemanticStatus>("semantic_status"));
    } catch {
      // Without a status, chapter search just isn't offered.
    }
  }

  async function runSearch(q: string, exact: boolean, scope: Scope) {
    if (!q.trim()) return;
    lastSearch.current = { query: q, exact, scope, version: libraryVersion };
    setSearching(true);
    try {
      if (scope === "chapters") {
        setChapterResults(await invoke<ChapterMatch[]>("search_chapters", { query: q }));
        // Books finish indexing in the background, so the count may have moved.
        refreshSemantic();
      } else {
        const mode: SearchMode = exact ? "exact" : "stemmed";
        setResults(await invoke<SearchResult[]>("search_library", { query: q, mode }));
      }
      setStatus("");
      setSearched(true);
    } catch (err) {
      setStatus(`Search failed: ${err}`);
    } finally {
      setSearching(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    inputRef.current?.focus();
    refreshSemantic();
    // Re-run what was actually searched, not whatever has been typed since.
    const last = lastSearch.current;
    if (last && last.version !== libraryVersion) runSearch(last.query, last.exact, last.scope);
  }, [active, libraryVersion]);

  function toggleExactWords(exact: boolean) {
    setExactWords(exact);
    // Re-run straight away so the two modes are easy to compare.
    runSearch(query, exact, scope);
  }

  function changeScope(next: Scope) {
    if (next === scope) return;
    setScope(next);
    // The other scope's results are for an older query, so don't show them.
    if (next === "chapters") setChapterResults([]);
    else setResults([]);
    setSearched(false);
    setStatus("");
    runSearch(query, exactWords, next);
  }

  const chapterScope = scope === "chapters";
  const count = chapterScope ? chapterResults.length : results.length;
  const noun = chapterScope ? "chapter" : "result";

  return (
    <main className="container">
      <h1>Search</h1>

      {semantic?.available && (
        <div className="scope-toggle" role="group" aria-label="Search for">
          <button
            type="button"
            aria-pressed={!chapterScope}
            title="Paragraphs containing the words you type"
            onClick={() => changeScope("passages")}
          >
            Passages
          </button>
          <button
            type="button"
            aria-pressed={chapterScope}
            title="Chapters about what you describe, whatever words they use"
            onClick={() => changeScope("chapters")}
          >
            Chapters
          </button>
        </div>
      )}

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(query, exactWords, scope);
        }}
      >
        <div className="search-field">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6" />
            <path d="M15 15l5.5 5.5" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search your library…"
          />
        </div>
        <button type="submit" className="button-primary" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
        {!chapterScope && (
          <label
            className="search-mode"
            title="Match whole words as typed, without matching related forms (e.g. learn / learning)"
          >
            <input
              type="checkbox"
              checked={exactWords}
              onChange={(e) => toggleExactWords(e.currentTarget.checked)}
            />
            Exact words
          </label>
        )}
      </form>
      {status ? (
        <p className="status">{status}</p>
      ) : (
        searched && (
          <p className="result-count">
            {count === 0 ? "No results" : `${count} ${noun}${count === 1 ? "" : "s"}`}
          </p>
        )
      )}

      {chapterScope ? (
        <ul className="results">
          {chapterResults.map((m) => (
            <li key={m.chapter_id} onClick={() => onOpenResult(m)}>
              <div className="result-meta">
                <b>{m.book_title ?? "Untitled"}</b> ·{" "}
                {m.chapter_title ?? `Chapter ${m.chapter_idx + 1}`}
              </div>
              {/* Plain text: nothing matched word for word, so nothing is marked. */}
              <div className="result-snippet">{m.preview}</div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="results">
          {results.map((r) => (
            <li key={r.content_block_id} onClick={() => onOpenResult(r)}>
              <div className="result-meta">
                <b>{r.book_title ?? "Untitled"}</b> ·{" "}
                {r.chapter_title ?? `Chapter ${r.chapter_idx + 1}`}
              </div>
              <div className="result-snippet">{highlight(r.snippet)}</div>
            </li>
          ))}
        </ul>
      )}

      {chapterScope && semantic && semantic.indexed_books < semantic.total_books && (
        <p className="index-coverage">
          {semantic.indexed_books} of {semantic.total_books} books indexed for chapter search.
          Remove and re-import a book to include it.
        </p>
      )}
    </main>
  );
}

export default SearchView;
