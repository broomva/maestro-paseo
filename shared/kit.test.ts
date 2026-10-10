import { describe, expect, test } from "bun:test";
import { galleryEnabled, KIT_GALLERY_ENV } from "./kit";

describe("the component gallery's flag", () => {
  test("on only when the daemon's environment says exactly 1", () => {
    expect(galleryEnabled({ [KIT_GALLERY_ENV]: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"])
      expect(galleryEnabled({ [KIT_GALLERY_ENV]: value })).toBe(false);
    expect(galleryEnabled({})).toBe(false);
  });
});
