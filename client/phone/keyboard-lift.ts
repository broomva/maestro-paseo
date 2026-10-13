// The keyboard's lift as a pure rule (client/phone/keyboard.ts hooks it to the events).

/** How far a sheet standing `safeBottom` above the screen's bottom edge rises for a keyboard `height` tall. */
export function keyboardLift(height: number, safeBottom: number): number {
  return Math.max(0, Math.round(height - Math.max(0, safeBottom)));
}
