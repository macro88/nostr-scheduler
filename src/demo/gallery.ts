import { suggestionId, type UnixSeconds } from "../domain/brand.ts";
import { parseDraft } from "../domain/draft.ts";
import { noteUnsigned } from "../domain/event.ts";
import type { Draft, Profile, Signer } from "../domain/types.ts";
import type { WorkStore } from "../work/store.ts";

const EVENT = "11".repeat(32);
const ROOT = "22".repeat(32);
const OTHER = "33".repeat(32);

type Kind = "suggestion" | "approved" | "signed" | "queued" | "sent" | "failed" | "missed";

function mondayOf(anchor: Date): Date {
  const next = new Date(anchor);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}

function at(monday: Date, day: number, hour: number, minute: number): number {
  const date = new Date(monday);
  date.setDate(monday.getDate() + day);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function note(content: string, when: number): Draft {
  return parseDraft({ type: "note", content, proposedFireAt: when });
}

function thread(first: string, second: string, when: number): Draft {
  return parseDraft({
    type: "thread",
    segments: [
      { content: first, proposedFireAt: when },
      { content: second, proposedFireAt: when + 1 },
    ],
  });
}

function reply(content: string, when: number, parentAt: number, parent: string): Draft {
  return parseDraft({
    type: "reply",
    content,
    proposedFireAt: when,
    target: { eventId: EVENT, rootId: ROOT, pubkey: OTHER },
    parent: { at: parentAt, content: parent },
  });
}

export async function seedGallery(args: {
  store: WorkStore;
  profile: Profile;
  signer: Signer;
  now: UnixSeconds;
}): Promise<void> {
  const monday = mondayOf(new Date(args.now * 1000));
  const relay = args.profile.relays.configured[0];
  const parentAt = at(monday, 2, 8, 41);
  const inbox: { id: string; draft: Draft }[] = [
    { id: "sug_in01", draft: reply(
      "yeah I can do Thursday but not before 11, the school run kills the morning",
      at(monday, 9, 9, 0),
      parentAt,
      "are you around to look at the relay list this week? I can do Thursday morning.",
    ) },
    { id: "sug_in02", draft: note("yes, ship it", at(monday, 10, 16, 0)) },
    { id: "sug_in03", draft: note(
      "relays for this week: ws://127.0.0.1, and the backup on the same host. if the first is lagging again just skip it. dont add another until the invoice is settled.",
      at(monday, 9, 18, 30),
    ) },
    { id: "sug_in04", draft: thread(
      "1/3 scheduled posts still need a signed created_at close to publish time, otherwise clients treat them as backdated.",
      "the rest of this is in the next note, including the typo I keep leaving in teh time.",
      at(monday, 11, 8, 0),
    ) },
    { id: "sug_in05", draft: note("can someone confirm the local relay still answers after the restart? I got a silent fail last time.", at(monday, 12, 12, 0)) },
    { id: "sug_in06", draft: note("pls don't zap this one, it's only a draft thought", at(monday, 10, 9, 30)) },
    { id: "sug_in07", draft: reply("ok", at(monday, 11, 19, 0), at(monday, 11, 18, 12), "see the thread from last night") },
    { id: "sug_in08", draft: thread(
      "gift wrap is still off for this profile. if a reply comes in sealed I will miss it until that's back on.",
      "leaving it off until the local relay is boring again.",
      at(monday, 12, 8, 45),
    ) },
  ];
  const queue: { id: string; kind: Kind; draft: Draft }[] = [
    { id: "sug_qu01", kind: "queued", draft: note("back tomorrow", at(monday, 0, 9, 0)) },
    { id: "sug_qu02", kind: "signed", draft: note("ship notes.md to the repo before the call, the one with the relay table", at(monday, 1, 11, 0)) },
    { id: "sug_qu03", kind: "missed", draft: note("gm", at(monday, 2, 8, 0)) },
    { id: "sug_qu04", kind: "queued", draft: note("office closed 24–26 Dec. queue is pre-filled, don't add more until the 29th.", at(monday, 2, 15, 0)) },
    { id: "sug_qu05", kind: "suggestion", draft: note("check the invoice on relay fees before Monday", at(monday, 2, 19, 0)) },
    { id: "sug_qu06", kind: "signed", draft: note("spec is in NIP-01. the kind 1 section is still the useful bit, the rest I keep mixing up.", at(monday, 3, 11, 0)) },
    { id: "sug_qu07", kind: "queued", draft: note("gm", at(monday, 4, 7, 15)) },
    { id: "sug_sg01", kind: "approved", draft: note("weekly metrics dump, ignore the zap count, it's a week behind", at(monday, 4, 11, 30)) },
    { id: "sug_sg02", kind: "approved", draft: note("reminder: rotate the bunker pairing on Monday, the current one expires soon", at(monday, 5, 10, 30)) },
    { id: "sug_sg03", kind: "approved", draft: note("meetup address is the side door, don't post it before Saturday", at(monday, 5, 18, 0)) },
  ];
  const log: { id: string; kind: "sent" | "failed"; draft: Draft }[] = [
    { id: "sug_lg01", kind: "failed", draft: note("test note, ignore — wait, this one was meant for the sandbox and hit the local list.", at(monday, 2, 11, 0)) },
    { id: "sug_lg02", kind: "sent", draft: note("accepted on the local relay, then it went out.", at(monday, 2, 9, 0)) },
    { id: "sug_lg03", kind: "sent", draft: note("gm", at(monday, 1, 16, 45)) },
    { id: "sug_lg04", kind: "sent", draft: note("invoicing for the paid relay is still outstanding. I left the draft in the other profile so it does not go out by accident.", at(monday, 1, 8, 12)) },
    { id: "sug_lg05", kind: "sent", draft: note("back tomorrow", at(monday, 0, 19, 30)) },
    { id: "sug_lg06", kind: "sent", draft: note("the meetup post is drafted, holding it until the address is confirmed.", at(monday, 0, 12, 5)) },
    { id: "sug_lg07", kind: "failed", draft: note("the local relay timed out twice. I will try again after the weekend.", at(monday, -1, 18, 40)) },
    { id: "sug_lg08", kind: "sent", draft: note("weekly open thread, same as last Sunday, no extra links.", at(monday, -1, 10, 15)) },
  ];

  for (const item of inbox) await place(args, item.draft, "suggestion", relay, item.id);
  for (const item of queue) await place(args, item.draft, item.kind, relay, item.id);
  for (const item of log) await place(args, item.draft, item.kind, relay, item.id);
}

async function place(
  args: { store: WorkStore; profile: Profile; signer: Signer; now: UnixSeconds },
  draft: Draft,
  kind: Kind,
  relay: Profile["relays"]["configured"][number],
  id: string,
): Promise<void> {
  const item = args.store.suggest({
    profile: args.profile,
    suggesterId: args.profile.suggesterId,
    draft,
    rationale: draft.type === "reply" ? "it answers a mention from this morning." : "it matches the profile notes",
    at: args.now,
    id: suggestionId(id),
  });
  if (kind === "suggestion") return;
  const approved = args.store.transition(item.id, { type: "approve" }, args.now, args.profile);
  if (kind === "approved" || approved.status !== "approved" || approved.draft.type !== "note") return;
  const signed = await args.signer.signEvent(
    noteUnsigned({
      pubkey: args.signer.pubkey,
      content: approved.draft.content,
      createdAt: approved.draft.proposedFireAt,
    }),
  );
  args.store.transition(item.id, { type: "sign", events: [signed] }, args.now);
  if (kind === "signed") return;
  args.store.transition(item.id, { type: "enqueue" }, args.now);
  if (kind === "queued") return;
  if (kind === "sent") {
    args.store.transition(item.id, { type: "sent", results: [{ relay, accepted: true, message: "" }] }, args.now);
    return;
  }
  if (kind === "failed") {
    args.store.transition(
      item.id,
      { type: "failed", results: [{ relay, accepted: false, message: "rejected: try again" }], reason: "no relay accepted the event" },
      args.now,
    );
    return;
  }
  const late = Math.max(0, args.now - approved.draft.proposedFireAt);
  args.store.transition(item.id, { type: "missed", lateBySeconds: late }, args.now, args.profile);
}
