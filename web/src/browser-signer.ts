export type BrowserSigner = {
  signEvent: (event: unknown) => Promise<unknown>;
};

export type SignerHost = {
  nostr?: unknown;
  document?: { readyState: string };
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export const browserSignerWaitMs = 1000;

export function classifyBrowserSigner(value: unknown): "missing" | "incompatible" | "ready" {
  if (value == null) return "missing";
  if (typeof value === "object" && typeof (value as { signEvent?: unknown }).signEvent === "function") return "ready";
  return "incompatible";
}

export function readBrowserSigner(host: SignerHost): BrowserSigner | null {
  return classifyBrowserSigner(host.nostr) === "ready" ? (host.nostr as BrowserSigner) : null;
}

export function browserSignerForClick(args: {
  host: SignerHost;
  signal: AbortSignal;
  waitMs?: number;
}): Promise<BrowserSigner> {
  const host = args.host;
  const ready = readBrowserSigner(host);
  if (ready) return Promise.resolve(ready);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, signer?: BrowserSigner) => {
      if (settled) return;
      settled = true;
      host.clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      host.removeEventListener?.("load", onLoad);
      if (signer) resolve(signer);
      else reject(error ?? new Error("no browser signer"));
    };
    const check = (final: boolean) => {
      if (args.signal.aborted) {
        finish(new Error("signer cancelled"));
        return;
      }
      const found = readBrowserSigner(host);
      if (found) {
        finish(null, found);
        return;
      }
      if (!final) return;
      finish(new Error(classifyBrowserSigner(host.nostr) === "incompatible" ? "incompatible browser signer" : "no browser signer"));
    };
    const onAbort = () => check(true);
    const onLoad = () => check(false);
    args.signal.addEventListener("abort", onAbort);
    if (host.document && host.document.readyState !== "complete") host.addEventListener?.("load", onLoad);
    const timer = host.setTimeout(() => check(true), args.waitMs ?? browserSignerWaitMs);
  });
}

export function acceptedSignerIdentity(signed: unknown, expectedPubkey: string): boolean {
  if (typeof signed !== "object" || signed === null || !("pubkey" in signed)) return false;
  return (signed as { pubkey?: unknown }).pubkey === expectedPubkey;
}

let browserSign: { controller: AbortController; promise: Promise<number> } | null = null;

type BrowserSignRun = ((task: (signal: AbortSignal) => Promise<number>) => Promise<number>) & {
  cancel(): void;
};

export const runBrowserSign: BrowserSignRun = Object.assign(
  (task: (signal: AbortSignal) => Promise<number>): Promise<number> => {
    if (browserSign) return browserSign.promise;
    const controller = new AbortController();
    const promise = task(controller.signal).finally(() => {
      if (browserSign?.promise === promise) browserSign = null;
    });
    browserSign = { controller, promise };
    return promise;
  },
  {
    cancel() {
      browserSign?.controller.abort();
    },
  },
);

export function permissionDenied(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("reject") || text.includes("denied") || text.includes("not allowed") || text.includes("permission");
}
