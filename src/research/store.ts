import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProfileId } from "../domain/brand.ts";
import { parseResearchRecord, type ResearchRecord } from "../domain/research.ts";

export class ResearchStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
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
    this.db
      .prepare("INSERT INTO research_records (id, profile_id, kind, body_json) VALUES (?, ?, ?, ?)")
      .run(record.id, record.profileId, record.kind, JSON.stringify(record));
    return record;
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
