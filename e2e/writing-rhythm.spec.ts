import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";
const typed = "A local note, six words, and https://example.invalid/queue/item.";

function openData(signer: { npub: string; pubkey: string }) {
  mkdirSync(dataDir, { recursive: true });
  const sqlite = `${dataDir}/app.sqlite`;
  if (existsSync(sqlite)) {
    const db = new DatabaseSync(sqlite);
    db.exec("DELETE FROM work_items");
    db.close();
  }
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    ["profiles:", "  - id: desk", "    label: Desk", `    npub: ${signer.npub}`, `    pubkey: ${signer.pubkey}`, "    suggester_id: desk-suggester", "    signer:", "      kind: nip07", "    relays: []", "    read_nip65: false", "    allow_public_relays: false", ""].join("\n"),
  );
}

async function compose(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("note-text").fill(typed);
}

function px(value: string) {
  return Number.parseFloat(value);
}

test("the writing well, type, footer, and section rules match the approved rhythm", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.addInitScript(() => localStorage.setItem("nostr-scheduler-theme", "light"));
  await compose(page, 1280, 800);
  const desktop = await page.evaluate(() => {
    const editor = document.querySelector("textarea.editor");
    const foot = document.querySelector(".composer-foot");
    const schedule = document.querySelector("[data-testid='save-draft']");
    const rail = document.querySelector(".queue-pane");
    const tab = document.querySelector(".tab");
    const date = document.querySelector("[data-testid='schedule']");
    const heading = document.querySelector(".write-pane h1");
    const upcoming = document.querySelector(".queue-pane h2");
    const excerpt = document.querySelector(".queue-pane .q-preview");
    const current = document.querySelector("nav [aria-current='page']");
    const write = document.querySelector(".write-pane");
    const row = document.querySelector(".queue-pane .q-row");
    const count = document.querySelector(".char-count");
    const countName = document.querySelector(".meta-pair:last-child .meta-name");
    if (!(editor instanceof HTMLElement) || !(foot instanceof HTMLElement) || !(schedule instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(tab instanceof HTMLElement) || !(date instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(upcoming instanceof HTMLElement) || !(excerpt instanceof HTMLElement) || !(current instanceof HTMLElement) || !(write instanceof HTMLElement) || !(row instanceof HTMLElement) || !(count instanceof HTMLElement) || !(countName instanceof HTMLElement)) return null;
    const box = (node: Element) => node.getBoundingClientRect();
    const style = (node: Element) => getComputedStyle(node);
    const editorBox = box(editor);
    const scheduleBox = box(schedule);
    const countBox = box(count);
    const countNameBox = box(countName);
    return {
      editor: { w: editor.offsetWidth, h: editor.offsetHeight, pad: style(editor).paddingTop, radius: style(editor).borderRadius, size: style(editor).fontSize, family: style(editor).fontFamily },
      heading: { size: style(heading).fontSize, weight: style(heading).fontWeight },
      upcoming: { size: style(upcoming).fontSize, weight: style(upcoming).fontWeight },
      excerpt: { size: style(excerpt).fontSize, family: style(excerpt).fontFamily },
      tab: { h: Math.round(box(tab).height), w: Math.round(box(tab).width), radius: style(tab).borderRadius },
      date: { h: Math.round(box(date).height), family: style(date).fontFamily },
      schedule: { h: Math.round(scheduleBox.height), size: style(schedule).fontSize, weight: style(schedule).fontWeight, right: scheduleBox.right, family: style(schedule).fontFamily },
      editorRight: editorBox.right,
      footW: foot.offsetWidth,
      railBorder: style(rail).borderLeftWidth,
      railPad: style(rail).paddingLeft,
      railW: rail.offsetWidth,
      navRule: style(current).borderBottomWidth,
      navRadius: style(current).borderRadius,
      writeRule: style(write).borderTopWidth,
      rowRule: style(row).borderTopWidth,
      countGap: countBox.left - countNameBox.right,
      countFamily: style(count).fontFamily,
      countSize: style(count).fontSize,
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(desktop).not.toBeNull();
  expect(desktop?.editor.w).toBe(720);
  expect(desktop?.editor.h).toBe(320);
  expect(px(desktop?.editor.pad ?? "0")).toBe(18);
  expect(desktop?.editor.radius).toBe("10px");
  expect(desktop?.editor.size).toBe("22px");
  expect(desktop?.editor.family).toContain("Atkinson Hyperlegible");
  expect(desktop?.heading).toEqual({ size: "26px", weight: "700" });
  expect(desktop?.upcoming).toEqual({ size: "18px", weight: "700" });
  expect(desktop?.excerpt.size).toBe("22px");
  expect(desktop?.excerpt.family).toContain("Atkinson Hyperlegible");
  expect(desktop?.excerpt.family).not.toMatch(/mono|Plex/i);
  expect(desktop?.tab.h).toBeGreaterThanOrEqual(44);
  expect(desktop?.tab.w).toBeGreaterThanOrEqual(44);
  expect(desktop?.tab.radius).toBe("0px");
  expect(desktop?.date.h).toBeGreaterThanOrEqual(44);
  expect(desktop?.date.family).toContain("Atkinson Hyperlegible");
  expect(desktop?.schedule.h).toBeGreaterThanOrEqual(44);
  expect(desktop?.schedule.size).toBe("16px");
  expect(Number(desktop?.schedule.weight)).toBeGreaterThanOrEqual(700);
  expect(desktop?.schedule.family).toContain("Atkinson Hyperlegible");
  expect(Math.abs((desktop?.footW ?? 0) - (desktop?.editor.w ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((desktop?.schedule.right ?? 0) - (desktop?.editorRight ?? 0))).toBeLessThanOrEqual(2);
  expect(px(desktop?.railBorder ?? "1")).toBe(0);
  expect(px(desktop?.railPad ?? "1")).toBe(0);
  expect(desktop?.railW).toBe(280);
  expect(px(desktop?.navRule ?? "0")).toBe(2);
  expect(desktop?.navRadius).toBe("0px");
  expect(px(desktop?.writeRule ?? "1")).toBe(0);
  expect(px(desktop?.rowRule ?? "0")).toBeGreaterThan(0);
  expect(desktop?.countGap ?? 99).toBeLessThanOrEqual(16);
  expect(desktop?.countFamily).toContain("Atkinson Hyperlegible");
  expect(desktop?.countFamily).not.toMatch(/mono|Plex/i);
  expect(desktop?.countSize).toBe("14px");
  expect(desktop?.horizontal).toBe(0);

  await compose(page, 390, 844);
  const phone = await page.evaluate(() => {
    const editor = document.querySelector("textarea.editor");
    const excerpt = document.querySelector(".rail-excerpt");
    const count = document.querySelector(".sum-count");
    const summary = document.querySelector(".rail-summary");
    const list = document.querySelector(".rail-list");
    const schedule = document.querySelector("[data-testid='save-draft']");
    const save = document.querySelector("[data-testid='save-note']");
    const summaries = document.querySelectorAll(".rail-summary");
    if (!(editor instanceof HTMLElement) || !(excerpt instanceof HTMLElement) || !(count instanceof HTMLElement) || !summary || !list || !(schedule instanceof HTMLElement) || !(save instanceof HTMLElement)) return null;
    const style = (node: Element) => getComputedStyle(node);
    return {
      h: editor.offsetHeight,
      pad: style(editor).paddingLeft,
      size: style(editor).fontSize,
      excerpt: style(excerpt).fontSize,
      countSize: style(count).fontSize,
      countWeight: style(count).fontWeight,
      summary: style(summary).display,
      list: style(list).display,
      summaries: summaries.length,
      scheduleGrow: style(schedule).flexGrow,
      saveGrow: style(save).flexGrow,
      scheduleH: Math.round(schedule.getBoundingClientRect().height),
    };
  });
  expect(phone?.h).toBe(148);
  expect(px(phone?.pad ?? "0")).toBe(18);
  expect(phone?.size).toBe("20px");
  expect(phone?.excerpt).toBe("22px");
  expect(phone?.countSize).toBe("14px");
  expect(Number(phone?.countWeight)).toBeGreaterThanOrEqual(700);
  expect(phone?.summary).not.toBe("none");
  expect(phone?.list).toBe("none");
  expect(phone?.summaries).toBe(1);
  expect(Number(phone?.scheduleGrow)).toBeGreaterThan(0);
  expect(Number(phone?.saveGrow)).toBeGreaterThan(0);
  expect(phone?.scheduleH).toBeGreaterThanOrEqual(44);

  await compose(page, 320, 844);
  const upcomingBounds = () => page.evaluate(() => {
    const editor = document.querySelector("textarea.editor");
    const rail = document.querySelector(".queue-pane");
    const link = document.querySelector("[data-testid='view-queue']");
    const rule = document.querySelector(".rail-next");
    const excerpt = document.querySelector(".rail-excerpt");
    const summary = document.querySelector(".rail-summary");
    const tab = document.querySelector(".tab");
    const date = document.querySelector("[data-testid='schedule']");
    if (!(editor instanceof HTMLElement) || !(rail instanceof HTMLElement) || !(link instanceof HTMLElement) || !(rule instanceof HTMLElement) || !(excerpt instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(tab instanceof HTMLElement) || !(date instanceof HTMLElement)) return null;
    const edge = (node: Element) => Math.round(node.getBoundingClientRect().right);
    return {
      h: editor.offsetHeight,
      tab: Math.round(tab.getBoundingClientRect().height),
      date: Math.round(date.getBoundingClientRect().height),
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      editorW: editor.offsetWidth,
      railW: rail.offsetWidth,
      editorRight: edge(editor),
      linkRight: edge(link),
      ruleRight: edge(rule),
      excerptRight: edge(excerpt),
      summaryRight: edge(summary),
      linkText: link.textContent?.replace(/\s+/g, " ").trim() ?? "",
      linkClient: link.clientWidth,
      linkScroll: link.scrollWidth,
      viewport: window.innerWidth,
    };
  });
  const narrow = await upcomingBounds();
  expect(narrow?.h).toBe(148);
  expect(narrow?.tab).toBeGreaterThanOrEqual(44);
  expect(narrow?.date).toBeGreaterThanOrEqual(44);
  expect(narrow?.horizontal).toBe(0);
  expect(narrow?.linkText).toBe("View queue");
  expect(narrow?.railW ?? 999).toBeLessThanOrEqual((narrow?.editorW ?? 0) + 1);
  expect(narrow?.linkRight ?? 999).toBeLessThanOrEqual((narrow?.editorRight ?? 0) + 1);
  expect(narrow?.ruleRight ?? 999).toBeLessThanOrEqual((narrow?.editorRight ?? 0) + 1);
  expect(narrow?.excerptRight ?? 999).toBeLessThanOrEqual((narrow?.editorRight ?? 0) + 1);
  expect(narrow?.summaryRight ?? 999).toBeLessThanOrEqual((narrow?.editorRight ?? 0) + 1);
  expect(narrow?.linkRight ?? 999).toBeLessThanOrEqual(narrow?.viewport ?? 0);
  expect(narrow?.linkScroll ?? 999).toBeLessThanOrEqual((narrow?.linkClient ?? 0) + 1);

  await page.getByTestId("profile").click();
  await page.getByTestId("theme-dark").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.scheme)).toBe("dark");
  const narrowDark = await upcomingBounds();
  expect(narrowDark?.linkText).toBe("View queue");
  expect(narrowDark?.railW ?? 999).toBeLessThanOrEqual((narrowDark?.editorW ?? 0) + 1);
  expect(narrowDark?.linkRight ?? 999).toBeLessThanOrEqual((narrowDark?.editorRight ?? 0) + 1);
  expect(narrowDark?.ruleRight ?? 999).toBeLessThanOrEqual((narrowDark?.editorRight ?? 0) + 1);
  expect(narrowDark?.excerptRight ?? 999).toBeLessThanOrEqual((narrowDark?.editorRight ?? 0) + 1);
  expect(narrowDark?.summaryRight ?? 999).toBeLessThanOrEqual((narrowDark?.editorRight ?? 0) + 1);
  expect(narrowDark?.linkScroll ?? 999).toBeLessThanOrEqual((narrowDark?.linkClient ?? 0) + 1);

  await page.getByTestId("profile").click();
  await page.getByTestId("theme-light").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.scheme)).toBe("light");

  await page.getByTestId("note-text").fill("see nsec1notarealkeyxxxxxxxx in the note");
  const blocked = page.getByTestId("save-draft");
  await expect(blocked).toBeDisabled();
  const disabled = await blocked.evaluate((node) => {
    const style = getComputedStyle(node);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    document.body.append(probe);
    const paint = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const fill = paint("--color-disabled-bg");
    const ink = paint("--color-disabled-fg");
    const accent = paint("--color-accent");
    probe.remove();
    return {
      fill: style.backgroundColor,
      ink: style.color,
      roleFill: fill,
      roleInk: ink,
      accent,
      disabledFillRole: root.getPropertyValue("--color-disabled-bg").trim(),
      disabledInkRole: root.getPropertyValue("--color-disabled-fg").trim(),
    };
  });
  expect(disabled.fill).toBe(disabled.roleFill);
  expect(disabled.ink).toBe(disabled.roleInk);
  expect(disabled.fill).not.toBe(disabled.accent);
  expect(disabled.disabledFillRole.toLowerCase()).toBe("#d9d0e2");
  expect(disabled.disabledInkRole.toLowerCase()).toBe("#5a4764");

  await page.getByTestId("profile").click();
  await page.getByTestId("theme-dark").click();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.scheme)).toBe("dark");
  const darkDisabled = await page.getByTestId("save-draft").evaluate((node) => {
    const style = getComputedStyle(node);
    const root = getComputedStyle(document.documentElement);
    return {
      fill: style.backgroundColor,
      ink: style.color,
      roleFill: root.getPropertyValue("--color-disabled-bg").trim().toLowerCase(),
      roleInk: root.getPropertyValue("--color-disabled-fg").trim().toLowerCase(),
    };
  });
  expect(darkDisabled.roleFill).toBe("#3a2c44");
  expect(darkDisabled.roleInk).toBe("#d2c0da");
  expect(darkDisabled.fill).toBe("rgb(58, 44, 68)");
  expect(darkDisabled.ink).toBe("rgb(210, 192, 218)");
});
