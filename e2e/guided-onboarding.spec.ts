import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";

function wipeData() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${dataDir}/profiles.yaml`, "profiles: []\n");
  const sqlite = `${dataDir}/app.sqlite`;
  if (!existsSync(sqlite)) return;
  const db = new DatabaseSync(sqlite);
  db.exec("DELETE FROM work_items");
  db.close();
}

const themeKey = "nostr-scheduler-theme";
const themeBackground = {
  light: "rgb(230, 231, 230)",
  dark: "rgb(20, 21, 21)",
} as const;

function themeOf(name: string): "light" | "dark" {
  if (name.includes("-dark-")) return "dark";
  if (name.includes("-light-")) return "light";
  throw new Error(`frame name must include -light- or -dark-: ${name}`);
}

async function paintOf(page: Page) {
  return page.evaluate((key) => {
    const root = document.documentElement;
    const raw = getComputedStyle(document.body).backgroundColor;
    const match = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return {
      scheme: root.dataset.scheme ?? "",
      themeName: root.dataset.theme ?? "",
      background: match ? `rgb(${match[1]}, ${match[2]}, ${match[3]})` : raw,
      stored: localStorage.getItem(key) ?? "",
    };
  }, themeKey);
}

async function assertTheme(page: Page, theme: "light" | "dark") {
  await expect.poll(() => paintOf(page)).toEqual({
    scheme: theme,
    themeName: "nostr",
    background: themeBackground[theme],
    stored: theme,
  });
  return paintOf(page);
}

async function frame(page: Page, theme: "light" | "dark", width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.addInitScript((value) => {
    localStorage.setItem("nostr-scheduler-theme", value);
  }, theme);
}

async function grab(page: Page, name: string, proof: Record<string, unknown>) {
  const theme = themeOf(name);
  const paint = await assertTheme(page, theme);
  const file = `${name}.png`;
  console.log(JSON.stringify({ file, scheme: paint.scheme, background: paint.background, stored: paint.stored, ...proof }));
  const dir = process.env.SCREENSHOT_DIR?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${file}`, animations: "disabled" });
}

