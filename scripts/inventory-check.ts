#!/usr/bin/env bun
// Checks docs/design/next/inventory.yaml: every feature reaches a page and an interface,
// every edge points at an id that exists, each store has one writer, and only the
// conductor or a lane may launch a session (A8). BRO-2994.
//
//   bun scripts/inventory-check.ts            # exit 1 on any finding
//   bun scripts/inventory-check.ts --summary  # counts per section and status

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const LAYERS = ["owner", "ui", "plugin", "conductor", "lane", "worker", "bstack", "paseo"] as const;
export const STATUSES = ["keep", "change", "new", "retire"] as const;
const PREFIX = { features: "F-", pages: "P-", components: "C-", interfaces: "I-", stores: "S-", loops: "L-" } as const;
type Section = keyof typeof PREFIX;

export interface Item {
  name: string;
  status: (typeof STATUSES)[number];
  code?: string[];
  // features
  kind?: string;
  pages?: string[];
  interfaces?: string[];
  answers?: string[];
  // pages
  frame?: string;
  png?: string;
  phone_frame?: string;
  phone_png?: string;
  components?: string[];
  reads?: string[];
  writes?: string[];
  // interfaces
  handler?: string;
  callers?: string[];
  gate?: "owner" | "agent" | "any";
  launches?: boolean;
  stores?: string[];
  // stores (owner is the layer that owns it; loops reuse owner for the layer that runs them)
  modules?: string[];
  exception?: string;
  // loops
  scheduler?: string;
  owner?: string;
  calls?: string[];
  // any section
  replaced_by?: string[];
  pen?: string | null;
  note?: string;
}

export interface Finding {
  name: string;
  severity: "blocker" | "major" | "minor";
  state: "open" | "fixed";
  about: string[];
  ticket?: string;
  code?: string[];
}

export type Inventory = { [K in Section]: Record<string, Item> } & {
  version: number;
  findings?: Record<string, Finding>;
};

export const NEED_KINDS = ["ask", "approval", "owner-step"];

// The chosen design (owner, 2026-10-09/10): J on the desktop (J6b included), M on the phone, K session
// cards, P presence, B2/B3/D4 settings. The families are exact, so a rejected variant (M1a–M1d), a
// diagram (B1, D0–D3, D5) or a reference (S, V, H, G, R, I) never passes as the design to build.
export const CHOSEN_EXPORT = /^(j\d+b?|j2-j4|m\d+|m2-m4|k[0-2]|p\d+|b[23]|d4)-[a-z0-9-]+\.png$/;
export const PHONE_EXPORT = /^(m\d+|m2-m4|p\d+)-[a-z0-9-]+\.png$/;
// Canvas frames that stay as references. A live page whose frame is one of them builds a superseded screen.
export const REFERENCE_FRAMES = new Set([
  // S series and its shell header
  "PMWAB",
  "gcul5",
  "R4srT",
  "oWMTo",
  "qzneN",
  "ukSou",
  "f6IibL",
  "DcOYb",
  "zijFm",
  "hRa0W",
  // V variations, R0 and S1r, B1
  "cDMyJ",
  "Au6C9",
  "aIqPF",
  "Qmp6D",
  "ovY0F",
  "W42jZ",
  "X1KOi",
  // H interim, G glass
  "OwTs3",
  "rXNta",
  "A4aiNd",
  "brdkh",
  "NoeRO",
  "I3mpR",
  "M4rJk",
  // M1 variations
  "WHeH4",
  "Y1W5SM",
  "FcV4R",
  "yKacZ",
  "NnyoV",
]);
export const GATES = ["owner", "agent", "any"] as const;
const FINDING_KEYS = new Set(["name", "severity", "state", "about", "ticket", "code", "note"]);

// Every key an item may carry. An unknown key is how a comma inside a YAML flow mapping shows up:
// `{ name: Button (primary, secondary), status: keep }` parses as a short name plus a stray key.
const KEYS = new Set([
  "name",
  "status",
  "code",
  "kind",
  "pages",
  "interfaces",
  "answers",
  "frame",
  "png",
  "phone_frame",
  "phone_png",
  "components",
  "reads",
  "writes",
  "handler",
  "callers",
  "gate",
  "launches",
  "stores",
  "modules",
  "exception",
  "scheduler",
  "owner",
  "calls",
  "replaced_by",
  "pen",
  "note",
]);

