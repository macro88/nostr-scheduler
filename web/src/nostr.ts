export type Unsigned = {
  kind: 1;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
};

declare global {
  interface Window {
    nostr?: {
      signEvent: (event: Unsigned) => Promise<Unsigned & { id: string; sig: string }>;
    };
    __nostrSign?: (event: Unsigned) => Promise<Unsigned & { id: string; sig: string }>;
  }
}
