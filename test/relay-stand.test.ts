import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { relayUrl, unixSeconds } from "../src/domain/brand.ts";
import { noteUnsigned } from "../src/domain/event.ts";
import { createMockSigner } from "../src/mock-signer/index.ts";
import { publishToRelay } from "../src/test-relay/client.ts";

const NOTE = "stand relay note";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no free port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function ipv4Listeners(port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const lines = readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1);
  const hosts: string[] = [];
  for (const line of lines) {
    const [local, , state] = line.trim().split(/\s+/).slice(1);
    if (state !== "0A" || !local) continue;
    const [ip, current] = local.split(":");
    if (current !== hexPort || !ip) continue;
    const bytes = ip.match(/../g)?.map((byte) => Number.parseInt(byte, 16)).reverse() ?? [];
    hosts.push(bytes.join("."));
  }
  return hosts;
}

async function waitFor(predicate: () => boolean, detail: () => string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 5000) throw new Error(detail());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

describe("standing local relay", () => {
  test("binds loopback, accepts one event, and stops", async () => {
    const port = await freePort();
    const script = fileURLToPath(new URL("../src/test-relay/stand.ts", import.meta.url));
    const child = spawn(process.execPath, [script, "--port", String(port)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (!child.stdout || !child.stderr) throw new Error("relay pipes missing");
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    try {
      const url = `ws://127.0.0.1:${port}`;
      await waitFor(
        () => stdout.includes(`relay ${url}\n`),
        () => `relay did not print its url (exit ${child.exitCode})\n${stdout}\n${stderr}`,
      );
      expect(stdout).toContain(`relay ${url}\n`);
      expect(stdout).toContain(`Put ${url} in the profile relays list in data/profiles.yaml.`);
      expect(ipv4Listeners(port)).toEqual(["127.0.0.1"]);

      const signer = createMockSigner();
      const signed = await signer.signEvent(
        noteUnsigned({ pubkey: signer.pubkey, content: NOTE, createdAt: unixSeconds(1_700_000_100) }),
      );
      const result = await publishToRelay(relayUrl(url), signed);
      expect(result.accepted).toBe(true);
      const logged = `accepted ${signed.id} kind 1 created_at 1700000100`;
      await waitFor(
        () => stdout.includes(logged),
        () => `relay did not log the event\n${stdout}\n${stderr}`,
      );
      expect(stdout).not.toContain(NOTE);
      expect(stderr).not.toContain(NOTE);

      child.kill("SIGINT");
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code).toBe(0);
      expect(ipv4Listeners(port)).toEqual([]);
    } finally {
      await stopChild(child);
    }
  }, 15_000);
});
