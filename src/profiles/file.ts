import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { InputError } from "../domain/brand.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readProfileDocument(path: string): Record<string, unknown> {
  if (!existsSync(path)) return { profiles: [] };
  const raw = parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.profiles)) throw new InputError("profiles", "expected a list");
  return raw;
}

export function profileEntries(doc: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(doc.profiles)) throw new InputError("profiles", "expected a list");
  if (!doc.profiles.every(isRecord)) throw new InputError("profiles", "expected a mapping");
  return doc.profiles as Record<string, unknown>[];
}

export function writeProfileDocument(path: string, doc: Record<string, unknown>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, stringify(doc), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw error;
  }
}
