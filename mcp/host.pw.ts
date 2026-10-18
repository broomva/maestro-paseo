import { expect, test } from "@playwright/test";

const host = "http://127.0.0.1:4323";
for (const [width, height] of [
  [1280, 800],
  [728, 620],
  [390, 740],
]) {
  test(`real MCP frame handshake and action geometry at ${width}x${height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: height + 30 });
    await page.goto(`${host}/?width=${width}&height=${height}&source=demo`);
    await expect(page.locator("body")).toHaveAttribute("data-connected", "true");
    const app = page.frameLocator("#maestro-frame");
    await expect(app.getByText("Sample data", { exact: true })).toBeVisible();
    await expect(app.locator("html")).toHaveAttribute("data-theme", "light");
    const reader = await app.locator(".decision-reader").boundingBox();
    expect(reader!.width).toBeGreaterThan(width > 960 ? 600 : width - 60);
    for (const name of ["Skip", "Answer"]) {
      const button = app.getByRole("button", { name, exact: true });
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 30);
      expect(
        await button.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      ).toBe(true);
    }
    await app.getByRole("radio").first().check();
    await app.locator("textarea").fill("Preserve my draft across an MCP refresh.");
    await app.getByRole("button", { name: "Refresh Maestro" }).click();
    await expect(app.locator("textarea")).toHaveValue("Preserve my draft across an MCP refresh.");
    await expect(app.getByRole("radio").first()).toBeChecked();
    await app.getByRole("button", { name: "Skip", exact: true }).click();
    const events = await page.evaluate(async () => (await fetch("/events")).json());
    expect(events.some((e: { kind: string }) => e.kind === "initialized")).toBe(true);
    expect(events.some((e: { name?: string }) => e.name === "maestro_snapshot")).toBe(true);
    expect(events.some((e: { name?: string }) => e.name === "maestro_answer_ask")).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("UI answer crosses AppBridge and actual MCP tool into canonical ledger and receipt", async ({ page }) => {
  await page.goto(`${host}/?source=fixture&width=728&height=760`);
  await expect(page.locator("body")).toHaveAttribute("data-connected", "true");
  const app = page.frameLocator("#maestro-frame");
  await expect(app.getByRole("heading", { name: "Approve the isolated end-to-end test?" })).toBeVisible();
  await app.getByRole("radio", { name: /^Approve / }).check();
  await app.locator("textarea").fill("Approved through the actual MCP App UI.");
  await app.getByRole("button", { name: "Answer", exact: true }).click();
  await expect(app.getByText("Answer recorded. Routing and execution are tracked separately.")).toBeVisible();
  await expect(app.getByRole("heading", { name: "Approve the isolated end-to-end test?" })).toHaveCount(0);
  const receipt = await page.evaluate(async () => (await fetch("/receipt")).json());
  expect(receipt.source).toBe("fixture");
  expect(receipt.ledger).toContain('answer_option: "approve"');
  expect(receipt.ledger).toContain("Approved through the actual MCP App UI.");
  expect(receipt.receipts.filter((r: { kind: string }) => r.kind === "ask.answered")).toHaveLength(1);
  const events = await page.evaluate(async () => (await fetch("/events")).json());
  const answers = events.filter((e: { name?: string }) => e.name === "maestro_answer_ask");
  expect(answers).toHaveLength(1);
  expect(answers[0].arguments).toMatchObject({ id: "host-review", option: "approve" });
  expect(answers[0].arguments.hash).toBeTruthy();
  expect(answers[0].arguments.key).toBeTruthy();
  await app.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(app.getByRole("heading", { name: "Approve the isolated end-to-end test?" })).toHaveCount(0);
  await expect(app.getByText("Answer routing is unavailable on this connection.")).toBeVisible();
});
