import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createMockSigner } from "../src/mock-signer/index.ts";

test("a blank criteria field still saves a profile and schedules the note you write", async ({ page }) => {
  mkdirSync("e2e/run", { recursive: true });
  writeFileSync("e2e/run/profiles.yaml", "profiles: []\n");
  const signer = createMockSigner({ NOSTR_SCHEDULER_MODE: "test" });
  await page.goto("/");
  await page.getByLabel("Label").fill("Desk");
  await page.getByRole("radio", { name: "Browser signer (NIP-07)" }).click();
  await page.getByLabel("npub", { exact: true }).fill(signer.npub);
  await expect(page.getByTestId("npub-settled")).toBeVisible();
  await page.getByTestId("save-profile").click();
  await expect(page.getByRole("heading", { name: "Write a note" })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const response = await fetch("/api/profiles");
    return response.json() as Promise<{ criteriaPath: string | null; criteriaExists: boolean; allowPublicRelays: boolean }[]>;
  });
  expect(saved[0]?.criteriaPath).toBeNull();
  expect(saved[0]?.criteriaExists).toBe(false);
  expect(saved[0]?.allowPublicRelays).toBe(false);
  await page.getByTestId("note-text").fill("A note from the blank profile.");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("Scheduled for")).toBeVisible();
  await page.getByTestId("nav-sign").click();
  await expect(page.getByText("A note from the blank profile.")).toBeVisible();
});
