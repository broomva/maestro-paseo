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
    await page.locator("main").evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
    });
    await page.screenshot({ path: `/tmp/maestro-t3-${width}-light.png`, fullPage: true });
    await page.getByRole("button", { name: "Switch to dark theme" }).click();
    await nav.getByRole("button", { name: /^Decisions/ }).click();
    await page.locator("main").evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
    });
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
  await page.locator(".series-row").first().click();
  const first = next.asks?.[0];
  if (!first) throw new Error("Missing sample ask");
  first.hash = "changed";
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: next }));
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.locator(".action-explanation")).toBeVisible();
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

test("glass respects reduced transparency, high contrast and reduced motion", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(page.locator(".chrome")).toHaveCSS("backdrop-filter", /blur/);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await expect(page.locator(".chrome")).toHaveCSS("backdrop-filter", "none");
  await expect(page.locator(".chrome")).toHaveCSS("background-color", "rgb(23, 24, 28)");
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-contrast", value: "more" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await expect(page.locator(".chrome")).toHaveCSS("backdrop-filter", "none");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  const foreground = await page.locator("h1").evaluate((el) => getComputedStyle(el).color);
  await expect(page.locator(".subtitle")).toHaveCSS("color", foreground);
  const tab = page.getByRole("navigation").getByRole("button", { name: /^Feed/ });
  await expect(tab).toHaveCSS("transition-duration", "0s");
  await tab.hover();
  await page.mouse.down();
  await expect(tab).toHaveCSS("transform", "none");
  await page.mouse.up();
  await page.screenshot({ path: "/tmp/maestro-glass-accessible.png", fullPage: true });
});

test("preview refuses rebinding hosts before serving snapshots", async ({ request }) => {
  for (const host of ["attacker.example:4319", "127.0.0.1:9999", "localhost.attacker.example:4319"]) {
    const response = await request.get("/api/snapshot", { headers: { host } });
    expect(response.status()).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  }
  for (const host of ["127.0.0.1:4319", "localhost:4319"]) {
    const response = await request.get("/api/snapshot", { headers: { host } });
    expect(response.status()).toBe(200);
  }
});

for (const [width, height] of [
  [1280, 800],
  [728, 600],
  [390, 740],
]) {
  test(`decision actions stay reachable at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto("/?view=decisions");
    const answer = page.getByRole("button", { name: "Answer", exact: true });
    const skip = page.getByRole("button", { name: "Skip", exact: true });
    await expect(answer).toBeVisible();
    for (const button of [skip, answer]) {
      const box = await button.boundingBox();
      expect(box).toBeTruthy();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      expect(
        await button.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        }),
      ).toBe(true);
    }
    const reader = await page.locator(".decision-reader").boundingBox();
    expect(reader!.width).toBeGreaterThan(width > 960 ? 600 : width - 60);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(".decision-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.getByRole("radio").first().check();
    await expect(answer).toBeEnabled();
    const before = await page.locator(".decision-card h2").textContent();
    await skip.click();
    if (await page.locator(".decision-reader").count()) {
      await expect(page.locator(".decision-card h2")).not.toHaveText(before!);
    } else {
      await expect(page.locator(".series-list")).toBeVisible();
    }
  });
}

test("preview answer endpoint refuses cross-origin and simple form writes", async ({ request }) => {
  expect(
    (await request.post("/api/answer", { headers: { origin: "https://attacker.example" }, data: {} })).status(),
  ).toBe(403);
  expect((await request.post("/api/answer", { headers: { "Content-Type": "text/plain" }, data: "{}" })).status()).toBe(
    415,
  );
});

test("default reader pins its revision; next asks start at the question; filters reconcile selection", async ({
  page,
}) => {
  const next = sampleSnapshot();
  // No explicit series click: the initial reader must be just as safe as a pinned one.
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: next }));
  await page.goto("/?view=decisions");
  await page.getByRole("radio").first().check();
  await page.locator("textarea").fill("Draft bound to the original question");
  const first = next.asks![0];
  first.hash = "new-revision";
  first.title = "Changed question must be reviewed";
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await expect(page.locator(".action-explanation")).toContainText("This decision changed");
  await expect(page.getByRole("button", { name: "Answer", exact: true })).toBeDisabled();
  await expect(page.locator("textarea")).toHaveValue("Draft bound to the original question");
  await page.getByRole("button", { name: "All decision series" }).click();
  await page.locator(".series-row").first().click();
  await expect(page.locator("textarea")).toHaveValue("");
  await expect(page.getByRole("radio").first()).not.toBeChecked();
  // Two asks in one series: advance after reading all the way to the note.
  const second = next.asks![1];
  second.ledger = first.ledger;
  await page.getByRole("button", { name: "Refresh Maestro" }).click();
  await page.locator(".decision-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.locator(".decision-card h2")).toHaveText(second.title);
  expect(await page.locator(".decision-body").evaluate((el) => el.scrollTop)).toBe(0);
  await expect(page.locator(".decision-card h2")).toBeFocused();
  await page.getByRole("textbox", { name: "Search this view" }).fill("nonmatching-query");
  await expect(page.locator(".decision-reader")).toHaveCount(0);
  await expect(page.getByText(/Ask · 0/)).toHaveCount(0);
});

test("irreversible confirmation binds the note; rapid clicks send one exact revision", async ({ page }) => {
  const data = sampleSnapshot();
  data.capabilities.answerAsks = true;
  data.readOnly = false;
  const ask = data.asks?.[0];
  if (!ask) throw Error("Missing fixture");
  ask.options[0].reversible = false;
  const calls: unknown[] = [];
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: data }));
  await page.route("**/api/answer", async (route) => {
    calls.push(route.request().postDataJSON());
    const next = structuredClone(data);
    const answered = next.asks?.find((a) => a.key === ask.key);
    if (answered) answered.state = "answered";
    await route.fulfill({ json: { ok: true, snapshot: next } });
  });
  await page.goto("/?view=decisions");
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  expect(calls).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Confirm answer" })).toBeVisible();
  await page.locator("textarea").fill("A new condition requires renewed confirmation");
  await expect(page.getByRole("button", { name: "Answer", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm answer" }).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect(page.getByText("Answer recorded. Routing and execution are tracked separately.")).toBeVisible();
  expect(calls).toEqual([
    {
      key: ask.key,
      hash: ask.hash,
      ledger: ask.ledger,
      id: ask.id,
      option: ask.options[0].id,
      note: "A new condition requires renewed confirmation",
    },
  ]);
});

test("opening a Feed hold clears a different ledger scope", async ({ page }) => {
  const data = sampleSnapshot();
  const [first, second] = data.asks ?? [];
  if (!first || !second || !data.needs) throw Error("Missing fixture");
  first.ledger = "ledger-a.yaml";
  second.ledger = "ledger-b.yaml";
  data.needs.rows = [
    {
      key: "hold-b",
      title: second.title,
      scope: "workspace",
      kind: "ask",
      since: "now",
      target: { kind: "ask", id: second.key },
    },
  ];
  await page.route("**/api/snapshot", (route) => route.fulfill({ json: data }));
  await page.goto("/?view=decisions");
  await page.getByRole("combobox", { name: "Filter by ledger" }).selectOption("ledger-a.yaml");
  await page.getByRole("navigation").getByRole("button", { name: /^Feed/ }).click();
  await page.locator(".need-row").click();
  await expect(page.locator(".decision-card h2")).toHaveText(second.title);
  await expect(page.getByRole("combobox", { name: "Filter by ledger" })).toHaveValue("all");
  await expect(page.locator(".decision-header-title")).toHaveText("Ask · 1 of 1");
});
