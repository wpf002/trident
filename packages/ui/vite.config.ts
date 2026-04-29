import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SSE-friendly proxy: disable timeouts so long-lived streams aren't killed
// mid-generation, and force HTTP/1.1 keep-alive.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4243,
    proxy: {
      "/api": {
        target: "http://localhost:4242",
        changeOrigin: false,
        ws: false,
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Match the upstream's no-buffer hint so any further hop respects it.
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
