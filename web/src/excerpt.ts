export function weekExcerpt(note: string): string {
  const first = note.split(/\r?\n/, 1)[0] ?? "";
  const stripped = first
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "");
  return stripped.replace(/\s+/g, " ").trim();
}
