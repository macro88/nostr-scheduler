import { randomBytes } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";

const COOKIE = "ns_session";

export function isLoopbackHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").split(":")[0] ?? "";
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

export function createGuard(): { sessions: Set<string>; middleware: MiddlewareHandler } {
  const sessions = new Set<string>();
  const middleware: MiddlewareHandler = async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!isLoopbackHost(host)) return c.json({ error: "forbidden host" }, 403);
    const origin = c.req.header("origin");
    if (origin === "null") return c.json({ error: "forbidden origin" }, 403);
    if (origin) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return c.json({ error: "forbidden origin" }, 403);
      }
      if (!isLoopbackHost(parsed.host) || parsed.host !== host) return c.json({ error: "forbidden origin" }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.path.startsWith("/api/")) {
      const cookie = getCookie(c, COOKIE);
      const header = c.req.header("x-csrf-token");
      if (!cookie || !header || cookie !== header || !sessions.has(cookie)) {
        return c.json({ error: "forbidden" }, 403);
      }
    }
    await next();
  };
  return { sessions, middleware };
}

export function issueSession(c: Context, sessions: Set<string>): string {
  let token = getCookie(c, COOKIE);
  if (!token || !sessions.has(token)) token = randomBytes(32).toString("hex");
  sessions.add(token);
  setCookie(c, COOKIE, token, { httpOnly: true, sameSite: "Strict", path: "/", secure: false });
  return token;
}
