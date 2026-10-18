import { call, NoAnswer, Refused, Unreachable } from "../bin/maestro";
import { mcpSocketPath } from "../server/mcp-read-bridge";
import { type Snapshot, SnapshotSchema, unavailable } from "../shared/mcp";
import { sampleSnapshot } from "./sample";

export function createBackend(options: { demo?: boolean; socket?: string } = {}): () => Promise<Snapshot> {
  return async () => {
    if (options.demo) return sampleSnapshot();
    try {
      return SnapshotSchema.parse(
        await call(
          "snapshot",
          {},
          {
            path: options.socket ?? mcpSocketPath(),
            caller: null,
            cwd: null,
            timeoutMs: 20_000,
          },
        ),
      );
    } catch (error) {
      if (error instanceof Refused) return unavailable(`Maestro could not read its snapshot: ${error.message}`);
      if (error instanceof NoAnswer)
        return unavailable("Maestro did not answer the read request in time. Refresh to try again.");
      if (!(error instanceof Unreachable))
        return unavailable("Maestro returned an incompatible snapshot. Update the plugin and MCP companion together.");
      return unavailable(
        "The read-only Maestro connection is unavailable. Enable its read bridge in Paseo, then refresh.",
      );
    }
  };
}
