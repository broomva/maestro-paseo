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
