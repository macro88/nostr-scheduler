import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";

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
  await page.getByTestId("note-text").fill("Zoom check");
  await expect(page.getByTestId("keep-note")).toBeVisible();
}

async function previewBox(page: Page) {
  return page.locator(".q-preview").evaluate((node) => {
    const box = node.getBoundingClientRect();
    const status = node.parentElement?.querySelector(".status-slot")?.getBoundingClientRect();
    return {
      text: node.textContent ?? "",
      width: box.width,
      right: box.right,
      statusLeft: status?.left ?? box.right,
    };
  });
}

test("zoom and reflow keep the schedule actions and the queue preview readable", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.addInitScript(() => localStorage.setItem("nostr-scheduler-theme", "light"));
  await compose(page, 1440, 900);
  await expect(page.getByTestId("save-draft")).toHaveText("Schedule");
  await page.getByTestId("schedule").click();
  await expect(page.getByTestId("time-apply")).toHaveText("Use this time");
  await page.keyboard.press("Escape");
  const wide = await previewBox(page);
  expect(wide.text).toBe("Zoom check");
  expect(wide.width).toBeGreaterThan(120);
  expect(wide.statusLeft).toBeGreaterThanOrEqual(wide.right - 1);

  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await previewBox(page);
  expect(narrow.text).toBe("Zoom check");
  expect(narrow.width).toBeGreaterThan(120);
  const gap = await page.evaluate(() => {
    const actions = document.querySelector(".composer-actions")?.getBoundingClientRect();
    const queue = document.querySelector(".queue-pane h2")?.getBoundingClientRect();
    const when = document.querySelector(".when-field")?.getBoundingClientRect();
    const count = document.querySelector(".char-count")?.getBoundingClientRect();
    return {
      queueGap: actions && queue ? queue.top - actions.bottom : 0,
      counterBelow: Boolean(when && count && count.top >= when.bottom - 1),
      overlap: Boolean(when && count && count.left < when.right && count.top < when.bottom && when.top < count.bottom),
    };
  });
  expect(gap.queueGap).toBeGreaterThan(16);
  expect(gap.counterBelow || !gap.overlap).toBe(true);

  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByTestId("note-text").fill("A seventy six character note for the narrow count so the counter has two numbers.");
  const units = await page.evaluate(() => {
    const oneLine = (selector: string) => {
      const node = document.querySelector(selector);
      if (!(node instanceof HTMLElement)) return null;
      const box = node.getBoundingClientRect();
      return { text: node.textContent ?? "", height: box.height, rects: node.getClientRects().length, nowrap: getComputedStyle(node).whiteSpace };
    };
    return {
      count: oneLine(".char-count"),
      zone: oneLine("[data-testid='schedule-zone']"),
      date: oneLine("[data-testid='schedule']"),
    };
  });
  expect(units.count?.text).toMatch(/^\d+ \/ 280$/);
  expect(units.count?.nowrap).toBe("nowrap");
  expect(units.count?.rects).toBe(1);
  expect(units.zone?.nowrap).toBe("nowrap");
  expect(units.zone?.rects).toBe(1);
  expect(units.zone?.text).not.toMatch(/UTC UTC/);
  expect(units.date?.nowrap).toBe("nowrap");
  expect(units.date?.rects).toBe(1);
  await page.getByTestId("note-text").fill("Zoom check");

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "200%";
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fit)).toBe("stack");
  await page.getByTestId("save-draft").scrollIntoViewIfNeeded();
  await page.getByTestId("save-draft").focus();
  await expect(page.getByTestId("save-draft")).toBeFocused();
  const zoomed = await page.evaluate(() => {
    const button = document.querySelector("[data-testid='save-draft']");
    const note = document.querySelector("[data-testid='save-note']");
    const date = document.querySelector("[data-testid='schedule']");
    const preview = document.querySelector(".q-preview");
    const box = (node: Element | null) => node?.getBoundingClientRect();
    const buttonBox = box(button);
    const noteBox = box(note);
    const dateBox = box(date);
    const previewBox = box(preview);
    return {
      height: window.innerHeight,
      buttonBottom: buttonBox ? buttonBox.bottom : 0,
      noteBottom: noteBox ? noteBox.bottom : 0,
      dateBottom: dateBox ? dateBox.bottom : 0,
      buttonWidth: buttonBox?.width ?? 0,
      previewWidth: previewBox?.width ?? 0,
      previewText: preview?.textContent ?? "",
      fit: document.documentElement.dataset.fit ?? "",
    };
  });
  expect(zoomed.fit).toBe("stack");
  expect(zoomed.previewText).toBe("Zoom check");
  expect(zoomed.previewWidth).toBeGreaterThan(80);
  expect(zoomed.buttonBottom).toBeLessThanOrEqual(zoomed.height + 1);
  expect(zoomed.noteBottom).toBeLessThanOrEqual(zoomed.height + 1);
  expect(zoomed.dateBottom).toBeLessThanOrEqual(zoomed.height + 1);
  expect(zoomed.buttonWidth).toBeGreaterThan(40);

  await page.evaluate(() => {
    document.documentElement.style.zoom = "";
    document.documentElement.style.fontSize = "32px";
  });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fit)).toBe("wide");
  const textResize = await previewBox(page);
  expect(textResize.text).toBe("Zoom check");
  expect(textResize.width).toBeGreaterThan(100);
  expect(textResize.statusLeft).toBeGreaterThanOrEqual(textResize.right - 1);

  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page.keyboard.down("Control");
  await page.keyboard.press("Equal");
  await page.keyboard.up("Control");
  const chrome = await page.evaluate(() => ({
    scale: window.visualViewport?.scale ?? 1,
    dpr: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    zoom: getComputedStyle(document.documentElement).zoom,
  }));
  expect(chrome.zoom).toBe("1");

  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.fit)).toBe("stack");
  const pinch = await previewBox(page);
  expect(pinch.text).toBe("Zoom check");
  expect(pinch.width).toBeGreaterThan(80);
});

