// The kit's smaller rules: tokens (B1), the platform assumptions (BRO-3033),
// the glance tile's tint, the inspector's verbs and the Undertow's marks.

import { describe, expect, test } from "bun:test";
import type { PluginTheme } from "@getpaseo/plugin";
import { chromeInset, frostLook, keysHint, nativeDriver, undertowLook } from "./assumptions";
import { GALLERY_DARK, GALLERY_LIGHT } from "./gallery-data";
import { INSPECTOR_KINDS, KIND_LOOK, KIND_VERBS, verbsFor } from "./inspector-model";
import { glanceRow, MAX_TILES, tileLook } from "./tile-model";
import { EXTENSION, kitOf } from "./tokens";
import { undertowMarks } from "./undertow-model";

const PASEO_GREEN: PluginTheme = {
  colors: { ...GALLERY_LIGHT.colors, accent: "#20744a", accentForeground: "#ffffff" },
};

describe("tokens follow the active theme; primaries are broomva ink (B1)", () => {
  test("a primary is the theme's foreground on its surface, never its accent", () => {
    const kit = kitOf(PASEO_GREEN);
    expect(kit.ink).toBe(PASEO_GREEN.colors.foreground);
    expect(kit.onInk).toBe(PASEO_GREEN.colors.surface0);
    expect(Object.values(kit)).not.toContain(PASEO_GREEN.colors.accent);
  });
  test("surfaces, text and status come from the theme", () => {
    const kit = kitOf(GALLERY_DARK);
    expect(kit.bg).toBe(GALLERY_DARK.colors.surface0);
    expect(kit.fg).toBe(GALLERY_DARK.colors.foreground);
    expect(kit.warn).toBe(GALLERY_DARK.colors.statusWarning);
    expect(kit.ok).toBe(GALLERY_DARK.colors.statusSuccess);
  });
  test("the extension's colors switch with the surface's luminance", () => {
    expect(kitOf(GALLERY_LIGHT).needs).toBe(EXTENSION.light.needs);
    expect(kitOf(GALLERY_DARK).needs).toBe(EXTENSION.dark.needs);
    expect(kitOf(GALLERY_DARK).dark).toBe(true);
    expect(kitOf(GALLERY_LIGHT).dark).toBe(false);
  });
});

describe("the platform assumptions BRO-3033 is verifying, each in one place", () => {
  test("A1: the Undertow animates its gradient on the web, a still ring on iOS", () => {
    expect(undertowLook("web")).toBe("gradient");
    expect(undertowLook("ios")).toBe("ring");
    expect(undertowLook("android")).toBe("ring");
  });
  test("A2: the action bar is frosted on the web only", () => {
    expect(frostLook("web")).toBe("frost");
    expect(frostLook("ios")).toBe("solid");
  });
  test("A3: no bottom chrome is assumed until the spike measures it", () => {
    expect(chromeInset("ios")).toBe(0);
  });
  test("A4 and A5: the native driver off the web; key caps on the web only", () => {
    expect(nativeDriver("web")).toBe(false);
    expect(nativeDriver("ios")).toBe(true);
    expect(keysHint("web")).toBe(true);
    expect(keysHint("ios")).toBe(false);
  });
});

describe("the glance tile is tinted only for Needs you or warn", () => {
  test("needs is Tidepool, warn is warn, everything else plain", () => {
    const kit = kitOf(GALLERY_LIGHT);
    expect(tileLook(kit, "needs")).toMatchObject({ tinted: true, label: kit.needs, fill: kit.needsSoft });
    expect(tileLook(kit, "warn")).toMatchObject({ tinted: true, label: kit.warn, fill: kit.warnSoft });
    expect(tileLook(kit, "plain")).toMatchObject({ tinted: false, fill: kit.bg });
  });
  test("four tiles at most", () => {
    expect(glanceRow([1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4]);
    expect(MAX_TILES).toBe(4);
  });
});

describe("the inspector's verbs", () => {
  test("every kind has its verbs, exactly one primary, drawn last", () => {
    for (const kind of INSPECTOR_KINDS) {
      const verbs = KIND_VERBS[kind];
      expect(verbs.filter((verb) => verb.primary)).toHaveLength(1);
      expect(verbs.at(-1)?.primary).toBe(true);
    }
  });
  test("no kind offers Approve: work is never approved (A0, BRO-2999), a notice is a fact", () => {
    for (const kind of INSPECTOR_KINDS)
      for (const verb of KIND_VERBS[kind]) expect(verb.label.toLowerCase()).not.toContain("approve");
    expect(KIND_VERBS.notice.map((verb) => verb.id)).toEqual(["open", "unblock"]);
  });
  test("the kinds' own verbs: Allow or Deny, Answer or Skip, Open or Unblock", () => {
    expect(KIND_VERBS.approval.map((verb) => verb.id)).toEqual(["deny", "allow"]);
    expect(KIND_VERBS.ask.map((verb) => verb.id)).toEqual(["skip", "answer"]);
    expect(KIND_VERBS.review.map((verb) => verb.id)).toEqual(["skip", "answer"]);
  });
  test("a screen names its primary in its own words", () => {
    expect(verbsFor("approval", "Allow merge").map((verb) => verb.label)).toEqual(["Deny…", "Allow merge"]);
    expect(verbsFor("approval").map((verb) => verb.label)).toEqual(["Deny…", "Allow"]);
  });
  test("asks, approvals and reviews are holds; notices and work are not", () => {
    expect(INSPECTOR_KINDS.filter((kind) => KIND_LOOK[kind].hold)).toEqual(["approval", "ask", "review"]);
  });
});

describe("the Undertow marks Running only (JE rule 9)", () => {
  test("running wears the halo and the dot; standing the pulse; nothing else wears anything", () => {
    expect(undertowMarks("running")).toEqual({ halo: true, dot: true, pulse: false });
    expect(undertowMarks("standing")).toEqual({ halo: false, dot: false, pulse: true });
    for (const state of ["queued", "proposed", "review", "blocked", "done", "canceled", "needs-you", ""])
      expect(undertowMarks(state)).toEqual({ halo: false, dot: false, pulse: false });
  });
});
