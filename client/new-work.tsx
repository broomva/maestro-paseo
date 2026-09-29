// New work: Paseo's own composer. Above it sits the work's contract (where it
// runs, how it is isolated, who closes it, where it is filed); inside it, an
// optional title, the brief the agent reads as its prompt, and Paseo's agent
// controls (model, thinking, mode, features) read from `paseo.providers`, so
// they change with the provider. Only the brief (or a title) and a place are
// needed; every other field starts at a default, and a choice left alone is
// not sent, so Settings decides it at dispatch.
//
// The plugin SDK has no composer, menu or popover, so they are built here from
// View, TextInput and Pressable with Paseo's composer tokens.

import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  type NativeSyntheticEvent,
  type TextInput as NativeTextInput,
  Platform,
  Pressable,
  type Role,
  Text,
  type TextInputKeyPressEventData,
  type TextStyle,
  View,
} from "react-native";
import { type Isolation, inspectFolder } from "../shared/contracts";
import type { GateMode } from "../shared/states";
import {
  type AgentDraft,
  agentPillLabels,
  canSubmit,
  contractSummary,
  createInput,
  EMPTY_AGENT,
  type FeatureDef,
  family,
  featureIcon,
  featureValue,
  initiativesOf,
  type ModeDef,
  type ModelDef,
  modelKey,
  modeShown,
  pillLabel,
  resolveModel,
  shortPath,
  thinkingShown,
  withModel,
} from "./composer";
import { basename, errorText, plural } from "./format";
import { useConfig, useVerbs, useWorkList } from "./hooks";
import { IconButton, Notice, radius, size, space, useText } from "./ui";

/** Paseo reads are not Maestro state: kept out of the `maestro` key so a verb does not refetch them. */
const PASEO_KEY = "maestro-paseo";
const STALE_MS = 60_000;

type MenuId = "project" | "isolation" | "gate" | "initiative" | "model" | "thinking" | "mode" | `feature:${string}`;

const ISOLATION_COPY: Record<Isolation, { label: string; hint: string; icon: string }> = {
  worktree: { label: "New worktree", hint: "A fresh branch and folder for each run", icon: "GitBranch" },
  directory: { label: "In the repository", hint: "Runs in the checkout itself", icon: "FolderGit2" },
};

/** Paseo's mode icons are these lucide names; anything else gets the plain shield. */
const MODE_ICONS = new Set([
  "Bot",
  "Shield",
  "ShieldAlert",
  "ShieldCheck",
  "ShieldEllipsis",
  "ShieldOff",
  "ShieldPlus",
  "ShieldQuestionMark",
]);

function providerIcon(name: string | null): string {
  if (name === "claude") return "Asterisk";
  if (name === "codex") return "SquareTerminal";
  return "Bot";
}

type Keys = TextInputKeyPressEventData & {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
};

interface KeyTarget {
  addEventListener(type: "keydown", listener: (event: { key?: string }) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: { key?: string }) => void, capture: boolean): void;
}

/**
 * A row that is one choice among several. On the web it is ARIA's
 * `menuitemradio` inside `role="menu"`: react-native-web writes the role as
 * given, though RN's Role type omits it. Native has no such role and logs an
 * error for unknown ones, so there it is a radio.
 */
const CHOICE_ROLE = (Platform.OS === "web" ? "menuitemradio" : "radio") as Role;

export interface NewWorkPaneProps {
  theme: PluginTheme;
  compact: boolean;
  onCreated: (id: string) => void;
  onClose: () => void;
}

/** The full composer screen for the detail pane: heading, esc to close, the composer centered. */
export function NewWorkPane({ theme, compact, onCreated, onClose }: NewWorkPaneProps) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: 800,
        alignSelf: "center",
        paddingHorizontal: compact ? space[4] : space[6],
        paddingTop: compact ? space[4] : 96,
        // Room for a menu that opens below the composer.
        paddingBottom: 360,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Composer theme={theme} compact={compact} onCreated={onCreated} onClose={onClose} heading />
    </ScrollView>
  );
}

