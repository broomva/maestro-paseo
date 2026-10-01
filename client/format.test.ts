import { expect, test } from "bun:test";
import { ago, agoWords, bytes, duration, errorText } from "./format";

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

test("ages in words, for screen readers", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  expect(agoWords("2026-09-22T11:59:40Z", now)).toBe("updated just now");
  expect(agoWords("2026-09-22T11:59:00Z", now)).toBe("updated 1 minute ago");
  expect(agoWords("2026-09-22T11:48:00Z", now)).toBe("updated 12 minutes ago");
  expect(agoWords("2026-09-22T09:00:00Z", now)).toBe("updated 3 hours ago");
  expect(agoWords("2026-09-21T12:00:00Z", now)).toBe("updated 1 day ago");
  expect(agoWords(null, now)).toBe("");
});

test("file sizes", () => {
  expect(bytes(0)).toBe("0 B");
  expect(bytes(812)).toBe("812 B");
  expect(bytes(1024)).toBe("1.0 KB");
  expect(bytes(1260)).toBe("1.2 KB");
  expect(bytes(65_536)).toBe("64 KB");
  expect(bytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
});
