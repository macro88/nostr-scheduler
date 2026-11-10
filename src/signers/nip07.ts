import { createServer, type Server } from "node:http";
import { LOOPBACK_HOST } from "../domain/defaults.ts";
import { assertSamePayload, parseSignedEvent } from "../domain/event.ts";
import type { HexPubkey, SignedEvent, UnsignedEvent } from "../domain/types.ts";

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Sign</title>
<p id="status">Waiting for the browser signer.</p>
<script>
async function run() {
  const status = document.getElementById("status");
  if (!window.nostr || typeof window.nostr.signEvent !== "function") {
    status.textContent = "No browser signer is available. This page does not collect a secret.";
    await fetch("/failed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "no browser signer" }) });
    return;
  }
  for (;;) {
    const pending = await fetch("/pending").then((response) => response.json());
    if (pending.done) {
      status.textContent = "Signed. You can close this page.";
      return;
    }
    const signed = await window.nostr.signEvent(pending.event);
    const saved = await fetch("/signed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
    if (!saved.ok) {
      status.textContent = "The signed event was rejected.";
      return;
    }
  }
}
run();
</script>
`;

export type Nip07Session = {
  readonly url: string;
  readonly host: string;
  readonly page: string;
  close(): Promise<void>;
  finish(events: readonly SignedEvent[]): void;
};

export async function openNip07(args: {
  events: readonly UnsignedEvent[];
  expectedPubkey: HexPubkey;
  timeoutMs?: number;
}): Promise<{ session: Nip07Session; signed: Promise<SignedEvent[]> }> {
  const pending = [...args.events];
  const signed: SignedEvent[] = [];
  let failed: Error | null = null;
  let resolveSigned: (events: SignedEvent[]) => void = () => undefined;
  let rejectSigned: (error: Error) => void = () => undefined;
  const done = new Promise<SignedEvent[]>((resolve, reject) => {
    resolveSigned = resolve;
    rejectSigned = reject;
  });
  const timeout = setTimeout(() => {
    failed = new Error("browser signer timed out");
    rejectSigned(failed);
  }, args.timeoutMs ?? 120_000);

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (!host.startsWith(`${LOOPBACK_HOST}:`) && host !== LOOPBACK_HOST) {
      res.writeHead(403);
      res.end("loopback only");
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && req.url === "/pending") {
      const event = pending[signed.length];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(event ? { done: false, event } : { done: true }));
      return;
    }
    if (req.method === "POST" && (req.url === "/signed" || req.url === "/failed")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (req.url === "/failed") {
            failed = new Error(typeof body.message === "string" ? body.message : "browser signer failed");
            rejectSigned(failed);
            res.writeHead(400);
            res.end("failed");
            return;
          }
          const expected = pending[signed.length];
          if (!expected) throw new Error("no event is waiting");
          const event = parseSignedEvent(body);
          assertSamePayload(expected, event);
          if (event.pubkey !== args.expectedPubkey) throw new Error("signed pubkey does not match the profile");
          signed.push(event);
          res.writeHead(204);
          res.end();
          if (signed.length === pending.length) {
            clearTimeout(timeout);
            resolveSigned(signed);
          }
        } catch (error) {
          failed = error instanceof Error ? error : new Error("rejected signed event");
          rejectSigned(failed);
          res.writeHead(400);
          res.end(failed.message);
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, LOOPBACK_HOST, () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST) {
    server.close();
    throw new Error("signer page must bind 127.0.0.1");
  }
  const url = `http://${LOOPBACK_HOST}:${address.port}/`;
  return {
    signed: done,
    session: {
      url,
      host: LOOPBACK_HOST,
      page: PAGE,
      finish() {
        clearTimeout(timeout);
      },
      close() {
        clearTimeout(timeout);
        return new Promise((resolve) => server.close(() => resolve()));
      },
    },
  };
}
