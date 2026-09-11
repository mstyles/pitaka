import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type SearchResult = {
  book_title: string | null;
  chapter_idx: number;
  block_idx: number;
  content_block_id: number;
  snippet: string;
  rank: number;
};

function App() {
  const [importStatus, setImportStatus] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  async function importBook() {
    const path = await open({
      multiple: false,
      filters: [{ name: "EPUB", extensions: ["epub"] }],
    });
    if (!path || Array.isArray(path)) return;

    setImportStatus(`Importing ${path}…`);
    try {
      const bookId = await invoke<number>("import_book", { path });
      setImportStatus(`Imported book #${bookId}`);
    } catch (err) {
      setImportStatus(`Import failed: ${err}`);
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const hits = await invoke<SearchResult[]>("search_library", { query });
      setResults(hits);
    } catch (err) {
      setImportStatus(`Search failed: ${err}`);
    } finally {
      setSearching(false);
    }
  }

  return (
    <main className="container">
      <h1>Pitaka</h1>

      <div className="row">
        <button onClick={importBook}>Import EPUB…</button>
        <span>{importStatus}</span>
      </div>

      <form className="row" onSubmit={runSearch}>
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search your library…"
        />
        <button type="submit" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      <ul className="results">
        {results.map((r) => (
          <li key={r.content_block_id}>
            <div className="result-meta">
              {r.book_title ?? "Untitled"} — chapter {r.chapter_idx}
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

export default App;
