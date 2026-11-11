import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createApp } from "./app.ts";

const dataDir = process.env.NOSTR_SCHEDULER_DATA ?? join(process.cwd(), "data");
const port = Number(process.env.PORT ?? 4173);
const { app } = createApp({ dataDir, staticDir: join(process.cwd(), "web/dist") });

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`ui http://127.0.0.1:${info.port}`);
});
