import { WebSocket, type RawData } from "ws";
import type { RawEvent } from "../domain/event.ts";
import { assertRelayAllowed } from "../domain/relays.ts";
import type { PerRelayResult, RelayUrl } from "../domain/types.ts";

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export function publishToRelay(url: RelayUrl, event: RawEvent, timeoutMs = 3000): Promise<PerRelayResult> {
  assertRelayAllowed(url);
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result: PerRelayResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ relay: url, accepted: false, message: "timeout" }), timeoutMs);
    ws.on("error", () => finish({ relay: url, accepted: false, message: "connection error" }));
    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(textOf(data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || message[0] !== "OK" || message[1] !== event.id) return;
      const accepted = message[2] === true || (message[2] === false && /duplicate/i.test(String(message[3] ?? "")));
      finish({ relay: url, accepted, message: String(message[3] ?? "") });
    });
  });
}

export function fetchFromRelay(
  url: RelayUrl,
  filter: Record<string, unknown>,
  options: { readonly timeoutMs?: number; readonly strict?: boolean } = {},
): Promise<unknown[]> {
  assertRelayAllowed(url);
  const timeoutMs = options.timeoutMs ?? 3000;
  const strict = options.strict === true;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const found: unknown[] = [];
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      if (error && strict) reject(error);
      else resolve(found);
    };
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    ws.on("error", () => finish(new Error("connection error")));
    ws.on("open", () => ws.send(JSON.stringify(["REQ", "read", filter])));
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(textOf(data));
      } catch {
        return;
      }
      if (!Array.isArray(message)) return;
      if (message[0] === "EVENT" && message[1] === "read") found.push(message[2]);
      if (message[0] === "EOSE" && message[1] === "read") finish();
    });
  });
}
