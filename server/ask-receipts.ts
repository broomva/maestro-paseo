// The one writer of Maestro's receipts of answers (`asks.jsonl`, BRO-2997): the line an answer leaves when it is
// written into a ledger (server/control-asks.ts), and the lines that record what became of it (server/answer-routes.ts).
// Both append here, through the one appender, so a line is whole whichever of them, or whichever daemon, wrote it.

import { appendJsonLine } from "./jsonl";

export function appendAskReceipt(path: string, line: object): Promise<void> {
  return appendJsonLine(path, line, { mode: 0o600, dirMode: 0o700 });
}
