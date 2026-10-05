// @ts-nocheck
// A verbatim copy of tools/paseo-asks/server/ledger.ts (broomva workspace 47cc255db), the Asks
// plugin's reader and writer, which reads the same ledgers live. Only its type import is cut.
// control-home.test.ts proves an answer Maestro writes still reads as answered here.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";
type NormalizedAsk = Record<string, unknown>;

/**
 * Ledgers are git-tracked, so every worktree carries an identical copy of all 27.
 * Editing the copy inside an arbitrary worktree would land the answer on whatever
 * branch that worktree happens to be on. The canonical target is the main checkout.
 */
const ROOT_CANDIDATES = [
  process.env.PASEO_ASKS_ROOT,
  // An operator-controlled override that does NOT require a daemon restart.
  // `PASEO_ASKS_ROOT` is read from the plugin subprocess's environment, which is
  // inherited from the daemon at ITS start — so on a daemon that has been up for
  // days there is no way to set it without killing every running agent. A path
  // (or symlink) checked at call time is settable now and takes effect on the
  // next plugin reload.
  join(homedir(), ".paseo", "asks-root"),
  // Default: the main checkout. Note this is a WORKING TREE — if it sits on a
  // feature branch, these ledgers are that branch's, not main's. The override
  // above exists precisely so that is fixable without moving someone else's HEAD.
  join(homedir(), "broomva", ".control", "asks"),
].filter((p): p is string => typeof p === "string" && p.length > 0);

export function resolveRoot(): string {
  for (const candidate of ROOT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return ROOT_CANDIDATES[ROOT_CANDIDATES.length - 1] ?? "";
}

/**
 * Field aliases observed in the corpus. Order is preference order: the first key
 * present wins, and the key that won is reported so the UI can show the drift
 * rather than hide it behind a normalized label.
 */
const QUESTION_KEYS = ["ask", "question"] as const;
const DEFAULT_KEYS = ["default", "default_if_silent"] as const;
const GATE_KEYS = ["gates", "gates_lanes", "blocks"] as const;
const ANSWER_KEYS = ["answer", "answered", "resolution", "outcome", "answered_at"] as const;
const ASKED_KEYS = ["asked_at", "asked_at_hour_0"] as const;

/** Decision-layer keys. Absent on legacy asks, which still render from `question`. */
function parseOptions(raw: unknown): { id: string; label: string; consequence: string; reversible: boolean; recommended: boolean }[] {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id);
    const label = str(row.label);
    if (!id || !label) continue;
    out.push({
      id,
      label,
      consequence: str(row.consequence) ?? "",
      reversible: row.reversible === true,
      recommended: row.recommended === true,
    });
  }
  return out;
}

const KNOWN_CLASSES = new Set([
  "credential",
  "authority",
  "decision",
  "artifact",
  "scope",
  "external",
]);

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return null;
}

function strList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => str(v) ?? "").filter(Boolean);
  const single = str(value);
  return single ? [single] : [];
}

function pick(
  row: Record<string, unknown>,
  keys: readonly string[],
): { value: unknown; key: string | null } {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return { value: row[key], key };
  }
  return { value: null, key: null };
}

/**
 * `status` carries the answer state independently of the answer keys: the corpus
 * has rows with `status: resolved` and no answer text, and rows with an answer and
 * no status. Either one closes the ask.
 */
function isAnswered(row: Record<string, unknown>, answerText: string | null): boolean {
  const status = (str(row.status) ?? "").toLowerCase();
  // Every terminal status, matching scripts/ask_ledger.py. A status this side
  // treats as open and that side treats as closed is how an ask gets archived
  // twice or shown after it stopped being a question.
  if (/^(resolved|answered|closed|rerouted|withdrawn)/.test(status)) return true;
  return answerText !== null;
}

export interface LedgerRead {
  asks: NormalizedAsk[];
  problems: { ledgerFile: string; ledgerPath: string; message: string }[];
}

