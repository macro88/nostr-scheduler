import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { InputError } from "../domain/brand.ts";

export type CriteriaLocation = {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly exists: boolean;
};

function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function criteriaLocation(dataDir: string, input: string): CriteriaLocation {
  if (input.trim() === "" || input.includes("\0")) {
    throw new InputError("criteria_path", "must stay inside the data directory");
  }
  const root = realpathSync(resolve(dataDir));
  const absolutePath = resolve(root, input);
  const rel = relative(root, absolutePath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new InputError("criteria_path", "must stay inside the data directory");
  }
  const anchor = realpathSync(existingAncestor(absolutePath));
  const anchorRel = relative(root, anchor);
  if (anchorRel === ".." || anchorRel.startsWith(`..${sep}`) || isAbsolute(anchorRel)) {
    throw new InputError("criteria_path", "must stay inside the data directory");
  }
  return {
    relativePath: rel.split(sep).join("/"),
    absolutePath,
    exists: existsSync(absolutePath),
  };
}