export function check(inv: Inventory, root: string): string[] {
  const out: string[] = [];
  const has = (s: Section, id: string) => Object.hasOwn(inv[s] ?? {}, id);
  const live = (it: Item) => it.status !== "retire";

  // Ids carry their section's prefix, statuses come from one vocabulary, cited code exists.
  for (const s of Object.keys(PREFIX) as Section[]) {
    for (const [id, it] of Object.entries(inv[s] ?? {})) {
      if (!id.startsWith(PREFIX[s])) out.push(`${id}: id in ${s} must start with ${PREFIX[s]}`);
      if (!STATUSES.includes(it.status)) out.push(`${id}: status "${it.status}" is not one of ${STATUSES.join(", ")}`);
      for (const k of Object.keys(it))
        if (!KEYS.has(k)) out.push(`${id}: unknown key "${k}" (a comma in a flow mapping?)`);
      for (const k of ["frame", "png", "phone_frame", "phone_png"] as const)
        if (k in it && (typeof it[k] !== "string" || it[k] === "")) out.push(`${id}: ${k} must be a non-empty string`);
      if ("gate" in it && !GATES.includes(it.gate as (typeof GATES)[number]))
        out.push(`${id}: gate "${it.gate}" is not one of ${GATES.join(", ")}`);
      if ("launches" in it && typeof it.launches !== "boolean") out.push(`${id}: launches must be true or false`);
      for (const c of it.code ?? []) {
        if (!existsSync(join(root, c.split(":")[0]))) out.push(`${id}: cites ${c}, which does not exist`);
      }
    }
  }

  const ref = (from: string, s: Section, ids: string[] | undefined) => {
    for (const id of ids ?? []) if (!has(s, id)) out.push(`${from}: points at ${id}, which is not in ${s}`);
  };

  // Features: a live feature is reachable (a page, or a loop that runs it) and does something (an interface).
  for (const [id, f] of Object.entries(inv.features)) {
    ref(id, "pages", f.pages);
    ref(id, "interfaces", f.interfaces);
    if (!live(f)) continue;
    const loopRuns = Object.values(inv.loops).some(
      (l) => live(l) && (l.calls ?? []).some((c) => f.interfaces?.includes(c)),
    );
    if (!f.pages?.length && !loopRuns) out.push(`${id}: no page shows it and no loop runs it`);
    if (!f.interfaces?.length) out.push(`${id}: no interface carries it`);
    for (const p of f.pages ?? [])
      if (has("pages", p) && !live(inv.pages[p])) out.push(`${id}: live feature on retired page ${p}`);
    for (const i of f.interfaces ?? [])
      if (has("interfaces", i) && !live(inv.interfaces[i])) out.push(`${id}: live feature uses retired interface ${i}`);
    if (f.kind === "need" && !NEED_KINDS.some((k) => id === `F-need-${k}`))
      out.push(`${id}: kind need is reserved for the three holds (${NEED_KINDS.join(", ")}), A1`);
  }

  // Pages: every live page belongs to a feature, has a design frame and its export, and touches no retired
  // interface. `frame: today` keeps a surface as it is, and only while a finding tracks the missing frame.
  const featured = new Set(Object.values(inv.features).flatMap((f) => f.pages ?? []));
  const tracked = new Set(Object.values(inv.findings ?? {}).flatMap((f) => f.about ?? []));
  for (const [id, p] of Object.entries(inv.pages)) {
    ref(id, "components", p.components);
    ref(id, "interfaces", p.reads);
    ref(id, "interfaces", p.writes);
    ref(id, "pages", p.replaced_by);
    if (!live(p)) continue;
    if (!featured.has(id)) out.push(`${id}: no feature lives on this page`);
    if (!p.frame) out.push(`${id}: no design frame`);
    if (p.frame === "today" && !tracked.has(id)) out.push(`${id}: frame "today" with no finding tracking it`);
    for (const i of [...(p.reads ?? []), ...(p.writes ?? [])])
      if (has("interfaces", i) && !live(inv.interfaces[i])) out.push(`${id}: uses retired interface ${i}`);
    const exp = (f: unknown) => typeof f === "string" && f !== "" && existsSync(join(root, "docs/design/next", f));
    if (p.frame === "today") {
      if (p.png || p.phone_png) out.push(`${id}: a "today" page has no design, so it carries no export`);
    } else {
      if (!p.png) out.push(`${id}: no export (png) for its frame`);
      if (typeof p.frame === "string" && REFERENCE_FRAMES.has(p.frame))
        out.push(`${id}: frame ${p.frame} is a reference, not the chosen design`);
    }
    if (typeof p.phone_frame === "string" && REFERENCE_FRAMES.has(p.phone_frame))
      out.push(`${id}: phone frame ${p.phone_frame} is a reference, not the chosen design`);
    if (typeof p.png === "string" && p.png && !exp(p.png)) out.push(`${id}: export ${p.png} is missing`);
    if (typeof p.png === "string" && p.png && !CHOSEN_EXPORT.test(p.png))
      out.push(`${id}: export ${p.png} is a reference, not the chosen design (J, M, K, P, B2, B3 or D4)`);
    if (typeof p.phone_png === "string" && p.phone_png && !exp(p.phone_png))
      out.push(`${id}: phone export ${p.phone_png} is missing`);
    if (typeof p.phone_png === "string" && p.phone_png && !PHONE_EXPORT.test(p.phone_png))
      out.push(`${id}: phone export ${p.phone_png} is not an M or P frame`);
    if (Boolean(p.phone_frame) !== Boolean(p.phone_png)) out.push(`${id}: phone_frame and phone_png come together`);
    for (const c of p.components ?? [])
      if (has("components", c) && !live(inv.components[c])) out.push(`${id}: uses retired component ${c}`);
  }

  // Components: derived usage, never stored twice. A live component no page uses is dead.
  const used = new Set(
    Object.values(inv.pages)
      .filter(live)
      .flatMap((p) => p.components ?? []),
  );
  for (const [id, c] of Object.entries(inv.components))
    if (live(c) && !used.has(id)) out.push(`${id}: no live page uses it`);

  // Interfaces: a known handler layer, someone calls it, gate verbs are the owner's, only conductor or lane launch.
  const called = new Set<string>([
    ...Object.values(inv.features)
      .filter(live)
      .flatMap((f) => f.interfaces ?? []),
    ...Object.values(inv.pages)
      .filter(live)
      .flatMap((p) => [...(p.reads ?? []), ...(p.writes ?? [])]),
    ...Object.values(inv.loops)
      .filter(live)
      .flatMap((l) => l.calls ?? []),
  ]);
  for (const [id, i] of Object.entries(inv.interfaces)) {
    ref(id, "stores", i.stores);
    if (!live(i)) continue;
    if (!LAYERS.includes(i.handler as (typeof LAYERS)[number]))
      out.push(`${id}: handler "${i.handler}" is not a layer`);
    for (const c of i.callers ?? [])
      if (!LAYERS.includes(c as (typeof LAYERS)[number])) out.push(`${id}: caller "${c}" is not a layer`);
    if (!called.has(id)) out.push(`${id}: no live feature, page or loop calls it`);
    if (i.gate === "owner" && (i.callers ?? []).some((c) => c !== "owner" && c !== "ui"))
      out.push(`${id}: an owner gate verb is callable by ${(i.callers ?? []).join(", ")}`);
    if (i.launches && i.handler !== "conductor" && i.handler !== "lane")
      out.push(`${id}: launches a session from ${i.handler}; only the conductor or a lane may (A8)`);
  }

  // Stores: one owning layer writes it, through one module. Several modules need a ticketed exception;
  // a store no interface here writes must be owned outside the plugin (fleet-reconcile, Paseo, bstack).
  for (const [id, s] of Object.entries(inv.stores)) {
    if (!live(s)) continue;
    if (!LAYERS.includes(s.owner as (typeof LAYERS)[number])) out.push(`${id}: owner "${s.owner}" is not a layer`);
    const writers = Object.entries(inv.interfaces).filter(([, i]) => live(i) && (i.stores ?? []).includes(id));
    for (const [iid, i] of writers)
      if (i.handler !== s.owner) out.push(`${id}: written by ${iid} from ${i.handler}, but ${s.owner} owns it`);
    if (writers.length === 0 && (s.owner === "plugin" || s.owner === "ui"))
      out.push(`${id}: owned by ${s.owner}, yet no live interface writes it`);
    if ((s.modules ?? []).length > 1 && !/BRO-\d+/.test(s.exception ?? ""))
      out.push(
        `${id}: ${s.modules?.length} writer modules (${s.modules?.join(", ")}); one, or an exception with a ticket`,
      );
  }

  // Findings: about real ids, cited code exists, and anything above minor carries a ticket.
  const anyId = (x: string) => (Object.keys(PREFIX) as Section[]).some((s) => has(s, x));
  for (const [id, f] of Object.entries(inv.findings ?? {})) {
    if (!id.startsWith("FND-")) out.push(`${id}: id in findings must start with FND-`);
    for (const k of Object.keys(f)) if (!FINDING_KEYS.has(k)) out.push(`${id}: unknown key "${k}"`);
    if (!["blocker", "major", "minor"].includes(f.severity)) out.push(`${id}: severity "${f.severity}" is unknown`);
    if (!["open", "fixed"].includes(f.state)) out.push(`${id}: state "${f.state}" is unknown`);
    if (!f.about?.length) out.push(`${id}: about nothing`);
    for (const a of f.about ?? []) if (!anyId(a)) out.push(`${id}: about ${a}, which is not in the inventory`);
    if (f.severity !== "minor" && !/^BRO-\d+$/.test(f.ticket ?? ""))
      out.push(`${id}: a ${f.severity} finding needs a ticket`);
    for (const c of f.code ?? [])
      if (!existsSync(join(root, c.split(":")[0]))) out.push(`${id}: cites ${c}, which does not exist`);
  }

  // Loops: a scheduler and an owner layer; only conductor or lane loops may call a launching interface.
  for (const [id, l] of Object.entries(inv.loops)) {
    ref(id, "interfaces", l.calls);
    if (!live(l)) continue;
    if (!l.scheduler) out.push(`${id}: no scheduler`);
    if (!LAYERS.includes(l.owner as (typeof LAYERS)[number])) out.push(`${id}: owner "${l.owner}" is not a layer`);
    for (const c of l.calls ?? [])
      if (has("interfaces", c) && inv.interfaces[c].launches && l.owner !== "conductor" && l.owner !== "lane")
        out.push(`${id}: a ${l.owner} loop calls ${c}, which launches a session (A8)`);
    for (const c of l.calls ?? [])
      if (has("interfaces", c) && inv.interfaces[c].gate === "owner" && l.owner !== "owner")
        out.push(`${id}: a ${l.owner} loop calls ${c}, an owner gate verb only the owner may use`);
  }
  return out;
}

