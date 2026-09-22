import React from "react";
import ReactDOM from "react-dom/client";
import "./fonts.css";
import App from "./App";
import DemoBanner from "./DemoBanner";

async function start() {
  // `npm run dev:mock`: run in a plain browser tab against fixture data
  // instead of the Rust backend. Vite replaces MODE at build time, so this
  // branch and the fixtures are left out of real builds.
  if (import.meta.env.MODE === "mock") {
    const { installMockBackend } = await import("./test/mockBackend");
    installMockBackend();
    document.title = "pitaka (mock backend)";
  }
  // `npm run dev:demo` / `build:demo`: the same, with one real book and a
  // working search, published on the project's GitHub Pages site.
  const demo = import.meta.env.MODE === "demo";
  if (demo) {
    const { installDemoBackend } = await import("./demo/installDemo");
    installDemoBackend();
    document.title = "Pitaka — try it in your browser";
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {demo && <DemoBanner />}
      <App />
    </React.StrictMode>,
  );
}

start();
