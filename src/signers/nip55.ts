import type { HexPubkey, Signer } from "../domain/types.ts";

export function createNip55Signer(pubkey: HexPubkey): Signer {
  return {
    ref: { kind: "nip55", platform: "android" },
    pubkey,
    signEvent() {
      return Promise.reject(new Error("NIP-55 is an Android flow. On this machine use a bunker signer."));
    },
  };
}
