import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { pasteWarning } from "../src/domain/private-key.ts";

const root = new URL("..", import.meta.url).pathname;

const skipFile = new Set(["src/mock-signer/index.ts"]);

const sessionFile = "src/signers/nip46-session.ts";

const fixture = "nsec1notarealkeyxxxxxxxx";

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
  let body = text.split(pasteWarning).join("");
  if (rel.startsWith("test/") || rel.startsWith("e2e/")) body = body.split(fixture).join("");
  if (rel === "src/domain/private-key.ts") body = body.replace(/\/nsec1\/i/g, "");
  for (const pattern of patterns) {
    if (!pattern.re.test(body)) continue;
    if (rel === sessionFile && pattern.session) continue;
    hits.push(pattern.name);
  }
  if (!rel.startsWith("test/") && !rel.startsWith("e2e/")) {
    for (const line of text.split("\n")) {
      if (/nsec1/i.test(line) && /(console\.|writeFile|appendFile|remember\(|insert\()/.test(line)) {
        hits.push("persisted-marker");
      }
    }
  }
  return hits;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules" || name === "coverage") continue;
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
