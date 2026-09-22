// Settings: where work folders live and how a dispatch starts its agent.

import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import type { MaestroConfig } from "../shared/contracts";
import { errorText } from "./format";
import { useConfig, useVerbs } from "./hooks";
import { Notice, space } from "./ui";

export function MaestroSettings({ theme }: PluginSurfaceProps) {
  const config = useConfig();
  const verbs = useVerbs();
  const toast = useToast();
  const [draft, setDraft] = useState<MaestroConfig | null>(null);

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
          <SettingsAction
            label="Save settings"
            actionLabel={verbs.saveConfig.isPending ? "Saving" : "Save"}
            disabled={verbs.saveConfig.isPending}
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
