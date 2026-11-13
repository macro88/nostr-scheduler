import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Profile } from "../domain/types.ts";
import { publicSigner } from "../profiles/load.ts";

export function profileJson(profile: Profile, dataDir: string, queuedOrSigned: number) {
  const shown = publicSigner(profile);
  const rel = relative(dataDir, profile.criteriaPath);
  const criteriaPath = rel.split(sep).join("/");
  return {
    id: profile.id,
    label: profile.label,
    npub: profile.npub,
    pubkey: profile.pubkey,
    signer: shown.signer,
    timezone: "UTC",
    criteriaPath,
    criteriaExists: existsSync(profile.criteriaPath),
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
