/**
 * The backup file cipher: AES-256-GCM under MUSTER_TOWN_BACKUP_KEY, the scheme of docs/secrets.md applied to a whole
 * file: iv[12] | tag[16] | ciphertext, with a fixed AAD so the blob can only be read as a backup. The key is 32 bytes,
 * base64 or 64 hex chars (`openssl rand -base64 32`), lives in the server's env and never in the DB or on health.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const BACKUP_AAD = "muster-town backup v1";

/** 32 bytes from base64 or hex; null when unset or blank; throws when malformed. */
export function backupKeyFrom(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("MUSTER_TOWN_BACKUP_KEY must be 32 bytes (base64, or 64 hex chars).");
  return key;
}

export function encryptBackup(key: Buffer, plain: Uint8Array): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(BACKUP_AAD));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** Throws on a wrong key or a tampered blob (GCM tag mismatch). */
export function decryptBackup(key: Buffer, blob: Uint8Array): Buffer {
  if (blob.byteLength < 28) throw new Error("not a backup blob (too short)");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(Buffer.from(BACKUP_AAD));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}
