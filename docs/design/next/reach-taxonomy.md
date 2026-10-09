# How agent sessions reach the owner: a measured taxonomy (BRO-2980)

Agent-read research note. Machine-readable twin: `reach-taxonomy.json` (same numbers, plus per-cluster reply breakdowns).
Question tested: do four kinds (**Ask**, **Approval**, **Owner step**, **Notice**) cover every way a session on this Mac tries to reach Carlos or waits on him?

**Short answer:** the four kinds hold for single items, with four changes:
1. The dominant volume isn't any of the four. It is a fifth bucket, **should-never-reach-owner**: offers to continue, rename asks, and gate-handled calls.
2. **Notice** needs two sub-kinds, *Finished* and *Health*.
3. The line between **Owner step** and **Approval** should follow who carries out the action, not what kind of action it is.
4. Two shapes don't fit at all. **Bundles** are lists that mix kinds and must be split into items. **Proposals** are park-or-build ideas, almost never answered, and should not sit in "Needs you".

## Method and sample sizes

| Source | What was read | Size |
|---|---|---|
| Claude Code transcripts | every top-level `~/.claude/projects/*/*.jsonl` modified in the last 30 days, streamed in full (no sampling); subagent files excluded | 1,522 sessions; activity 2026-08-26 to 2026-10-09 |
| → excluded | synthetic (eval/probe cwd under `/tmp`, `/var/folders`) 484; automation (CI-runner triage, headless scorer/probe one-shots) 359 | |
| → analysed | Paseo sessions the owner started: 293 · Paseo sessions spawned by an agent: 221 · non-Paseo interactive sessions: 164 | 678 sessions, 11,232 turn-ends ("stops") |
| Ask ledgers | `~/broomva/.control/asks` (55 files), `~/.local/state/fleet-reconcile/*/.control/asks` (31), SRI `.control/asks` (8) | 250 asks |
| Maestro | `~/maestro/**/_events.jsonl`, `~/.local/state/maestro-paseo/asks.jsonl` | 109 work items (2026-09-29 to 10-09); 217 receipts (10-05 to 10-09) |
| Paseo / ctx | `~/.paseo/agents/*/*.json`; `~/.local/state/ctx/{broomva,sri}/events.jsonl` | 575 agent records; 2,422 ctx `session.stop` events (from 2026-09-29) |
| Bridged logs | `docs/conversations/`, used only to check coverage | 576 recent logs; 339 have no local transcript, and 322 of those are VPS sessions, which are **out of scope** |

**Definitions**
- **Owner prompt:** a human-origin user record. It is not a task notification, peer message, scheduled or meta prompt, and it does not match a prompt another agent sent through `paseo send_agent_prompt` or `create_agent`.
- **Stop:** the last assistant message before the next input. **Latency** runs from that message to the next owner prompt. That is agent idle time, not owner effort.
- **Blocked share:** the share of stops where the next input was the owner (or nothing). The other possibility is that a notification, tick or peer woke the agent first.
- **Prose clusters** are regex classifiers on the final message. Spot checks found false positives in *continue-offer*, *decision-section* and *owner-step*: status lines with "if you want", and lists that mix kinds. Choice and approval questions were mostly correct. Treat prose counts as upper bounds.

## Cluster table

Medians are in minutes. "By construction" means the mechanism blocks by definition; it was not measured.

