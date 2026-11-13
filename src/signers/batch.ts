import { unixSeconds, type RelayUrl, type UnixSeconds } from "../domain/brand.ts";
import {
  nextThreadUnsigned,
  noteUnsigned,
  replyUnsigned,
  threadPlanFromDraft,
  assertSamePayload,
} from "../domain/event.ts";
import { assertWithinSignHorizon } from "../domain/horizon.ts";
import { assertNoPrivateKey } from "../domain/private-key.ts";
import { markSigned } from "../domain/transitions.ts";
import type { Approved, SignedEvent, SignedWork, Signer } from "../domain/types.ts";

async function signOne(signer: Signer, event: Parameters<Signer["signEvent"]>[0]): Promise<SignedEvent> {
  const signed = await signer.signEvent(event);
  assertSamePayload(event, signed);
  if (signed.pubkey !== signer.pubkey) throw new Error("signer returned a different pubkey");
  return signed;
}

export async function signApproved(args: {
  signer: Signer;
  item: Approved;
  now: UnixSeconds;
  maxAheadSeconds: number;
  relayHint?: RelayUrl;
}): Promise<SignedWork> {
  assertNoPrivateKey(args.item.draft);
  const relayHint = args.relayHint;
  if (args.item.draft.type !== "note" && !relayHint) {
    throw new Error("add a relay before signing");
  }
  const check = (createdAt: UnixSeconds) =>
    assertWithinSignHorizon({ now: args.now, createdAt, maxAheadSeconds: args.maxAheadSeconds });
  const events: SignedEvent[] = [];
  if (args.item.draft.type === "note") {
    const unsigned = noteUnsigned({
      pubkey: args.signer.pubkey,
      content: args.item.draft.content,
      createdAt: args.item.draft.proposedFireAt,
    });
    check(unsigned.created_at);
    events.push(await signOne(args.signer, unsigned));
  } else if (args.item.draft.type === "reply") {
    const unsigned = replyUnsigned({
      pubkey: args.signer.pubkey,
      draft: args.item.draft,
      relayHint: neededHint(relayHint),
    });
    check(unsigned.created_at);
    events.push(await signOne(args.signer, unsigned));
  } else {
    const plan = threadPlanFromDraft({
      pubkey: args.signer.pubkey,
      draft: args.item.draft,
      relayHint: neededHint(relayHint),
    });
    check(plan.root.created_at);
    for (const reply of plan.replyDrafts) check(reply.created_at);
    const root = await signOne(args.signer, plan.root);
    events.push(root);
    let signedSoFar = [root] as [SignedEvent, ...SignedEvent[]];
    for (let i = 0; i < plan.replyDrafts.length; i += 1) {
      const unsigned = nextThreadUnsigned({ plan, signedSoFar });
      const signed = await signOne(args.signer, unsigned);
      events.push(signed);
      signedSoFar = [...signedSoFar, signed];
    }
  }
  const [first, ...rest] = events;
  if (first === undefined) throw new Error("nothing to sign");
  return markSigned(args.item, { events: [first, ...rest], at: args.now });
}

function neededHint(hint: RelayUrl | undefined): RelayUrl {
  if (!hint) throw new Error("add a relay before signing");
  return hint;
}

export function systemNow(): UnixSeconds {
  return unixSeconds(Math.floor(Date.now() / 1000));
}
