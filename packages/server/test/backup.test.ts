import Database from "better-sqlite3";
import { integrityCheck, migrate, openDb } from "@muster-town/core";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { BackupJob, backupKeyFrom, decryptBackup, encryptBackup, msUntilNextRun, objectKey } from "../src/backup/index.ts";
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

  it("schedules 04:17 UTC and names objects by UTC date", () => {
    expect(msUntilNextRun(new Date("2026-10-27T04:16:00Z"))).toBe(60_000);
    expect(msUntilNextRun(new Date("2026-10-27T04:17:00Z"))).toBe(24 * 3600_000);
    expect(objectKey(new Date("2026-10-27T23:59:59Z"))).toBe("town/2026-10-27.db.gz.enc");
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
    let now = new Date("2026-10-27T04:17:00Z");
    const env = { BUCKET_NAME: "bkt", AWS_ENDPOINT_URL_S3: endpoint, AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", MUSTER_TOWN_BACKUP_KEY: KEY };
    const job = new BackupJob({ db, dir, env, now: () => now, log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } });
    expect(job.configured).toBe(true);
    expect(job.snapshot()).toEqual({ lastAt: null, bytes: null, dest: `127.0.0.1:${(server.address() as AddressInfo).port}/bkt/town/`, error: null });

    const r1 = (await job.run())!;
    expect(r1.key).toBe("town/2026-10-27.db.gz.enc");
    expect(r1.deleted).toEqual(["town/2026-09-01.db.gz.enc", "town/2026-09-02.db.gz.enc"]);
    expect(objects.size).toBe(30);
    expect(readdirSync(dir)).toEqual(["town-2026-10-27.db"]);
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
    const snap = job.snapshot()!;
    expect(snap).toEqual({ lastAt: "2026-10-27T04:17:00.000Z", bytes: r1.bytes, dest: snap.dest, error: null });
    expect(JSON.stringify(snap)).not.toMatch(/SK|AK|7777/);

    // the next night: a new object, the older local copy goes
    now = new Date("2026-10-28T04:17:00Z");
    const r2 = (await job.run())!;
    expect(r2.key).toBe("town/2026-10-28.db.gz.enc");
    expect(objects.size).toBe(30);
    expect(objects.has("town/2026-09-03.db.gz.enc")).toBe(false);
    expect(readdirSync(dir)).toEqual(["town-2026-10-28.db"]);
    expect(seen.every((s) => s.endsWith("signed"))).toBe(true);

    // a failing bucket is stored, never thrown; lastAt stays
    server.close();
    now = new Date("2026-10-29T04:17:00Z");
    expect(await job.run()).toBeNull();
    const failed = job.snapshot()!;
    expect(failed.lastAt).toBe("2026-10-28T04:17:00.000Z");
    expect(failed.error).toMatch(/fetch failed|ECONNREFUSED|S3 PUT/);
    expect(logs.some((l) => l.startsWith("[backup] failed:"))).toBe(true);
    db.close();
  });

  it("migration 038 gives every database the state row", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(db.prepare("SELECT id, lastAt FROM backup_state").all()).toEqual([{ id: 1, lastAt: null }]);
    db.close();
  });
});