| # | Cluster | Channel | Trigger | Count (window) | Blocked | Median latency | Maestro kind | Recommendation |
|---|---|---|---|---|---|---|---|---|
| 1 | **Status stop → owner sends next instruction** | final message with no question; Paseo `finished` attention (165 agents) | turn ended | 3,086 stops in 296 sessions (27.5% of stops) | 100% | 5.3 (p75 16.3) | **Notice / Finished** | Show "finished + the planned next step"; auto-dispatch it when the message names one. |
| 2 | **AskUserQuestion** | native picker, which Paseo renders as a permission sheet | choice, approval or owner action | 814 calls (1,341 questions), 102 sessions | by construction | 8.2 (p75 27.1); Maestro-mediated 5.5 | Ask 481 · Approval 247 · Owner step 86 | Keep as the Ask transport. Owner picked the "(Recommended)" option in 64.4% of parsed answers (approval-type 68.6%), so take a reversible recommendation by default and send a Notice. |
| 3 | **Offer to continue** ("Want me to…", "Should I…", "say the word") | final-message prose | agent hands back a reversible next step | 959 stops, 274 sessions | 69.7% | 11.7 (p75 56.4) | **should-never-reach-owner** | Preauthorize: PR, ticket, commit and push. The prior measurement found 86 PR/commit asks and none refused. |
| 4 | **Handback / decision section** ("Decisions for you", "Blocked on you", "Waiting on you") | final-message list | agent batches items | 901 stops, 100 sessions (758 in client sessions) | 37.0% | 5.9 | **Bundle** (mixed kinds): split it | One item per row, each with its own kind. A message is not a reach unit. |
| 5 | **Owner step in prose** | final-message prose: `/mcp`, `/login`, "needs you to log in", reload, Accessibility, paste config | something only the owner can do | 618 stops, 159 sessions | 66.7% | 7.5 | **Owner step** | One-click deep link plus a stated fallback. Dedupe across sessions; Linear sign-in recurs fleet-wide. |
| 6 | **Session death** | ctx `session.died`; the owner then types `/resume` (222), `/mcp` (46), `/login` (9) | rate limit 262 · auth failed 104 · OAuth org not allowed 17 · other 7 | 390 events (from 09-29) | by construction | n/a | rate limit → **Notice / Health**; auth → **Owner step** | Auto-resume after the rate-limit window. Raise one fleet-wide re-auth Owner step, not one per dead session. |
| 7 | **Choice question in prose** | final-message question with alternatives | real direction choice | 310 stops, 146 sessions | 79.0% | 11.3 (p75 64.0) | **Ask** | Move to AskUserQuestion or the ledger with a default; it blocks most often of all prose clusters. |
| 8 | **Ask ledger entry** | `.control/asks/*.yaml` → Maestro "Needs you" → `answered_by: owner:maestro` | arc-level human dependency, autonomy ladder exhausted | 250 asks; 201 answered (158 via Maestro) | 1.6% (`blocking: true`, 4 of 250) | 131 (workspace, `asked_at`, n=52); 204 (fleet-reconcile, `opened`, n=85) | Ask 91 · Approval 73 · Owner step 54 · Proposal 23 · never 9 | Right shape (default + options + ladder). Make it the single sink for Ask, Approval and Owner step. |
| 9 | **Tool permission prompt** | Claude Code permission prompt; Maestro `permission.asked` | tool call not covered by mode or rules | 196 transcript decisions (51 "always allow", 70 rejected, 75 cancelled); Maestro 25 (20 resolved, 5 never) | by construction | 0.5 (Maestro) | **Approval** | Rare: 500 of 575 Paseo agents run `bypassPermissions`. Auto-allow reads; keep Approval for writes. |
| 10 | **Gate-handled tool calls** | auto-mode classifier, settings deny rules, control-gate hook | policy matched first | 573 (classifier accept 291, deny 9; deny rule 70; control-gate blocks 203) | not blocked | n/a | **should-never-reach-owner** | Audit log only; escalate only when the agent can't reroute. |
| 11 | **Approval question in prose** | final-message question about merge, deploy, send or delete | exact external or irreversible action | 187 stops, 83 sessions (merge 37, PR/commit/push 15, other 135) | 51.3% | 4.4 | **Approval** | Approval carrying the exact command. Move PR/commit/push into preauth. |
| 12 | **ARC-STATUS end line** | ctx `session.stop` `arc_line` | session closing its arc | 182 lines: HANDBACK 66 · CLOSED 76 · DONE 18 · BLOCKED 7 · IN-PROGRESS 7 · MERGED 5 · REQUIRE_HUMAN 2 · COMPLETE 1 | n/a | n/a | Notice (CLOSED, DONE, MERGED) · Bundle (HANDBACK, BLOCKED) · Approval (REQUIRE_HUMAN) | Emit a typed status (kind + item ids) so Maestro doesn't parse prose. |
| 13 | **Rename-session ask** | prose + ledger | agent wants a canonical name | 95 stops (50 sessions) + 9 ledger asks | 55.8% | 30.0 (p75 152) | **should-never-reach-owner** | Drop. The owner said stop asking on 2026-10-06; Paseo should own titles. |
| 14 | **Peer escalation** | cross-session `SendMessage`, Paseo prompt to coordinator | worker blocked; coordinator relays to owner | 73 of 518 peer messages (39 client) | n/a | n/a | **should-never-reach-owner directly** | Workers write ledger entries, the coordinator dedupes, Maestro shows one item. |
| 15 | **Maestro review gate** | Maestro gate verdict | work item reached review | 26 verdicts (approve 21, block 4, revise 1); 26 moves to `blocked` | n/a | n/a | **Approval** | Keep. Feed REQUIRE_HUMAN merges into it. |
| 16 | **Control-surface write block** | `check-file-write-safety` hook → later "apply the policy patch / add these hooks" asks | agent may not edit `policy.yaml` or `settings.json` | 24 blocks | n/a | n/a | today **Owner step**; should be **Approval with an owner-identity executor** | Show the exact diff; one tap applies it. |
| 17 | **Idea triage** | ledger `class: idea` ("…, or park it?") | research or /checkit follow-ups | 23 asks, 2 answered | 0% | 1,133 (n=2) | **new kind: Proposal** | Keep out of "Needs you". Weekly digest; park is the default. |
| 18 | **Maestro loop flag** | `loop.flagged` | quiet, "yours", failed | 11 (quiet 8, yours 2, failed 1) | n/a | n/a | **Notice / Health** | A "yours" flag is an Ask in disguise; link it to the item. |
| 19 | **Dormant channels** | ExitPlanMode (0), PushNotification (2), Stop-hook block (5 inputs, all probes; 0 arc-continuation or handback blocks recorded across 4 arc files in window) | — | ~0 | — | — | n/a | Don't design around them. |