// docs/design/next/view-models.md carries a per-screen table: | Page | Screens | Reads | Writes | New fields |.
// The contract and the inventory must agree on what each live page reads and writes.
export function contractDrift(inv: Inventory, markdown: string): string[] {
  const out: string[] = [];
  const rows = new Map<string, { reads: string[]; writes: string[] }>();
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (!cells[1]?.startsWith("P-")) continue;
    const ids = (c: string | undefined) => (c ?? "").match(/I-[a-z0-9-]+/g) ?? [];
    rows.set(cells[1], { reads: ids(cells[3]), writes: ids(cells[4]) });
  }
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  for (const [id, p] of Object.entries(inv.pages)) {
    if (p.status === "retire" || p.frame === "today") continue;
    const row = rows.get(id);
    if (!row) {
      out.push(`${id}: no row in view-models.md`);
      continue;
    }
    if (!same(row.reads, p.reads ?? []))
      out.push(
        `${id}: view-models.md reads ${row.reads.join(", ")}; the inventory reads ${(p.reads ?? []).join(", ")}`,
      );
    if (!same(row.writes, p.writes ?? []))
      out.push(
        `${id}: view-models.md writes ${row.writes.join(", ")}; the inventory writes ${(p.writes ?? []).join(", ")}`,
      );
  }
  for (const id of rows.keys())
    if (!Object.hasOwn(inv.pages, id)) out.push(`${id}: in view-models.md but not in the inventory`);
  return out;
}

