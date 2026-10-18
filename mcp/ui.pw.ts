import { expect, test } from "@playwright/test";
import { sampleSnapshot } from "./sample";

for (const width of [1100, 728, 390]) {
  test(`all views, theme, search and draft at ${width}px`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 950 });
    await page.goto("/");
    await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Maestro views" });
    for (const title of ["Decisions", "Work", "Health", "Initiatives", "Feed"]) {
      await nav.getByRole("button", { name: new RegExp(`^${title}`) }).click();
      await expect(nav.getByRole("button", { name: new RegExp(`^${title}`) })).toHaveAttribute("aria-current", "page");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByRole("button", { name: "Switch to light theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await nav.getByRole("button", { name: /^Decisions/ }).click();
    await page.getByRole("radio").first().check();
    await page.locator("textarea").fill("Explore this with the orchestrator first.");
    await page.getByRole("button", { name: "Refresh Maestro" }).click();
    await expect(page.locator("textarea")).toHaveValue("Explore this with the orchestrator first.");
    await expect(page.getByRole("radio").first()).toBeChecked();
    await nav.getByRole("button", { name: /^Work/ }).click();
    await page.getByRole("button", { name: "Board", exact: true }).click();
    await expect(page.locator(".board-card")).toHaveCount(5);
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("textbox", { name: "Search this view" }).fill("keyboard");
    await expect(page.locator(".work-row")).toHaveCount(1);
    await page.locator(".work-row").click();
    await expect(page.getByRole("heading", { name: "Acceptance checks" })).toBeVisible();
    await page.getByRole("button", { name: "Close work details" }).click();
    await page.screenshot({ path: `/tmp/maestro-t3-${width}-light.png`, fullPage: true });
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await nav.getByRole("button", { name: /^Decisions/ }).click();
    await page.screenshot({ path: `/tmp/maestro-t3-${width}-dark.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
test("refresh marks a pinned decision stale and preserves data on disconnect", async ({ page }) => {
  const next = sampleSnapshot();
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: /^Decisions/ })
    .click();
  await page.locator(".quiet-card").first().click();
  const first = next.asks?.[0];
  if (!first) throw new Error("Missing sample ask");
  first.hash = "changed";
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: next }));
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.getByText(/This decision changed/)).toBeVisible();
  await page.route("**/api/snapshot", (route) =>
    route.fulfill({ json: { ...next, source: "unavailable", errors: { connection: "Disconnected" } } }),
  );
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.getByText("Disconnected", { exact: true })).toBeVisible();
  await expect(page.locator(".decision-card")).toBeVisible();
});

test("same-title holds navigate by identity and work details follow refresh", async ({ page }) => {
  const next = sampleSnapshot();
  const first = next.asks?.[0],
    second = next.asks?.[1];
  if (!first || !second || !next.needs || !next.work) throw new Error("Missing sample records");
  first.title = second.title = "Approve rollout";
  first.summary = "FIRST CONTEXT";
  second.summary = "SECOND CONTEXT";
  next.needs.rows = [
    {
      key: "hold2",
      title: "Approve rollout",
      scope: "second",
      kind: "ask",
      since: "now",
      target: { kind: "ask", id: second.key },
    },
  ];
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: next }));
  await page.goto("/");
  await page.locator(".need-row").click();
  await expect(page.getByText("SECOND CONTEXT", { exact: true })).toBeVisible();
  await expect(page.getByText("FIRST CONTEXT", { exact: true })).toHaveCount(0);
  await page.getByRole("navigation").getByRole("button", { name: /^Work/ }).click();
  await page.locator(".work-row").first().click();
  const work = next.work[0];
  if (!work) throw new Error("Missing work");
  work.state = "done";
  work.group = "done";
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.locator(".inspector .badge")).toHaveText("done");
  next.work = [];
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.getByText(/This work item is no longer available/)).toBeVisible();
  await expect(page.locator(".inspector")).toHaveCount(0);
});
