import { expect, test } from "bun:test";
import { ago, duration, errorText } from "./format";

test("errors read as the handler's sentence", () => {
  expect(
    errorText(
      new Error(
        "Request failed: Only queued or stuck work can be dispatched. requestType=plugin.rpc.invoke.request code=handler_error",
      ),
    ),
  ).toBe("Only queued or stuck work can be dispatched.");
  expect(errorText(new Error("plain"))).toBe("plain");
  expect(errorText(undefined)).toBe("Something went wrong.");
});

test("ages and durations", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  expect(ago("2026-09-22T11:59:40Z", now)).toBe("now");
  expect(ago("2026-09-22T11:48:00Z", now)).toBe("12m");
  expect(ago("2026-09-22T09:00:00Z", now)).toBe("3h");
  expect(ago("2026-09-20T12:00:00Z", now)).toBe("2d");
  expect(duration(230 * 60_000)).toBe("3h 50m");
});
