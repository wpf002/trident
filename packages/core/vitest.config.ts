import { defineConfig } from "vitest/config";

// Core owns the Rift subsystem, and Rift is a measurement instrument — its
// tests are part of the evidence chain. Each builds its own throwaway SQLite
// file; no shared state.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
