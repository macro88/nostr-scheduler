import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;

const skipFile = new Set(["src/mock-signer/index.ts"]);

const sessionFile = "src/signers/nip46-session.ts";

const patterns = [
  { name: "nsec", re: /nsec/i, session: false },
  { name: "NOSTR_PRIVATE_KEY", re: /NOSTR_PRIVATE_KEY/, session: false },
  { name: "nsec1", re: /nsec1/, session: false },
  { name: "generateSecretKey", re: /generateSecretKey/, session: false },
  { name: "nip19.nsecEncode", re: /nip19\.nsecEncode/, session: false },
  { name: "secretKey", re: /secretKey/, session: true },
  { name: "privateKey", re: /privateKey/, session: true },
  { name: "randomSecretKey", re: /randomSecretKey/, session: true },
  { name: "getSharedSecret", re: /getSharedSecret/, session: true },
  { name: "schnorr.sign", re: /schnorr\.sign\b/, session: true },
  { name: "schnorr.utils", re: /schnorr\.utils/, session: true },
];

export function scanText(rel, text) {
  if (skipFile.has(rel)) return [];
  const hits = [];
  for (const pattern of patterns) {
    if (!pattern.re.test(text)) continue;
    if (rel === sessionFile && pattern.session) continue;
    hits.push(pattern.name);
  }
  return hits;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path, out);
      continue;
    }
    if (name.endsWith(".ts") || name.endsWith(".js") || name.endsWith(".mjs")) {
      out.push(path);
    }
  }
}

export function scanTree(start = root) {
  const files = [];
  for (const dir of ["src", "test", "web", "e2e"]) {
    const full = join(start, dir);
    try {
      walk(full, files);
    } catch {
      continue;
    }
  }
  const failures = [];
  for (const file of files) {
    const rel = relative(start, file);
    const hits = scanText(rel, readFileSync(file, "utf8"));
    for (const hit of hits) failures.push(`${rel}: ${hit}`);
  }
  return failures;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const failures = scanTree();
  if (failures.length > 0) {
    console.error("secret-key handling outside the mock signer:");
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log("custody check passed");
}
