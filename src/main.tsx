import React from "react";
import ReactDOM from "react-dom/client";
import "./fonts.css";
import App from "./App";

async function start() {
  // `npm run dev:mock`: run in a plain browser tab against fixture data
  // instead of the Rust backend. Vite replaces MODE at build time, so this
  // branch and the fixtures are left out of real builds.
  if (import.meta.env.MODE === "mock") {
    const { installMockBackend } = await import("./test/mockBackend");
    installMockBackend();
    document.title = "pitaka (mock backend)";
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

start();
