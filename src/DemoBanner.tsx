/** Shown above every screen of the browser demo (`npm run build:demo`). */
export default function DemoBanner() {
  return (
    <aside className="demo-banner" aria-label="About this demo">
      <p>
        You're trying Pitaka in your browser with one built-in book, the Therīgāthā. Bookmarks
        last until you reload. Chapter search by meaning needs the desktop app.{" "}
        <a href="https://github.com/mstyles/pitaka#install">Get the desktop app →</a>
      </p>
    </aside>
  );
}