export function readLedgers(root: string): LedgerRead {
  const asks: NormalizedAsk[] = [];
  const problems: LedgerRead["problems"] = [];
  if (!existsSync(root)) {
    return { asks, problems: [{ ledgerFile: "", ledgerPath: root, message: `no ledger directory at ${root}` }] };
  }

  for (const file of readdirSync(root).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()) {
    const path = join(root, file);
    let doc: Document.Parsed;
    try {
      doc = parseDocument(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push({ ledgerFile: file, ledgerPath: path, message: String(error) });
      continue;
    }
    // A ledger with a YAML syntax error still gets a row. One file in the corpus
    // (bro-2460) is unparseable; dropping it silently would hide a real open ask.
    if (doc.errors.length > 0) {
      problems.push({ ledgerFile: file, ledgerPath: path, message: doc.errors[0].message });
      continue;
    }

    const data = doc.toJS() as Record<string, unknown> | null;
    if (!data || typeof data !== "object") {
      problems.push({ ledgerFile: file, ledgerPath: path, message: "top level is not a mapping" });
      continue;
    }

    const arc = str(data.arc) ?? file.replace(/\.ya?ml$/, "");
    const ticket = str(data.ticket) ?? str(data.tickets);
    // `open_asks` is a second spelling in the corpus. A ledger using it would be
    // read as empty rather than as an error — absence is the resting state here,
    // so a silently-skipped ledger looks exactly like a ledger with nothing in it.
    const rows = Array.isArray(data.asks)
      ? data.asks
      : Array.isArray(data.open_asks)
        ? data.open_asks
        : [];

    for (const raw of rows) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const aliases: Record<string, string> = {};

      const question = pick(row, QUESTION_KEYS);
      if (question.key) aliases.question = question.key;
      const fallback = pick(row, DEFAULT_KEYS);
      if (fallback.key) aliases.fallback = fallback.key;
      const gates = pick(row, GATE_KEYS);
      if (gates.key) aliases.gates = gates.key;
      const answer = pick(row, ANSWER_KEYS);
      if (answer.key) aliases.answer = answer.key;
      const asked = pick(row, ASKED_KEYS);
      if (asked.key) aliases.askedAt = asked.key;

      const answerText = str(answer.value);
      const archivedAt = str(row.archived_at);
      const statusText = (str(row.status) ?? "").toLowerCase();
      const rawClass = (str(row.class) ?? "").toLowerCase();
      const originRow = (row.origin && typeof row.origin === "object" ? row.origin : {}) as Record<string, unknown>;
      const parsedOptions = parseOptions(row.options);
      // An untagged ask still needs a project, or it drops out of every
      // project facet and becomes unfindable by the one filter most likely
      // to be used. The arc is the best available answer and is usually right.
      const project = str(row.project) ?? arc.split(/[^a-z0-9-]/i)[0].toLowerCase();
      const topics = strList(row.topics).map((t) => t.toLowerCase());
      const headline = str(row.headline);
      const stakes = str(row.stakes);
      const whyYou = str(row.why_you) ?? str(row.whyYou);
      const searchText = [
        headline, stakes, whyYou, str(question.value), arc, ticket, project,
        ...topics,
        ...parsedOptions.flatMap((o) => [o.label, o.consequence]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      asks.push({
        ledgerFile: file,
        ledgerPath: path,
        arc,
        ticket,
        id: str(row.id) ?? `${file}#${asks.length}`,
        headline,
        stakes,
        whyYou,
        options: parsedOptions,
        project,
        topics,
        searchText,
        question: str(question.value) ?? "(no question text in the ledger)",
        askClass: (KNOWN_CLASSES.has(rawClass) ? rawClass : "unknown") as NormalizedAsk["askClass"],
        gates: strList(gates.value),
        fallback: str(fallback.value),
        blocking: row.blocking === true,
        exhausted: strList(row.exhausted),
        askedAt: str(asked.value),
        answeredAt: str(row.answered_at),
        answerText,
        state: archivedAt || statusText.startsWith("archived") ? "archived"
          : isAnswered(row, answerText) ? "answered" : "open",
        archivedReason: str(row.archived_reason),
        // A person is needed when silence is unsafe, or when the thing the agent
        // would do cannot be undone. Everything else proceeds and is FYI.
        urgency:
          row.blocking === true || parsedOptions.some((o) => o.recommended && !o.reversible)
            ? "decide"
            : "default",
        origin: {
          // A top-level `session:` predates the per-ask origin stamp; keep reading it.
          agentId: str(originRow.agent_id) ?? str(originRow.agentId),
          provider: str(originRow.provider),
          cwd: str(originRow.cwd),
          session: str(originRow.session) ?? str(data.session),
        },
        aliases,
      });
    }
  }

  return { asks, problems };
}

/**
 * Write the answer into the ledger with surgical, offset-based edits.
 *
 * The obvious implementation — mutate the Document and re-serialize — was tried
 * first and rejected by its own smoke test: re-emitting reflows every folded
 * scalar and flow sequence in the file, so a three-line answer produced a diff of
 * 67 added / 65 removed lines. These ledgers are git-tracked, so that diff is the
 * artifact a human has to review. Editing only the byte ranges that change keeps
 * the rest of the file identical.
 */
/**
 * The column a key actually sits at, not the whitespace before it. An ask is a
 * sequence item, so its first key is preceded by `  - `. Matching a leading-
 * whitespace pattern there returns two spaces, so every appended key lands
 * under-indented and breaks the file. The column is right in both shapes.
 */
function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return " ".repeat(offset - lineStart);
}

/** Render a value as a YAML scalar: block literal when multi-line, JSON-quoted otherwise. */
function renderScalar(value: string, indent: string): string {
  if (!value.includes("\n")) return JSON.stringify(value);
  const body = value
    .split("\n")
    .map((line) => (line.length > 0 ? `${indent}  ${line}` : ""))
    .join("\n");
  return `|-\n${body}`;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  /** Build order, used to break ties between inserts at the same offset. */
  seq: number;
}

function upsertKey(
  source: string,
  map: YAMLMap,
  key: string,
  value: string,
  indent: string,
  seq: number,
): Edit {
  for (const pair of map.items) {
    const pairKey = pair.key as { value?: unknown } | null;
    if (!pairKey || String(pairKey.value ?? "") !== key) continue;
    const node = pair.value as { range?: [number, number, number] } | null;
    if (node?.range) {
      // Replace just this value's span; the key, its indent and everything
      // around it stay byte-identical.
      return { start: node.range[0], end: node.range[1], text: renderScalar(value, indent), seq };
    }
  }
  // Not present: append directly after the map's last line of content. A block
  // scalar's range runs past the blank line that follows it, so anchoring on the
  // last value and scanning forward for a newline lands OUTSIDE the map and
  // corrupts the file. Walking back from the map's end to the last non-space
  // character is correct for both block and plain scalars.
  let at = map.range?.[1] ?? source.length;
  while (at > 0 && /\s/.test(source[at - 1])) at--;
  return { start: at, end: at, text: `\n${indent}${key}: ${renderScalar(value, indent)}`, seq };
}

export function writeAnswer(
  ledgerPath: string,
  askId: string,
  answer: string,
  now = new Date(),
): void {
  const source = readFileSync(ledgerPath, "utf8");
  const doc = parseDocument(source);
  if (doc.errors.length > 0) throw new Error(`ledger has a YAML error: ${doc.errors[0].message}`);

  const asks = doc.get("asks", true);
  if (!isSeq(asks)) throw new Error("ledger has no `asks` sequence");

  let target: YAMLMap | null = null;
  for (const item of asks.items) {
    if (isMap(item) && String(item.get("id") ?? "") === askId) {
      target = item;
      break;
    }
  }
  if (!target) throw new Error(`no ask '${askId}' in ${ledgerPath}`);

  const firstKey = target.items[0]?.key as { range?: [number, number, number] } | null;
  const indent = firstKey?.range ? indentOf(source, firstKey.range[0]) : "    ";

  // Respect the row's existing answer key when it has one; rewriting `resolution:`
  // into `answer:` would be an unrequested schema migration of someone else's ledger.
  const existingKey = ANSWER_KEYS.find((k) => k !== "answered_at" && target.has(k));
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const edits: Edit[] = [
    upsertKey(source, target, existingKey ?? "answer", answer, indent, 0),
    upsertKey(source, target, "answered_at", stamp, indent, 1),
    upsertKey(source, target, "status", "resolved", indent, 2),
  ];

  // Apply back-to-front so earlier offsets stay valid. Inserts that share an
  // offset must go highest-seq first: each later insert pushes the earlier ones
  // right, so applying in reverse build order leaves them in build order.
  const applied = [...edits].sort((a, b) => b.start - a.start || b.seq - a.seq);
  let out = source;
  for (const edit of applied) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  writeFileSync(ledgerPath, out, "utf8");
}
