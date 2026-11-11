import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function setProfileSigner(
  file: string,
  id: string,
  signer: { kind: "nip07" } | { kind: "nip46"; bunker_uri: string },
): void {
  const raw = parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) throw new Error("profiles file is unreadable");
  const found = raw.profiles.find((item) => isRecord(item) && item.id === id);
  if (!isRecord(found)) throw new Error(`no profile ${id}`);
  found.signer = signer.kind === "nip07" ? { kind: "nip07" } : { kind: "nip46", bunker_uri: signer.bunker_uri };
  writeFileSync(file, stringify(raw));
}
