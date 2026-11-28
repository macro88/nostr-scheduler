export type DraftBody = {
  type: string;
  content?: string;
  proposedFireAt?: number;
  segments?: readonly { content: string; proposedFireAt: number }[];
  target?: { eventId: string; rootId: string; pubkey: string; relayHint?: string };
  parent?: { at: number; content: string };
};

export type DraftRow = {
  id: string;
  preview: string;
  fireAt: number;
  draft: DraftBody;
};

export type DraftItem = {
  id: string;
  profileId: string;
  status: string;
  preview: string;
  fireAt: readonly number[];
  draft?: DraftBody;
};

function fireAtOf(item: DraftItem): number {
  const listed = item.fireAt[0];
  if (typeof listed === "number") return listed;
  const proposed = item.draft?.proposedFireAt;
  if (typeof proposed === "number") return proposed;
  const segment = item.draft?.segments?.[0]?.proposedFireAt;
  if (typeof segment === "number") return segment;
  return 0;
}

export function draftsOf(items: readonly DraftItem[], profileId: string): DraftRow[] {
  const rows: DraftRow[] = [];
  for (const item of items) {
    if (item.profileId !== profileId || item.status !== "draft" || !item.draft) continue;
    rows.push({
      id: item.id,
      preview: item.preview,
      fireAt: fireAtOf(item),
      draft: item.draft,
    });
  }
  rows.sort((left, right) => {
    if (left.fireAt !== right.fireAt) return left.fireAt - right.fireAt;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  return rows;
}
