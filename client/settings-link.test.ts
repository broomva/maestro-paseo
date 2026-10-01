import { afterEach, expect, test } from "bun:test";
import { linkSettingsOf, settingsOpener } from "./settings-link";

let unlink: () => void = () => undefined;
afterEach(() => unlink());

test("a host without openSettings links nothing, so the panel offers no press that would throw", () => {
  unlink = linkSettingsOf({}, "maestro");
  expect(settingsOpener()).toBeNull();
});

test("a host with openSettings opens Maestro's screen, and unlinking takes the opener back", () => {
  const opened: string[] = [];
  unlink = linkSettingsOf({ openSettings: (id: string) => opened.push(id) }, "maestro");
  settingsOpener()?.();
  expect(opened).toEqual(["maestro"]);
  unlink();
  expect(settingsOpener()).toBeNull();
});
