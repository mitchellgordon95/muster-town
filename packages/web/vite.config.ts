import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const target = process.env.AGENT_TOWN_URL ?? "http://localhost:4321";

export default defineConfig({
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
