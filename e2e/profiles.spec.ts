import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { LocalRelay } from "../src/test-relay/relay.ts";

const fixture = "nsec1notarealkeyxxxxxxxx";

function screenshotDir(): string | undefined {
  const dir = process.env.SCREENSHOT_DIR?.trim();
  if (!dir) return undefined;
  return dir;
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.style.setProperty("--motion-duration-fast", "0ms");
    root.style.setProperty("--motion-duration-base", "0ms");
    root.dataset.theme = "nostr";
    root.dataset.scheme = value;
  }, scheme);
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
  }));
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    const pending = () => document.getAnimations().filter((anim) => anim.playState === "running");
    let running = pending();
    while (running.length > 0) {
      await Promise.all(running.map((anim) => anim.finished.catch(() => undefined)));
      running = pending();
    }
  });
}

async function shots(page: Page, name: string, kind: "form" | "sheet" | "page" = "form") {
  const shotDir = screenshotDir();
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      await setScheme(page, theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      if (width === 390 && (name === "settings-detail" || name === "bunker-masked" || name === "remove-notes" || name === "remove-empty")) {
        if ((await page.getByTestId("profile-pane").count()) === 0) {
          const row = page.locator("[data-testid^='profile-row-']").first();
          if ((await row.count()) > 0) await row.click();
        }
      }
      if (width === 390 && name === "settings-list" && (await page.getByTestId("profile-back").count()) > 0) {
        await page.getByTestId("profile-back").click();
      }
      await settle(page);
      const file = `${shotDir}/${name}-${theme}-${width}.png`;
      if (kind === "sheet") {
        await page.screenshot({ path: file });
      } else if (width === 1440 && (await page.locator(".profile-setup").count()) > 0) {
        await page.locator(".profile-setup").first().screenshot({ path: file });
      } else if (width === 390 && (name === "settings-detail" || name === "bunker-masked")) {
        await page.getByTestId("profile-pane").screenshot({ path: file });
      } else {
        await page.screenshot({ path: file, fullPage: true });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setScheme(page, "light");
}

async function axe(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await setScheme(page, theme);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
    expect(blocking, `${label} ${theme}\n${JSON.stringify(blocking, null, 2)}`).toEqual([]);
  }
}

async function emptyProfiles(page: Page) {
  await page.evaluate(async () => {
    const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
    const listed = (await fetch("/api/profiles").then((response) => response.json())) as { id: string }[];
    for (const item of listed) {
      await fetch(`/api/profiles/${item.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": session.token },
      });
    }
  });
}

test("profile setup covers the form, the opt-in, and removal", async ({ page }) => {
  test.setTimeout(180_000);
  const relay = new LocalRelay();
  const url = await relay.start();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const other = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.goto("/");
  await emptyProfiles(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Set up a profile" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await shots(page, "first-run-empty");
  await axe(page, "first run");

  await page.getByLabel("Label").fill("Desk");
  await page.getByLabel("npub", { exact: true }).fill("hello");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("That isn't an npub. It starts with npub1.")).toBeVisible();
  await shots(page, "error-npub");
  await page.getByLabel("npub", { exact: true }).fill(signer.pubkey);
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("That looks like a hex key. Paste the npub instead.")).toBeVisible();
  await shots(page, "error-hex");

  await page.getByLabel("Label").fill(`keep ${fixture} out`);
  await expect(page.getByLabel("Label")).toHaveValue("");
  await expect(page.getByTestId("secret-alert")).toBeVisible();
  await expect(page.getByLabel("Label")).toBeFocused();
  const secretPaint = await page.getByTestId("secret-alert").evaluate((node) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--color-danger-fg)";
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { color: getComputedStyle(node).color, expected };
  });
  expect(secretPaint.color).toBe(secretPaint.expected);
  await shots(page, "secret-block");
  await page.getByLabel("Label").fill("Desk");

  await page.getByLabel("Criteria file").fill("missing.md");
  await page.getByLabel("Criteria file").blur();
  await expect(page.getByText("No file at that path in the data directory.")).toBeVisible();
  await shots(page, "error-criteria");
  await page.getByLabel("Criteria file").fill("criteria/demo.md");

  await page.getByRole("textbox", { name: "Relay", exact: true }).fill("https://nope.example");
  await page.getByTestId("add-relay").click();
  await expect(page.getByTestId("relay-warning")).toHaveText("Relay addresses start with ws:// or wss://.");
  await shots(page, "error-relay");
  await page.getByRole("textbox", { name: "Relay", exact: true }).fill("ws://127.0.0.1:9");
  await page.getByTestId("add-relay").click();
  await expect(page.getByText("Can't reach this relay right now.")).toBeVisible();
  await shots(page, "error-unreachable");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No relays yet.")).toBeVisible();
  await shots(page, "empty-relays");

  await page.getByRole("radio", { name: "Bunker (NIP-46)" }).click();
  await expect(page.getByLabel("Bunker link")).toBeFocused();
  await expect(page.getByTestId("pair-state")).toHaveText("Not paired");
  await shots(page, "bunker-revealed");
  await page.getByRole("radio", { name: "Browser signer (NIP-07)" }).click();
  await expect(page.getByRole("radio", { name: "Browser signer (NIP-07)" })).toBeFocused();
  await expect(page.getByTestId("nip65-switch")).not.toBeChecked();
  await shots(page, "nip65-off");
  await page.getByTestId("nip65-switch").click();
  await expect(page.getByTestId("nip65-switch")).toBeChecked();
  await shots(page, "nip65-on");
  await page.getByTestId("nip65-switch").click();
  await expect(page.getByTestId("nip65-switch")).not.toBeChecked();

  await page.getByTestId("public-switch").click();
  await expect(page.getByTestId("public-switch")).not.toBeChecked();
  await expect(page.getByText(`Allow public relays for Desk?`)).toBeVisible();
  await shots(page, "opt-in-sheet", "sheet");
  await page.getByRole("button", { name: "Keep them off" }).click();
  await expect(page.getByTestId("public-switch")).not.toBeChecked();
  await page.getByTestId("public-switch").click();
  await page.getByRole("button", { name: "Allow public relays" }).click();
  await expect(page.getByTestId("public-switch")).toBeChecked();
  await page.getByRole("textbox", { name: "Relay", exact: true }).fill("wss://relay.example");
  await page.getByTestId("add-relay").click();
  await expect(page.getByText("Public", { exact: true })).toBeVisible();
  const badgePaint = await page.locator(".public-badge").evaluate((node) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const read = (name: string) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    const fg = read("--color-status-warning-fg");
    const bg = read("--color-status-warning-bg");
    probe.remove();
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, fg, bg };
  });
  expect(badgePaint.color).toBe(badgePaint.fg);
  expect(badgePaint.background).toBe(badgePaint.bg);
  await shots(page, "public-relay");
  await page.getByTestId("public-switch").click();
  await expect(page.getByText("Off: public relays not allowed")).toBeVisible();
  await shots(page, "public-off");
  await page.getByRole("button", { name: "Remove" }).click();

  await page.getByRole("textbox", { name: "Relay", exact: true }).fill(url);
  await page.getByTestId("add-relay").click();
  await expect(page.getByTestId("relay-row")).toContainText(url);
  await shots(page, "relays-loopback");
  await page.getByLabel("npub", { exact: true }).fill(signer.npub);
  await expect(page.getByTestId("npub-settled")).toBeVisible();
  await expect(page.getByTestId("change-npub")).toBeFocused();
  await shots(page, "first-run-filled");
  const savePaint = await page.getByTestId("save-profile").evaluate((node) => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--color-accent)";
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { background: getComputedStyle(node).backgroundColor, accent };
  });
  expect(savePaint.background).toBe(savePaint.accent);
  await page.getByTestId("save-profile").click();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();

  await page.getByTestId("profile").click();
  await page.getByTestId("manage-profiles").click();
  await expect(page.getByTestId("profile-settings")).toBeVisible();
  const addChrome = await page.getByTestId("add-profile").evaluate((node) => {
    const style = getComputedStyle(node);
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--color-text)";
    const text = getComputedStyle(probe).color;
    probe.style.backgroundColor = "var(--color-surface)";
    const surface = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      classes: node.className,
      direction: style.flexDirection,
      shadow: style.boxShadow,
      background: style.backgroundColor,
      color: style.color,
      text,
      surface,
    };
  });
  expect(addChrome.classes).toContain("inline-flex");
  expect(addChrome.classes).toContain("button-outline");
  expect(addChrome.direction).toBe("row");
  expect(addChrome.shadow).not.toBe("none");
  expect(addChrome.background).toBe(addChrome.surface);
  expect(addChrome.color).toBe(addChrome.text);
  await shots(page, "settings-list", "page");
  await page.setViewportSize({ width: 390, height: 844 });
  if ((await page.getByTestId("profile-pane").count()) === 0) await page.getByTestId("profile-row-desk").click();
  await expect(page.getByTestId("profile-pane")).toBeVisible();
  await shots(page, "settings-detail", "form");
  await page.setViewportSize({ width: 390, height: 844 });
  if ((await page.getByTestId("profile-pane").count()) === 0) await page.getByTestId("profile-row-desk").click();
  await expect(page.getByTestId("profile-pane")).toBeVisible();
  await page.getByTestId("profile-back").click();
  const popped = await page.evaluate(async () => {
    const moving = () =>
      document.getAnimations().filter((anim) => {
        const read = anim.effect as { getKeyframes?: () => unknown } | null;
        const frames = read?.getKeyframes?.();
        const text = JSON.stringify(frames ?? "");
        return text.includes("matrix") || text.includes("translate");
      });
    const started = moving().length > 0;
    await Promise.all(document.getAnimations().map((anim) => anim.finished.catch(() => undefined)));
    return started;
  });
  expect(popped).toBe(true);
  await expect(page.getByTestId("profile-list")).toBeVisible();
  await expect(page.getByTestId("profile-pane")).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("remove-profile").click();
  await expect(page.getByText("This profile has no queued or signed notes.")).toBeVisible();
  await shots(page, "remove-empty", "sheet");
  await page.getByRole("button", { name: "Keep it" }).click();

  const waiting = await page.evaluate(async (profileId) => {
    const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
    const headers = { "content-type": "application/json", "x-csrf-token": session.token };
    const suggested = await fetch("/api/suggestions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        profileId,
        rationale: "because",
        draft: { type: "note", content: "Queued from the test", proposedFireAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }).then((response) => response.json() as Promise<{ id: string }>);
    await fetch(`/api/items/${suggested.id}/approve`, { method: "POST", headers, body: "{}" });
    return fetch("/api/sign/nip07/next", {
      method: "POST",
      headers,
      body: JSON.stringify({ profileId }),
    }).then((response) => response.json() as Promise<{ itemId: string; unsigned: { kind: 1; pubkey: string; created_at: number; tags: string[][]; content: string } }>);
  }, "desk");
  const signed = await signer.signEvent({
    kind: 1,
    pubkey: signer.pubkey,
    created_at: waiting.unsigned.created_at,
    tags: waiting.unsigned.tags,
    content: waiting.unsigned.content,
  } as unknown as Parameters<typeof signer.signEvent>[0]);
  await page.evaluate(async ({ itemId, event }) => {
    const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
    await fetch("/api/sign/nip07/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.token },
      body: JSON.stringify({ itemId, event }),
    });
  }, { itemId: waiting.itemId, event: signed });
  await page.reload();
  await page.getByTestId("profile").click();
  await page.getByTestId("manage-profiles").click();
  await page.getByTestId("profile-row-desk").click();
  await page.getByTestId("remove-profile").click();
  await expect(page.getByText("This discards 1 queued or signed note for this profile.")).toBeVisible();
  await shots(page, "remove-notes", "sheet");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove profile" }).click();
  await expect(page.getByRole("heading", { name: "Set up a profile" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await shots(page, "first-run-return");

  await page.getByLabel("Label").fill("Other");
  await page.getByRole("radio", { name: "Browser signer (NIP-07)" }).click();
  await page.getByLabel("Criteria file").fill("criteria/demo.md");
  await page.getByLabel("npub", { exact: true }).fill(other.npub);
  await page.getByRole("textbox", { name: "Relay", exact: true }).fill(url);
  await page.getByTestId("add-relay").click();
  await page.getByTestId("save-profile").click();
  await expect(page.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await page.getByTestId("profile").click();
  await page.getByTestId("manage-profiles").click();
  await page.getByTestId("add-profile").click();
  await page.getByLabel("Label").fill("Copy");
  await page.getByLabel("npub", { exact: true }).fill(other.npub);
  await page.getByRole("radio", { name: "Android signer (NIP-55)" }).click();
  await page.getByLabel("Criteria file").fill("criteria/demo.md");
  await page.getByTestId("save-profile").click();
  await expect(page.getByText(`This npub already has a profile: Other.`)).toBeVisible();
  await shots(page, "error-duplicate");
  await axe(page, "settings");
  await relay.stop();
});

test("a bunker link is masked and the secret is not in the page", async ({ page }) => {
  const secret = "pairing-secret-value";
  const remote = "cd".repeat(32);
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const bunkerUri = `bunker://${remote}?relay=${encodeURIComponent("wss://relay.example")}&secret=${secret}`;
  await page.goto("/");
  await emptyProfiles(page);
  await page.evaluate(
    async ({ npub, bunkerUri: uri }) => {
      const session = (await fetch("/api/session").then((response) => response.json())) as { token: string };
      await fetch("/api/profiles", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": session.token },
        body: JSON.stringify({
          label: "Bunker",
          npub,
          signer: { kind: "nip46", bunkerUri: uri },
          criteriaPath: "criteria/demo.md",
          relays: ["ws://127.0.0.1:9"],
        }),
      });
    },
    { npub: signer.npub, bunkerUri },
  );
  await page.reload();
  await page.getByTestId("profile").click();
  await page.getByTestId("manage-profiles").click();
  await expect(page.getByTestId("bunker-masked")).toHaveText(`bunker://${remote.slice(0, 8)}…${remote.slice(-4)}`);
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(page.getByTestId("pair-state")).toHaveText("Paired");
  await shots(page, "bunker-masked");
  await page.getByTestId("pair-again").click();
  await expect(page.getByLabel("Bunker link")).toHaveValue("");
  await expect(page.getByTestId("pair-state")).toHaveText("Not paired");
  await expect(page.locator("body")).not.toContainText(secret);
});
