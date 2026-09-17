import { useState } from "react";
import LibraryView from "./LibraryView";
import ReaderView from "./ReaderView";
import type { SearchResult } from "./types";
import "./App.css";

type ReaderTarget = {
  bookId: number;
  chapterId?: number;
  focusBlockId?: number;
};

function App() {
  const [reader, setReader] = useState<ReaderTarget | null>(null);

  return (
    <>
      {/* Kept mounted while reading so the search query/results survive a round trip. */}
      <div hidden={reader != null}>
        <LibraryView
          onOpenBook={(bookId) => setReader({ bookId })}
          onOpenSearchResult={(r: SearchResult) =>
            setReader({ bookId: r.book_id, chapterId: r.chapter_id, focusBlockId: r.content_block_id })
          }
        />
      </div>
      {reader && (
        <ReaderView
          bookId={reader.bookId}
          initialChapterId={reader.chapterId}
          focusBlockId={reader.focusBlockId}
          onBack={() => setReader(null)}
        />
      )}
    </>
  );
}

export default App;
