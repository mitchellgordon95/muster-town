import type { Statement } from "better-sqlite3";
import type { DB } from "./db.ts";
import { notFound } from "./errors.ts";

/** The slice of a Zod object schema we need (avoids a direct zod import). */
export interface ObjSchema<T> {
  parse(v: unknown): T;
  shape: Record<string, { safeParse(v: unknown): { success: boolean } }>;
}

export interface TableOptions {
  /** columns stored as JSON text */
  json?: string[];
  /** columns stored as 0/1 */
  bool?: string[];
  /** primary key column (default "id") */
  key?: string;
}

type Row = Record<string, unknown>;

/**
 * Maps one schema object type to one table. Every write is validated with the schema;
 * every read is parsed back through it (so defaults apply and bad rows fail loudly).
 */
export class Table<T extends object> {
  readonly cols: string[];
  private readonly key: string;
  private readonly json: Set<string>;
  private readonly bool: Set<string>;
  private readonly nullable: Set<string>;
  private readonly upsertSql: string;
  private stmts = new Map<string, Statement<unknown[]>>();

  constructor(
    private readonly db: DB,
    readonly name: string,
    readonly schema: ObjSchema<T>,
    opts: TableOptions = {},
    private readonly onChange?: (obj: T) => void,
  ) {
    this.cols = Object.keys(schema.shape);
    this.key = opts.key ?? "id";
    this.json = new Set(opts.json ?? []);
    this.bool = new Set(opts.bool ?? []);
    this.nullable = new Set(this.cols.filter((c) => schema.shape[c].safeParse(null).success));
    const have = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((r) => r.name));
    const missing = this.cols.filter((c) => !have.has(c));
    if (missing.length) throw new Error(`[core] table ${name} is missing columns: ${missing.join(", ")}`);
    const q = this.cols.map((c) => `"${c}"`).join(", ");
    const ph = this.cols.map(() => "?").join(", ");
    const set = this.cols.filter((c) => c !== this.key).map((c) => `"${c}" = excluded."${c}"`).join(", ");
    this.upsertSql = `INSERT INTO "${name}" (${q}) VALUES (${ph}) ON CONFLICT("${this.key}") DO UPDATE SET ${set}`;
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare<unknown[]>(sql); this.stmts.set(sql, s); }
    return s;
  }

  private toParams(o: T): unknown[] {
    const r = o as Row;
    return this.cols.map((c) => {
      const v = r[c];
      if (v === undefined || v === null) return null;
      if (this.json.has(c)) return JSON.stringify(v);
      if (this.bool.has(c)) return v ? 1 : 0;
      return v;
    });
  }

  fromRow(row: Row): T {
    const o: Row = {};
    for (const c of this.cols) {
      let v = row[c];
      if (v === null || v === undefined) {
        if (this.nullable.has(c)) o[c] = null;
        continue;
      }
      if (this.json.has(c) && typeof v === "string") v = JSON.parse(v);
      if (this.bool.has(c)) v = !!v;
      o[c] = v;
    }
    return this.schema.parse(o);
  }

  get(id: string): T | undefined {
    const row = this.stmt(`SELECT * FROM "${this.name}" WHERE "${this.key}" = ?`).get(id) as Row | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  require(id: string, what = this.name.replace(/s$/, "")): T {
    const v = this.get(id);
    if (!v) throw notFound(what, id);
    return v;
  }

  /** `where` is a SQL fragment with `?` params; `tail` is e.g. `ORDER BY createdAt DESC LIMIT 20`. */
  where(where = "1=1", params: unknown[] = [], tail = ""): T[] {
    const rows = this.stmt(`SELECT * FROM "${this.name}" WHERE ${where} ${tail}`).all(...params) as Row[];
    return rows.map((r) => this.fromRow(r));
  }

  first(where: string, params: unknown[] = [], tail = ""): T | undefined {
    return this.where(where, params, `${tail} LIMIT 1`)[0];
  }

  all(tail = "ORDER BY rowid"): T[] {
    return this.where("1=1", [], tail);
  }

  count(where = "1=1", params: unknown[] = []): number {
    return (this.stmt(`SELECT COUNT(*) AS n FROM "${this.name}" WHERE ${where}`).get(...params) as { n: number }).n;
  }

  /** SUM of a numeric column over the matching rows (0 when none). */
  sum(col: string, where = "1=1", params: unknown[] = []): number {
    return (this.stmt(`SELECT COALESCE(SUM("${col}"), 0) AS n FROM "${this.name}" WHERE ${where}`).get(...params) as { n: number }).n;
  }

  /** Arbitrary SELECT returning this table's rows (e.g. FTS joins). */
  query(sql: string, params: unknown[] = []): T[] {
    return (this.stmt(sql).all(...params) as Row[]).map((r) => this.fromRow(r));
  }

  upsert(obj: T, opts: { silent?: boolean } = {}): T {
    const parsed = this.schema.parse(obj);
    this.stmt(this.upsertSql).run(...this.toParams(parsed));
    if (!opts.silent) this.onChange?.(parsed);
    return parsed;
  }

  patch(id: string, patch: Partial<T>, opts: { silent?: boolean } = {}): T {
    const cur = this.require(id);
    return this.upsert({ ...cur, ...patch }, opts);
  }

  delete(id: string): void {
    this.stmt(`DELETE FROM "${this.name}" WHERE "${this.key}" = ?`).run(id);
  }
}
