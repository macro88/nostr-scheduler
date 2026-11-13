import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { LocalRelay } from "./relay.ts";

const DEFAULT_PORT = 7777;

function relayPort(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const { values } = parseArgs({
    args: [...argv],
    options: { port: { type: "string" } },
    strict: true,
  });
  const raw = values.port ?? env.NOSTR_SCHEDULER_RELAY_PORT ?? String(DEFAULT_PORT);
  if (!/^[0-9]+$/.test(raw)) throw new Error("port must be a whole number from 1 to 65535");
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error("port must be a whole number from 1 to 65535");
  return port;
}

async function runLocalRelay(port: number): Promise<void> {
  const relay = new LocalRelay();
  relay.logAccepted = true;
  const url = await relay.start(port);
  console.log(`relay ${url}`);
  console.log(`Add ${url} under Relays on the profile setup page.`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void relay.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  let port = DEFAULT_PORT;
  try {
    port = relayPort(process.argv.slice(2), process.env);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "relay failed");
    process.exit(1);
  }
  runLocalRelay(port).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "relay failed");
    process.exit(1);
  });
}
