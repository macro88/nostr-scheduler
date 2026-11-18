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
  if (classifyBrowserSigner(host.nostr) === "incompatible") {
    return Promise.reject(new Error("incompatible browser signer"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let current = host.nostr;
    let getter: (() => unknown) | null = null;
    const finish = (error: Error | null, signer?: BrowserSigner) => {
      if (settled) return;
      settled = true;
      if (signer) resolve(signer);
      else reject(error ?? new Error("no browser signer"));
      queueMicrotask(cleanup);
    };
    const check = () => {
      if (args.signal.aborted) {
        finish(new Error("signer cancelled"));
        return;
      }
      const found = readBrowserSigner(host);
      if (found) finish(null, found);
      else if (classifyBrowserSigner(host.nostr) === "incompatible") finish(new Error("incompatible browser signer"));
    };
    const descriptor = Object.getOwnPropertyDescriptor(host, "nostr");
    if (!descriptor || descriptor.configurable) {
      getter = () => current;
      try {
        Object.defineProperty(host, "nostr", {
          configurable: true,
          enumerable: true,
          get: getter,
          set(value) {
            current = value;
            check();
          },
        });
      } catch {
        getter = null;
      }
    }
    const onAbort = () => finish(new Error("signer cancelled"));
    args.signal.addEventListener("abort", onAbort);
    const onLoad = () => check();
    if (host.document && host.document.readyState !== "complete") host.addEventListener?.("load", onLoad);
    const timer = host.setTimeout(() => {
      check();
      if (!settled) finish(new Error("no browser signer"));
    }, args.waitMs ?? browserSignerWaitMs);
    function cleanup() {
      host.clearTimeout(timer);
      args.signal.removeEventListener("abort", onAbort);
      host.removeEventListener?.("load", onLoad);
      if (!getter) return;
      const now = Object.getOwnPropertyDescriptor(host, "nostr");
      if (!now?.configurable || now.get !== getter) return;
      delete host.nostr;
      if (current !== undefined) host.nostr = current;
    }
    check();
  });
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
