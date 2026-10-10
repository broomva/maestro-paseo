// CI runs on the owner's Mac (self-hosted, BRO-3056), which it shares with the owner's own work.
// Under load, suites that shell out to git several times per test (answers-landing, control-home,
// loops-ledger) overran bun's 5 s default and failed with nothing wrong (BRO-3060). A hang still
// fails, just later. bunfig's `[test] timeout` is not honoured by this bun; setDefaultTimeout is.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(30_000);
