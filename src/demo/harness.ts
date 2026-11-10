import { pathToFileURL } from "node:url";
import { unixSeconds } from "../domain/brand.ts";
import { noteUnsigned, parseSignedEvent } from "../domain/event.ts";
import { createMockSigner } from "../mock-signer/index.ts";
import { fetchFromRelay } from "../test-relay/client.ts";
import { publishToRelay } from "../test-relay/client.ts";
import { LocalRelay } from "../test-relay/relay.ts";

export async function runHarness(): Promise<{ id: string; relay: string }> {
  const relay = new LocalRelay();
  const url = await relay.start();
  try {
    const signer = createMockSigner();
    const unsigned = noteUnsigned({
      pubkey: signer.pubkey,
      content: "harness note",
      createdAt: unixSeconds(1_700_000_000),
    });
    const signed = await signer.signEvent(unsigned);
    const result = await publishToRelay(url, signed);
    if (!result.accepted) throw new Error(`relay rejected the event: ${result.message}`);
    const rows = await fetchFromRelay(url, { ids: [signed.id] });
    const read = parseSignedEvent(rows[0]);
    if (read.id !== signed.id || read.content !== unsigned.content) throw new Error("relay readback did not match");
    return { id: signed.id, relay: url };
  } finally {
    await relay.stop();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runHarness()
    .then((report) => {
      console.log(`accepted ${report.id}`);
      console.log(`read ${report.id}`);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "harness failed");
      process.exit(1);
    });
}
