import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.MUSTER_TOWN_URL ?? process.env.AGENT_TOWN_URL ?? "http://localhost:4321";

export default defineConfig({
  // the Workshop's client lives under /workshop/ (the server sends / there); /api, /auth, /ws stay at the root
  base: process.env.MUSTER_TOWN_WEB_BASE ?? "/workshop/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/mcp": { target, changeOrigin: true },
      "/auth": { target, changeOrigin: true },
      "/ws": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
});
