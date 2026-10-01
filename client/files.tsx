// The files in one work folder, and the text of the one you open. Read-only.
// The server refuses anything outside the folder and anything that is not
// text; the refusal shows here in its own words.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { FILE_READ_BYTES, readWorkFile, type WorkFile, workFiles } from "../shared/records";
import { ago, agoWords, bytes, errorText } from "./format";
import { Card, Notice, radius, space, useText } from "./ui";

const POLL_MS = 10_000;

export function useWorkFiles(id: string) {
  const list = useRpc(workFiles);
  return useQuery({ queryKey: ["maestro", "files", id], queryFn: () => list({ id }), refetchInterval: POLL_MS });
}

export function useWorkFile(id: string, name: string) {
  const read = useRpc(readWorkFile);
  return useQuery({ queryKey: ["maestro", "file", id, name], queryFn: () => read({ id, name }) });
}

/** "_work.md, 1.2 KB, updated 5 minutes ago". */
export function fileLabel(file: WorkFile, now = Date.now()): string {
  return [file.name, bytes(file.size), agoWords(file.mtime, now)].filter(Boolean).join(", ");
}

export function FilesSection({ id, theme }: { id: string; theme: PluginTheme }) {
  const files = useWorkFiles(id);
  const text = useText(theme);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View style={{ gap: space[2] }}>
      <Text style={text.label} accessibilityRole="header">
        Files
      </Text>
      {files.isPending ? (
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      ) : files.isError ? (
        <Notice theme={theme} tone="warn">
          {errorText(files.error)}
        </Notice>
      ) : files.data.files.length === 0 ? (
        <Text style={text.muted}>No files in this work folder.</Text>
      ) : (
        <Card theme={theme} style={{ padding: space[2], gap: space[1] }}>
          {files.data.files.map((file) => {
            const shown = open === file.name;
            return (
              <View key={file.name} style={{ gap: space[2] }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded: shown }}
                  aria-expanded={shown}
                  accessibilityLabel={fileLabel(file)}
                  onPress={() => setOpen(shown ? null : file.name)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space[2],
                    minHeight: 36,
                    paddingHorizontal: space[2],
                    borderRadius: radius.control,
                    backgroundColor: shown || pressed ? theme.colors.surface2 : "transparent",
                  })}
                >
                  <Icon name={shown ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
                  <Text style={[text.mono, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text style={[text.small, text.tabular]}>{bytes(file.size)}</Text>
                  <Text style={[text.small, text.tabular, { width: 32, textAlign: "right" }]}>{ago(file.mtime)}</Text>
                </Pressable>
                {shown ? <FileText id={id} name={file.name} theme={theme} /> : null}
              </View>
            );
          })}
        </Card>
      )}
    </View>
  );
}

function FileText({ id, name, theme }: { id: string; name: string; theme: PluginTheme }) {
  const file = useWorkFile(id, name);
  const text = useText(theme);
  if (file.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (file.isError) {
    return (
      <Notice theme={theme} tone="warn">
        {errorText(file.error)}
      </Notice>
    );
  }
  return (
    <View style={{ gap: space[1] }}>
      <ScrollView
        accessibilityLabel={`Contents of ${name}`}
        nestedScrollEnabled
        style={{
          maxHeight: 360,
          borderRadius: radius.control,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
        }}
        contentContainerStyle={{ padding: space[3] }}
      >
        <Text style={text.mono} selectable>
          {file.data.text || "This file is empty."}
        </Text>
      </ScrollView>
      {file.data.truncated ? (
        <Text style={text.small}>Showing the first {Math.round(FILE_READ_BYTES / 1024)} KB.</Text>
      ) : null}
    </View>
  );
}
