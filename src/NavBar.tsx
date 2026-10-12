import type { ComponentType } from "react";
import { BookmarkIcon, BooksIcon, HomeIcon, SearchIcon } from "./icons";

export type Screen = "home" | "books" | "bookmarks" | "search";

const SECTIONS: { screen: Screen; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { screen: "home", label: "Home", Icon: HomeIcon },
  { screen: "books", label: "Books", Icon: BooksIcon },
  { screen: "bookmarks", label: "Bookmarks & notes", Icon: BookmarkIcon },
  { screen: "search", label: "Search", Icon: SearchIcon },
];

type Props = {
  current: Screen;
  onNavigate: (screen: Screen) => void;
};

/** The header on every section screen, for switching without going through home. */
function NavBar({ current, onNavigate }: Props) {
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <span className="wordmark">Pitaka</span>
        <nav className="app-nav" aria-label="Sections">
          {SECTIONS.map(({ screen, label, Icon }) => (
            <button
              key={screen}
              className="button-icon"
              aria-current={screen === current ? "page" : undefined}
              onClick={() => onNavigate(screen)}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
}

export default NavBar;
