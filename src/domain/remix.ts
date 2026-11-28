import { assertNoPrivateKey } from "./private-key.ts";
import { researchText } from "./research-text.ts";
import type { ResearchRecord } from "./research.ts";
import type { NoteDraft, UnixSeconds } from "./types.ts";

export function promoteResearch(record: ResearchRecord, proposedFireAt: UnixSeconds): NoteDraft {
  const draft: NoteDraft = {
    type: "note",
    content: researchText(record),
    proposedFireAt,
  };
  assertNoPrivateKey(draft);
  return draft;
}
