// Sessions in scope: the newest report's rows as a table on the desktop and
// stacked rows on the phone, each with what the fleet would do; a row opens
// the inspector (draft B), a ⋯ menu opens it in Paseo, adopts it into Maestro
// or copies its id. The inspector shows only what the report says: its facts,
// its class at each tick read, the fleet's verdict and your verdict on it,
// and the evidence. Nothing here changes what the fleet does.

import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import type { FleetProposal } from "../shared/fleet";
import {
  activeWords,
  adoptTitle,
  agreeText,
  bucketOf,
  canAdopt,
  cutWords,
  displayName,
  evidenceSentence,
  HISTORY_GLYPH,
  HISTORY_LEGEND,
  type HistoryKind,
  historyKind,
  historyText,
  middlePath,
  placedWords,
  plainAction,
  REPORT_MEANS,
  type RosterFilter,
  type RosterRow,
  resumeCommand,
  stateTone,
  stateWord,
  verdictNote,
  wouldText,
} from "./fleet-cockpit-model";
import { NoteInput, useVerdict } from "./fleet-queue";
import { copy, Facts, infoInk, type MenuItem, Pill, Press, RowMenu, ramp, Segmented, tint, Verb } from "./fleet-ui";
import { ago, errorText, plural } from "./format";
import { useVerbs } from "./hooks";
import { radius, space } from "./ui";

type Navigation = PluginSurfaceProps["navigation"];

/** How the roster names a session's kind: a Paseo agent, a CLI session, a background one. */
export function kindText(row: Pick<RosterRow, "kind" | "agentId">): string {
  if (row.agentId) return "Paseo agent";
  if (row.kind === "interactive") return "CLI";
  if (row.kind === "background") return "background";
  return row.kind ?? "session";
}

/** A session's name as people read it: a name that repeats itself said once. */
function rowName(row: Pick<RosterRow, "name" | "short">): string {
  return displayName(row.name ?? row.short);
}

/** The verbs every row and the inspector share: Open in Paseo, Adopt into Maestro, Copy session id. */
export function useSessionVerbs(onSelect: (id: string) => void) {
  const verbs = useVerbs();
  const toast = useToast();
  return {
    adopting: verbs.adopt.isPending,
    adopt: (row: RosterRow) => {
      if (!row.agentId) return;
      verbs.adopt.mutate(
        { agentId: row.agentId, title: adoptTitle(row) },
        {
          onSuccess: ({ item }) => {
            toast.show(`Tracked as work: ${item.title}`);
            onSelect(item.id);
          },
          onError: (error) => toast.error(errorText(error)),
        },
      );
    },
    copyResume: (command: string) => {
      copy(command)
        .then((done) =>
          done ? toast.show("Copied the resume command") : toast.error("Copying is not available here."),
        )
        .catch((error) => toast.error(errorText(error)));
    },
    copyId: (row: RosterRow) => {
      copy(row.id)
        .then((done) => (done ? toast.show(`Copied ${row.short}`) : toast.error("Copying is not available here.")))
        .catch((error) => toast.error(errorText(error)));
    },
  };
}

function menuFor(row: RosterRow, navigation: Navigation, verbs: ReturnType<typeof useSessionVerbs>): MenuItem[] {
  const agentId = row.agentId;
  const resume = resumeCommand(row.id, row.cwd);
  return [
    ...(agentId && navigation
      ? [{ label: "Open in Paseo", icon: "ArrowUpRight", onPress: () => navigation.openAgent({ agentId }) }]
      : []),
    ...(canAdopt(row) ? [{ label: "Adopt into Maestro", icon: "ListPlus", onPress: () => verbs.adopt(row) }] : []),
    // A canonical session id and its folder: the command that resumes it where it ran.
    ...(resume
      ? [{ label: "Copy resume command", icon: "SquareTerminal", onPress: () => verbs.copyResume(resume) }]
      : []),
    { label: "Copy session id", icon: "Copy", onPress: () => verbs.copyId(row) },
  ];
}

