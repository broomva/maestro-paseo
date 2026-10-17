// The keyboard's lift as a pure rule (client/phone/keyboard.ts hooks it to the events).

/** How far a sheet standing `safeBottom` above the screen's bottom edge rises for a keyboard `height` tall. */
export function keyboardLift(height: number, safeBottom: number): number {
  return Math.max(0, Math.round(height - Math.max(0, safeBottom)));
}

/**
 * How much of a view the keyboard covers on a native screen (BRO-3180): the view's bottom edge in the window less the
 * keyboard's top (`endCoordinates.screenY`), never negative. A view that ends above the keyboard is not covered.
 */
export function keyboardOverlap(viewBottom: number, keyboardTop: number): number {
  return Math.max(0, Math.round(viewBottom - keyboardTop));
}

/**
 * How much of the layout viewport the web's visual viewport leaves out at the bottom (BRO-3180): on iOS Safari and a
 * webview the software keyboard shrinks the visual viewport and leaves the layout one as it was, so what a bottom view
 * loses is the layout height less the visual viewport's bottom edge. Under 1 px is rounding, not a keyboard.
 */
export function viewportInset(layoutHeight: number, visualHeight: number, visualTop: number): number {
  const inset = Math.round(layoutHeight - (visualTop + visualHeight));
  return inset > 1 ? inset : 0;
}

/**
 * Where a scroll view showing `viewport` px of its content scrolls so a field at `top`, `height` tall, is in full view
 * with `margin` around it (BRO-3180: the field you type in stays above the keyboard). Null when it already is, so a
 * field in view is never moved under your thumb. A field taller than the viewport shows its bottom, where the caret is
 * while you type.
 */
export function revealScroll(
  field: { top: number; height: number },
  viewport: number,
  current: number,
  margin = 16,
): number | null {
  if (viewport <= 0) return null;
  const bottom = field.top + field.height + margin;
  if (bottom > current + viewport) return Math.max(0, Math.round(bottom - viewport));
  const top = Math.max(0, field.top - margin);
  if (top < current) return Math.round(top);
  return null;
}
