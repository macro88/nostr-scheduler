import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";

const root = new URL("..", import.meta.url).pathname;
const tokenFile = "web/src/theme/tokens.css";
const skipDirs = new Set([
  "node_modules",
  "dist",
  ".git",
  "data",
  "artifacts",
  "coverage",
  "test-results",
  "playwright-report",
]);
const textExt = new Set([".css", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".html", ".svg", ".yml", ".yaml"]);

function hexesFor(css: string, name: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{6})`, "g");
  for (const match of css.matchAll(pattern)) {
    const hex = match[1]?.toLowerCase();
    if (!hex || hex === "#ffffff" || hex === "#000000") continue;
    found.add(hex);
  }
  return [...found];
}

const retiredGreen = ["0c5548", "5b9e8a", "e4e9e6"].map((value) => `#${value}`);

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function hsl(hex: string): [number, number, number] {
  const [red, green, blue] = channels(hex).map((part) => part / 255) as [number, number, number];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const light = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(light * 100)];
  const delta = max - min;
  const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [Math.round(hue), Math.round(sat * 100), Math.round(light * 100)];
}

function needles(hexes: readonly string[]): RegExp[] {
  return hexes.flatMap((hex) => {
    const [red, green, blue] = channels(hex);
    const [hue, sat, light] = hsl(hex);
    const rgb = `${red}\\s*,?\\s*${green}\\s*,?\\s*${blue}`;
    const hueSat = `${hue}\\s*,?\\s*${sat}%\\s*,?\\s*${light}%`;
    return [
      new RegExp(hex.replace("#", "#"), "i"),
      new RegExp(`rgba?\\(\\s*${rgb}`, "i"),
      new RegExp(`hsla?\\(\\s*${hueSat}`, "i"),
    ];
  });
}

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name) && dir === root) continue;
    if (name === "node_modules" || name === "dist" || name === "run") continue;
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      out.push(...files(path));
      continue;
    }
    const ext = name.slice(name.lastIndexOf("."));
    if (textExt.has(ext)) out.push(path);
  }
  return out;
}

function hits(hexes: readonly string[], includeTokenFile = false): string[] {
  const patterns = needles(hexes);
  const found: string[] = [];
  for (const path of files(root)) {
    const rel = relative(root, path).split(sep).join("/");
    if (!includeTokenFile && rel === tokenFile) continue;
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) found.push(`${rel}:${index + 1}`);
    });
  }
  return found;
}

describe("accent token", () => {
  const css = readFileSync(join(root, tokenFile), "utf8");
  const accents = hexesFor(css, "color-accent");
  const accentFg = hexesFor(css, "color-accent-fg");

  test("the accent hex is declared once per theme", () => {
    expect(accents).toHaveLength(2);
    expect(new Set(accents).size).toBe(2);
  });

  test("an accent hex outside the token file is noticed", () => {
    const sample = accents[0] ?? "";
    expect(needles(accents).some((pattern) => pattern.test(`color: ${sample}`))).toBe(true);
    const [red, green, blue] = channels(sample);
    expect(needles(accents).some((pattern) => pattern.test(`rgb(${red}, ${green}, ${blue})`))).toBe(true);
    const retired = retiredGreen[0] ?? "";
    expect(needles(retiredGreen).some((pattern) => pattern.test(retired))).toBe(true);
  });

  test("accent values stay in the theme token file", () => {
    expect(hits([...accents, ...accentFg])).toEqual([]);
  });

  test("retired green values are gone", () => {
    expect(hits(retiredGreen, true)).toEqual([]);
  });
});
