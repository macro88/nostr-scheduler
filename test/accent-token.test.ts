import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const webRoot = new URL("../web", import.meta.url).pathname;
const themeDir = "src/theme/";
const skipDirs = new Set(["node_modules", "dist"]);
const textExt = new Set([".css", ".ts", ".tsx", ".js", ".mjs", ".html", ".svg"]);
const colour = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...files(path));
      continue;
    }
    const ext = name.slice(name.lastIndexOf("."));
    if (textExt.has(ext)) out.push(path);
  }
  return out;
}

function colourHits(): string[] {
  const found: string[] = [];
  for (const path of files(webRoot)) {
    const rel = relative(webRoot, path).split(sep).join("/");
    if (rel.startsWith(themeDir)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      const matches = line.match(new RegExp(colour.source, "g"));
      if (matches) found.push(`${rel}:${index + 1} ${matches.join(" ")}`);
    });
  }
  return found;
}

describe("colour tokens", () => {
  test("a colour hex outside the theme folder is noticed", () => {
    expect(colour.test("color: #662482")).toBe(true);
    expect(colour.test("rgb(15, 106, 82)")).toBe(true);
  });

  test("web colours stay in the theme folder", () => {
    expect(colourHits()).toEqual([]);
  });
});
