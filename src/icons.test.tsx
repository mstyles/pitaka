// @ts-expect-error type error without @types/node package
import { readdirSync, readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as icons from "./icons";

describe("icons", () => {
  it.each(Object.entries(icons))("%s renders with the app's defaults", (_, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg")!;
    expect(svg.classList).toContain("icon");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("stroke-width")).toBe("1.6");
  });

  it("takes a size", () => {
    const { container } = render(<icons.SearchIcon size={16} />);
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("16");
  });

  it("is the only file that imports lucide-react", () => {
    const sources = (readdirSync("src", { recursive: true }) as string[]).filter((f) =>
      /\.tsx?$/.test(f),
    );
    // Built, so this file's own source doesn't match.
    const needle = `from "${"lucide"}-react"`;
    const importers = sources.filter((f) => readFileSync(`src/${f}`, "utf8").includes(needle));
    expect(importers).toEqual(["icons.tsx"]);
  });
});
