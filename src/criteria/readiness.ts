import { readFileSync } from "node:fs";
import { InputError, profileId, type ProfileId } from "../domain/brand.ts";
import { criteriaLocation } from "../profiles/criteria.ts";
import { parseCriteria } from "./parse.ts";

export type CriteriaAssessment =
  | { readonly state: "ready"; readonly path: string; readonly profileId: string }
  | { readonly state: "missing"; readonly path: string; readonly profileId?: string }
  | { readonly state: "mismatch"; readonly path: string; readonly fileProfileId: string; readonly profileId: string }
  | { readonly state: "invalid"; readonly path: string; readonly detail: string }
  | { readonly state: "outside" };

function isInputError(error: unknown): error is InputError {
  return error instanceof InputError;
}

export function assessCriteria(dataDir: string, input: string, expected?: ProfileId): CriteriaAssessment {
  let located: ReturnType<typeof criteriaLocation>;
  try {
    located = criteriaLocation(dataDir, input);
  } catch (error) {
    if (isInputError(error)) return { state: "outside" };
    throw error;
  }
  const path = located.relativePath;
  if (!located.exists) return { state: "missing", path, ...(expected ? { profileId: expected } : {}) };
  let text = "";
  try {
    text = readFileSync(located.absolutePath, "utf8");
  } catch {
    return { state: "invalid", path, detail: "could not be read" };
  }
  try {
    const criteria = parseCriteria(text);
    if (expected && criteria.profileId !== expected) {
      return { state: "mismatch", path, fileProfileId: criteria.profileId, profileId: expected };
    }
    return { state: "ready", path, profileId: criteria.profileId };
  } catch (error) {
    const detail = isInputError(error) ? error.message : "could not be read";
    return { state: "invalid", path, detail };
  }
}

export function criteriaBlock(check: CriteriaAssessment): string | null {
  if (check.state === "ready") return null;
  if (check.state === "outside") return "The criteria path must stay inside the data directory.";
  if (check.state === "missing") {
    const id = check.profileId ?? "this profile";
    return `No file at ${check.path}. Copy examples/criteria/example-profile.md to that path and set profile_id to ${id}.`;
  }
  if (check.state === "mismatch") {
    return `${check.path} has profile_id ${check.fileProfileId}. Set profile_id to ${check.profileId} and save again.`;
  }
  return `${check.path} could not be read (${check.detail}). Fix that file and save again.`;
}

export function assertCriteriaReady(dataDir: string, input: string, expected: ProfileId): void {
  const message = criteriaBlock(assessCriteria(dataDir, input, expected));
  if (message) throw new InputError("criteria_path", message);
}

export function expectedProfileId(value: string | undefined): ProfileId | undefined {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) return undefined;
  return profileId(value);
}
