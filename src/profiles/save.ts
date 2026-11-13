import { assertValueHasNoPrivateKey } from "../domain/private-key.ts";
import { profileEntries, readProfileDocument, writeProfileDocument } from "./file.ts";

export function setProfileSigner(
  file: string,
  id: string,
  signer: { kind: "nip07" } | { kind: "nip46"; bunker_uri: string },
): void {
  assertValueHasNoPrivateKey(signer);
  const doc = readProfileDocument(file);
  const found = profileEntries(doc).find((item) => item.id === id);
  if (!found) throw new Error(`no profile ${id}`);
  found.signer = signer.kind === "nip07" ? { kind: "nip07" } : { kind: "nip46", bunker_uri: signer.bunker_uri };
  writeProfileDocument(file, doc);
}
