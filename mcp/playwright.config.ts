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
  webServer: [
    {
      command: "bun mcp/preview.ts --demo",
      cwd: "..",
      env: { MAESTRO_MCP_PREVIEW_PORT: "4319" },
      url: "http://127.0.0.1:4319",
      reuseExistingServer: false,
    },
    {
      command: "bun mcp/test-host.ts",
      cwd: "..",
      env: { MAESTRO_MCP_TEST_HOST_PORT: "4323" },
      url: "http://127.0.0.1:4323",
      reuseExistingServer: false,
    },
  ],
});
