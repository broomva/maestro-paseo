// Settings: where work folders live, how a dispatch starts its agent, how many
// run at once, and what an approval cleans up.

import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import type { MaestroConfig } from "../shared/contracts";
import { errorText } from "./format";
import { useConfig, useVerbs } from "./hooks";
import { Notice, space } from "./ui";

/** The cap as typed: empty is no cap, a whole number from 1 is a cap, anything else is an error to show. */
function parseCap(text: string): { cap: number | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { cap: null, error: null };
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return { cap: null, error: "A whole number of runs, 1 or more. Leave it empty for no cap." };
  }
  return { cap: Number(trimmed), error: null };
}

export function MaestroSettings({ theme }: PluginSurfaceProps) {
  const config = useConfig();
  const verbs = useVerbs();
  const toast = useToast();
  const [draft, setDraft] = useState<MaestroConfig | null>(null);
  const [capError, setCapError] = useState<string | null>(null);

  useEffect(() => {
    if (config.data && draft === null) setDraft(config.data);
  }, [config.data, draft]);

  if (config.isError) {
    return (
      <Notice theme={theme} tone="danger">
        {errorText(config.error)}
      </Notice>
    );
  }
  if (!draft) return <ActivityIndicator color={theme.colors.foregroundMuted} />;

  const patch = (next: Partial<MaestroConfig>) => setDraft({ ...draft, ...next });

  return (
    <View style={{ gap: space[6] }}>
      <SettingsSection title="Work">
        <SettingsCard>
          <SettingsInput
            label="Work folder"
            hint="Each work item is a folder here with a _work.md file. Absolute path on this host."
            initialValue={draft.workRoot}
            onChangeText={(workRoot) => patch({ workRoot })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Runs">
        <SettingsCard>
          <SettingsInput
            label="Provider"
            hint="A provider such as claude or codex, optionally with a model: claude/opus."
            initialValue={draft.provider}
            onChangeText={(provider) => patch({ provider })}
          />
          <SettingsInput
            label="Mode"
            hint="Optional provider mode for unattended runs. Leave empty for the provider default."
            initialValue={draft.modeId ?? ""}
            onChangeText={(modeId) => patch({ modeId: modeId.trim() ? modeId : null })}
          />
          <SettingsSelect
            label="Isolation"
            value={draft.isolation}
            options={[
              { label: "New worktree per run", value: "worktree" },
              { label: "Run in the repository", value: "directory" },
            ]}
            onValueChange={(isolation) => patch({ isolation })}
          />
          <SettingsInput
            label="Runs at once"
            hint="A dispatch past this many running is refused and the work stays queued. Leave empty for no cap."
            error={capError}
            initialValue={draft.concurrencyCap === null ? "" : String(draft.concurrencyCap)}
            onChangeText={(text) => {
              const { cap, error } = parseCap(text);
              setCapError(error);
              if (!error) patch({ concurrencyCap: cap });
            }}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="The gate">
        <SettingsCard>
          <SettingsSelect
            label="New work"
            hint="Used when you do not choose. Checks decide only when the work has a check command."
            value={draft.defaultGate}
            options={[
              { label: "You approve", value: "human" },
              { label: "Checks decide", value: "auto" },
            ]}
            onValueChange={(defaultGate) => patch({ defaultGate })}
          />
          <SettingsSwitch
            label="Archive the workspace on approve"
            hint="When an approval takes effect, the run's worktree goes away. The branch stays as the receipt."
            value={draft.archiveOnApprove}
            onValueChange={(archiveOnApprove) => patch({ archiveOnApprove })}
          />
          <SettingsAction
            label="Save settings"
            actionLabel={verbs.saveConfig.isPending ? "Saving" : "Save"}
            disabled={verbs.saveConfig.isPending || capError !== null}
            onPress={() =>
              verbs.saveConfig.mutate(draft, {
                onSuccess: (saved) => {
                  setDraft(saved);
                  toast.show("Settings saved", { variant: "success" });
                },
                onError: (error) => toast.error(errorText(error)),
              })
            }
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
