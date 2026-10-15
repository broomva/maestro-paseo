# BRO-3001 dogfood receipts

Sandbox: `scripts/dogfood/up.ts` (seeded work in every state), plus a control repo at the sandbox's
`~/broomva` with a bare origin. It holds three asks: Q1 blocks, Q2 recommends what cannot be undone, Q3 is
calm. It also holds an initiative whose review date passed, the answers batch waiting on PR #915, and a
queued item held for you. The plugin was reloaded on the sandbox daemon only.

| File | What it shows |
|---|---|
| `needs-list-before.json` | `needs.list` over RPC: 7 holds (2 approvals, 2 owner steps, 3 asks). The stuck items, the running and queued work, and the calm ask are not in it |
| `feed-before-7.png` | The same 7 in the subtitle ("7 need you"), on the Feed tab, and in the Needs you section. Decisions shows 3 and Initiatives 1. Stuck work is under Stuck and the calm ask under Decide |
| `header-before-7.png` | Paseo's own workspace header button: "7 need you" |
| `feed-after-answer-6.png` | After answering Q1 in Decisions: the subtitle, the Feed tab and Needs you all say 6, and Decisions 2 |
| `header-after-6.png` | The header button: "6 need you" |
| `phone-after-6.png` | The phone: "6 need you" |
| `needs-list-after.json` | `needs.list` after the answer: 6 |
