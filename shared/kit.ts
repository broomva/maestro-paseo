// The component gallery's flag (BRO-3034). The gallery shows every part of the
// J/M kit in every state, light and dark, so the dogfood harness can shoot it
// before the screens that use the parts exist (BRO-3035, 3036, 3037). It is a
// development screen: the daemon turns it on with MAESTRO_KIT_GALLERY=1, and
// without that the screen says it is off. Each screen ticket removes its
// components from the gallery as it adopts them.

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * The gallery's screen id. Paseo 0.11.1 routes it at /h/<server>/plugin/maestro/surface/kit, and its params
 * travel as ?param.<name>=: `section` (desktop, phone, undertow, m1) and `scheme` (both, light, dark).
 */
export const KIT_SCREEN = "kit";

/** The daemon's environment variable that turns the gallery on (exactly "1"). */
export const KIT_GALLERY_ENV = "MAESTRO_KIT_GALLERY";

/** Whether the gallery is on, from the daemon's environment. */
export function galleryEnabled(env: Record<string, string | undefined>): boolean {
  return env[KIT_GALLERY_ENV] === "1";
}

export const kitGallery = defineRpc({
  name: "kit.gallery",
  input: z.object({}),
  output: z.object({ enabled: z.boolean() }),
});