/** The New work modal, kept for surfaces that still open it: the same composer inside Paseo's Modal. */
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
  return (
    <Modal
      title="New work"
      icon={<Icon name="Plus" size={18} color={theme.colors.foreground} />}
      open={open}
      onOpenChange={onOpenChange}
    >
      <Modal.Content contentContainerStyle={{ paddingBottom: 320 }}>
        {open ? (
          <Composer
            theme={theme}
            compact={compact}
            heading={false}
            onClose={() => onOpenChange(false)}
            onCreated={(id) => {
              onOpenChange(false);
              onCreated(id);
            }}
          />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

function Composer({ theme, compact, onCreated, onClose, heading }: NewWorkPaneProps & { heading: boolean }) {
  const paseo = usePaseo();
  const verbs = useVerbs();
  const toast = useToast();
  const text = useText(theme);
  const settings = useConfig();
  const list = useWorkList();
  const keyboard = Platform.OS === "web" && !compact;

  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [repo, setRepo] = useState("");
  const [folderMode, setFolderMode] = useState(false);
  /** The folder path as last committed (blur or return), for the daemon to inspect. */
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [gate, setGate] = useState<GateMode>("human");
  const [initiative, setInitiative] = useState("");
  const [isolation, setIsolation] = useState<Isolation | null>(null);
  const [agent, setAgent] = useState<AgentDraft>(EMPTY_AGENT);
  const [menu, setMenu] = useState<MenuId | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const briefRef = useRef<NativeTextInput>(null);
  const searchRef = useRef<NativeTextInput>(null);

  // esc closes the open menu, then the composer. Web only: native has its own back. Capture
  // phase, so the key is seen before a focused text field handles it.
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!heading || Platform.OS !== "web") return;
    const doc = (globalThis as { document?: KeyTarget }).document;
    if (!doc) return;
    const onKey = (event: { key?: string }) => {
      if (event.key !== "Escape") return;
      if (menuRef.current) setMenu(null);
      else closeRef.current();
    };
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, [heading]);

  const toggle = (id: MenuId) => {
    setQuery("");
    setMenu((current) => (current === id ? null : id));
  };

  // ── Where it runs ─────────────────────────────────────────────────────────
  const projects = useQuery({
    queryKey: [PASEO_KEY, "projects"],
    queryFn: () => paseo.projects.list(),
    staleTime: STALE_MS,
  });
  const gitProjects = (projects.data?.projects ?? []).filter((project) => project.projectKind === "git");
  const firstProject = gitProjects[0]?.projectRootPath ?? null;
  useEffect(() => {
    if (!repo && !folderMode && firstProject) setRepo(firstProject);
  }, [repo, folderMode, firstProject]);
  const project = folderMode ? undefined : gitProjects.find((candidate) => candidate.projectRootPath === repo);
  const projectName = project?.projectDisplayName ?? (repo.trim() ? basename(repo.trim()) : null);
  // A typed folder is read by the daemon, which expands ~ and knows whether it is a repository;
  // the provider reads then use the path it returns, the same one a run will use.
  const inspect = useRpc(inspectFolder);
  const folder = useQuery({
    queryKey: [PASEO_KEY, "folder", folderPath],
    queryFn: () => inspect({ path: folderPath ?? "" }),
    enabled: folderMode && Boolean(folderPath),
    staleTime: 10_000,
  });
  const folderInfo = folderMode && folderPath ? folder.data : undefined;
  const cwd = project?.projectRootPath ?? (folderInfo?.directory ? folderInfo.path : undefined);

  const config = settings.data;
  const shownIsolation: Isolation = isolation ?? config?.isolation ?? "worktree";
  const folderProblem = !folderInfo
    ? null
    : !folderInfo.directory
      ? `No folder at ${folderInfo.path}.`
      : !folderInfo.git && shownIsolation === "worktree"
        ? "Not a git repository, and each run gets a new worktree. Choose In the repository to run in the folder itself."
        : null;

  // ── The agent: Paseo's provider reads ──────────────────────────────────────
  const selection = agent.model ?? config?.provider ?? null;
  const shownFamily = selection ? family(selection) : null;
  const where = cwd ? { cwd } : {};
  const snapshot = useQuery({
    queryKey: [PASEO_KEY, "providers", cwd ?? ""],
    queryFn: () => paseo.providers.snapshot(where),
    staleTime: STALE_MS,
  });
  const entries = (snapshot.data?.entries ?? []).filter(
    (entry) => entry.enabled !== false && entry.status !== "unavailable",
  );
  const entry = entries.find((candidate) => candidate.provider === shownFamily);
  const providerName = entry?.label ?? shownFamily ?? "the provider";

  const models = useQuery({
    queryKey: [PASEO_KEY, "models", shownFamily, cwd ?? ""],
    queryFn: () => paseo.providers.listModels(shownFamily ?? "", where),
    enabled: shownFamily !== null,
    staleTime: STALE_MS,
  });
  const modelList: ModelDef[] = models.data?.models ?? entry?.models ?? [];
  const shownModelDef = resolveModel(modelList, selection);
  const shownModel = shownModelDef ? modelKey(shownModelDef) : selection?.includes("/") ? selection : null;
  const shown = { model: shownModel, family: shownFamily };

  const modes = useQuery({
    queryKey: [PASEO_KEY, "modes", shownFamily, cwd ?? ""],
    queryFn: () => paseo.providers.listModes(shownFamily ?? "", where),
    enabled: shownFamily !== null,
    staleTime: STALE_MS,
  });
  const modeList: ModeDef[] = modes.data?.modes ?? entry?.modes ?? [];
  const mode = modeShown(modeList, {
    picked: agent.modeId,
    shownFamily,
    settings: config ? { provider: config.provider, modeId: config.modeId } : null,
    providerDefault: entry?.defaultModeId ?? null,
  });

  const thinking = thinkingShown(shownModelDef, agent.thinkingOptionId);
  const pills = agentPillLabels({
    settingsLoading: settings.isLoading,
    modelsLoading: models.isLoading,
    modesLoading: modes.isLoading,
    model: shownModelDef,
    thinking,
    mode,
  });
  const thinkingOptions = shownModelDef?.thinkingOptions ?? [];

  const hasDraftFeatures = Object.keys(agent.featureValues).length > 0;
  const features = useQuery({
    queryKey: [
      PASEO_KEY,
      "features",
      shownModel,
      cwd ?? "",
      mode?.id ?? null,
      thinking?.id ?? null,
      agent.featureValues,
    ],
    queryFn: () =>
      paseo.providers.listFeatures({
        provider: shownModel ?? "",
        cwd: cwd ?? "",
        ...(mode ? { modeId: mode.id } : {}),
        ...(thinking ? { thinkingOptionId: thinking.id } : {}),
        ...(hasDraftFeatures ? { featureValues: agent.featureValues } : {}),
      }),
    // Features belong to one model in one folder: Paseo needs both to list them.
    enabled: Boolean(shownModel && cwd),
    staleTime: STALE_MS,
    placeholderData: (previous) => previous,
  });
  const featureList: FeatureDef[] = features.data?.features ?? [];
  const featureError = features.isError ? errorText(features.error) : (features.data?.error ?? null);

  // ── Initiatives in use ─────────────────────────────────────────────────────
  const initiatives = initiativesOf(list.data?.items ?? []);
  const typed = query.trim();
  /** What a typed name files under: the initiative in use when it matches one, else a new one. */
  const typedInitiative =
    initiatives.find((known) => known.name.toLowerCase() === typed.toLowerCase())?.name ?? (typed || null);
  const typedIsNew = typedInitiative !== null && !initiatives.some((known) => known.name === typedInitiative);

  // ── Submit ─────────────────────────────────────────────────────────────────
  const ready = canSubmit({ title, brief, repo }) && !folderProblem;
  const pending = verbs.create.isPending;
  const submit = (dispatch: boolean) => {
    if (!ready || pending) return;
    setMenu(null);
    setError(null);
    verbs.create.mutate(
      createInput({ title, brief, repo, check, gate, initiative, isolation }, agent, shown, dispatch),
      {
        onSuccess: ({ item }) => {
          toast.show(dispatch ? "Dispatched" : "Saved to the queue", { variant: "success" });
          setTitle("");
          setBrief("");
          setCheck("");
          setGate("human");
          onCreated(item.id);
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  };

  const onBriefKey = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (!keyboard) return;
    const keys = event.nativeEvent as Keys;
    if (keys.key !== "Enter" || keys.isComposing || keys.shiftKey) return;
    (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    submit(!(keys.metaKey || keys.ctrlKey));
  };
  const onTitleKey = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (!keyboard) return;
    const keys = event.nativeEvent as Keys;
    if (keys.key !== "Enter" || keys.isComposing) return;
    (event as unknown as { preventDefault?: () => void }).preventDefault?.();
    if (keys.metaKey || keys.ctrlKey) submit(false);
    else briefRef.current?.focus();
  };

  // ── Pieces ─────────────────────────────────────────────────────────────────
  const filter = <T,>(items: T[], words: (item: T) => string) => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => words(item).toLowerCase().includes(needle)) : items;
  };
  const checkText = check.trim();
  const shownGate: GateMode = checkText ? gate : "human";
  const contractMenu = menu === "project" || menu === "isolation" || menu === "gate" || menu === "initiative";
  const inputBase: TextStyle = {
    color: theme.colors.foreground,
    fontSize: 15,
    lineHeight: 21,
    padding: 0,
    outlineWidth: 0,
  };

  return (
    <View style={{ gap: space[3] }}>
      {menu ? (
        // Pressing anywhere outside the open menu closes it. It sits under the row or composer
        // that holds the menu and over everything else; on the web it reaches past the composer
        // to the whole pane, on native it covers the composer's own area.
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          onPress={() => setMenu(null)}
          style={{ position: "absolute", top: -4000, bottom: -4000, left: -4000, right: -4000, zIndex: 10 }}
        />
      ) : null}
      {heading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], paddingHorizontal: space[1] }}>
          <Text
            accessibilityRole="header"
            style={{ flex: 1, color: theme.colors.foreground, fontSize: 28, lineHeight: 34, fontWeight: "500" }}
          >
            New work
          </Text>
          {keyboard ? <Text style={text.small}>esc</Text> : null}
          <IconButton theme={theme} icon="X" label="Close new work" onPress={onClose} />
        </View>
      ) : null}

      {/* The work's contract */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space[1],
          zIndex: contractMenu ? 20 : 0,
        }}
      >
        <Anchor open={menu === "project"}>
          <Pill
            theme={theme}
            compact={compact}
            label={projectName ?? (projects.isLoading ? "Loading…" : "Choose a project")}
            icon="FolderOpen"
            leading={projectName ? <Badge theme={theme} name={projectName} /> : undefined}
            open={menu === "project"}
            accessibilityLabel={`Runs in ${projectName ?? "no project yet"}`}
            onPress={() => toggle("project")}
          />
          {menu === "project" ? (
            <Menu theme={theme}>
              <MenuSearch theme={theme} placeholder="Search projects" value={query} onChange={setQuery} />
              {projects.isLoading ? <MenuNote theme={theme}>Loading projects{"…"}</MenuNote> : null}
              {projects.isError ? <MenuNote theme={theme}>{errorText(projects.error)}</MenuNote> : null}
              {filter(gitProjects, (p) => `${p.projectDisplayName} ${p.projectRootPath}`).map((candidate) => (
                <MenuRow
                  key={candidate.projectId}
                  theme={theme}
                  leading={<Badge theme={theme} name={candidate.projectDisplayName} />}
                  label={candidate.projectDisplayName}
                  hint={shortPath(candidate.projectRootPath)}
                  selected={!folderMode && candidate.projectRootPath === repo}
                  onPress={() => {
                    setFolderMode(false);
                    setRepo(candidate.projectRootPath);
                    setMenu(null);
                  }}
                />
              ))}
              <MenuDivider theme={theme} />
              <MenuRow
                theme={theme}
                icon="FolderOpen"
                label={"Choose a folder…"}
                hint="Any git repository on this host"
                selected={folderMode}
                onPress={() => {
                  setFolderMode(true);
                  setFolderPath(null);
                  setRepo("");
                  setMenu(null);
                }}
              />
            </Menu>
          ) : null}
        </Anchor>

        <Anchor open={menu === "isolation"}>
          <Pill
            theme={theme}
            compact={compact}
            icon={ISOLATION_COPY[shownIsolation].icon}
            label={pillLabel({
              loading: settings.isLoading && isolation === null,
              label: isolation || config ? ISOLATION_COPY[shownIsolation].label : null,
            })}
            open={menu === "isolation"}
            onPress={() => toggle("isolation")}
          />
          {menu === "isolation" ? (
            <Menu theme={theme}>
              {(Object.keys(ISOLATION_COPY) as Isolation[]).map((key) => (
                <MenuRow
                  key={key}
                  theme={theme}
                  icon={ISOLATION_COPY[key].icon}
                  label={ISOLATION_COPY[key].label}
                  hint={ISOLATION_COPY[key].hint}
                  selected={shownIsolation === key}
                  onPress={() => {
                    setIsolation(key);
                    setMenu(null);
                  }}
                />
              ))}
              <MenuDivider theme={theme} />
              <MenuNote theme={theme}>Defaults to Settings {"→"} Isolation.</MenuNote>
            </Menu>
          ) : null}
        </Anchor>

        <Anchor open={menu === "gate"}>
          <Pill
            theme={theme}
            compact={compact}
            icon={checkText ? "ListChecks" : "UserCheck"}
            label={shownGate === "auto" ? "Checks decide" : "You approve"}
            code={checkText || undefined}
            filled={Boolean(checkText)}
            open={menu === "gate"}
            accessibilityLabel={`Who closes it: ${shownGate === "auto" ? "checks decide" : "you approve"}`}
            onPress={() => toggle("gate")}
          />
          {menu === "gate" ? (
            <Menu theme={theme} width={320}>
              <View style={{ gap: space[2], padding: space[2] }}>
                <Text style={text.label}>Check</Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space[2],
                    minHeight: 36,
                    paddingHorizontal: space[3],
                    borderRadius: radius.control,
                    borderWidth: 1,
                    borderColor: checkText ? theme.colors.accent : theme.colors.border,
                  }}
                >
                  <Icon name="SquareTerminal" size={14} color={theme.colors.foregroundMuted} />
                  <TextInput
                    value={check}
                    onChangeText={setCheck}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="bun test"
                    placeholderTextColor={theme.colors.foregroundMuted}
                    accessibilityLabel="Check command"
                    style={[
                      text.mono,
                      { flex: 1, fontSize: 13, lineHeight: 18, paddingVertical: space[2], outlineWidth: 0 },
                    ]}
                  />
                </View>
                <Text style={text.small}>
                  Runs in the {shownIsolation === "worktree" ? "worktree" : "repository"} when the agent stops. Exit 0
                  passes.
                </Text>
              </View>
              <View style={{ paddingHorizontal: space[2], paddingTop: space[1] }}>
                <Text style={text.label}>Who closes it</Text>
              </View>
              <MenuRow
                theme={theme}
                icon={shownGate === "human" ? "CircleCheck" : "Circle"}
                radio
                label="You approve"
                hint="Every run waits at your gate, check or not."
                selected={shownGate === "human"}
                onPress={() => setGate("human")}
              />
              <MenuRow
                theme={theme}
                icon={shownGate === "auto" ? "CircleCheck" : "Circle"}
                radio
                label="Checks decide"
                hint={
                  checkText
                    ? "A pass closes it. A fail marks it stuck for you."
                    : "Write a check first. A pass closes it; a fail marks it stuck for you."
                }
                selected={shownGate === "auto"}
                disabled={!checkText}
                onPress={() => setGate("auto")}
              />
            </Menu>
          ) : null}
        </Anchor>

        <View style={{ flexGrow: 1 }} />

        <Anchor open={menu === "initiative"}>
          <Pill
            theme={theme}
            compact={compact}
            icon="Folder"
            label={initiative.trim() || "No initiative"}
            open={menu === "initiative"}
            accessibilityLabel={`Initiative: ${initiative.trim() || "none"}`}
            onPress={() => toggle("initiative")}
          />
          {menu === "initiative" ? (
            <Menu theme={theme} align="right">
              <MenuSearch
                theme={theme}
                inputRef={searchRef}
                placeholder="Find or create"
                value={query}
                onChange={setQuery}
                onSubmit={() => {
                  if (typedInitiative) {
                    setInitiative(typedInitiative);
                    setMenu(null);
                  }
                }}
              />
              <MenuRow
                theme={theme}
                icon="Minus"
                label="No initiative"
                hint="Top level of the work folder"
                selected={!initiative.trim()}
                onPress={() => {
                  setInitiative("");
                  setMenu(null);
                }}
              />
              {filter(
                initiative.trim() && !initiatives.some((known) => known.name === initiative.trim())
                  ? [{ name: initiative.trim(), count: 0 }, ...initiatives]
                  : initiatives,
                (known) => known.name,
              ).map((known) => (
                <MenuRow
                  key={known.name}
                  theme={theme}
                  icon="Folder"
                  label={known.name}
                  hint={known.count > 0 ? plural(known.count, "item") : "New, made when you save"}
                  selected={initiative.trim() === known.name}
                  onPress={() => {
                    setInitiative(known.name);
                    setMenu(null);
                  }}
                />
              ))}
              {typedIsNew || !typed ? (
                <>
                  <MenuDivider theme={theme} />
                  <MenuRow
                    theme={theme}
                    icon="FolderPlus"
                    kind="action"
                    label={typed ? `New initiative “${typed}”` : "New initiative…"}
                    hint={typed ? "Creates a folder under the work root" : "Type its name above"}
                    selected={false}
                    onPress={() => {
                      if (!typed) {
                        searchRef.current?.focus();
                        return;
                      }
                      setInitiative(typed);
                      setMenu(null);
                    }}
                  />
                </>
              ) : null}
            </Menu>
          ) : null}
        </Anchor>
      </View>

      {folderMode ? (
        <View style={{ gap: space[1] }}>
          <TextInput
            value={repo}
            onChangeText={setRepo}
            onBlur={() => setFolderPath(repo.trim() || null)}
            onSubmitEditing={() => setFolderPath(repo.trim() || null)}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="/absolute/path/to/repository"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="Repository folder"
            style={{
              ...inputBase,
              fontSize: size.sm,
              minHeight: compact ? 44 : 36,
              paddingHorizontal: space[3],
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          />
          <Text
            style={[
              text.small,
              { paddingHorizontal: space[1] },
              folderProblem || folder.isError ? { color: theme.colors.statusDanger } : null,
            ]}
          >
            {folder.isError
              ? errorText(folder.error)
              : folderProblem
                ? folderProblem
                : folderInfo
                  ? `${shortPath(folderInfo.path)}${folderInfo.git ? ", a git repository" : ""}`
                  : folder.isFetching
                    ? "Checking\u2026"
                    : "An absolute path to a git repository on this host. ~ is your home folder."}
          </Text>
        </View>
      ) : null}

      {/* The composer */}
      <View
        style={{
          backgroundColor: theme.colors.surface1,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 16,
          paddingHorizontal: compact ? space[3] : space[4],
          paddingVertical: compact ? space[2] : space[4],
          gap: space[3],
          zIndex: menu && !contractMenu ? 20 : 0,
        }}
      >
        <TextInput
          value={title}
          onChangeText={setTitle}
          onKeyPress={onTitleKey}
          onFocus={() => setMenu(null)}
          onSubmitEditing={() => briefRef.current?.focus()}
          submitBehavior="submit"
          placeholder="Title (optional)"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Title, optional"
          style={{ ...inputBase, fontWeight: "600" }}
        />
        <TextInput
          ref={briefRef}
          value={brief}
          onChangeText={setBrief}
          onKeyPress={onBriefKey}
          onFocus={() => setMenu(null)}
          multiline
          autoFocus={heading && Platform.OS === "web"}
          placeholder="Describe the work and what done looks like. The agent reads this as its prompt."
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Brief"
          style={{ ...inputBase, minHeight: Platform.OS === "web" ? 96 : 72, textAlignVertical: "top" }}
        />

        {/* Paseo's agent controls */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[1] }}>
          <Anchor open={menu === "model"}>
            <ToolbarPill
              theme={theme}
              compact={compact}
              icon={providerIcon(shownFamily)}
              label={pills.model}
              open={menu === "model"}
              accessibilityLabel="Model"
              onPress={() => toggle("model")}
            />
            {menu === "model" ? (
              <Menu theme={theme}>
                <MenuSearch theme={theme} placeholder={"Search models…"} value={query} onChange={setQuery} />
                {snapshot.isLoading ? <MenuNote theme={theme}>Loading providers{"…"}</MenuNote> : null}
                {snapshot.isError ? <MenuNote theme={theme}>{errorText(snapshot.error)}</MenuNote> : null}
                {(entries.length > 0
                  ? entries
                  : shownFamily
                    ? [{ provider: shownFamily, label: undefined, models: modelList }]
                    : []
                ).map((group) => {
                  const own = group.provider === shownFamily ? modelList : (group.models ?? []);
                  const usable = filter(
                    own.filter((model) => model.isSelectable !== false),
                    (model) => `${model.label} ${model.id}`,
                  );
                  const name = group.label ?? group.provider;
                  if (own.length > 0 && usable.length === 0) return null;
                  return (
                    <View key={group.provider}>
                      <MenuHeader theme={theme}>{name}</MenuHeader>
                      {own.length === 0 ? (
                        <MenuRow
                          theme={theme}
                          icon={providerIcon(group.provider)}
                          label={`${name} models`}
                          hint={
                            group.provider === shownFamily && models.isLoading
                              ? "Loading…"
                              : "Listed by the provider on this host"
                          }
                          selected={shownFamily === group.provider && !shownModelDef}
                          onPress={() => {
                            setAgent(withModel(agent, group.provider, shownFamily));
                            setMenu(null);
                          }}
                        />
                      ) : (
                        usable.map((model) => (
                          <MenuRow
                            key={modelKey(model)}
                            theme={theme}
                            icon={providerIcon(group.provider)}
                            label={model.label}
                            hint={model.description}
                            selected={shownModelDef !== null && modelKey(shownModelDef) === modelKey(model)}
                            onPress={() => {
                              setAgent(withModel(agent, modelKey(model), shownFamily));
                              setMenu(null);
                            }}
                          />
                        ))
                      )}
                    </View>
                  );
                })}
                {models.data?.error ? <MenuNote theme={theme}>{models.data.error}</MenuNote> : null}
                {agent.model ? (
                  <>
                    <MenuDivider theme={theme} />
                    <MenuRow
                      theme={theme}
                      icon="RotateCcw"
                      kind="action"
                      label="Use the Settings default"
                      hint={config ? `Currently ${config.provider}` : undefined}
                      selected={false}
                      onPress={() => {
                        setAgent(EMPTY_AGENT);
                        setMenu(null);
                      }}
                    />
                  </>
                ) : null}
              </Menu>
            ) : null}
          </Anchor>

          <Anchor open={menu === "thinking"}>
            <ToolbarPill
              theme={theme}
              compact={compact}
              icon="Brain"
              label={pills.thinking}
              open={menu === "thinking"}
              accessibilityLabel="Thinking"
              onPress={() => toggle("thinking")}
            />
            {menu === "thinking" ? (
              <Menu theme={theme} width={240}>
                {thinkingOptions.length === 0 ? (
                  <MenuNote theme={theme}>
                    {models.isLoading
                      ? "Loading\u2026"
                      : models.isError
                        ? errorText(models.error)
                        : (models.data?.error ??
                          "This model lists no thinking levels here, so it runs at its default.")}
                  </MenuNote>
                ) : null}
                {thinkingOptions.map((option) => (
                  <MenuRow
                    key={option.id}
                    theme={theme}
                    icon="Brain"
                    label={option.label}
                    hint={option.description}
                    selected={thinking?.id === option.id}
                    onPress={() => {
                      setAgent({ ...agent, thinkingOptionId: option.id });
                      setMenu(null);
                    }}
                  />
                ))}
                <MenuDivider theme={theme} />
                <MenuNote theme={theme}>The levels are the model{"’"}s own.</MenuNote>
              </Menu>
            ) : null}
          </Anchor>

          <Anchor open={menu === "mode"}>
            <ToolbarPill
              theme={theme}
              compact={compact}
              icon={mode?.icon && MODE_ICONS.has(mode.icon) ? mode.icon : "Shield"}
              label={pills.mode}
              open={menu === "mode"}
              accessibilityLabel="Mode"
              onPress={() => toggle("mode")}
            />
            {menu === "mode" ? (
              <Menu theme={theme}>
                <MenuSearch theme={theme} placeholder={"Search modes…"} value={query} onChange={setQuery} />
                {modes.isError ? <MenuNote theme={theme}>{errorText(modes.error)}</MenuNote> : null}
                {modes.data?.error ? <MenuNote theme={theme}>{modes.data.error}</MenuNote> : null}
                {modes.isLoading ? <MenuNote theme={theme}>Loading{"\u2026"}</MenuNote> : null}
                {!modes.isLoading && modeList.length === 0 && !modes.data?.error && !modes.isError ? (
                  <MenuNote theme={theme}>No modes listed here, so runs use the Settings mode.</MenuNote>
                ) : null}
                {filter(modeList, (candidate) => `${candidate.label} ${candidate.id}`).map((candidate) => (
                  <MenuRow
                    key={candidate.id}
                    theme={theme}
                    icon={candidate.icon && MODE_ICONS.has(candidate.icon) ? candidate.icon : "Shield"}
                    label={candidate.label}
                    hint={candidate.description}
                    selected={mode?.id === candidate.id}
                    onPress={() => {
                      setAgent({ ...agent, modeId: candidate.id });
                      setMenu(null);
                    }}
                  />
                ))}
                <MenuDivider theme={theme} />
                <MenuNote theme={theme}>
                  From {providerName}
                  {"’"}s mode list in Paseo.
                </MenuNote>
              </Menu>
            ) : null}
          </Anchor>

          {featureList.map((feature) => {
            const value = featureValue(feature, agent.featureValues);
            if (feature.type === "toggle") {
              const on = value === true;
              return (
                <Pressable
                  key={feature.id}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={feature.label}
                  accessibilityHint={feature.description ?? feature.tooltip}
                  onPress={() => setAgent({ ...agent, featureValues: { ...agent.featureValues, [feature.id]: !on } })}
                  style={({ pressed }) => ({
                    width: compact ? 36 : 28,
                    height: compact ? 36 : 28,
                    borderRadius: 16,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: on || pressed ? theme.colors.surface2 : "transparent",
                  })}
                >
                  <Icon
                    name={featureIcon(feature.icon)}
                    size={16}
                    color={on ? theme.colors.accent : theme.colors.foregroundMuted}
                  />
                </Pressable>
              );
            }
            const id: MenuId = `feature:${feature.id}`;
            const current = feature.options.find((option) => option.id === value);
            return (
              <Anchor key={feature.id} open={menu === id}>
                <ToolbarPill
                  theme={theme}
                  compact={compact}
                  icon={featureIcon(feature.icon)}
                  label={current?.label ?? feature.label}
                  open={menu === id}
                  accessibilityLabel={feature.label}
                  onPress={() => toggle(id)}
                />
                {menu === id ? (
                  <Menu theme={theme} width={240}>
                    {feature.options.map((option) => (
                      <MenuRow
                        key={option.id}
                        theme={theme}
                        label={option.label}
                        hint={option.description}
                        selected={option.id === value}
                        onPress={() => {
                          setAgent({ ...agent, featureValues: { ...agent.featureValues, [feature.id]: option.id } });
                          setMenu(null);
                        }}
                      />
                    ))}
                  </Menu>
                ) : null}
              </Anchor>
            );
          })}

          <View style={{ flexGrow: 1 }} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save to queue"
            accessibilityState={{ disabled: !ready || pending }}
            disabled={!ready || pending}
            onPress={() => submit(false)}
            style={({ pressed }) => ({
              height: compact ? 36 : 30,
              paddingHorizontal: space[2],
              justifyContent: "center",
              borderRadius: 15,
              backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              opacity: !ready || pending ? 0.5 : 1,
            })}
          >
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.sm }}>Save to queue</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dispatch"
            accessibilityState={{ disabled: !ready || pending, busy: pending }}
            disabled={!ready || pending}
            onPress={() => submit(true)}
            style={({ pressed }) => ({
              height: compact ? 36 : 30,
              paddingHorizontal: space[3],
              flexDirection: "row",
              alignItems: "center",
              gap: space[2],
              borderRadius: 15,
              backgroundColor: ready ? theme.colors.accent : theme.colors.surface2,
              opacity: pending ? 0.7 : pressed ? 0.85 : 1,
            })}
          >
            <Text
              style={{
                color: ready ? theme.colors.accentForeground : theme.colors.foregroundMuted,
                fontSize: size.sm,
                fontWeight: "600",
              }}
            >
              Dispatch
            </Text>
            {pending ? (
              <ActivityIndicator size="small" color={theme.colors.accentForeground} />
            ) : (
              <Icon
                name="CornerDownLeft"
                size={14}
                color={ready ? theme.colors.accentForeground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </View>
      </View>

      {featureError ? (
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space[2], paddingHorizontal: space[1] }}>
          <Icon name="TriangleAlert" size={14} color={theme.colors.statusWarning} />
          <Text style={[text.small, { flex: 1 }]}>
            Could not list {providerName}
            {"\u2019"}s features: {featureError}
          </Text>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: space[3],
          paddingHorizontal: space[1],
        }}
      >
        <Text style={[text.small, { flex: 1, minWidth: 200 }]}>
          {title.trim() || brief.trim()
            ? contractSummary({ project: projectName, isolation: shownIsolation, initiative })
            : "A blank title takes the brief’s first line."}
        </Text>
        {keyboard ? (
          <Text style={text.small}>
            {"↵"} dispatch{"   "}
            {"⌘↵"} queue{"   "}
            {"⇧↵"} new line
          </Text>
        ) : null}
      </View>

      {error ? (
        <Notice theme={theme} tone="danger">
          {error}
        </Notice>
      ) : null}
    </View>
  );
}

