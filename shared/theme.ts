// Broomva as a Paseo theme. Values are the broomva-design semantic tokens
// (oklch in tokens.json) converted to the hex Paseo requires. Borders use the
// input token rather than the 7% whisper border: Paseo also paints its highest
// raised surface and diff gutters with `border`, and the whisper value
// disappears there.

import type { PluginThemeContribution } from "@getpaseo/plugin";

export const BROOMVA_LIGHT: PluginThemeContribution = {
  id: "broomva-light",
  name: "Broomva light",
  appearance: "light",
  colors: {
    background: "#ffffff",
    foreground: "#0c101a",
    raised: "#f3f4f6",
    control: "#f3f4f6",
    border: "#e1e3e6",
    accent: "#5480c7",
    mutedForeground: "#5f636c",
    ring: "#5480c7",
  },
};

export const BROOMVA_DARK: PluginThemeContribution = {
  id: "broomva-dark",
  name: "Broomva dark",
  appearance: "dark",
  colors: {
    background: "#060810",
    foreground: "#f2f3f6",
    raised: "#0d101c",
    control: "#1f2332",
    border: "#1f2332",
    accent: "#5480c7",
    mutedForeground: "#818693",
    ring: "#5480c7",
  },
};
