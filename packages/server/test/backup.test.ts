import Database from "better-sqlite3";
import { integrityCheck, migrate, openDb } from "@muster-town/core";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { BackupJob, backupKeyFrom, decryptBackup, encryptBackup, keysToDelete, msUntilNextRun, objectKey, parseObjectKey, S3 } from "../src/backup/index.ts";
import { signV4 } from "../src/backup/sigv4.ts";
import { json, seededApp } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "muster-backup-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("WAL-safe online copy", () => {
  it("copies the committed rows while another connection holds an uncommitted write, and the copy passes integrity_check", async () => {
    const path = join(tmp, "wal.db");
    const db = openDb(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 500; i++) insert.run(`row ${i}`);
    // a second connection with an open write transaction: its rows are not committed
    const writer = new Database(path);
    writer.pragma("busy_timeout = 100");
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO t (v) VALUES (?)").run("uncommitted");
    const copyPath = join(tmp, "wal-copy.db");
    await db.backup(copyPath);
    writer.exec("ROLLBACK");
    writer.close();
    expect(integrityCheck(copyPath)).toBe("ok");
    const copy = new Database(copyPath, { readonly: true });
    expect((copy.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(500);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM t WHERE v = 'uncommitted'").get()).toEqual({ n: 0 });
    copy.close();
    db.close();
  });
});