// ── Menus and pills ──────────────────────────────────────────────────────────
// A menu floats under its pill. Every View is its own stacking layer on the
// web, so the open pill's anchor, and the row or composer that holds it, are
// lifted above the siblings that follow them.

function Anchor({ open, children }: { open: boolean; children: ReactNode }) {
  return <View style={{ position: "relative", zIndex: open ? 30 : 0 }}>{children}</View>;
}

function Menu({
  theme,
  children,
  width = 288,
  align = "left",
}: {
  theme: PluginTheme;
  children: ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  return (
    <View
      role="menu"
      style={{
        position: "absolute",
        top: "100%",
        marginTop: space[1],
        ...(align === "right" ? { right: 0 } : { left: 0 }),
        zIndex: 50,
        width,
        maxHeight: 420,
        padding: 6,
        gap: 2,
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface0,
        shadowColor: theme.colors.foreground,
        shadowOpacity: 0.1,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        elevation: 8,
      }}
    >
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ gap: 2 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * One row of a menu. A choice is one of several (checked when it is the
 * current one); an action does something else, such as revealing a field.
 */
function MenuRow({
  theme,
  label,
  hint,
  icon,
  leading,
  selected,
  disabled = false,
  kind = "choice",
  radio = false,
  onPress,
}: {
  theme: PluginTheme;
  label: string;
  hint?: string;
  icon?: string;
  leading?: ReactNode;
  selected: boolean;
  disabled?: boolean;
  kind?: "choice" | "action";
  /** Drawn as a radio button rather than with a check mark. */
  radio?: boolean;
  onPress: () => void;
}) {
  const choice = kind === "choice";
  return (
    <Pressable
      role={choice ? CHOICE_ROLE : "menuitem"}
      aria-checked={choice ? selected : undefined}
      aria-disabled={disabled}
      accessibilityLabel={hint ? `${label}. ${hint}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: hint ? "flex-start" : "center",
        gap: space[3],
        paddingHorizontal: space[2],
        paddingVertical: space[2],
        borderRadius: radius.control,
        backgroundColor: selected || pressed ? theme.colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {leading ??
        (icon ? (
          <View style={{ paddingTop: hint ? 2 : 0 }}>
            <Icon
              name={icon}
              size={16}
              color={radio && selected ? theme.colors.accent : theme.colors.foregroundMuted}
            />
          </View>
        ) : null)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: size.sm, lineHeight: 20 }}>{label}</Text>
        {hint ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, lineHeight: 16 }}>{hint}</Text>
        ) : null}
      </View>
      {selected && choice && !radio ? <Icon name="Check" size={16} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

function MenuSearch({
  theme,
  placeholder,
  value,
  onChange,
  onSubmit,
  inputRef,
}: {
  theme: PluginTheme;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  inputRef?: RefObject<NativeTextInput | null>;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: space[2],
        paddingHorizontal: space[2],
        marginBottom: 2,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        autoFocus={Platform.OS === "web"}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel={placeholder}
        style={{
          flex: 1,
          color: theme.colors.foreground,
          fontSize: size.sm,
          paddingVertical: space[2],
          outlineWidth: 0,
        }}
      />
    </View>
  );
}

function MenuHeader({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        fontWeight: "600",
        letterSpacing: 0.5,
        textTransform: "uppercase",
        paddingHorizontal: space[2],
        paddingTop: space[2],
        paddingBottom: space[1],
      }}
    >
      {children}
    </Text>
  );
}

function MenuNote({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: size.xs,
        lineHeight: 16,
        paddingHorizontal: space[2],
        paddingVertical: space[1],
      }}
    >
      {children}
    </Text>
  );
}

function MenuDivider({ theme }: { theme: PluginTheme }) {
  return <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: space[1] }} />;
}

/** A project's initial on a small square, as Paseo marks projects. */
function Badge({ theme, name }: { theme: PluginTheme; name: string | null }) {
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.foreground,
      }}
    >
      <Text style={{ color: theme.colors.surface0, fontSize: 11, lineHeight: 14, fontWeight: "700" }}>
        {(name ?? "?").charAt(0).toLowerCase()}
      </Text>
    </View>
  );
}

/** A pill in the contract row above the composer. */
function Pill({
  theme,
  compact,
  label,
  icon,
  leading,
  code,
  filled = false,
  open,
  accessibilityLabel,
  onPress,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon?: string;
  leading?: ReactNode;
  /** A command shown in monospace before the label. */
  code?: string;
  filled?: boolean;
  open: boolean;
  accessibilityLabel?: string;
  onPress: () => void;
}) {
  const text = useText(theme);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: compact ? 40 : 32,
        maxWidth: 360,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 10,
        borderRadius: 16,
        backgroundColor: open || filled || pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {leading ?? (icon ? <Icon name={icon} size={16} color={theme.colors.foregroundMuted} /> : null)}
      {code ? (
        <Text numberOfLines={1} style={[text.mono, { fontSize: 13, color: theme.colors.foreground, flexShrink: 1 }]}>
          {code}
        </Text>
      ) : null}
      {code ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.sm }}>{"·"}</Text> : null}
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: size.sm, flexShrink: 1 }}>
        {label}
      </Text>
      <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

/** A trigger in the composer's toolbar: Paseo's model, thinking and mode controls. */
function ToolbarPill({
  theme,
  compact,
  label,
  icon,
  open,
  accessibilityLabel,
  onPress,
}: {
  theme: PluginTheme;
  compact: boolean;
  label: string;
  icon: string;
  open: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${label}`}
      accessibilityState={{ expanded: open }}
      onPress={onPress}
      style={({ pressed }) => ({
        height: compact ? 36 : 28,
        flexDirection: "row",
        alignItems: "center",
        gap: space[1],
        paddingHorizontal: space[2],
        borderRadius: 16,
        backgroundColor: open ? theme.colors.surface0 : pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name={icon} size={16} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: size.sm }}>
        {label}
      </Text>
      <Icon name="ChevronDown" size={12} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}
