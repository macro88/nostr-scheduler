import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { parseCriteria } from "../criteria/parse.ts";
import { readFeedback } from "../criteria/feedback.ts";
import { feedbackPath } from "../criteria/feedback.ts";
import { profileId, suggesterId, unixSeconds } from "../domain/brand.ts";
import { parseDraft } from "../domain/draft.ts";
import { parseSignedEvent } from "../domain/event.ts";
import { MCP_TOOL_NAMES, type McpToolName, type Profile, type ReplyTarget } from "../domain/types.ts";
import { publicSigner } from "../profiles/load.ts";
import { fetchFromRelay } from "../test-relay/client.ts";
import { WorkStore } from "../work/store.ts";

export type McpContext = {
  readonly profiles: readonly Profile[];
  readonly store: WorkStore;
  readonly now: () => ReturnType<typeof unixSeconds>;
};

type ToolSpec = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOLS: readonly ToolSpec[] = [
  {
    name: "list_profiles",
    description: "List configured profiles and the public signer kind for each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_criteria",
    description: "Read one profile's criteria and the decision log.",
    inputSchema: {
      type: "object",
      properties: { profileId: { type: "string" } },
      required: ["profileId"],
    },
  },
  {
    name: "get_thread_context",
    description: "Read a target note and its root from the profile relays.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string" },
        eventId: { type: "string" },
        pubkey: { type: "string" },
        rootId: { type: "string" },
        relayHint: { type: "string" },
      },
      required: ["profileId", "eventId", "pubkey", "rootId"],
    },
  },
  {
    name: "suggest_post",
    description: "Store a suggestion for the operator to review.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: { type: "string" },
        suggesterId: { type: "string" },
        draft: { type: "object" },
        rationale: { type: "string" },
      },
      required: ["profileId", "suggesterId", "draft", "rationale"],
    },
  },
  {
    name: "list_queue",
    description: "Read queue status and fire times.",
    inputSchema: { type: "object", properties: { profileId: { type: "string" } } },
  },
];

export function mcpToolNames(): readonly string[] {
  return TOOLS.map((tool) => tool.name);
}

function profileById(ctx: McpContext, id: string): Profile {
  const found = ctx.profiles.find((profile) => profile.id === id);
  if (!found) throw new Error(`no profile ${id}`);
  return found;
}

function fireTimesOf(item: ReturnType<WorkStore["list"]>[number]): number[] {
  if (item.status === "discarded") return [];
  if (item.status === "suggestion" || item.status === "approved" || item.status === "rejected") {
    if (item.draft.type === "thread") return item.draft.segments.map((segment) => segment.proposedFireAt);
    return [item.draft.proposedFireAt];
  }
  return item.events.map((event) => event.created_at);
}

function summarize(event: { id: string; pubkey: string; content: string; created_at: number }): string {
  return `${event.id} by ${event.pubkey} at ${event.created_at}\n${event.content}`;
}

export async function readThreadContext(ctx: McpContext, profile: Profile, target: ReplyTarget): Promise<string> {
  const load = async (id: string) => {
    const cached = ctx.store.recall(id);
    if (cached) return cached;
    for (const relay of profile.relays.configured) {
      const rows = await fetchFromRelay(relay, { ids: [id] });
      for (const row of rows) {
        try {
          const event = parseSignedEvent(row);
          ctx.store.remember(event);
          if (event.id === id) return event;
        } catch {
          continue;
        }
      }
    }
    return null;
  };
  const targetEvent = await load(target.eventId);
  if (!targetEvent) throw new Error(`no event ${target.eventId} on the configured relays`);
  const rootEvent = target.rootId === target.eventId ? targetEvent : await load(target.rootId);
  if (!rootEvent) throw new Error(`no root ${target.rootId} on the configured relays`);
  if (rootEvent.id === targetEvent.id) return summarize(targetEvent);
  return `${summarize(rootEvent)}\n\n${summarize(targetEvent)}`;
}

export async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(MCP_TOOL_NAMES as readonly string[]).includes(name)) throw new Error(`unknown tool ${name}`);
  if (name === "list_profiles") return ctx.profiles.map(publicSigner);
  if (name === "get_criteria") {
    const profile = profileById(ctx, String(args.profileId ?? ""));
    const criteria = parseCriteria(readFileSync(profile.criteriaPath, "utf8"), profile.id);
    const feedback = readFeedback(feedbackPath(profile.criteriaPath, profile.id));
    return { criteria, feedback };
  }
  if (name === "get_thread_context") {
    const profile = profileById(ctx, String(args.profileId ?? ""));
    const draft = parseDraft({
      type: "reply",
      content: "context",
      proposedFireAt: 0,
      target: {
        eventId: args.eventId,
        pubkey: args.pubkey,
        rootId: args.rootId,
        relayHint: args.relayHint,
      },
    });
    if (draft.type !== "reply") throw new Error("target is incomplete");
    return { context: await readThreadContext(ctx, profile, draft.target) };
  }
  if (name === "suggest_post") {
    const profile = profileById(ctx, String(args.profileId ?? ""));
    const draft = parseDraft(args.draft);
    return ctx.store.suggest({
      profile,
      suggesterId: suggesterId(String(args.suggesterId ?? "")),
      draft,
      rationale: String(args.rationale ?? ""),
      at: ctx.now(),
    });
  }
  if (name === "list_queue") {
    const id = args.profileId === undefined ? undefined : profileId(String(args.profileId));
    return ctx.store.list(id).map((item) => ({
      id: item.id,
      profileId: item.profileId,
      status: item.status,
      fireAt: fireTimesOf(item),
    }));
  }
  throw new Error(`unknown tool ${name}`);
}

type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown };

export async function handleRpc(ctx: McpContext, message: Rpc): Promise<unknown | null> {
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "nostr-scheduler", version: "0.1.0" },
    };
  }
  if (message.method === "tools/list") return { tools: TOOLS };
  if (message.method === "tools/call") {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const result = await callTool(ctx, String(params?.name ?? ""), params?.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (message.method === "ping") return {};
  throw new Error(`unknown method ${message.method ?? ""}`);
}

export function serveMcp(ctx: McpContext): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void (async () => {
      let message: Rpc;
      try {
        message = JSON.parse(trimmed) as Rpc;
      } catch {
        return;
      }
      try {
        const result = await handleRpc(ctx, message);
        if (result === null || message.id === undefined || message.id === null) return;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      } catch (error) {
        if (message.id === undefined || message.id === null) return;
        const text = error instanceof Error ? error.message : "request failed";
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } })}\n`);
      }
    })();
  });
}

export function assertToolList(): void {
  const names = mcpToolNames();
  if (names.join(",") !== MCP_TOOL_NAMES.join(",")) throw new Error("tool list drifted");
  if (names.some((name) => name.includes("sign") || name.includes("publish"))) {
    throw new Error("signing and publishing are not tools");
  }
}
