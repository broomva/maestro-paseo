import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.pw.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  outputDir: "dist/test-results",
  use: {
    baseURL: "http://127.0.0.1:4319",
    headless: true,
    launchOptions: process.env.MAESTRO_HEADLESS_SHELL ? { executablePath: process.env.MAESTRO_HEADLESS_SHELL } : {},
  },
  webServer: {
    command: "bun mcp/preview.ts --demo",
    cwd: "..",
    env: { MAESTRO_MCP_PREVIEW_PORT: "4319" },
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
  },
});