export function load(root: string): Inventory {
  return parse(readFileSync(join(root, "docs/design/next/inventory.yaml"), "utf8")) as Inventory;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const inv = load(root);
  if (process.argv.includes("--summary")) {
    for (const s of Object.keys(PREFIX) as Section[]) {
      const by: Record<string, number> = {};
      for (const it of Object.values(inv[s] ?? {})) by[it.status] = (by[it.status] ?? 0) + 1;
      console.log(`${s.padEnd(11)} ${String(Object.keys(inv[s] ?? {}).length).padStart(3)}  ${JSON.stringify(by)}`);
    }
    const open: Record<string, number> = {};
    for (const f of Object.values(inv.findings ?? {}))
      if (f.state === "open") open[f.severity] = (open[f.severity] ?? 0) + 1;
    console.log(
      `findings    ${String(Object.keys(inv.findings ?? {}).length).padStart(3)}  open ${JSON.stringify(open)}`,
    );
  }
  const findings = [
    ...check(inv, root),
    ...contractDrift(inv, readFileSync(join(root, "docs/design/next/view-models.md"), "utf8")),
  ];
  for (const f of findings) console.log(`✗ ${f}`);
  console.log(findings.length ? `${findings.length} findings` : "inventory: clean");
  process.exit(findings.length ? 1 : 0);
}
