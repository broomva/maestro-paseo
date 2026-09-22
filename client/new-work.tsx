// New work: a title, a brief, where it runs, and how it is judged. Saving
// writes a `_work.md` folder; dispatching also starts the run.

import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { GateMode } from "../shared/states";
import { errorText } from "./format";
import { useVerbs } from "./hooks";
import { Button, Notice, radius, space, useText } from "./ui";

export function NewWork({
  theme,
  open,
  onOpenChange,
  onCreated,
  compact,
}: {
  theme: PluginTheme;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
  compact: boolean;
}) {
  const paseo = usePaseo();
  const verbs = useVerbs();
  const toast = useToast();
  const text = useText(theme);
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [repo, setRepo] = useState("");
  const [check, setCheck] = useState("");
  const [initiative, setInitiative] = useState("");
  const [gate, setGate] = useState<GateMode>("human");
  const [error, setError] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ["maestro", "projects"],
    queryFn: () => paseo.projects.list(),
    enabled: open,
    staleTime: 60_000,
  });
  const roots = (projects.data?.projects ?? []).filter((project) => project.projectKind === "git").slice(0, 8);

  const reset = () => {
    setTitle("");
    setBrief("");
    setCheck("");
    setInitiative("");
    setGate("human");
    setError(null);
  };

  const submit = (dispatch: boolean) => {
    setError(null);
    verbs.create.mutate(
      { title, brief, repo, check, initiative, gate: check.trim() ? gate : "human", dispatch },
      {
        onSuccess: ({ item }) => {
          toast.show(dispatch ? "Dispatched" : "Saved to the queue", { variant: "success" });
          reset();
          onOpenChange(false);
          onCreated(item.id);
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  };

  const input = {
    minHeight: 44,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: 14,
  };

  return (
    <Modal
      title="New work"
      icon={<Icon name="Plus" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content>
        <Field theme={theme} label="Title">
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Persist run transcripts on the Run record"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Title"
            style={input}
          />
        </Field>
        <Field theme={theme} label="Brief" hint="What done looks like, in your words. The agent reads this.">
          <TextInput
            value={brief}
            onChangeText={setBrief}
            multiline
            placeholder="Store the full transcript on each run so reviews do not need the live session."
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Brief"
            style={[input, { minHeight: 112, textAlignVertical: "top" }]}
          />
        </Field>
        <Field theme={theme} label="Runs in" hint="A git repository on this host. Each run gets its own worktree.">
          {roots.length > 0 ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
              {roots.map((project) => {
                const selected = project.projectRootPath === repo;
                return (
                  <Pressable
                    key={project.projectId}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Run in ${project.projectDisplayName}`}
                    onPress={() => setRepo(project.projectRootPath)}
                    style={{
                      minHeight: compact ? 44 : 32,
                      justifyContent: "center",
                      paddingHorizontal: space[3],
                      borderRadius: radius.pill,
                      borderWidth: 1,
                      borderColor: selected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: selected ? theme.colors.surface2 : "transparent",
                    }}
                  >
                    <Text
                      style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "400" }}
                    >
                      {project.projectDisplayName}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          <TextInput
            value={repo}
            onChangeText={setRepo}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/absolute/path/to/repository"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Repository path"
            style={input}
          />
        </Field>
        <Field
          theme={theme}
          label="Check"
          hint="Optional. A command that proves the work, run in the worktree when the agent stops."
        >
          <TextInput
            value={check}
            onChangeText={setCheck}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="bun test"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Check command"
            style={[input, text.mono]}
          />
        </Field>
        <Field theme={theme} label="Who closes it">
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
            <Segment
              theme={theme}
              label="You approve"
              selected={gate === "human" || !check.trim()}
              onPress={() => setGate("human")}
              compact={compact}
            />
            <Segment
              theme={theme}
              label="Checks decide"
              selected={gate === "auto" && Boolean(check.trim())}
              disabled={!check.trim()}
              onPress={() => setGate("auto")}
              compact={compact}
            />
          </View>
        </Field>
        <Field theme={theme} label="Initiative" hint="Optional. Groups related work into one folder.">
          <TextInput
            value={initiative}
            onChangeText={setInitiative}
            autoCapitalize="none"
            placeholder="hawthorne"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Initiative"
            style={input}
          />
        </Field>
        {error ? (
          <Notice theme={theme} tone="danger">
            {error}
          </Notice>
        ) : null}
        <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Button
            theme={theme}
            label="Save to queue"
            compact={compact}
            disabled={verbs.create.isPending}
            onPress={() => submit(false)}
          />
          <Button
            theme={theme}
            variant="primary"
            icon="Play"
            label="Create and dispatch"
            compact={compact}
            busy={verbs.create.isPending}
            onPress={() => submit(true)}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function Field({
  theme,
  label,
  hint,
  children,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  const text = useText(theme);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label}>{label}</Text>
      {children}
      {hint ? <Text style={text.small}>{hint}</Text> : null}
    </View>
  );
}

function Segment({
  theme,
  label,
  selected,
  disabled = false,
  onPress,
  compact,
}: {
  theme: PluginTheme;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onPress: () => void;
  compact: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: compact ? 44 : 32,
        justifyContent: "center",
        paddingHorizontal: space[3],
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: selected ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}