**Examples** (redacted; client items paraphrased):
1. "`db974c5` has #757's first Codex review round running. It has frozen its tree…" · "main is green on all four repos; the skills re-run passed."
2. "Pencil isn't running: Pen.app is installed but closed… How should I proceed?" · "PR #662 hit a P20 stop (6→4). The session recommends splitting…"
3. "Want me to open the PR for the 5 entities, and file BRO tickets…?" · "Want me to land it?" · "Say the word and I'll open a Linear ticket for #1."
4. "Run this, or press Merge on the PR: `gh pr merge 933 … --match-head-commit <sha>`" · "Waiting on you: Sign Linear back in with `/mcp` … Merge sri#1857 after updating its branch."
5. "`broomva handoff push` needs you to log in (`broomva auth login`)." · "parked until Chrome's Interceptor extension is reloaded. That needs you to unlock the Mac…"
6. `session.died error=authentication_failed` → owner types `/resume`.
7. "Scope: all 20 primitives, or start with the 5 that already have control-layer references…?" · "Which do you want next?"
8. "Merge PR 718 now, or leave it open?" · "Refill Codex credits so cross-vendor review (Strata A) works again?" · "Name the workspace app now, or keep the working name skene…?"
9. Maestro "Run a command": `cat ~/.claude/projects/…/memory/<note>.md` · rejected: `Agent "P20 … Stratum C"`.
10. classifier `[Merge Without Review]` · `[control-gate] BLOCKED … rm -rf on / or home`.
11. "Decision for you: should I merge?" · "Should I send it?" · "Remove arcan-old's stale Vercel project?"
12. "ARC-STATUS: REQUIRE_HUMAN on #851. It is green and CLEAN with P20 PASS. Next: you merge #851" · "ARC-STATUS: BLOCKED #842 awaits your merge after P20 STOP"
13. "Rename this session to serene-puma-holon-acp?"
14. (client) "blocker: no machine credential can read Sentry or PostHog; it needs a human"
16. "Apply the v4 policy patch, which human-merges every other file a hook executes?" · "Turn on automatic memory commits by adding two hooks to your settings?"
17. "Build a voxel-world eval harness … on Craftium, or park it?"

## The owner's side

- **Volume:** 5,604 owner prompts in 580 sessions. 66% of those sessions (383) had at least one reaching stop. 27.4% of all stops reached for the owner, and 1,649 of those reaches got an owner reply.
- **Approvals typed by hand are rare as bare words:** 60 bare approvals, 1.1% of non-interrupt prompts. The most common were "go" (19), "continue" (14) and "do it" (11). Counting prompts that *lead* with an approval token ("merge, go", "go /autonomous") gives 228 (4.2%). After a reaching stop, 143 of 1,649 replies (8.7%) were approval-led. 77 of those followed a continue-offer, which is the clearest automate-away signal.
- **Nudges and restarts:** 156 nudge prompts (2.9%) in 114 sessions ("Is the arc finished? Is it all merged and updated?", "continue please"). `/resume` was typed 222 times in 106 sessions, mostly after session deaths, plus 209 interrupts. Continuation slash commands (`/resume`, `/arc`, `/loop`, `/autonomous`) totalled 285.
- **Owner steps executed in chat:** `/mcp` 46 and `/login` 9 typed by hand.

## Ranking by owner time cost

Proxy: owner turns consumed, then agent idle hours. Idle hours are the sum of per-stop latency, each capped at 24 h.