test("a three-line note fits in the focused 320 editor", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.addInitScript(() => localStorage.setItem("nostr-scheduler-theme", "light"));
  await compose(page, 320, 900);
  const sentence = "A longer note for the narrow page so the date and the actions stay together.";
  await page.getByTestId("note-text").fill(sentence);
  await page.getByTestId("note-text").focus();
  await expect(page.getByTestId("note-text")).toBeFocused();
  const fit = await page.getByTestId("note-text").evaluate((node) => {
    const field = node as HTMLTextAreaElement;
    const style = getComputedStyle(node);
    const mirror = document.createElement("div");
    mirror.style.position = "absolute";
    mirror.style.left = "0";
    mirror.style.top = "0";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.overflowWrap = "break-word";
    mirror.style.width = `${node.clientWidth}px`;
    mirror.style.font = style.font;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.textContent = field.value;
    document.body.append(mirror);
    const needed = mirror.getBoundingClientRect().height;
    mirror.remove();
    return { clientHeight: field.clientHeight, needed, fontSize: style.fontSize, lineHeight: style.lineHeight };
  });
  expect(fit.lineHeight).toBe("36px");
  expect(Number.parseFloat(fit.fontSize)).toBeGreaterThanOrEqual(20);
  expect(fit.needed).toBeGreaterThan(36 * 2);
  expect(fit.clientHeight).toBeGreaterThanOrEqual(fit.needed - 1);
});

test("the persistence hint hides while an outcome is showing", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("keep-note")).toHaveText("Unsaved text is lost on reload. Save it to keep it in Queue.");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await page.getByTestId("note-text").fill("Keep the draft");
  await page.getByTestId("schedule").click();
  await page.getByTestId("time-year").fill(String(yesterday.getFullYear()));
  await page.getByTestId("time-month").fill(String(yesterday.getMonth() + 1));
  await page.getByTestId("time-day").fill(String(yesterday.getDate()));
  await page.getByTestId("time-apply").click();
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("This time is in the past. Choose a time from now on.")).toBeVisible();
  await expect(page.getByTestId("keep-note")).toHaveCount(0);
  await page.reload();
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await expect(page.getByTestId("keep-note")).toBeVisible();
  await page.getByTestId("note-text").fill("Keep the draft");
  await page.getByTestId("save-note").click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await expect(page.getByTestId("status-draft")).toHaveText("Saved");
  await expect(page.getByText("Keep the draft")).toBeVisible();
});

test("theme choices fit a 320 menu and the week grid scrolls", async ({ page }) => {
  openData(createMockSigner({ NOSTR_SCHEDULER_MODE: "test" }));
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("profile").click();
  const choices = page.locator(".profile-menu button, .profile-menu input");
  const choiceCount = await choices.count();
  expect(choiceCount).toBeGreaterThanOrEqual(5);
  for (let index = 0; index < choiceCount; index += 1) {
    const box = await choices.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  }
  for (let step = 0; step < choiceCount; step += 1) {
    if (await page.getByTestId("theme-system").evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(page.getByTestId("theme-system")).toBeFocused();
  await page.getByTestId("theme-system").click();
  await expect(page.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByTestId("nav-calendar").click();
  await expect(page.getByTestId("prev")).toBeVisible();
  await page.getByTestId("next").focus();
  await expect(page.getByTestId("next")).toBeFocused();
  const grid = page.getByTestId("week-grid");
  await grid.focus();
  await expect(grid).toBeFocused();
  const read = () =>
    grid.evaluate((node) => {
      const host = node.getBoundingClientRect();
      const days = [...node.querySelectorAll(".day-head")]
        .filter((day) => {
          const box = day.getBoundingClientRect();
          return box.right > host.left + 48 && box.left < host.right - 8;
        })
        .map((day) => (day.textContent ?? "").replace(/\s+/g, " ").trim());
      return { left: node.scrollLeft, wider: node.scrollWidth > node.clientWidth + 1, days };
    });
  const before = await read();
  expect(before.wider).toBe(true);
  expect(before.days.length).toBeGreaterThan(0);
  await page.keyboard.press("ArrowLeft");
  const afterKey = await read();
  expect(afterKey.left).toBeLessThan(before.left - 40);
  expect(afterKey.days.join("|")).not.toBe(before.days.join("|"));
  const host = await grid.boundingBox();
  expect(host).not.toBeNull();
  await page.mouse.move(host!.x + host!.width / 2, host!.y + 80);
  await page.mouse.wheel(400, 0);
  await page.waitForTimeout(100);
  const afterWheel = await read();
  expect(afterWheel.left).toBeGreaterThan(afterKey.left + 40);
});
