import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InputError, type ProfileId, type ResearchId, type UnixSeconds } from "../domain/brand.ts";
import { parseResearchRecord, type ResearchRecord } from "../domain/research.ts";

export class ResearchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_records (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_records_profile ON research_records (profile_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  insertFixture(value: unknown): ResearchRecord {
    const record = parseResearchRecord(value);
    this.write(record, "insert");
    return record;
  }

  put(value: unknown): ResearchRecord {
    const record = parseResearchRecord(value);
    this.write(record, "replace");
    return record;
  }

  delete(id: ResearchId): void {
    this.db.prepare("DELETE FROM research_records WHERE id = ?").run(id);
  }

  get(id: ResearchId): ResearchRecord {
    const row = this.db.prepare("SELECT body_json FROM research_records WHERE id = ?").get(id);
    if (row === undefined || typeof row !== "object" || row === null) throw new InputError("id", "no research record");
    const body = "body_json" in row ? row.body_json : undefined;
    if (typeof body !== "string") throw new InputError("id", "no research record");
    const parsed: unknown = JSON.parse(body);
    return parseResearchRecord(parsed);
  }

  markRemixed(id: ResearchId, at: UnixSeconds): ResearchRecord {
    const current = this.get(id);
    if (current.remixedAt !== undefined) return current;
    const next = { ...current, remixedAt: at };
    this.db.prepare("UPDATE research_records SET body_json = ? WHERE id = ?").run(JSON.stringify(next), id);
    return next;
  }

  private write(record: ResearchRecord, mode: "insert" | "replace"): void {
    const sql =
      mode === "insert"
        ? "INSERT INTO research_records (id, profile_id, kind, body_json) VALUES (?, ?, ?, ?)"
        : `INSERT INTO research_records (id, profile_id, kind, body_json) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             profile_id = excluded.profile_id,
             kind = excluded.kind,
             body_json = excluded.body_json`;
    this.db.prepare(sql).run(record.id, record.profileId, record.kind, JSON.stringify(record));
  }

  list(profileId?: ProfileId): ResearchRecord[] {
    const rows = profileId
      ? this.db.prepare("SELECT body_json FROM research_records WHERE profile_id = ? ORDER BY id").all(profileId)
      : this.db.prepare("SELECT body_json FROM research_records ORDER BY id").all();
    return rows.map((row) => {
      const body = row.body_json;
      if (typeof body !== "string") throw new Error("stored research record is unreadable");
      const parsed: unknown = JSON.parse(body);
      return parseResearchRecord(parsed);
    });
  }
}
