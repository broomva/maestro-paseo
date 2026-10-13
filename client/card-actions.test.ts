// Open in Maestro (K0 step 4, BRO-3008): where each action on a card goes, with a fake `openScreen`.

import { describe, expect, test } from "bun:test";
import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";
import { GateCardSchema, legacyCard } from "../shared/card";
import { cardActions } from "./card-actions";
import type { MaestroIntent } from "./intent";

// A Paseo agent id, not a Claude session id and not a work id.
const AGENT = "6f1c2e0a-93b4-4d7e-8a15-2c9d0b7e41aa";

function actions() {
  const opened: PluginOpenScreenInput[] = [];
  const intents: MaestroIntent[] = [];
  return {
    opened,
    intents,
    ...cardActions({ openScreen: (input) => void opened.push(input) }, (intent) => void intents.push(intent)),
  };
}

describe("a card's actions", () => {
  test("Open in Maestro for a session is openScreen on the session screen with that agent id as a param (K2)", () => {
    const made = actions();
    made.session(AGENT);
    expect(made.opened).toEqual([{ screenId: "session", params: { agentId: AGENT } }]);
  });

  test("a hold with no session opens its inspector on the Feed, by key, as a push does (M10)", () => {
    const made = actions();
    made.hold('ask:["origin/main","bro-3001.yaml",null,"A1"]');
    expect(made.opened).toEqual([
      { screenId: "maestro", params: { hold: 'ask:["origin/main","bro-3001.yaml",null,"A1"]' } },
    ]);
  });

  test("Maestro's home opens with no params, and a verb that sends you somewhere goes through the intent bus", () => {
    const made = actions();
    made.maestro();
    made.intent({ kind: "decisions" });
    expect(made.opened).toEqual([{ screenId: "maestro" }]);
    expect(made.intents).toEqual([{ kind: "decisions" }]);
  });
});

describe("the card of an earlier build", () => {
  test("a maestro-gate row reads as the finished card for its landing, in the work's own key", () => {
    const data = GateCardSchema.parse({ workId: "w-ledger", landing: 3, agentId: AGENT });
    expect(legacyCard(data)).toEqual({ kind: "finished", key: "work:w-ledger", version: "3" });
  });

  test("one written before landings were recorded has none: it reads as old, never as current", () => {
    expect(legacyCard(GateCardSchema.parse({ workId: "w-ledger" }))).toEqual({
      kind: "finished",
      key: "work:w-ledger",
      version: "",
    });
  });
});
