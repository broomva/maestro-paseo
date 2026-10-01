// Small, pure formatting helpers for the surfaces.

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The same age as `ago`, in words a screen reader can say. */
export function agoWords(iso: string | null, now = Date.now()): string {
  const short = ago(iso, now);
  if (!short) return "";
  if (short === "now") return "updated just now";
  const n = Number.parseInt(short, 10);
  const unit = short.endsWith("m") ? "minute" : short.endsWith("h") ? "hour" : "day";
  return `updated ${plural(n, unit)} ago`;
}

export function duration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "0m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The handler's own sentence, without the RPC transport's wrapping. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const clean = raw
    .replace(/^Request failed:\s*/, "")
    .replace(/\s+requestType=\S+(\s+code=\S+)?\s*$/, "")
    .trim();
  return clean || "Something went wrong.";
}

/** A file size a person reads: "812 B", "1.2 KB", "3.4 MB". */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
