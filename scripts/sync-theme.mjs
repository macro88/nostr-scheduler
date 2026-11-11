import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "web/src/theme/vendor");

const files = [
  {
    name: "tokens.css",
    paths: [
      "node_modules/@macro88/tokens/src/theme.css",
      "node_modules/@macro88/tokens/packages/tokens/src/theme.css",
    ],
  },
  {
    name: "motion.css",
    paths: [
      "node_modules/@macro88/motion/src/tokens.css",
      "node_modules/@macro88/motion/packages/motion/src/tokens.css",
    ],
  },
  {
    name: "theme.css",
    paths: [
      "node_modules/@macro88/theme-nostr/src/theme.css",
      "node_modules/@macro88/theme-nostr/packages/themes/nostr/src/theme.css",
    ],
  },
];

mkdirSync(out, { recursive: true });
for (const file of files) {
  const found = file.paths.map((path) => join(root, path)).find((path) => existsSync(path));
  if (!found) throw new Error(`missing ${file.name}. Looked in ${file.paths.join(", ")}`);
  copyFileSync(found, join(out, file.name));
}
