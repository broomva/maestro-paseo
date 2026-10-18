import { z } from "zod";

export const VIEWS = ["feed", "decisions", "work", "health", "initiatives"] as const;
export type View = (typeof VIEWS)[number];
const Text = z.string();
export const SnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  source: z.enum(["live", "sample", "unavailable"]),
  readOnly: z.boolean(),
  capabilities: z.object({ answerAsks: z.boolean() }).default({ answerAsks: false }),
  errors: z.record(z.string(), Text),
  needs: z
    .object({
      total: z.number().int().nonnegative(),
      rows: z.array(
        z.object({
          key: Text,
          title: Text,
          kind: Text,
          scope: Text,
          since: Text,
          target: z
            .object({ kind: z.enum(["ask", "work", "initiative"]), id: Text })
            .nullable()
            .default(null),
        }),
      ),
    })
    .nullable(),
  work: z
    .array(
      z.object({
        id: Text,
        title: Text,
        state: Text,
        group: Text,
        scope: Text,
        ticket: Text.nullable(),
        provider: Text.nullable(),
        reason: Text.nullable(),
        updatedAt: Text,
        checks: z.array(z.object({ name: Text, run: Text })),
      }),
    )
    .nullable(),
  asks: z
    .array(
      z.object({
        key: Text,
        hash: Text,
        id: Text,
        ledger: Text,
        title: Text,
        question: Text.nullable(),
        stakes: Text.nullable(),
        whyYou: Text.nullable(),
        fallback: Text.nullable(),
        blocking: z.boolean(),
        waiting: z.boolean(),
        askedAt: Text.nullable(),
        state: Text,
        refusal: Text.nullable(),
        options: z.array(
          z.object({
            id: Text,
            label: Text,
            consequence: Text.nullable(),
            recommended: z.boolean(),
            reversible: z.boolean().nullable(),
          }),
        ),
        summary: Text.nullable(),
        details: Text.nullable(),
        sources: z.array(z.object({ label: Text, ref: Text })),
      }),
    )
    .nullable(),
  answers: z.object({ waitingToLand: z.number(), routed: z.number(), acted: z.number(), held: z.number() }).nullable(),
  notices: z.array(z.object({ key: Text, title: Text, scope: Text, detail: Text, kind: Text })).nullable(),
  fleet: z
    .array(
      z.object({
        id: Text,
        health: Text,
        reason: Text,
        mode: Text.nullable(),
        dryRun: z.boolean().nullable(),
        lastTick: Text.nullable(),
        openAsks: z.number(),
      }),
    )
    .nullable(),
  loops: z
    .array(
      z.object({
        id: Text,
        title: Text,
        scope: Text,
        cadence: Text.nullable(),
        status: Text,
        detail: Text,
        drift: z.array(Text),
      }),
    )
    .nullable(),
  initiatives: z
    .array(
      z.object({
        id: Text,
        title: Text,
        summary: Text.nullable(),
        status: Text.nullable(),
        reviewBy: Text.nullable(),
        due: z.boolean(),
        nextAction: Text.nullable(),
      }),
    )
    .nullable(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export function unavailable(reason: string): Snapshot {
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    source: "unavailable",
    readOnly: true,
    capabilities: { answerAsks: false },
    errors: { connection: reason },
    needs: null,
    work: null,
    asks: null,
    answers: null,
    notices: null,
    fleet: null,
    loops: null,
    initiatives: null,
  };
}

export function askKey(ask: {
  home: { kind: string; path?: string };
  scope?: string | null;
  ledger: string;
  uid: string | null;
  id: string;
}): string {
  return JSON.stringify([ask.scope ?? null, ask.home.kind, ask.home.path ?? null, ask.ledger, ask.uid, ask.id]);
}
