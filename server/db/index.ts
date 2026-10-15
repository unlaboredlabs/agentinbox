import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./schema.ts";

export type Param = SQLInputValue;
export type Row = Record<string, unknown>;

/** Thin synchronous wrapper over node:sqlite. All repos go through this. */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Nested calls join the outer transaction (savepoints). */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth++}`;
    this.raw.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      this.raw.exec(`RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const row = this.get<{ v: number | null }>("SELECT MAX(version) AS v FROM _migrations");
    const current = row?.v ?? 0;
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (version <= current) return;
      this.tx(() => {
        this.raw.exec(sql);
        this.run("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)", version, new Date().toISOString());
      });
    });
  }
}

export const json = {
  parse<T>(v: unknown, fallback: T): T {
    if (typeof v !== "string" || v === "") return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  str(v: unknown): string {
    return JSON.stringify(v);
  },
};

export const bool = (v: unknown): boolean => v === 1 || v === 1n || v === true;
export const now = (): string => new Date().toISOString();