const COLUMNS = { session: 2.2, state: 0.9, where: 2, active: 0.7, would: 2.2 } as const;

/** The roster: a table on the desktop, stacked rows on the phone, or a list beside the inspector. */
export function Roster({
  theme,
  rows,
  proposals,
  layout,
  showScope,
  selected,
  navigation,
  onOpen,
  onSelect,
}: {
  theme: PluginTheme;
  rows: readonly RosterRow[];
  proposals: ReadonlyMap<string, FleetProposal>;
  layout: "table" | "stack" | "list";
  showScope: boolean;
  selected: string | null;
  navigation: Navigation;
  onOpen: (row: RosterRow) => void;
  onSelect: (id: string) => void;
}) {
  const t = ramp(theme);
  const verbs = useSessionVerbs(onSelect);
  const [menu, setMenu] = useState<string | null>(null);
  if (rows.length === 0) {
    return <Text style={[t.muted, { paddingVertical: space[3] }]}>No session here.</Text>;
  }
  const meta = (row: RosterRow) =>
    [row.short, kindText(row), showScope ? row.scopeId : null].filter(Boolean).join(" · ");
  if (layout !== "table") {
    const list = layout === "list";
    return (
      <View
        style={{
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          overflow: "hidden",
        }}
      >
        {rows.map((row, index) => {
          const isSelected = selected === row.id;
          const would = wouldText(row, proposals.get(row.id) ?? null);
          return (
            <Press
              key={row.id}
              accessibilityLabel={`${rowName(row)}, ${stateWord(row.state)}, ${row.activeAt ? `active ${ago(row.activeAt)} ago` : "no activity known"}. The fleet would: ${would}`}
              selected={isSelected}
              ring={0}
              onPress={() => onOpen(row)}
              style={(pressed) => ({
                minHeight: 56,
                paddingVertical: space[2],
                paddingHorizontal: space[3],
                gap: 2,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: theme.colors.border,
                borderLeftWidth: 2,
                borderLeftColor: isSelected ? theme.colors.foreground : "transparent",
                backgroundColor: isSelected || pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
                <Text style={[t.body, { fontWeight: "600", flex: 1 }]}>{cutWords(rowName(row), list ? 30 : 34)}</Text>
                <Pill theme={theme} tone={stateTone(row.state)} label={stateWord(row.state)} />
              </View>
              <Text style={[t.meta, t.tabular]}>
                {cutWords(
                  [
                    row.activeAt ? ago(row.activeAt) : bucketOf(row.state) === "running" ? "now" : null,
                    list ? kindText(row) : middlePath(row.cwd, 28),
                    showScope ? row.scopeId : null,
                    list ? null : would,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  56,
                )}
              </Text>
            </Press>
          );
        })}
      </View>
    );
  }
  return (
    <View
      style={{
        borderRadius: radius.card,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space[3],
          paddingHorizontal: space[4],
          paddingVertical: space[2],
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
        }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {(
          [
            ["Session", COLUMNS.session],
            ["State", COLUMNS.state],
            ["Where", COLUMNS.where],
            ["Active", COLUMNS.active],
            ["The fleet would…", COLUMNS.would],
          ] as const
        ).map(([label, flex]) => (
          <Text key={label} style={[t.label, { flex }]}>
            {label.toUpperCase()}
          </Text>
        ))}
        <View style={{ width: 76 }} />
      </View>
      {rows.map((row, index) => {
        const agentId = row.agentId;
        const would = wouldText(row, proposals.get(row.id) ?? null);
        const open = menu === row.id;
        return (
          <View
            key={row.id}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space[3],
              paddingHorizontal: space[4],
              borderTopWidth: index === 0 ? 0 : 1,
              borderTopColor: theme.colors.border,
              zIndex: open ? 20 : 0,
              backgroundColor: selected === row.id ? theme.colors.surface2 : "transparent",
            }}
          >
            <Press
              accessibilityLabel={`${rowName(row)}, ${stateWord(row.state)}. The fleet would: ${would}. Open the inspector`}
              ring={4}
              onPress={() => onOpen(row)}
              outer={{ flex: COLUMNS.session + COLUMNS.state + COLUMNS.where + COLUMNS.active + COLUMNS.would }}
              style={(pressed) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: space[3],
                minHeight: 52,
                paddingVertical: space[2],
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ flex: COLUMNS.session, gap: 1 }}>
                <Text style={[t.body, { fontWeight: "600" }]}>{cutWords(rowName(row), 30)}</Text>
                <Text style={[t.mono, { fontSize: 11, color: theme.colors.foregroundMuted }]}>
                  {cutWords(meta(row), 34)}
                </Text>
              </View>
              <View style={{ flex: COLUMNS.state }}>
                <Pill theme={theme} tone={stateTone(row.state)} label={stateWord(row.state)} />
              </View>
              <View style={{ flex: COLUMNS.where, gap: 1 }}>
                <Text style={[t.mono, { fontSize: 12 }]}>{middlePath(row.cwd, 30) ?? "—"}</Text>
                {row.branch ? (
                  <Text style={[t.mono, { fontSize: 11, color: theme.colors.foregroundMuted }]}>
                    {cutWords(row.branch, 32)}
                  </Text>
                ) : null}
              </View>
              <Text style={[t.meta, t.tabular, { flex: COLUMNS.active }]}>
                {row.activeAt ? ago(row.activeAt) : bucketOf(row.state) === "running" ? "now" : "—"}
              </Text>
              <Text style={[t.body, { flex: COLUMNS.would }]} numberOfLines={2}>
                {would}
              </Text>
            </Press>
            <View style={{ width: 76, flexDirection: "row", justifyContent: "flex-end", gap: space[1] }}>
              {agentId && navigation ? (
                <Press
                  accessibilityLabel={`Open ${rowName(row)} in Paseo`}
                  hitSlop={4}
                  onPress={() => navigation.openAgent({ agentId })}
                  style={(pressed) => ({
                    width: 32,
                    height: 32,
                    borderRadius: radius.control,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: pressed ? theme.colors.surface2 : "transparent",
                  })}
                >
                  <Icon name="ArrowUpRight" size={16} color={theme.colors.foregroundMuted} />
                </Press>
              ) : null}
              <RowMenu
                theme={theme}
                label={`More for ${rowName(row)}`}
                open={open}
                onOpenChange={(next) => setMenu(next ? row.id : null)}
                items={menuFor(row, navigation, verbs)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The roster's filter chips, and how many each holds. */
export function RosterChips({
  theme,
  counts,
  value,
  phone,
  onChange,
}: {
  theme: PluginTheme;
  counts: Record<RosterFilter, number>;
  value: RosterFilter;
  phone: boolean;
  onChange: (filter: RosterFilter) => void;
}) {
  const base: { id: RosterFilter; label: string }[] = [
    { id: "attention", label: "Attention" },
    { id: "unmanaged", label: "Unmanaged" },
    { id: "running", label: "Running" },
    { id: "all", label: "All" },
  ];
  const extra: Record<string, string> = { idle: "Idle", failed: "Failed", out: "Out of scope" };
  const shown = extra[value] ? [...base, { id: value, label: extra[value] as string }] : base;
  return (
    <Segmented
      theme={theme}
      label="Show sessions"
      phone={phone}
      value={value}
      onChange={(id) => onChange(id as RosterFilter)}
      segments={shown.map((chip) => ({
        id: chip.id,
        label: chip.label,
        count: counts[chip.id],
        accessibilityLabel: `${chip.label}, ${plural(counts[chip.id], "session")}`,
      }))}
    />
  );
}

/** A history cell's paint: each kind by color and by shape (not listed is a dashed outline). */
function historyPaint(theme: PluginTheme, kind: HistoryKind) {
  switch (kind) {
    case "running":
      return { backgroundColor: infoInk(theme) };
    case "error":
      return { backgroundColor: theme.colors.statusDanger };
    case "attention":
      return { backgroundColor: theme.colors.statusWarning };
    case "unmanaged":
      return { backgroundColor: tint(theme.colors.foregroundMuted, 0.75) };
    case "quiet":
      return { backgroundColor: tint(theme.colors.statusSuccess, 0.55) };
    default:
      return {
        backgroundColor: "transparent",
        borderWidth: 1,
        borderStyle: "dashed" as const,
        borderColor: theme.colors.border,
      };
  }
}

/** A history cell's glyph (× error, ! wants a look), drawn over its paint. */
function HistoryGlyph({ theme, kind, size }: { theme: PluginTheme; kind: HistoryKind; size: number }) {
  const glyph = HISTORY_GLYPH[kind];
  if (!glyph) return null;
  return (
    <Text
      accessible={false}
      style={{
        color: kind === "error" ? "#ffffff" : theme.colors.surface0,
        fontSize: size,
        lineHeight: size + 2,
        fontWeight: "800",
      }}
    >
      {glyph}
    </Text>
  );
}

/** What the fleet saw of one session, a cell per tick read (oldest on the left), with its legend. */
function HistoryStrip({ theme, row }: { theme: PluginTheme; row: RosterRow }) {
  const t = ramp(theme);
  const cells = [...row.history].reverse();
  const shown = new Set(cells.map((cell) => historyKind(cell.classId)));
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: "row", gap: 3 }}>
        {cells.map((cell) => (
          <View
            key={cell.tick}
            accessible
            accessibilityRole="image"
            accessibilityLabel={
              cell.classId === null ? `Tick ${cell.tick}: not listed` : `Tick ${cell.tick}: class ${cell.classId}`
            }
            style={{
              flex: 1,
              height: 18,
              borderRadius: 4,
              alignItems: "center",
              justifyContent: "center",
              ...historyPaint(theme, historyKind(cell.classId)),
            }}
          >
            <HistoryGlyph theme={theme} kind={historyKind(cell.classId)} size={11} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: space[3], flexWrap: "wrap" }} accessibilityLabel="Legend">
        {/* The kinds this strip shows, and "not listed" always: an empty cell is never left to guess. */}
        {HISTORY_LEGEND.filter((entry) => shown.has(entry.kind) || entry.kind === "unlisted").map((entry) => (
          <View key={entry.kind} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                alignItems: "center",
                justifyContent: "center",
                ...historyPaint(theme, entry.kind),
              }}
            >
              <HistoryGlyph theme={theme} kind={entry.kind} size={8} />
            </View>
            <Text style={[t.meta, { fontSize: 11 }]}>{entry.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Your verdict on this one session's proposal: Agree, or Disagree with a note; given, it says so and offers the other. */
function InspectorVerdict({
  theme,
  scope,
  proposal,
  dryRun,
  phone,
}: {
  theme: PluginTheme;
  scope: string;
  proposal: FleetProposal;
  dryRun: boolean | null;
  phone: boolean;
}) {
  const t = ramp(theme);
  const review = useVerdict();
  const [disagreeing, setDisagreeing] = useState(false);
  const [note, setNote] = useState("");
  const verdict = proposal.review?.verdict ?? null;
  const who = displayName(proposal.session?.name ?? proposal.session?.short ?? proposal.key);
  if (disagreeing) {
    return (
      <View style={{ gap: space[2] }}>
        <NoteInput theme={theme} value={note} onChange={setNote} label={`Why disagree: ${who}`} />
        <View style={{ flexDirection: "row", gap: space[2] }}>
          <Verb
            theme={theme}
            icon="ThumbsDown"
            label="Disagree"
            phone={phone}
            busy={review.pending}
            accessibilityLabel={`Confirm disagree: ${who}`}
            onPress={() => review.decide(scope, [proposal.key], "reject", note, () => setDisagreeing(false))}
          />
          <Verb theme={theme} weight="quiet" label="Keep it" phone={phone} onPress={() => setDisagreeing(false)} />
        </View>
      </View>
    );
  }
  return (
    <View style={{ flexDirection: "row", gap: space[2], alignItems: "center", flexWrap: "wrap" }}>
      {verdict ? (
        <Pill
          theme={theme}
          tone={verdict === "accept" ? "success" : "danger"}
          icon={verdict === "accept" ? "Check" : "X"}
          label={verdict === "accept" ? "Agreed" : "Disagreed"}
        />
      ) : null}
      {verdict !== "accept" ? (
        <Verb
          theme={theme}
          icon="ThumbsUp"
          label={verdict ? "Change to agree" : "Agree"}
          weight={verdict ? "quiet" : "secondary"}
          phone={phone}
          busy={review.pending}
          accessibilityLabel={`Agree: ${who}`}
          onPress={() => review.decide(scope, [proposal.key], "accept", "")}
        />
      ) : null}
      {verdict !== "reject" ? (
        <Verb
          theme={theme}
          icon="ThumbsDown"
          label={verdict ? "Change to disagree…" : "Disagree…"}
          weight="quiet"
          phone={phone}
          accessibilityLabel={`Disagree: ${who}`}
          onPress={() => setDisagreeing(true)}
        />
      ) : null}
      <Text style={[t.meta, { flexBasis: "100%" }]}>{verdictNote(dryRun)}</Text>
    </View>
  );
}

/**
 * The inspector (draft B): one session's facts, what the fleet saw of it over
 * the ticks read, what it would do and your verdict on it, its evidence, and
 * its verbs. `onClose` is the desktop's close; the phone's sheet has its own.
 */
export function SessionInspector({
  theme,
  row,
  proposal,
  reportTick,
  dryRun = null,
  phone,
  navigation,
  onSelect,
  onClose,
}: {
  theme: PluginTheme;
  row: RosterRow;
  proposal: FleetProposal | null;
  reportTick: number | null;
  /** The scope's dry run: what a verdict does is said by it. */
  dryRun?: boolean | null;
  phone: boolean;
  navigation: Navigation;
  onSelect: (id: string) => void;
  onClose?: () => void;
}) {
  const t = ramp(theme);
  const verbs = useSessionVerbs(onSelect);
  const agentId = row.agentId;
  const resume = resumeCommand(row.id, row.cwd);
  const [raw, setRaw] = useState(false);
  const action = row.action && row.action !== "nothing" ? row.action : null;
  // Dry run is not a status: a neutral card, not the running blue.
  const accent = theme.colors.foreground;
  const active = activeWords(row.activeAt, bucketOf(row.state) === "running");
  const placed = placedWords(row.placement);
  const facts = [
    { label: "Where", value: row.cwd ?? "—", mono: true },
    ...(row.branch ? [{ label: "Branch", value: row.branch, mono: true }] : []),
    ...(active ? [{ label: "Last active", value: active, mono: true }] : []),
    { label: "Scope", value: row.scope ?? "none", mono: true },
    ...(placed ? [{ label: "Placed", value: placed }] : []),
    { label: "Session id", value: row.id, mono: true },
  ];
  return (
    <View style={{ gap: space[4] }}>
      <View style={{ gap: space[1] }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
          <Text style={[t.section, { fontSize: 18, lineHeight: 24, flexShrink: 1 }]} accessibilityRole="header">
            {rowName(row)}
          </Text>
          <Pill theme={theme} tone={stateTone(row.state)} label={stateWord(row.state)} />
          <View style={{ flex: 1 }} />
          {onClose ? (
            <Press
              accessibilityLabel="Close the inspector"
              hitSlop={6}
              onPress={onClose}
              style={(pressed) => ({
                width: 32,
                height: 32,
                borderRadius: radius.control,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <Icon name="X" size={16} color={theme.colors.foregroundMuted} />
            </Press>
          ) : null}
        </View>
        <Text style={[t.mono, { color: theme.colors.foregroundMuted }]}>
          {[row.short, kindText(row), agentId ? null : "not a Paseo agent"].filter(Boolean).join(" · ")}
        </Text>
      </View>

      <Facts theme={theme} rows={facts} />

      {row.history.length > 0 ? (
        <View style={{ gap: space[2] }}>
          <Text style={t.cardTitle}>{`What the fleet saw, last ${plural(row.history.length, "tick")}`}</Text>
          <HistoryStrip theme={theme} row={row} />
          <Text style={t.meta}>{historyText(row.history)}</Text>
        </View>
      ) : (
        <Text style={t.meta}>{historyText(row.history)}</Text>
      )}

      <View
        style={{
          padding: space[4],
          gap: space[2],
          borderRadius: radius.card,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: space[2] }}>
          <Icon name="FlaskConical" size={15} color={accent} />
          <Text style={[t.cardTitle, { color: accent, flex: 1 }]}>
            {action ? `The fleet would: ${plainAction(action).toLowerCase()}` : "The fleet would do nothing"}
          </Text>
        </View>
        {action && /^report\b/.test(action) ? <Text style={t.meta}>{REPORT_MEANS}</Text> : null}
        <Text style={t.body}>
          {action
            ? proposal
              ? agreeText(proposal.review)
              : "Not a proposal this scope can act on."
            : `It proposes nothing for this session${reportTick !== null ? ` at tick ${reportTick}` : ""}.`}
        </Text>
        {proposal ? (
          <InspectorVerdict theme={theme} scope={row.scopeId} proposal={proposal} dryRun={dryRun} phone={phone} />
        ) : null}
      </View>

      <View style={{ gap: space[2] }}>
        <Text style={t.cardTitle}>
          {reportTick !== null ? `What the report says (tick ${reportTick})` : "What the report says"}
        </Text>
        <Text style={t.body}>{evidenceSentence(row.evidence)}</Text>
        <View style={{ flexDirection: "row", marginLeft: -space[2] }}>
          <Verb
            theme={theme}
            weight="quiet"
            icon={raw ? "ChevronUp" : "ChevronDown"}
            label={raw ? "Hide details" : "Details"}
            phone={phone}
            accessibilityLabel={`${raw ? "Hide" : "Show"} the report's raw evidence for ${rowName(row)}`}
            onPress={() => setRaw((open) => !open)}
          />
        </View>
        {raw ? (
          <View
            style={{
              padding: space[3],
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface0,
            }}
          >
            <Text style={t.mono} selectable>
              {[
                `evidence: ${row.evidence ?? "none given"}`,
                `listing state: ${row.state ?? "unknown"}`,
                `fleet class: ${row.className ? `${row.className} (class ${row.classId})` : `class ${row.classId}`}`,
                `placement: ${row.placement ?? "none"}`,
                agentId ? `Paseo agent: ${agentId}` : "not a Paseo agent",
              ].join("\n")}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
        {agentId && navigation ? (
          <Verb
            theme={theme}
            weight="primary"
            icon="ArrowUpRight"
            label="Open in Paseo"
            phone={phone}
            grow={phone}
            accessibilityLabel={`Open ${rowName(row)} in Paseo`}
            onPress={() => navigation.openAgent({ agentId })}
          />
        ) : null}
        {!agentId && resume ? (
          // A session Paseo does not hold: the honest next step is to resume it where it ran.
          <Verb
            theme={theme}
            weight={bucketOf(row.state) === "failed" || row.state === "blocked" ? "primary" : "secondary"}
            icon="SquareTerminal"
            label="Copy resume command"
            phone={phone}
            grow={phone}
            accessibilityLabel={`Copy the command that resumes ${rowName(row)}`}
            onPress={() => verbs.copyResume(resume)}
          />
        ) : null}
        {canAdopt(row) ? (
          <Verb
            theme={theme}
            icon="ListPlus"
            label="Adopt into Maestro"
            phone={phone}
            grow={phone}
            busy={verbs.adopting}
            accessibilityLabel={`Adopt ${rowName(row)} into Maestro`}
            onPress={() => verbs.adopt(row)}
          />
        ) : null}
        <Verb
          theme={theme}
          weight="quiet"
          icon="Copy"
          label="Copy session id"
          phone={phone}
          accessibilityLabel={`Copy ${rowName(row)}'s session id`}
          onPress={() => verbs.copyId(row)}
        />
      </View>
    </View>
  );
}
