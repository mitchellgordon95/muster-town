// The node side of scripts/backup/restore.sh (grant gr_jkorz4f49a): the S3 GET/list, the decrypt + gunzip and the checks on the
// copy, reusing the step 1 code in packages/server/src/backup/ (crypto.ts, s3.ts, sigv4.ts) so a restore can only ever read what the
// job wrote. No npm install needed: those three files import node builtins only, and node >= 22.6 strips their types
// (run as `node --experimental-strip-types --no-warnings restore-helper.mjs ...`; restore.sh does). No SDK, no sqlite3 CLI: the
// checks use node:sqlite (node >= 22.5) and fall back to a `sqlite3` binary when it is missing.
//
//   list                         every town/<date>.db.gz.enc key in the bucket, oldest first (env: BUCKET_NAME, AWS_*)
//   get <key> <out>              download one object (env: BUCKET_NAME, AWS_*)
//   decrypt <blob> <out.db>      decrypt (MUSTER_TOWN_BACKUP_KEY) and gunzip a downloaded object into a database file
//   check <db>                   JSON: {integrity, agents, newestDocAt, docs, bytes} from the copy (read-only)
//   seal <db> <out.enc>          the inverse of decrypt (gzip + encrypt), for a test object without a bucket (--local drills)
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { backupKeyFrom, decryptBackup, encryptBackup } from "../../packages/server/src/backup/crypto.ts";
import { S3 } from "../../packages/server/src/backup/s3.ts";

const [cmd, ...args] = process.argv.slice(2);

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) { console.error(`${name} is not set`); process.exit(2); }
  return v;
}

function s3() {
  return new S3({
    endpoint: need("AWS_ENDPOINT_URL_S3"),
    bucket: need("BUCKET_NAME"),
    creds: { accessKeyId: need("AWS_ACCESS_KEY_ID"), secretAccessKey: need("AWS_SECRET_ACCESS_KEY"), region: process.env.AWS_REGION?.trim() || "auto" },
  });
}

function key() {
  const k = backupKeyFrom(need("MUSTER_TOWN_BACKUP_KEY"));
  if (!k) { console.error("MUSTER_TOWN_BACKUP_KEY is blank"); process.exit(2); }
  return k;
}

/** The three numbers the drill compares, read from a database file that is never written to. */
async function check(path) {
  const sql = {
    integrity: "PRAGMA integrity_check",
    agents: "SELECT count(*) AS n FROM agents WHERE status NOT IN ('banned','retired')",
    docs: "SELECT count(*) AS n FROM docs",
    newestDocAt: "SELECT max(createdAt) AS t FROM docs",
  };
  let out;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare(sql.integrity).all();
      out = {
        integrity: rows.map((r) => r.integrity_check).join("; ") || "no result",
        agents: db.prepare(sql.agents).get().n,
        docs: db.prepare(sql.docs).get().n,
        newestDocAt: db.prepare(sql.newestDocAt).get().t ?? null,
      };
    } finally { db.close(); }
  } catch (e) {
    if (e?.code !== "ERR_UNKNOWN_BUILTIN_MODULE" && e?.code !== "ERR_UNSUPPORTED_ESM_URL_SCHEME" && !/node:sqlite/.test(String(e))) throw e;
    // older node: the sqlite3 CLI (installed in the town image; `brew install sqlite` on a Mac)
    const q = (s) => execFileSync("sqlite3", ["-readonly", path, s], { encoding: "utf8" }).trim();
    out = { integrity: q(sql.integrity).split("\n").join("; "), agents: Number(q(sql.agents)), docs: Number(q(sql.docs)), newestDocAt: q(sql.newestDocAt) || null };
  }
  return { ...out, bytes: statSync(path).size };
}

switch (cmd) {
  case "list": {
    const keys = (await s3().list("town/")).filter((k) => /^town\/\d{4}-\d{2}-\d{2}\.db\.gz\.enc$/.test(k));
    for (const k of keys) console.log(k);
    break;
  }
  case "get": {
    const [k, out] = args;
    if (!k || !out) { console.error("usage: get <key> <out>"); process.exit(2); }
    const res = await s3().get(k);
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()));
    console.log(`${k}: ${statSync(out).size} bytes -> ${out}`);
    break;
  }
  case "decrypt": {
    const [blob, out] = args;
    if (!blob || !out) { console.error("usage: decrypt <blob> <out.db>"); process.exit(2); }
    const plain = gunzipSync(decryptBackup(key(), readFileSync(blob)));
    writeFileSync(out, plain);
    console.log(`${blob}: ${statSync(blob).size} bytes encrypted -> ${plain.byteLength} bytes of database at ${out}`);
    break;
  }
  case "check": {
    const [db] = args;
    if (!db) { console.error("usage: check <db>"); process.exit(2); }
    const r = await check(db);
    console.log(JSON.stringify(r));
    if (r.integrity !== "ok") process.exit(1);
    break;
  }
  case "seal": {
    const [db, out] = args;
    if (!db || !out) { console.error("usage: seal <db> <out.enc>"); process.exit(2); }
    writeFileSync(out, encryptBackup(key(), gzipSync(readFileSync(db), { level: 6 })));
    console.log(`${db} -> ${out} (${statSync(out).size} bytes, gzip + AES-256-GCM, the step 1 format)`);
    break;
  }
  default:
    console.error("usage: restore-helper.mjs list | get <key> <out> | decrypt <blob> <out.db> | check <db> | seal <db> <out.enc>");
    process.exit(2);
}
