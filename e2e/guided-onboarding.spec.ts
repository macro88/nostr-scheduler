import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

const dataDir = "e2e/run";

async function shot(page: Page, name: string) {
  const dir = process.env.SCREENSHOT_DIR?.trim();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => {
      document.documentElement.dataset.scheme = value;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.screenshot({ path: `${dir}/${name}-${theme}-${width}.png`, animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
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
  await shot(page, "loading");
});

test("a new profile schedules and saves a manual note without a criteria file", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(`${dataDir}/profiles.yaml`, "profiles: []\n");
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
  await shot(page, "identity");
  await expect(page.getByLabel("Criteria file")).toHaveCount(0);
  await page.getByTestId("setup-continue").click();
  await expect(page.getByText("Enter a profile name.")).toBeVisible();
  await expect(page.locator("#setup-error")).toBeFocused();
  await shot(page, "error-name");
  await page.getByLabel("Profile name").fill("Desk");
  await page.getByLabel("Public identity (npub)").fill(signer.npub);
  await expect(page.getByTestId("npub-settled")).toBeVisible();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByRole("heading", { name: "Signing method" })).toBeFocused();
  await shot(page, "signer");
  await page.getByTestId("setup-back").click();
  await expect(page.getByLabel("Profile name")).toHaveValue("Desk");
  await expect(page.getByTestId("setup-continue")).toBeFocused();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByText("Choose a signing method.")).toBeVisible();
  await page.getByRole("radio", { name: "Browser extension" }).click();
  await expect(page.getByTestId("signer-status")).toHaveText("Not connected yet. It will be used later, on Sign.");
  await page.getByTestId("setup-continue").click();
  await expect(page.getByRole("heading", { name: "Local setup" })).toBeFocused();
  await shot(page, "local");
  await expect(page.getByText("Public relays stay off unless you allow them.")).toBeVisible();
  await page.getByTestId("save-profile").click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Write a note" })).toBeFocused();
  await expect(page.getByTestId("profile")).toHaveText("Desk");
  await expect(page.getByTestId("writing-rules-note")).toBeVisible();
  await expect(page.getByTestId("repair-note")).toHaveCount(0);
  await shot(page, "compose");
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
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled for")).toBeVisible();
  const scheduled = (await listItems(page, "desk")).filter((item) => item.preview === content);
  expect(scheduled.map((item) => ({ status: item.status, origin: item.origin }))).toEqual([{ status: "approved", origin: "manual" }]);
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
  await shot(page, "repair");
  await expect(page.getByTestId("save-draft")).toBeDisabled();
  await expect(page.getByTestId("writing-rules-note")).toHaveCount(0);
  const sentence = `Keep this sentence ${Date.now()}.`;
  await page.getByTestId("note-text").fill(sentence);
  const when = await page.getByTestId("schedule").innerText();
  await page.getByTestId("repair-profile").click();
  await expect(page.getByRole("heading", { name: "Your identity" })).toBeVisible();
  await expect(page.getByLabel("Profile name")).toHaveValue("Test");
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("setup-continue").click();
  await page.getByTestId("save-profile").click();
  await expect(page.getByRole("heading", { name: "Write a note" })).toBeFocused();
  await expect(page.getByTestId("note-text")).toHaveValue(sentence);
  await expect(page.getByTestId("schedule")).toHaveText(when);
  await expect(page.getByTestId("repair-note")).toHaveCount(0);
  await expect(page.getByTestId("writing-rules-note")).toBeVisible();
  await shot(page, "repaired");
  expect((await listItems(page, "test")).filter((item) => item.preview === sentence)).toEqual([]);
  expect(readFileSync(kept, "utf8")).toBe(custom);
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled for")).toBeVisible();
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
