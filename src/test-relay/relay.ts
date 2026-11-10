import { createServer, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { relayUrl, type RelayUrl } from "../domain/brand.ts";
import type { EventTag } from "../domain/types.ts";

type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  tags: Record<string, string[]>;
};

type Stored = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: EventTag[];
  content: string;
  sig: string;
};

type Subscription = { id: string; filters: Filter[] };

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function parseFilter(value: unknown): Filter | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const filter: Filter = { tags: {} };
  if (Array.isArray(record.ids)) filter.ids = record.ids.filter((item) => typeof item === "string");
  if (Array.isArray(record.authors)) filter.authors = record.authors.filter((item) => typeof item === "string");
  if (Array.isArray(record.kinds)) filter.kinds = record.kinds.filter((item) => typeof item === "number");
  if (typeof record.since === "number") filter.since = record.since;
  if (typeof record.until === "number") filter.until = record.until;
  if (typeof record.limit === "number") filter.limit = record.limit;
  for (const [key, item] of Object.entries(record)) {
    if (key.startsWith("#") && Array.isArray(item)) {
      filter.tags[key.slice(1)] = item.filter((part) => typeof part === "string");
    }
  }
  return filter;
}

function matches(event: Stored, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [name, values] of Object.entries(filter.tags)) {
    const hit = event.tags.some((tag) => tag[0] === name && tag[1] !== undefined && values.includes(tag[1]));
    if (!hit) return false;
  }
  return true;
}

export class LocalRelay {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly events = new Map<string, Stored>();
  private readonly subs = new Map<WebSocket, Subscription[]>();
  failTimes = 0;
  url: RelayUrl | null = null;

  async start(): Promise<RelayUrl> {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (socket) => {
      this.subs.set(socket, []);
      socket.on("message", (data) => this.onMessage(socket, textOf(data)));
      socket.on("close", () => this.subs.delete(socket));
    });
    await new Promise<void>((resolve) => {
      http.listen(0, "127.0.0.1", () => resolve());
    });
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("relay failed to bind");
    if (address.address !== "127.0.0.1") throw new Error("relay must bind 127.0.0.1");
    this.http = http;
    this.wss = wss;
    this.url = relayUrl(`ws://127.0.0.1:${address.port}`);
    return this.url;
  }

  async stop(): Promise<void> {
    for (const socket of this.wss?.clients ?? []) socket.close();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => this.http?.close(() => resolve()) ?? resolve());
    this.http = null;
    this.wss = null;
  }

  storedIds(): string[] {
    return [...this.events.keys()];
  }

  private onMessage(socket: WebSocket, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    if (message[0] === "EVENT") this.onEvent(socket, message[1]);
    if (message[0] === "REQ" && typeof message[1] === "string") this.onReq(socket, message[1], message.slice(2));
    if (message[0] === "CLOSE" && typeof message[1] === "string") {
      const current = this.subs.get(socket) ?? [];
      this.subs.set(
        socket,
        current.filter((sub) => sub.id !== message[1]),
      );
    }
  }

  private onEvent(socket: WebSocket, value: unknown): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.pubkey !== "string" || typeof record.sig !== "string") {
      socket.send(JSON.stringify(["OK", "", false, "invalid: missing id"]));
      return;
    }
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      socket.send(JSON.stringify(["OK", record.id, false, "rejected: try again"]));
      return;
    }
    const tags = Array.isArray(record.tags) ? (record.tags as EventTag[]) : [];
    const stored: Stored = {
      id: record.id,
      pubkey: record.pubkey,
      created_at: typeof record.created_at === "number" ? record.created_at : 0,
      kind: typeof record.kind === "number" ? record.kind : 0,
      tags,
      content: typeof record.content === "string" ? record.content : "",
      sig: record.sig,
    };
    this.events.set(stored.id, stored);
    socket.send(JSON.stringify(["OK", stored.id, true, ""]));
    this.broadcast(stored);
  }

  private onReq(socket: WebSocket, id: string, filters: unknown[]): void {
    const parsed = filters.map(parseFilter).filter((filter): filter is Filter => filter !== null);
    const current = this.subs.get(socket) ?? [];
    current.push({ id, filters: parsed });
    this.subs.set(socket, current);
    const found = [...this.events.values()].filter((event) => parsed.some((filter) => matches(event, filter)));
    const limit = parsed.reduce<number | undefined>((acc, filter) => filter.limit ?? acc, undefined);
    const slice = limit === undefined ? found : found.slice(0, limit);
    for (const event of slice) socket.send(JSON.stringify(["EVENT", id, event]));
    socket.send(JSON.stringify(["EOSE", id]));
  }

  private broadcast(event: Stored): void {
    for (const [socket, subs] of this.subs) {
      for (const sub of subs) {
        if (sub.filters.some((filter) => matches(event, filter))) {
          socket.send(JSON.stringify(["EVENT", sub.id, event]));
        }
      }
    }
  }
}
