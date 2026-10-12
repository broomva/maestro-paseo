import { useEffect, useState } from "react";

/** The time now, moved on every `ms` while mounted: what a screen's ages and countdowns read. */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
