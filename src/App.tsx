import { useState } from "react";
import BookmarksView from "./BookmarksView";
import BooksView from "./BooksView";
import HomeView from "./HomeView";
import NavBar, { type Screen } from "./NavBar";
import ReaderView from "./ReaderView";
import SearchView from "./SearchView";
import "./App.css";

type ReaderTarget = {
  bookId: number;
  chapterId?: number;
  focusBlockId?: number;
  /** Names the screen the book was opened from, which is where back returns. */
  backLabel: string;
};

function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  const [libraryVersion, setLibraryVersion] = useState(0);

  function navigate(to: Screen) {
    // The Bookmarks link always shows the folder list.
    setOpenFolderId(null);
    setScreen(to);
  }

  return (
    <>
      {!reader && screen !== "home" && <NavBar current={screen} onNavigate={navigate} />}
      {!reader && screen === "home" && (
        <HomeView
          onNavigate={navigate}
          onOpenBook={(bookId) => setReader({ bookId, backLabel: "← Home" })}
        />
      )}
      {!reader && screen === "books" && (
        <BooksView
          onOpenBook={(bookId) => setReader({ bookId, backLabel: "← Books" })}
          onLibraryChanged={() => setLibraryVersion((v) => v + 1)}
        />
      )}
      {!reader && screen === "bookmarks" && (
        <BookmarksView
          openFolderId={openFolderId}
          onOpenFolder={setOpenFolderId}
          onOpenBookmark={(b, folder) =>
            setReader({
              bookId: b.book_id,
              chapterId: b.chapter_id,
              focusBlockId: b.content_block_id,
              backLabel: `← ${folder.name}`,
            })
          }
        />
      )}
      {/* Kept mounted so the query and results survive leaving the screen. */}
      <div hidden={screen !== "search" || reader != null}>
        <SearchView
          active={screen === "search" && reader == null}
          libraryVersion={libraryVersion}
          onOpenResult={(r) =>
            setReader({
              bookId: r.book_id,
              chapterId: r.chapter_id,
              focusBlockId: r.content_block_id,
              backLabel: "← Search results",
            })
          }
        />
      </div>
      {reader && (
        <ReaderView
          bookId={reader.bookId}
          initialChapterId={reader.chapterId}
          focusBlockId={reader.focusBlockId}
          backLabel={reader.backLabel}
          onBack={() => setReader(null)}
        />
      )}
    </>
  );
}

export default App;
