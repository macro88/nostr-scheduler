export function kindWord(type?: string): string {
  if (type === "thread") return "Thread";
  if (type === "reply") return "Reply";
  return "Note";
}

export function statusWord(status: string): string {
  const words: Record<string, string> = {
    suggestion: "Draft",
    approved: "Approved",
    signed: "Signed",
    queued: "Queued",
    sent: "Sent",
    failed: "Failed",
    missed: "Missed",
    rejected: "Rejected",
    discarded: "Discarded",
  };
  return words[status] ?? status;
}

export function shortKey(pubkey: string): string {
  if (pubkey.length < 12) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}
