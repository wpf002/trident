import { defineConfig } from "vitest/config";

// Spine is the only package in the repo with tests today. Keep the runner
// local to this package rather than hoisting a root-level config, so the
// other packages' build/dev scripts are untouched.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each test gets its own temp SQLite file; no shared global state.
    restoreMocks: true,
  },
});