async function listItems(page: Page, profileId: string) {
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/items?profileId=${id}`);
    return response.json() as Promise<{ id: string; status: string; preview: string; origin?: string }[]>;
  }, profileId);
}

test("loading shows the wordmark without navigation", async ({ page }) => {
  await page.route("**/api/profiles", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("Loading profiles")).toBeAttached();
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await expect(page.getByTestId("profile")).toHaveCount(0);
});

test("a new profile schedules and saves a manual note without a criteria file", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  wipeData();
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.exposeFunction("__nostrSign", (event: Parameters<typeof signer.signEvent>[0]) => signer.signEvent(event));
  await page.addInitScript(() => {
    const target = window as Window & {
      nostr?: { signEvent: (event: unknown) => Promise<unknown>; getPublicKey: () => Promise<string> };
      __nostrSign?: (event: unknown) => Promise<unknown>;
      __publicReads?: number;
    };
    target.__publicReads = 0;
    target.nostr = {
      getPublicKey() {
        target.__publicReads = (target.__publicReads ?? 0) + 1;
        return Promise.reject(new Error("getPublicKey"));
      },
      signEvent(event) {
        if (!target.__nostrSign) throw new Error("missing signer");
        return target.__nostrSign(event);
      },
    };
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your identity" })).toBeFocused();
  await expect(page.locator("[aria-current='step']")).toHaveText("Profile");
  await expect(page.getByLabel("Criteria file")).toHaveCount(0);
  await page.getByTestId("setup-continue").click();
  const name = page.getByLabel("Profile name");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(name).toHaveAttribute("aria-describedby", /profile-name-error/);
  await expect(page.locator("#profile-name-error")).toHaveText("Enter a profile name.");
  await expect(name).toBeFocused();
  await page.getByLabel("Profile name").fill("Desk");
  await page.getByTestId("setup-continue").click();
  const missingNpub = page.getByLabel("Public identity (npub)");
  await expect(missingNpub).toHaveAttribute("aria-invalid", "true");
  await expect(missingNpub).toHaveAttribute("aria-describedby", /profile-npub-error/);
  await expect(page.locator("#profile-npub-error")).toHaveText("Paste an npub starting with npub1.");
  await page.getByLabel("Public identity (npub)").fill("hello");
  await page.getByTestId("setup-continue").click();
  await expect(page.locator("#profile-npub-error")).toHaveText("That isn't an npub. It starts with npub1.");
  await page.getByLabel("Public identity (npub)").fill("ab".repeat(32));
  await page.getByTestId("setup-continue").click();
  await expect(page.locator("#profile-npub-error")).toHaveText("That looks like a hex key. Paste the npub instead.");
  await page.getByLabel("Profile name").fill("Desk");
  await page.getByLabel("Public identity (npub)").fill(signer.npub);
  await expect(page.getByTestId("npub-settled")).toBeVisible();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByRole("heading", { name: "Signing method" })).toBeFocused();
  await page.getByTestId("setup-back").click();
  await expect(page.getByLabel("Profile name")).toHaveValue("Desk");
  await expect(page.getByTestId("setup-continue")).toBeFocused();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-continue").click();
  const signerGroup = page.getByRole("radiogroup", { name: "Signing method" });
  await expect(signerGroup).toHaveAttribute("aria-invalid", "true");
  await expect(signerGroup).toHaveAttribute("aria-describedby", "signer-kind-error");
  await expect(page.locator("#signer-kind-error")).toHaveText("Choose a signing method.");
  await page.getByRole("radio", { name: "Browser extension" }).click();
  await expect(page.getByTestId("signer-status")).toHaveText("Not connected yet. It will be used later, on Sign.");
  await page.getByTestId("setup-continue").click();
  await expect(page.getByRole("heading", { name: "Local setup" })).toBeFocused();
  await expect(page.getByText("Public relays stay off unless you allow them.")).toBeVisible();
  await page.getByTestId("save-profile").click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Write a note" })).toBeFocused();
  await expect(page.getByTestId("profile")).toHaveText("Desk");
  await expect(page.getByTestId("keep-note")).toHaveText("Unsaved text is lost on reload. Save it to keep it in Queue.");
  await expect(page.getByText("Writing rules for suggestions are not set up.")).toHaveCount(0);
  await expect(page.getByTestId("repair-note")).toHaveCount(0);
  const content = `Blank profile ${Date.now()}`;
  await page.getByTestId("note-text").fill(content);
  const when = await page.getByTestId("schedule").innerText();
  await page.getByTestId("save-note").click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByTestId("note-text")).toHaveValue(content);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  const drafts = (await listItems(page, "desk")).filter((item) => item.preview === content);
  expect(drafts.map((item) => item.status)).toEqual(["draft"]);
  expect(drafts[0]?.origin).toBe("manual");
  await expect(page.getByTestId("composer-draft")).toHaveCount(0);
  await expect(page.getByTestId("status-draft")).toHaveText("Saved");
  await expect(page.getByTestId("schedule-zone")).toHaveText(/^(UTC|.+ UTC[+-]\d{2}:\d{2})$/);
  await expect(page.getByTestId("schedule-zone")).not.toHaveText(/UTC UTC/);
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const scheduled = (await listItems(page, "desk")).filter((item) => item.preview === content);
  expect(scheduled.map((item) => ({ status: item.status, origin: item.origin }))).toEqual([{ status: "approved", origin: "manual" }]);
  await expect(page.getByTestId("status-approved")).toHaveText("Awaiting signature");
  await page.reload();
  await expect(page.getByTestId("profile")).toHaveText("Desk");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("note-text")).toHaveValue("");
  await page.getByTestId("nav-sign").click();
  await expect(page.getByTestId("http-signer-note")).toContainText("only runs on HTTPS");
  await expect(page.getByTestId("sign").getByText(content)).toBeVisible();
  await page.getByTestId("sign-browser").click();
  await expect(page.getByTestId("sign-status")).toContainText("Queued");
  expect(await page.evaluate(() => (window as Window & { __publicReads?: number }).__publicReads)).toBe(0);
  const queued = (await listItems(page, "desk")).filter((item) => item.preview === content);
  expect(queued.map((item) => item.status)).toEqual(["queued"]);
});

test("an invalid test profile is repaired without scheduling or rewriting policy", async ({ page }) => {
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  wipeData();
  mkdirSync(`${dataDir}/criteria`, { recursive: true });
  const kept = `${dataDir}/criteria/kept.md`;
  const custom = ["---", "profile_id: other", "version: 4", "---", "# Voice", "keep this voice", "", "## Bench notes", "do not rewrite", ""].join("\n");
  writeFileSync(kept, custom);
  writeFileSync(
    `${dataDir}/profiles.yaml`,
    [
      "profiles:",
      "  - id: test",
      "    label: Test",
      `    npub: ${signer.npub}`,
      `    pubkey: ${signer.pubkey}`,
      "    suggester_id: test-suggester",
      "    signer:",
      "      kind: nip07",
      "    relays: []",
      "    read_nip65: false",
      "    allow_public_relays: false",
      "    criteria_path: test",
      "",
    ].join("\n"),
  );
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await expect(page.getByTestId("repair-note")).toBeVisible();
  await expect(page.getByTestId("save-draft")).toBeDisabled();
  await expect(page.getByTestId("save-draft")).toHaveAttribute("aria-disabled", "true");
  const repairPaint = await page.getByTestId("repair-profile").evaluate((node) => {
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { button: getComputedStyle(node).backgroundColor, expected };
  });
  expect(repairPaint.button).toBe(repairPaint.expected);
  await expect(page.getByTestId("keep-note")).toHaveCount(0);
  const sentence = `Keep this sentence ${Date.now()}.`;
  await page.getByTestId("note-text").fill(sentence);
  const when = await page.getByTestId("schedule").innerText();
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("status-approved")).toHaveCount(0);
  expect(await listItems(page, "test")).toEqual([]);
  await page.getByTestId("repair-profile").click();
  await expect(page.getByRole("heading", { name: "Your identity" })).toBeVisible();
  await expect(page.getByLabel("Profile name")).toHaveValue("Test");
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("save-profile").click();
  await expect(page.getByTestId("note-text")).toBeFocused();
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  await expect(page.getByTestId("repair-note")).toHaveCount(0);
  await expect(page.getByTestId("keep-note")).toHaveText("Unsaved text is lost on reload. Save it to keep it in Queue.");
  await expect(page.getByTestId("status-approved")).toHaveCount(0);
  expect(await listItems(page, "test")).toEqual([]);
  expect(readFileSync(kept, "utf8")).toBe(custom);
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled locally for")).toBeVisible();
  const rows = (await listItems(page, "test")).filter((item) => item.preview === sentence);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("approved");
  expect(readFileSync(kept, "utf8")).toBe(custom);
  const names = await page.evaluate(async () => {
    const response = await fetch("/api/profiles");
    const profiles = (await response.json()) as { criteriaPath: string | null; criteriaState: string }[];
    return profiles[0];
  });
  expect(names?.criteriaPath).toBeNull();
  expect(names?.criteriaState).toBe("absent");
});

const frames = [
  ["light", 390],
  ["light", 1440],
  ["dark", 390],
  ["dark", 1440],
] as const;

for (const [theme, width] of frames) {
  test(`fresh profile ${theme} ${width} has an empty queue`, async ({ page }) => {
    wipeData();
    await frame(page, theme, width);
    const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
    await page.goto("/");
    await assertTheme(page, theme);
    await expect(page.getByLabel("Criteria file")).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Sections" })).toHaveCount(0);
    await grab(page, `identity-${theme}-${width}`, { editor: "", queue: "none", approved: 0 });
    await page.getByTestId("setup-continue").click();
    const name = page.getByLabel("Profile name");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAttribute("aria-describedby", /profile-name-error/);
    await expect(page.locator("#profile-name-error")).toHaveText("Enter a profile name.");
    await grab(page, `error-name-${theme}-${width}`, {
      invalid: "true",
      describedby: "profile-name-error",
      error: "Enter a profile name.",
    });
    await name.fill("Desk");
    await page.getByTestId("setup-continue").click();
    const missingNpub = page.getByLabel("Public identity (npub)");
    await expect(missingNpub).toHaveAttribute("aria-invalid", "true");
    await expect(missingNpub).toHaveAttribute("aria-describedby", /profile-npub-error/);
    await expect(page.locator("#profile-npub-error")).toHaveText("Paste an npub starting with npub1.");
    await grab(page, `error-npub-${theme}-${width}`, {
      invalid: "true",
      describedby: "profile-npub-error",
      error: "Paste an npub starting with npub1.",
    });
    await missingNpub.fill(signer.npub);
    await page.getByTestId("setup-continue").click();
    await expect(page.getByTestId("signer-status")).toHaveText("No option is selected yet.");
    await grab(page, `signer-${theme}-${width}`, { connected: false });
    await page.getByTestId("setup-continue").click();
    const signerGroup = page.getByRole("radiogroup", { name: "Signing method" });
    await expect(signerGroup).toHaveAttribute("aria-invalid", "true");
    await expect(signerGroup).toHaveAttribute("aria-describedby", "signer-kind-error");
    await expect(page.locator("#signer-kind-error")).toHaveText("Choose a signing method.");
    await grab(page, `error-signer-${theme}-${width}`, {
      invalid: "true",
      describedby: "signer-kind-error",
      error: "Choose a signing method.",
    });
    await page.getByRole("radio", { name: "Browser extension" }).click();
    await page.getByTestId("setup-continue").click();
    await expect(page.getByText("Public relays stay off unless you allow them.")).toBeVisible();
    await grab(page, `local-${theme}-${width}`, { criteriaField: 0 });
    await page.route("**/api/profiles", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
        return;
      }
      await route.continue();
    });
    await page.getByTestId("save-profile").click();
    await expect(page.locator("#setup-error")).toHaveText("The profile could not be saved. Try again.");
    await expect(page.getByRole("heading", { name: "Local setup" })).toBeVisible();
    await expect(page.locator("#profile-name-error")).toHaveCount(0);
    await grab(page, `save-failure-${theme}-${width}`, {
      alert: "The profile could not be saved. Try again.",
      fieldError: 0,
    });
    await page.unroute("**/api/profiles");
    await page.getByTestId("setup-back").click();
    await page.getByTestId("setup-back").click();
    await expect(page.getByLabel("Profile name")).toHaveValue("Desk");
    await expect(page.getByTestId("npub-settled")).toBeVisible();
    await page.getByTestId("setup-continue").click();
    await page.getByTestId("setup-continue").click();
    await page.getByTestId("save-profile").click();
    await expect(page.getByTestId("profile")).toHaveText("Desk");
    await expect(page.getByTestId("note-text")).toHaveValue("");
    await expect(page.getByText("0 this week")).toBeVisible();
    await expect(page.getByTestId("status-approved")).toHaveCount(0);
    await grab(page, `compose-empty-${theme}-${width}`, { editor: "", approved: 0, week: "0 this week" });
    const content = `Fresh ${theme} ${width} ${Date.now()}`;
    await page.getByTestId("note-text").fill(content);
    await page.getByTestId("save-draft").click();
    await expect(page.getByText("Scheduled locally for")).toBeVisible();
    const rows = (await listItems(page, "desk")).filter((item) => item.preview === content);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "approved", origin: "manual" });
    await expect(page.getByTestId("status-approved")).toHaveCount(1);
    await expect(page.getByTestId("note-text")).toHaveValue("");
    await grab(page, `fresh-scheduled-${theme}-${width}`, { preview: content, status: "approved", count: 1 });
  });

  test(`invalid test repair ${theme} ${width} keeps the typed note`, async ({ page }) => {
    const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
    wipeData();
    mkdirSync(`${dataDir}/criteria`, { recursive: true });
    const kept = `${dataDir}/criteria/kept.md`;
    const custom = ["---", "profile_id: other", "version: 4", "---", "# Voice", "keep this voice", "", "## Bench notes", "do not rewrite", ""].join("\n");
    writeFileSync(kept, custom);
    writeFileSync(
      `${dataDir}/profiles.yaml`,
      [
        "profiles:",
        "  - id: test",
        "    label: Test",
        `    npub: ${signer.npub}`,
        `    pubkey: ${signer.pubkey}`,
        "    suggester_id: test-suggester",
        "    signer:",
        "      kind: nip07",
        "    relays: []",
        "    read_nip65: false",
        "    allow_public_relays: false",
        "    criteria_path: test",
        "",
      ].join("\n"),
    );
    await frame(page, theme, width);
    await page.goto("/");
    await assertTheme(page, theme);
    await page.getByTestId("nav-compose").click();
    const sentence = `Keep this sentence ${theme} ${width} ${Date.now()}`;
    await page.getByTestId("note-text").fill(sentence);
    const when = await page.getByTestId("schedule").innerText();
    await expect(page.getByTestId("repair-note")).toBeVisible();
    await expect(page.getByTestId("save-draft")).toBeDisabled();
    await expect(page.getByTestId("note-text")).toHaveValue(sentence);
    await expect(page.getByTestId("status-approved")).toHaveCount(0);
    expect(await listItems(page, "test")).toEqual([]);
    await grab(page, `repair-boundary-${theme}-${width}`, { editor: sentence, when, approved: 0, items: 0 });
    await page.getByTestId("repair-profile").click();
    await page.getByTestId("setup-continue").click();
    await page.getByTestId("setup-continue").click();
    await page.getByTestId("save-profile").click();
    await expect(page.getByTestId("note-text")).toHaveValue(sentence);
    await expect(page.getByTestId("schedule")).toHaveText(when);
    await expect(page.getByTestId("save-draft")).toBeEnabled();
    await expect(page.getByTestId("status-approved")).toHaveCount(0);
    expect(await listItems(page, "test")).toEqual([]);
    expect(readFileSync(kept, "utf8")).toBe(custom);
    await grab(page, `repaired-${theme}-${width}`, { editor: sentence, when, approved: 0, items: 0 });
    await page.getByTestId("save-draft").click();
    await expect(page.getByText("Scheduled locally for")).toBeVisible();
    const rows = await listItems(page, "test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "approved", origin: "manual", preview: sentence });
    await expect(page.getByTestId("note-text")).toHaveValue("");
    await expect(page.getByTestId("status-approved")).toHaveCount(1);
    expect(readFileSync(kept, "utf8")).toBe(custom);
    await grab(page, `scheduled-${theme}-${width}`, { editor: "", preview: sentence, status: "approved", count: 1 });
  });
}

test("a duplicate identity is described on the npub field", async ({ page }) => {
  const kept = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  const copy = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  wipeData();
  const before = [
    "profiles:",
    "  - id: copy",
    "    label: Copy",
    `    npub: ${copy.npub}`,
    `    pubkey: ${copy.pubkey}`,
    "    suggester_id: copy-suggester",
    "    signer:",
    "      kind: nip07",
    "    relays: []",
    "    read_nip65: false",
    "    allow_public_relays: false",
    "    criteria_path: test",
    "  - id: desk",
    "    label: Desk",
    `    npub: ${kept.npub}`,
    `    pubkey: ${kept.pubkey}`,
    "    suggester_id: desk-suggester",
    "    signer:",
    "      kind: nip07",
    "    relays: []",
    "    read_nip65: false",
    "    allow_public_relays: false",
    "",
  ].join("\n");
  writeFileSync(`${dataDir}/profiles.yaml`, before);
  await page.goto("/");
  await page.getByTestId("nav-compose").click();
  await page.getByTestId("repair-profile").click();
  await expect(page.getByLabel("Profile name")).toHaveValue("Copy");
  await page.getByTestId("change-npub").click();
  await page.getByLabel("Public identity (npub)").fill(kept.npub);
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("save-profile").click();
  const field = page.getByLabel("Public identity (npub)");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAttribute("aria-describedby", /profile-npub-error/);
  await expect(page.locator("#profile-npub-error")).toHaveText("This npub already has a profile: Desk.");
  await expect(page.locator("#setup-error")).toHaveCount(0);
  await expect(page.getByLabel("Profile name")).toHaveValue("Copy");
  expect(readFileSync(`${dataDir}/profiles.yaml`, "utf8")).toBe(before);
});
