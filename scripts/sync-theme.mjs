import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web/src/theme/vendor");
const files = [
  ["@macro88/tokens/src/theme.css", "tokens.css"],
  ["@macro88/motion/src/tokens.css", "motion.css"],
  ["@macro88/theme-nostr/src/theme.css", "theme.css"],
];

mkdirSync(out, { recursive: true });
for (const [from, name] of files) {
  copyFileSync(join(root, "node_modules", from), join(out, name));
}
