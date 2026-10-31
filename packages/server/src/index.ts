/** @muster-town/server — Fastify HTTP + WS API and the MCP endpoint over a core `World`. */
export { buildApp, DEFAULT_WEB_DIST, type BuildAppOptions } from "./app.ts";
export { buildMcpServer } from "./mcp.ts";
export { adminToken, resolveToken, type Auth, type RuntimeHooks } from "./context.ts";
export { desksFromEnv, loadEnvFile } from "./env.ts";
export { BackupJob, backupKeyFrom, decryptBackup, encryptBackup, S3, signV4, objectKey, keysToDelete, type BackupView } from "./backup/index.ts";
