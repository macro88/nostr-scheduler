import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Profile } from "../domain/types.ts";
import { publicSigner } from "../profiles/load.ts";

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
