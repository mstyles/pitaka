import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchMode, SearchResult } from "./types";

type Props = {
  /** False while another screen or the reader is showing; the view stays mounted. */
  active: boolean;
  /** Bumped when books are added or removed, so stale results get re-run. */
  libraryVersion: number;
  onOpenResult: (result: SearchResult) => void;
};

type LastSearch = { query: string; exact: boolean; version: number };

function SearchView({ active, libraryVersion, onOpenResult }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [exactWords, setExactWords] = useState(false);
  const [status, setStatus] = useState("");
  // False until the first search returns, so the count line doesn't say "No results" up front.
  const [searched, setSearched] = useState(false);
  const lastSearch = useRef<LastSearch | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function runSearch(q: string, exact: boolean) {
    if (!q.trim()) return;
    const mode: SearchMode = exact ? "exact" : "stemmed";
    lastSearch.current = { query: q, exact, version: libraryVersion };
    setSearching(true);
    try {
      setResults(await invoke<SearchResult[]>("search_library", { query: q, mode }));
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
    // Re-run what was actually searched, not whatever has been typed since.
    const last = lastSearch.current;
    if (last && last.version !== libraryVersion) runSearch(last.query, last.exact);
  }, [active, libraryVersion]);

  function toggleExactWords(exact: boolean) {
    setExactWords(exact);
    // Re-run straight away so the two modes are easy to compare.
    runSearch(query, exact);
  }

  return (
    <main className="container">
      <h1>Search</h1>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(query, exactWords);
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
      </form>
      {status ? (
        <p className="status">{status}</p>
      ) : (
        searched && (
          <p className="result-count">
            {results.length === 0
              ? "No results"
              : `${results.length} result${results.length === 1 ? "" : "s"}`}
          </p>
        )
      )}

      <ul className="results">
        {results.map((r) => (
          <li key={r.content_block_id} onClick={() => onOpenResult(r)}>
            <div className="result-meta">
              <b>{r.book_title ?? "Untitled"}</b> ·{" "}
              {r.chapter_title ?? `Chapter ${r.chapter_idx + 1}`}
            </div>
            <div
              className="result-snippet"
              dangerouslySetInnerHTML={{
                __html: r.snippet
                  .split("[").join("<mark>")
                  .split("]").join("</mark>"),
              }}
            />
          </li>
        ))}
      </ul>
    </main>
  );
}

export default SearchView;
