// Turns a provider permission request into a question a person can answer at
// a glance. Providers send the tool name ("Write", "Bash") as the only label;
// the useful part is in the input: the file, the command, the URL.

import { isAbsolute, relative } from "node:path";

export interface PermissionLike {
  name: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
}

const VERBS: Record<string, string> = {
  write: "Write a file",
  edit: "Edit a file",
  multiedit: "Edit a file",
  notebookedit: "Edit a notebook",
  bash: "Run a command",
  shell: "Run a command",
  exec: "Run a command",
  webfetch: "Fetch a page",
  websearch: "Search the web",
  read: "Read a file",
};

function field(input: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function shortPath(path: string, cwd: string | null): string {
  if (!cwd || !isAbsolute(path)) return path;
  const within = relative(cwd, path);
  if (within && !within.startsWith("..") && !isAbsolute(within)) return within;
  // macOS resolves /tmp to /private/tmp; compare without that prefix too.
  const strip = (p: string) => p.replace(/^\/private(?=\/)/, "");
  const again = relative(strip(cwd), strip(path));
  return again && !again.startsWith("..") && !isAbsolute(again) ? again : path;
}

export function describePermission(
  request: PermissionLike,
  cwd: string | null,
): { title: string; detail: string | null } {
  const title = request.title?.trim() || VERBS[request.name.toLowerCase()] || request.name;
  if (request.description?.trim()) return { title, detail: request.description.trim() };
  const command = field(request.input, "command", "cmd");
  if (command) return { title, detail: command.length > 200 ? `${command.slice(0, 199)}…` : command };
  const path = field(request.input, "file_path", "path", "notebook_path");
  if (path) return { title, detail: shortPath(path, cwd) };
  return { title, detail: field(request.input, "url", "query") };
}