describe("file cipher", () => {
  it("round-trips, rejects a tampered blob and the wrong key", () => {
    const key = backupKeyFrom(KEY)!;
    const plain = Buffer.from("SQLite format 3\0 and then some bytes ".repeat(50));
    const blob = encryptBackup(key, plain);
    expect(blob.byteLength).toBe(plain.byteLength + 28);
    expect(blob.includes("SQLite format 3")).toBe(false);
    expect(decryptBackup(key, blob).equals(plain)).toBe(true);
    const tampered = Buffer.from(blob); tampered[40] ^= 1;
    expect(() => decryptBackup(key, tampered)).toThrow();
    expect(() => decryptBackup(Buffer.alloc(32, 9), blob)).toThrow();
  });
  it("reads the key as base64 or hex, 32 bytes only", () => {
    expect(backupKeyFrom(undefined)).toBeNull();
    expect(backupKeyFrom("  ")).toBeNull();
    expect(backupKeyFrom("07".repeat(32))!.equals(backupKeyFrom(KEY)!)).toBe(true);
    expect(() => backupKeyFrom("dG9vc2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("SigV4 signer", () => {
  // the AWS SigV4 test suite (botocore tests/unit/auth/aws4_testsuite): get-vanilla and post-x-www-form-urlencoded
  const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "service" };
  const date = new Date("2015-08-30T12:36:00Z");
  it("matches get-vanilla", () => {
    const h = signV4(creds, { method: "GET", url: new URL("https://example.amazonaws.com/"), date });
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
    expect(h.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });
  it("matches post-x-www-form-urlencoded (a signed body and content-type)", () => {
    const h = signV4(creds, { method: "POST", url: new URL("https://example.amazonaws.com/"), date, headers: { "content-type": "application/x-www-form-urlencoded" }, body: Buffer.from("Param1=value1") });
    expect(h.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
  });
  it("adds x-amz-content-sha256 for s3", () => {
    const h = signV4({ ...creds, service: "s3" }, { method: "PUT", url: new URL("https://fly.storage.tigris.dev/b/town/x.enc"), date, body: Buffer.from("abc") });
    expect(h["x-amz-content-sha256"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(h.authorization).toMatch(/SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});

describe("the job", () => {
  it("is a no-op without the env vars: health shows backup null, nothing is written", async () => {
    const db = openDb(":memory:");
    const dir = join(tmp, "noop");
    const warnings: string[] = [];
    const job = new BackupJob({ db, dir, env: { BUCKET_NAME: "b" }, log: { log: () => {}, warn: (m: string) => warnings.push(m) } });
    expect(job.configured).toBe(false);
    expect(job.missing).toEqual(["AWS_ENDPOINT_URL_S3", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "MUSTER_TOWN_BACKUP_KEY"]);
    expect(job.snapshot()).toBeNull();
    job.start();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/\[backup\] off: .*AWS_ENDPOINT_URL_S3.*MUSTER_TOWN_BACKUP_KEY/);
    expect(await job.run()).toBeNull();
    expect(() => readdirSync(dir)).toThrow(); // the dir was never created
    db.close();
  });

  it("GET /api/health has backup: null without a job", async () => {
    const ctx = await seededApp();
    const res = await json(ctx.app, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("backup", null);
    await ctx.close();
  });

  it("schedules every hour on the hour and names objects by UTC date and hour", () => {
    expect(msUntilNextRun(new Date("2026-10-27T04:59:00Z"))).toBe(60_000);
    expect(msUntilNextRun(new Date("2026-10-27T04:00:00Z"))).toBe(3600_000);
    expect(msUntilNextRun(new Date("2026-10-27T23:30:00Z"))).toBe(30 * 60_000); // across midnight
    expect(objectKey(new Date("2026-10-27T23:59:59Z"))).toBe("town/2026-10-27T23.db.gz.enc");
    expect(parseObjectKey("town/2026-10-27T04.db.gz.enc")).toEqual({ date: "2026-10-27", hour: "04" });
    expect(parseObjectKey("town/2026-10-27.db.gz.enc")).toEqual({ date: "2026-10-27", hour: null });
    expect(parseObjectKey("town/notes.txt")).toBeNull();
    // a nightly object sorts before the hours of its date
    expect(["town/2026-10-27T00.db.gz.enc", "town/2026-10-27.db.gz.enc"].sort()[0]).toBe("town/2026-10-27.db.gz.enc");
  });

  it("boot catch-up runs when the last copy is older than 1 h", () => {
    const db = openDb(":memory:");
    migrate(db);
    let now = new Date("2026-10-31T12:00:00Z");
    const env = { BUCKET_NAME: "b", AWS_ENDPOINT_URL_S3: "http://127.0.0.1:9", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", MUSTER_TOWN_BACKUP_KEY: KEY };
    const job = new BackupJob({ db, dir: join(tmp, "stale"), env, now: () => now, log: { log: () => {}, warn: () => {} } });
    expect(job.stale()).toBe(true); // never copied
    db.prepare("UPDATE backup_state SET lastAt = ? WHERE id = 1").run("2026-10-31T11:10:00.000Z");
    expect(job.stale()).toBe(false); // 50 min
    now = new Date("2026-10-31T12:10:01Z");
    expect(job.stale()).toBe(true); // 1 h 0 min 1 s
    db.close();
  });

  it("tiered retention keeps the newest 48 hourly objects plus the newest of each of 30 days", () => {
    const keys: string[] = [];
    // 40 old nightly objects (09-01 .. 10-10) and 5 days of hourly objects (10-27 .. 10-31, 24 each)
    for (let d = 0; d < 40; d++) keys.push(`town/${new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10)}.db.gz.enc`);
    for (let d = 27; d <= 31; d++) for (let h = 0; h < 24; h++) keys.push(`town/2026-10-${d}T${String(h).padStart(2, "0")}.db.gz.enc`);
    keys.push("town/README", "other/2026-10-01.db.gz.enc");
    const del = new Set(keysToDelete(keys));
    const kept = keys.filter((k) => !del.has(k) && parseObjectKey(k));
    const hourly = kept.filter((k) => parseObjectKey(k)!.hour != null);
    // the last 48 hours (10-30T00 .. 10-31T23) plus 23:00 of 10-27, 10-28, 10-29
    expect(hourly.filter((k) => k >= "town/2026-10-30")).toHaveLength(48);
    expect(hourly.filter((k) => k < "town/2026-10-30")).toEqual(["town/2026-10-27T23.db.gz.enc", "town/2026-10-28T23.db.gz.enc", "town/2026-10-29T23.db.gz.enc"]);
    // 30 days in all: the 5 hourly days and the newest 25 nightly ones (09-16 .. 10-10)
    expect(new Set(kept.map((k) => parseObjectKey(k)!.date)).size).toBe(30);
    expect(kept.filter((k) => parseObjectKey(k)!.hour == null)).toHaveLength(25);
    expect(del.has("town/2026-09-15.db.gz.enc")).toBe(true);
    expect(del.has("town/2026-09-16.db.gz.enc")).toBe(false);
    expect(del.has("town/2026-10-27T22.db.gz.enc")).toBe(true);
    // never anything outside the naming
    expect(del.has("town/README")).toBe(false);
    expect(del.has("other/2026-10-01.db.gz.enc")).toBe(false);
    expect(kept.length + del.size).toBe(keys.length - 2);
    // today's nightly object stays until a newer object of its date exists
    expect(keysToDelete(["town/2026-10-31.db.gz.enc"])).toEqual([]);
    expect(keysToDelete(["town/2026-10-31.db.gz.enc", "town/2026-10-31T21.db.gz.enc"])).toEqual(["town/2026-10-31.db.gz.enc"]);
    expect(keysToDelete(["town/2026-10-30.db.gz.enc", "town/2026-10-31T21.db.gz.enc"])).toEqual([]);
  });

  it("verify-by-download fails loudly on a corrupted object: error on health, no lastAt, nothing pruned", async () => {
    const objects = new Map<string, Buffer>([["town/2026-10-30.db.gz.enc", Buffer.from("old")]]);
    const s3 = await fakeS3(objects, { corruptGet: true });
    const db = openDb(join(tmp, "corrupt.db"));
    migrate(db);
    const logs: string[] = [];
    const now = new Date("2026-11-01T05:00:00Z");
    const job = new BackupJob({ db, dir: join(tmp, "corrupt"), env: s3.env, now: () => now, log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } });
    expect(await job.run()).toBeNull();
    const snap = job.snapshot()!;
    expect(snap.lastAt).toBeNull();
    expect(snap.verifiedAt).toBeNull();
    expect(snap.error).toMatch(/^verify town\/2026-11-01T05\.db\.gz\.enc failed: /);
    expect(logs.some((l) => l.startsWith("[backup] failed: verify"))).toBe(true);
    expect(objects.has("town/2026-10-30.db.gz.enc")).toBe(true);
    expect(readdirSync(join(tmp, "corrupt")).filter((f) => f.endsWith(".verify"))).toEqual([]);
    // the next run reads its object back intact: error cleared, lastAt and verifiedAt set
    s3.corruptGet = false;
    expect((await job.run())!.key).toBe("town/2026-11-01T05.db.gz.enc");
    expect(job.snapshot()).toMatchObject({ lastAt: now.toISOString(), verifiedAt: now.toISOString(), error: null });
    s3.close();
    db.close();
  });

  it("copies, encrypts, uploads, prunes to 30 objects and keeps one local copy, and health shows it", async () => {
    // a fake S3 endpoint: PUT stores, GET ?list-type=2 lists, DELETE removes; every request must carry a SigV4 header
    const objects = new Map<string, Buffer>();
    for (let i = 1; i <= 31; i++) objects.set(`town/2026-09-${String(i).padStart(2, "0")}.db.gz.enc`, Buffer.from("old"));
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization ? "signed" : "unsigned"}`);
      if (!/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/.test(req.headers.authorization ?? "")) { res.statusCode = 403; return res.end("no auth"); }
      const url = new URL(req.url!, "http://x");
      const key = decodeURIComponent(url.pathname.replace(/^\/bkt\/?/, ""));
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); res.statusCode = 200; return res.end(); }
        if (req.method === "DELETE") { objects.delete(key); res.statusCode = 204; return res.end(); }
        if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
          res.setHeader("content-type", "application/xml");
          return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
        }
        if (req.method === "GET" && objects.has(key)) { res.statusCode = 200; return res.end(objects.get(key)); }
        res.statusCode = 400; res.end("bad");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dbPath = join(tmp, "live.db");
    const db = openDb(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 100; i++) db.prepare("INSERT INTO t (v) VALUES (?)").run(`row ${i}`);
    const dir = join(tmp, "backups");
    const logs: string[] = [];
    let now = new Date("2026-10-27T04:00:00Z");
    const env = { BUCKET_NAME: "bkt", AWS_ENDPOINT_URL_S3: endpoint, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", MUSTER_TOWN_BACKUP_KEY: KEY };
    const job = new BackupJob({ db, dir, env, now: () => now, log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } });
    expect(job.configured).toBe(true);
    expect(job.snapshot()).toEqual({ lastAt: null, verifiedAt: null, bytes: null, dest: `127.0.0.1:${(server.address() as AddressInfo).port}/bkt/town/`, error: null });

    const r1 = (await job.run())!;
    expect(r1.key).toBe("town/2026-10-27T04.db.gz.enc");
    expect(r1.deleted).toEqual(["town/2026-09-01.db.gz.enc", "town/2026-09-02.db.gz.enc"]);
    expect(objects.size).toBe(30);
    expect(readdirSync(dir)).toEqual(["town-2026-10-27T04.db"]);
    // the object decrypts and gunzips to a database with the rows
    const blob = objects.get(r1.key)!;
    expect(blob.byteLength).toBe(r1.bytes);
    expect(blob.includes("SQLite format 3")).toBe(false);
    const restored = join(tmp, "restored.db");
    const plain = gunzipSync(decryptBackup(backupKeyFrom(KEY)!, blob));
    expect(plain.subarray(0, 15).toString()).toBe("SQLite format 3");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(restored, plain);
    expect(integrityCheck(restored)).toBe("ok");
    const rdb = new Database(restored, { readonly: true });
    expect((rdb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n).toBe(100);
    rdb.close();
    // the restore side reads the same object back with S3.get (signed)
    const got = Buffer.from(await (await new S3({ endpoint, bucket: "bkt", creds: { accessKeyId: "AK", secretAccessKey: "SK", region: "auto" } }).get(r1.key)).arrayBuffer());
    expect(got.equals(blob)).toBe(true);
    const snap = job.snapshot()!;
    expect(snap).toEqual({ lastAt: "2026-10-27T04:00:00.000Z", verifiedAt: "2026-10-27T04:00:00.000Z", bytes: r1.bytes, dest: snap.dest, error: null });
    expect(JSON.stringify(snap)).not.toMatch(/SK|AK|7777/);

    // the next day: a new object, the older local copy goes
    now = new Date("2026-10-28T04:00:00Z");
    const r2 = (await job.run())!;
    expect(r2.key).toBe("town/2026-10-28T04.db.gz.enc");
    expect(objects.size).toBe(30);
    expect(objects.has("town/2026-09-03.db.gz.enc")).toBe(false);
    expect(readdirSync(dir)).toEqual(["town-2026-10-28T04.db"]);
    expect(seen.every((s) => s.endsWith("signed"))).toBe(true);

    // a failing bucket is stored, never thrown; lastAt stays
    server.close();
    now = new Date("2026-10-29T04:00:00Z");
    expect(await job.run()).toBeNull();
    const failed = job.snapshot()!;
    expect(failed.lastAt).toBe("2026-10-28T04:00:00.000Z");
    expect(failed.error).toMatch(/fetch failed|ECONNREFUSED|S3 PUT/);
    expect(logs.some((l) => l.startsWith("[backup] failed:"))).toBe(true);
    db.close();
  });

  it("migrations 039 and 069 give every database the state row", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(db.prepare("SELECT id, lastAt, verifiedAt FROM backup_state").all()).toEqual([{ id: 1, lastAt: null, verifiedAt: null }]);
    db.close();
  });
});

/** A fake S3 endpoint for the job: PUT stores, GET ?list-type=2 lists, GET reads (flipped bytes with corruptGet), DELETE removes. */
async function fakeS3(objects: Map<string, Buffer>, opts: { corruptGet?: boolean } = {}) {
  const state = { corruptGet: !!opts.corruptGet };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const key = decodeURIComponent(url.pathname.replace(/^\/bkt\/?/, ""));
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "PUT") { objects.set(key, Buffer.concat(chunks)); return res.end(); }
      if (req.method === "DELETE") { objects.delete(key); res.statusCode = 204; return res.end(); }
      if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
        const keys = [...objects.keys()].filter((k) => k.startsWith(url.searchParams.get("prefix") ?? "")).sort();
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
      }
      if (req.method === "GET" && objects.has(key)) {
        const body = Buffer.from(objects.get(key)!);
        if (state.corruptGet) body[body.length - 1] ^= 0xff;
        return res.end(body);
      }
      res.statusCode = 404; res.end("no such key");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    get corruptGet() { return state.corruptGet; },
    set corruptGet(v: boolean) { state.corruptGet = v; },
    env: { BUCKET_NAME: "bkt", AWS_ENDPOINT_URL_S3: endpoint, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", MUSTER_TOWN_BACKUP_KEY: KEY },
    close: () => server.close(),
  };
}
