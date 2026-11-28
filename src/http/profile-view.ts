import { existsSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { parseCriteria } from "../criteria/parse.ts";
import { assessCriteria } from "../criteria/readiness.ts";
import type { Profile } from "../domain/types.ts";
import { publicSigner } from "../profiles/load.ts";

export type CriteriaState = "absent" | "ready" | "invalid";

export function cadenceOf(profile: Pick<Profile, "id" | "criteriaPath">): { timezone: string; preferredHours: readonly number[] } | null {
  if (!profile.criteriaPath || !existsSync(profile.criteriaPath)) return null;
  try {
    const cadence = parseCriteria(readFileSync(profile.criteriaPath, "utf8"), profile.id).cadence;
    return { timezone: cadence.timezone, preferredHours: cadence.preferredHours };
  } catch {
    return null;
  }
}

export function criteriaStateOf(profile: Profile, dataDir: string): CriteriaState {
  if (!profile.criteriaPath) return "absent";
  const path = relative(dataDir, profile.criteriaPath).split(sep).join("/");
  return assessCriteria(dataDir, path, profile.id).state === "ready" ? "ready" : "invalid";
}

export function profileJson(profile: Profile, dataDir: string, queuedOrSigned: number) {
  const shown = publicSigner(profile);
  const criteriaPath = profile.criteriaPath ? relative(dataDir, profile.criteriaPath).split(sep).join("/") : null;
  return {
    id: profile.id,
    label: profile.label,
    npub: profile.npub,
    pubkey: profile.pubkey,
    signer: shown.signer,
    timezone: "UTC",
    criteriaPath,
    criteriaExists: profile.criteriaPath ? existsSync(profile.criteriaPath) : false,
    criteriaState: criteriaStateOf(profile, dataDir),
    readNip65: profile.relays.readNip65,
    allowPublicRelays: profile.relays.allowPublicRelays,
    relays: profile.relays.listed.map((item) => ({
      url: item.url,
      publish: item.publish,
      flagged: item.flagged,
      public: item.public,
    })),
    queuedOrSigned,
  };
}
