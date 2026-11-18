import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import { assessCriteria } from "../criteria/readiness.ts";
import type { Profile } from "../domain/types.ts";
import { publicSigner } from "../profiles/load.ts";

export type CriteriaState = "absent" | "ready" | "invalid";

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
