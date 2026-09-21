export type Screen = "home" | "books" | "bookmarks" | "search";

const SECTIONS: { screen: Screen; label: string }[] = [
  { screen: "home", label: "Home" },
  { screen: "books", label: "Books" },
  { screen: "bookmarks", label: "Bookmarks" },
  { screen: "search", label: "Search" },
];

type Props = {
  current: Screen;
  onNavigate: (screen: Screen) => void;
};

/** The header on every section screen, for switching without going through home. */
function NavBar({ current, onNavigate }: Props) {
  return (
    <nav className="app-nav" aria-label="Sections">
      {SECTIONS.map(({ screen, label }) => (
        <button
          key={screen}
          aria-current={screen === current ? "page" : undefined}
          onClick={() => onNavigate(screen)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

export default NavBar;
