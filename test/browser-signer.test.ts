import { describe, expect, test } from "vitest";
import { browserSignerForClick, runBrowserSign, type SignerHost } from "../web/src/browser-signer.ts";
import { plainError } from "../web/src/errors.ts";

function host(): SignerHost & { nostr?: { signEvent?: (event: unknown) => Promise<unknown>; getPublicKey?: () => Promise<string> } } {
  return {
    document: { readyState: "complete" },
    setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimeout: (id) => clearTimeout(id),
  };
}

describe("browser signer on a click", () => {
  test("uses a provider that is already present and does not call getPublicKey", async () => {
    let reads = 0;
    const calls: unknown[] = [];
    const page = host();
    page.nostr = {
      getPublicKey() {
        reads += 1;
        return Promise.resolve("ab".repeat(32));
      },
      signEvent(event) {
        calls.push(event);
        return Promise.resolve({ ok: true });
      },
    };
    const signer = await browserSignerForClick({ host: page, signal: new AbortController().signal, waitMs: 50 });
    await signer.signEvent({ kind: 1, content: "hello" } as never);
    expect(calls).toHaveLength(1);
    expect(reads).toBe(0);
  });

  test("waits for a provider assigned after the click", async () => {
    const page = host();
    const pending = browserSignerForClick({ host: page, signal: new AbortController().signal, waitMs: 200 });
    setTimeout(() => {
      page.nostr = { signEvent: () => Promise.resolve({ signed: true }) };
    }, 30);
    const signer = await pending;
    await expect(signer.signEvent({} as never)).resolves.toEqual({ signed: true });
  });

  test("reports no browser signer only after the wait", async () => {
    const page = host();
    const started = Date.now();
    await expect(browserSignerForClick({ host: page, signal: new AbortController().signal, waitMs: 40 })).rejects.toThrow("no browser signer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    expect(plainError(new Error("no browser signer")).message).toBe(
      "No browser signer is available. Pair a bunker, or install a signer for this page.",
    );
  });

  test("rejects an object that cannot sign without asking it to sign", async () => {
    const page = host();
    page.nostr = { getPublicKey: () => Promise.resolve("ab".repeat(32)) };
    await expect(browserSignerForClick({ host: page, signal: new AbortController().signal, waitMs: 20 })).rejects.toThrow(
      "incompatible browser signer",
    );
    expect(plainError(new Error("incompatible browser signer")).message).toBe(
      "This browser signer cannot sign notes. Pair a bunker, or use another signer.",
    );
  });

  test("a refused signature is not reported as a missing extension", () => {
    expect(plainError(new Error("signer permission denied: User rejected the request")).message).toBe(
      "The signer did not allow this note.",
    );
  });

  test("a load event supplies a provider when the property cannot be trapped", async () => {
    const listeners = new Map<string, () => void>();
    const page = host();
    page.document = { readyState: "interactive" };
    page.addEventListener = (type, listener) => listeners.set(type, listener);
    page.removeEventListener = (type) => listeners.delete(type);
    Object.defineProperty(page, "nostr", { configurable: false, writable: true, value: undefined });
    const started = Date.now();
    const pending = browserSignerForClick({ host: page, signal: new AbortController().signal, waitMs: 500 });
    page.nostr = { signEvent: () => Promise.resolve({ from: "load" }) };
    listeners.get("load")?.();
    await expect(pending.then((signer) => signer.signEvent({}))).resolves.toEqual({ from: "load" });
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("leaving the page cancels the wait before a late provider is used", async () => {
    const page = host();
    const controller = new AbortController();
    const pending = browserSignerForClick({ host: page, signal: controller.signal, waitMs: 500 });
    controller.abort();
    await expect(pending).rejects.toThrow("signer cancelled");
    page.nostr = { signEvent: () => Promise.resolve({ late: true }) };
    expect(plainError(new Error("signer cancelled")).message).toBe("Signing was cancelled.");
  });

  test("a second click joins the prompt that is already open", async () => {
    let prompts = 0;
    let release: () => void = () => undefined;
    const first = runBrowserSign(async (signal) => {
      prompts += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (signal.aborted) throw new Error("signer cancelled");
      return 1;
    });
    const second = runBrowserSign(async () => {
      prompts += 1;
      return 2;
    });
    expect(prompts).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
  });

  test("a signature that arrives after cancel is not submitted", async () => {
    let release: () => void = () => undefined;
    let submitted = false;
    const pending = runBrowserSign(async (signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (signal.aborted) throw new Error("signer cancelled");
      submitted = true;
      return 1;
    });
    runBrowserSign.cancel();
    release();
    await expect(pending).rejects.toThrow("signer cancelled");
    expect(submitted).toBe(false);
  });
});