1. **Status stops → next instruction:** 3,086 owner turns, 2,821 idle h. Not a reach, but the biggest cost; the queue empties only when the owner types.
2. **AskUserQuestion:** 814 calls, 1,341 questions, median 8.2 min each.
3. **Offer to continue:** 603 owner turns, 1,088 idle h. Pure waste by policy.
4. **Owner step in prose + session deaths:** 370 turns and 380 idle h, plus 390 deaths with 222 `/resume`, 46 `/mcp` and 9 `/login`.
5. **Decision sections:** 303 turns. They are concentrated in the client orchestrator, which writes a decision table every tick.
6. **Choice in prose:** 236 turns, 556 idle h. The longest tail (p75 64 min).
7. **Ledger asks:** 201 answered (158 via Maestro). Slow but deliberate: 131 min median (workspace); 193 min for Ask, 409 for Approval and 540 for Owner step (fleet-reconcile, `opened`-based).
8. **Tool permissions:** 196 plus 25 via Maestro.
9. **Approval in prose:** 86 turns.
10. **Rename asks:** 43 turns plus 9 ledger asks.

## What should be automated away

- **Continue offers** (959) and **PR/commit/push offers** (15 in the approval cluster): preauthorize them. They are reversible.
- **Rename asks** (104): delete the behaviour.
- **Gate-handled calls** (573): already silent; keep them out of Maestro except as an audit trail.
- **Rate-limit deaths** (262): auto-resume at window reset. **Auth deaths** (121 auth_failed + oauth_org_not_allowed): one fleet-level Owner step, not N `/resume`s.
- **AskUserQuestion with a reversible recommended option**: take the default, post a Notice, and allow undo. 64.4% of answers already picked it.
- **Peer escalations** (73): straight to the ledger, deduped.
- **Proposals** (23, 9% answered): weekly digest, not "Needs you".
- **Control-surface edits** (24 blocks, plus the related ledger asks): convert copy-paste Owner steps into one-tap Approvals with an executor.

## Kind model, revised

| Kind | Keep / change | Evidence |
|---|---|---|
| **Ask** | keep; must carry options + default | choice prose 310 · AUQ choice 481 · ledger 91 |
| **Approval** | keep; = an exact action with a fixed option set {approve, revise, block}; includes "owner-executed" control-surface edits once Maestro can execute them | AUQ approvals 247 (approval-type questions picked the recommended option 68.6%) · Maestro gate 26 · prose 187 · ledger 73 |
| **Owner step** | keep, narrowed to *physical* owner-only acts: OAuth browser flow, credits, macOS permission, Mac restart, 2FA | prose 618 · auth deaths 121 · ledger 54 · AUQ 86 |
| **Notice** | split into **Finished** (turn ended; 3,086 follow-ups, 165 Paseo "finished" flags) and **Health** (deaths, quiet, failed). A Health item with an owner-only fix is promoted to Owner step. | |
| **Proposal** (new) | non-blocking park-or-build; default park; digest | 23 ideas, 2 answered |
| **Bundle** (not a kind; a transport) | split into items before display | decision sections 901 · HANDBACK 66 · BLOCKED 7 |
| **should-never-reach-owner** | first-class rejection reason, so Maestro can count leaks | continue offers 959 · rename 104 · gate 573 · peer 73 |

Things that fit none of the four:
- **Bundles**, which mix kinds.
- **Proposals**.
- **Owner-initiated steering**: interrupts 209, nudges 156, `/resume` 222. These aren't agent reaches; they are evidence of a missing reach or a stall. Maestro's `loop.flagged quiet` is the right detector.
- **Approvals that only the owner can execute**: policy patches, redeploys behind 2FA. Today they look like Owner steps.

## Open questions

- **Attribution:** prompts a coordinator injects outside the Paseo MCP tools (Maestro answer routing, schedules that show up as `sdk`) are counted as owner prompts. A Paseo-side author field would settle it.
- **Permission latency:** the permission-prompt latency inside Claude Code isn't recorded (only the decision is). The 0.5 min median comes from 20 Maestro events only.
- **Handback contract:** arc-continuation and handback Stop-hook blocks leave no transcript trace, and arc state files show 0 blocks in the window. Is the contract firing, or is it silent?
- **Window coverage:** the ctx board and Maestro cover only about 10 days, so their counts aren't comparable with the 30-day transcript counts.
- **Client policy:** client (SRI) sessions produce 758 of 901 decision-section stops. Should client orchestrator ticks have their own "Needs you" policy?
- **Out of scope:** VPS sessions (322 bridged logs) aren't covered here.

## Reproduce

The scripts live only in a temporary `mktemp -d` scratch dir (`scan.py`, `analyze.py`, `asks.py`, `build.py`). They aren't committed, and the OS will clear them. The method is above:
- stream top-level transcripts;
- classify user records by `origin` / `turnOrigin` / `promptSource`;
- classify final messages with regexes;
- join to Paseo agent labels via `persistence.sessionId`;
- parse ledgers with PyYAML.

Every figure here is in `reach-taxonomy.json`.
