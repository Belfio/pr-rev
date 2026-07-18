import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PORT is the API port (default 3001) — the proxy target must follow it so that
// `PORT=3101 pnpm dev` moves the API and the web proxy together. WEB_PORT overrides
// the dev-server port itself (default 5173).
const apiPort = process.env.PORT ?? "3001";
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true },
    },
  },
});
