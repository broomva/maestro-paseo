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
 * loses is the layout height less the visual viewport's bottom edge. `layoutHeight` is the document's client height,
 * which leaves a horizontal scrollbar out as the visual viewport does. A pinch-zoomed page (`scale` above 1) shrinks
 * the visual viewport with no keyboard at all, so it reads 0 (P20 round 1); so is under 1 px, which is rounding.
 */
export function viewportInset(layoutHeight: number, visualHeight: number, visualTop: number, scale = 1): number {
  if (scale > 1.01) return 0;
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

type Measurable = { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void };
type VisualViewport = {
  height: number;
  offsetTop: number;
  scale?: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};
export type Page = {
  visualViewport?: VisualViewport;
  innerHeight?: number;
  document?: { documentElement?: { clientHeight?: number } };
};
type KeyboardNow = { height: number; screenY: number };
/** RN's Keyboard as used here; `isVisible`/`metrics` read a keyboard already up, and react-native-web has neither. */
export type KeyboardSource = {
  addListener(type: string, listener: (event: { endCoordinates: KeyboardNow }) => void): { remove(): void };
  isVisible?: () => boolean;
  metrics?: () => KeyboardNow | undefined;
};

/**
 * Watches how much of a bottom view the software keyboard covers and tells `set` (BRO-3180: the ask card); returns
 * the unsubscribe. Native: the Keyboard events, the overlap measured against the view's own bottom edge
 * (device-checks fact 4: the host insets nothing), and the keyboard's whole height when the view cannot be measured,
 * because a view over the keyboard drops the safe area it stood above. A keyboard already up when the view mounts
 * (you typed in the deck, then opened the card) is read from `metrics()`. The web: the visual viewport, which the
 * keyboard shrinks while the layout viewport stays (iOS Safari, a webview).
 */
export function watchKeyboardInset(
  env: {
    view: { current: unknown };
    platform: string;
    keyboard: KeyboardSource;
    events: { show: string; hide: string };
    page: Page | undefined;
  },
  set: (inset: number) => void,
): () => void {
  const { view, keyboard, events, page } = env;
  const visual = env.platform === "web" ? page?.visualViewport : undefined;
  if (visual && page) {
    const read = () => {
      const layout = page.document?.documentElement?.clientHeight || page.innerHeight || visual.height;
      set(viewportInset(layout, visual.height, visual.offsetTop, visual.scale ?? 1));
    };
    read();
    visual.addEventListener("resize", read);
    visual.addEventListener("scroll", read);
    return () => {
      visual.removeEventListener("resize", read);
      visual.removeEventListener("scroll", read);
    };
  }
  let live = true;
  const whole = (now: KeyboardNow) => Math.max(0, Math.round(now.height));
  const cover = (now: KeyboardNow) => {
    const target = view.current as Measurable | null;
    if (!target?.measureInWindow) return set(whole(now));
    target.measureInWindow((_x, y, _width, height) => {
      if (live) set(height > 0 ? keyboardOverlap(y + height, now.screenY) : whole(now));
    });
  };
  const up = keyboard.isVisible?.() ? keyboard.metrics?.() : undefined;
  if (up) cover(up);
  const shown = keyboard.addListener(events.show, (event) => cover(event.endCoordinates));
  const hidden = keyboard.addListener(events.hide, () => set(0));
  return () => {
    live = false;
    shown.remove();
    hidden.remove();
  };
}
