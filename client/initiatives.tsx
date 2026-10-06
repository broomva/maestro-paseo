// Initiatives: one card per `.control/initiatives` file of the workspace, read
// as origin/main holds it with a checkout's edit that has not landed shown
// beside it (server/initiatives.ts). Each card says what the initiative is
// for (the owner's words, or that they were never written down), where it
// stands, what it waits on (an ask opens in Decisions), its links, and its
// ideas. The ideas are idea-triage asks, answered here develop / park / kill
// through the same ask.answer as Decisions, at the ask's home, under its lock:
// develop also files a queued work item in the initiative's folder, held for
// you to start; park writes the wake date you chose.
//
// InitiativeNotices is the same where the rest of Maestro shows what needs
// you: the initiatives past their review date, or parked ones whose wake date
// came, which the header count counts.

import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginSurfaceProps, useRpc } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import { ANSWER_NOTE_CHARS, answerAsk, type DecisionAsk, homeKey } from "../shared/fleet";
import {
  fileIdeaWork,
  getInitiatives,
  type Initiative,
  type InitiativesView as InitiativesRead,
  ideaRef,
} from "../shared/initiatives";
import { sameAsk } from "./decisions";
import { homeText } from "./decisions-model";
import { errorText } from "./format";
import { useAttention, useRefresh } from "./hooks";
import {
  dateLine,
  defaultWake,
  driverText,
  evidenceUrl,
  INTENT_NOT_STATED,
  ideaMeta,
  ideaOutcome,
  ideasOf,
  ideasText,
  initiativeNoticeText,
  initiativesMeta,
  linearUrl,
  STATUS_TEXT,
  waitingText,
  wakeProblem,
} from "./initiatives-model";
import { Button, Card, Notice, radius, Section, space, useText } from "./ui";

/** Files change when a session lands a PR: a read every 60 s is plenty. */
const POLL_MS = 60_000;
const QUERY_KEY = ["maestro", "initiatives"] as const;

type Navigation = PluginSurfaceProps["navigation"];

export function useInitiatives() {
  const get = useRpc(getInitiatives);
  return useQuery({ queryKey: QUERY_KEY, queryFn: () => get({}), refetchInterval: POLL_MS });
}

/** Opens a link outside Maestro; one the host cannot open is said. */
export function useOpenUrl() {
  const toast = useToast();
  return (url: string) => {
    Linking.openURL(url).catch((error: unknown) => toast.error(`Could not open ${url}: ${errorText(error)}`));
  };
}

/**
 * An idea, answered in place: develop, park until a day you choose, or kill,
 * with your words beside it. The answer goes through ask.answer at the idea's
 * home, as Decisions sends it.
 */
export function IdeaCard({
  theme,
  ask,
  today,
  compact,
  onAnswered,
  onOpenWork,
}: {
  theme: PluginTheme;
  ask: DecisionAsk;
  today: string;
  compact: boolean;
  onAnswered: (answered: DecisionAsk) => void;
  onOpenWork: (id: string) => void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const refresh = useRefresh();
  const openUrl = useOpenUrl();
  const send = useRpc(answerAsk);
  const fileWork = useRpc(fileIdeaWork);
  // The tab's own read, from its cache: the work item each developed idea has. Never fetched or polled per card.
  const getView = useRpc(getInitiatives);
  const developed = useQuery({ queryKey: QUERY_KEY, queryFn: () => getView({}), enabled: false }).data?.developed ?? [];
  const [filed, setFiled] = useState<{ id: string; title: string } | null>(null);
  const ref = ideaRef(ask);
  // Only a develop has work: another answer for the same ref (another home's copy) never shows it.
  const work = ask.answerOption === "develop" ? (filed ?? developed.find((entry) => entry.ref === ref) ?? null) : null;
  const refile = useMutation({
    mutationFn: () => fileWork({ ledger: ask.ledger, id: ask.id, home: homeKey(ask.home) }),
    onSuccess: ({ work: filedNow, warning }) => {
      if (filedNow) setFiled({ id: filedNow.id, title: filedNow.title });
      else toast.error(warning ?? "No work item was filed for it.");
    },
    onError: (error) => toast.error(errorText(error)),
    onSettled: () => {
      void refresh();
    },
  });
  const answer = useMutation({
    mutationFn: send,
    onSuccess: ({ ask: answered, work }) => {
      if (work) setFiled({ id: work.id, title: work.title });
      onAnswered(answered);
    },
    onSettled: () => {
      void refresh();
    },
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [wake, setWake] = useState(() => defaultWake(ask.idea?.wake ?? null, today));
  const open = ask.state === "open";
  const option = ask.options.find((entry) => entry.id === chosen) ?? null;
  const parking = chosen === "park";
  const problem = parking ? wakeProblem(wake, today) : null;
  const evidence = evidenceUrl(ask.idea?.evidence ?? null);
  const submit = () =>
    answer.mutate(
      {
        where: { kind: "workspace", home: homeKey(ask.home) },
        ledger: ask.ledger,
        uid: ask.uid,
        id: ask.id,
        hash: ask.hash,
        option: chosen,
        note,
        ...(parking ? { wake } : {}),
      },
      {
        onSuccess: ({ warning }) => {
          setChosen(null);
          setNote("");
          if (warning) toast.error(warning);
        },
        onError: (error) => toast.error(errorText(error)),
      },
    );
  return (
    <Card theme={theme} style={{ gap: space[2] }}>
      <Text style={[text.body, { fontWeight: "600" }]}>{ask.headline ?? ask.idea?.idea ?? ask.id}</Text>
      {ask.idea?.idea && ask.headline ? <Text style={text.muted}>{ask.idea.idea}</Text> : null}
      <Text style={text.small}>{ideaMeta(ask)}</Text>
      {ask.stakes ? (
        <Text style={text.small}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>What waiting costs: </Text>
          {ask.stakes}
        </Text>
      ) : null}
      {evidence ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            variant="quiet"
            icon="ExternalLink"
            label={`Read ${ask.idea?.evidence}`}
            compact={compact}
            accessibilityLabel={`Open the evidence for ${ask.id}, ${ask.idea?.evidence}`}
            onPress={() => openUrl(evidence)}
          />
        </View>
      ) : null}
      {open ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={`Develop, park or kill ${ask.id}`}
          style={{ gap: space[2] }}
        >
          {ask.options.map((entry) => {
            const picked = chosen === entry.id;
            return (
              <Pressable
                key={entry.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: picked, disabled: answer.isPending }}
                aria-checked={picked}
                accessibilityLabel={`${entry.label}${entry.recommended ? ", recommended" : ""} for ${ask.id}`}
                disabled={answer.isPending}
                onPress={() => setChosen((current) => (current === entry.id ? null : entry.id))}
                style={({ pressed }) => ({
                  gap: 2,
                  padding: space[3],
                  borderRadius: radius.control,
                  borderWidth: picked ? 2 : 1,
                  borderColor: picked ? theme.colors.accent : theme.colors.border,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
                  <Text style={[text.body, { flex: 1, minWidth: 120, fontWeight: picked ? "600" : "400" }]}>
                    {entry.label}
                  </Text>
                  {entry.recommended ? (
                    <Text style={[text.small, { color: theme.colors.accent }]}>Recommended</Text>
                  ) : null}
                </View>
                {entry.consequence ? <Text style={text.small}>{entry.consequence}</Text> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {!open ? (
        <View style={{ gap: 2 }}>
          <Text style={[text.small, { color: theme.colors.statusSuccess }]}>{ideaOutcome(ask, work !== null)}</Text>
          {ask.answer ? (
            <Text style={text.small} selectable>
              {ask.answer}
            </Text>
          ) : null}
          {work ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="secondary"
                icon="ArrowUpRight"
                label={`Open the work: ${work.title}`}
                compact={compact}
                accessibilityLabel={`Open the work filed for ${ask.id}`}
                onPress={() => onOpenWork(work.id)}
              />
            </View>
          ) : ask.answerOption === "develop" ? (
            <View style={{ flexDirection: "row" }}>
              <Button
                theme={theme}
                variant="secondary"
                icon="Plus"
                label="File its work item"
                compact={compact}
                busy={refile.isPending}
                accessibilityLabel={`File the work for ${ask.id}`}
                onPress={() => refile.mutate()}
              />
            </View>
          ) : null}
        </View>
      ) : ask.refusal ? (
        <Notice theme={theme} tone="warn">
          {ask.refusal}
        </Notice>
      ) : (
        <View style={{ gap: space[2] }}>
          {parking ? (
            <View style={{ gap: space[1] }}>
              <Text style={text.small}>Wake it on (YYYY-MM-DD)</Text>
              <TextInput
                value={wake}
                onChangeText={setWake}
                maxLength={10}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.foregroundMuted}
                accessibilityLabel={`The wake date for ${ask.id}`}
                style={{
                  padding: space[3],
                  borderRadius: radius.control,
                  borderWidth: 1,
                  borderColor: problem ? theme.colors.statusWarning : theme.colors.border,
                  backgroundColor: theme.colors.surface2,
                  color: theme.colors.foreground,
                  fontSize: 14,
                }}
              />
              {problem ? <Text style={[text.small, { color: theme.colors.statusWarning }]}>{problem}</Text> : null}
            </View>
          ) : null}
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={ANSWER_NOTE_CHARS}
            placeholder="Add words (optional)"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel={`Your words for ${ask.id}`}
            style={{
              minHeight: 44,
              padding: space[3],
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.surface2,
              color: theme.colors.foreground,
              fontSize: 14,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap", alignItems: "center" }}>
            <Button
              theme={theme}
              variant="primary"
              icon="Check"
              label={option ? (parking ? `Park until ${wake}` : `Answer: ${option.label}`) : "Choose one"}
              compact={compact}
              busy={answer.isPending}
              disabled={!option || problem !== null}
              accessibilityLabel={`Answer ${ask.id}${option ? `: ${option.label}` : ""}`}
              onPress={submit}
            />
            <Text style={[text.small, { flex: 1, minWidth: 160 }]}>{homeText(ask)}</Text>
          </View>
        </View>
      )}
    </Card>
  );
}

/** Ideas, open first, then the triaged ones folded behind a button. */
function IdeaList({
  theme,
  ideas,
  today,
  compact,
  onAnswered,
  onOpenWork,
}: {
  theme: PluginTheme;
  ideas: readonly DecisionAsk[];
  today: string;
  compact: boolean;
  onAnswered: (answered: DecisionAsk) => void;
  onOpenWork: (id: string) => void;
}) {
  const text = useText(theme);
  // Ideas you answered here stay in view, saying so, rather than folding away at once.
  const [here, setHere] = useState<ReadonlySet<string>>(() => new Set());
  const [triagedOpen, setTriagedOpen] = useState(false);
  const keyOf = (ask: DecisionAsk) => `${homeKey(ask.home)}:${ask.ledger}:${ask.uid ?? ask.id}`;
  const answered = (ask: DecisionAsk) => {
    setHere((now) => new Set([...now, keyOf(ask)]));
    onAnswered(ask);
  };
  const shown = ideas.filter((ask) => ask.state === "open" || here.has(keyOf(ask)));
  const folded = ideas.filter((ask) => ask.state !== "open" && !here.has(keyOf(ask)));
  const card = (ask: DecisionAsk) => (
    <IdeaCard
      key={keyOf(ask)}
      theme={theme}
      ask={ask}
      today={today}
      compact={compact}
      onAnswered={answered}
      onOpenWork={onOpenWork}
    />
  );
  return (
    <View style={{ gap: space[2] }}>
      {shown.length === 0 && folded.length === 0 ? <Text style={text.muted}>No ideas filed.</Text> : null}
      {shown.length === 0 && folded.length > 0 ? <Text style={text.muted}>Every idea is triaged.</Text> : null}
      {shown.map(card)}
      {folded.length > 0 ? (
        <View style={{ flexDirection: "row" }}>
          <Button
            theme={theme}
            variant="quiet"
            icon={triagedOpen ? "ChevronUp" : "ChevronDown"}
            label={triagedOpen ? "Hide the triaged" : `Show ${folded.length} triaged`}
            compact={compact}
            onPress={() => setTriagedOpen((now) => !now)}
          />
        </View>
      ) : null}
      {triagedOpen ? folded.map(card) : null}
    </View>
  );
}

/** A row of link buttons under a label. */
function LinkRow({ theme, label, children }: { theme: PluginTheme; label: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space[1] }}>
      <Text style={[text.small, { fontWeight: "600", color: theme.colors.foreground }]}>{label}</Text>
      {children}
    </View>
  );
}

/** One initiative: what it is for, where it stands, what it waits on, its links and its ideas. */
export function InitiativeCard({
  theme,
  initiative,
  ideas,
  today,
  compact,
  navigation,
  onOpenDecision,
  onAnswered,
  onOpenWork,
}: {
  theme: PluginTheme;
  initiative: Initiative;
  ideas: readonly DecisionAsk[];
  today: string;
  compact: boolean;
  navigation: Navigation;
  onOpenDecision: (ledger: string, askId: string | null) => void;
  onAnswered: (answered: DecisionAsk) => void;
  onOpenWork: (id: string) => void;
}) {
  const text = useText(theme);
  const openUrl = useOpenUrl();
  const [ideasOpen, setIdeasOpen] = useState(false);
  const title = initiative.title ?? initiative.id;
  if (initiative.error) {
    return (
      <Card theme={theme} style={{ gap: space[2] }}>
        <Text style={[text.body, { fontWeight: "600" }]}>{title}</Text>
        <Notice theme={theme} tone="danger">
          {`This initiative cannot be read, so it is shown as it is: ${initiative.error}`}
        </Notice>
      </Card>
    );
  }
  const date = dateLine(initiative, today);
  const status = initiative.status ? STATUS_TEXT[initiative.status] : "No status";
  const local = initiative.home.kind === "checkout";
  return (
    <Card theme={theme} style={{ gap: space[2] }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: space[2], flexWrap: "wrap" }}>
        <Text style={[text.body, { flex: 1, minWidth: 160, fontWeight: "600" }]}>{title}</Text>
        <Text style={[text.small, { fontWeight: "600" }]}>{status}</Text>
      </View>
      <Text style={text.small}>
        {[initiative.id, local ? `only in ${initiative.home.path}, not on origin/main` : null]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {initiative.quote ? (
        <Text style={[text.body, { fontStyle: "italic" }]} selectable>
          {`“${initiative.quote}”`}
          <Text
            style={[text.small, { fontStyle: "normal" }]}
          >{` — ${initiative.intentSource ?? "source not given"}`}</Text>
        </Text>
      ) : (
        <Text style={[text.small, { fontStyle: "italic" }]}>{INTENT_NOT_STATED}</Text>
      )}
      {initiative.summary ? <Text style={text.muted}>{initiative.summary}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Text style={text.small}>{date.text}</Text>
        {date.badge ? (
          <Text
            accessibilityLabel={`${title}: ${date.badge}`}
            style={[
              text.small,
              {
                fontWeight: "600",
                color: theme.colors.statusWarning,
                borderWidth: 1,
                borderColor: theme.colors.statusWarning,
                borderRadius: radius.pill,
                paddingHorizontal: space[2],
              },
            ]}
          >
            {date.badge}
          </Text>
        ) : null}
        <Text style={text.small}>{driverText(initiative.driver)}</Text>
      </View>
      {initiative.nextAction ? (
        <Text style={text.small}>
          <Text style={{ fontWeight: "600", color: theme.colors.foreground }}>Next: </Text>
          {initiative.nextAction}
        </Text>
      ) : null}
      {initiative.waitingOn.length > 0 ? (
        <View style={{ gap: space[1] }}>
          <Text style={[text.small, { fontWeight: "600", color: theme.colors.foreground }]}>Waits on</Text>
          {initiative.waitingOn.map((entry) => {
            const ledger = entry.ledger;
            const pr = entry.kind === "pr" ? initiative.prs.find((link) => link.ref === entry.ref) : null;
            return (
              <View
                key={`${entry.kind}:${entry.ref}`}
                style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}
              >
                <Text style={[text.small, { flex: 1, minWidth: 160 }]}>{waitingText(entry)}</Text>
                {ledger ? (
                  <Button
                    theme={theme}
                    variant="quiet"
                    icon="Inbox"
                    label="Open in Decisions"
                    compact={compact}
                    accessibilityLabel={`Open ${entry.ref} in Decisions`}
                    onPress={() => onOpenDecision(ledger, entry.askId)}
                  />
                ) : pr?.url ? (
                  <Button
                    theme={theme}
                    variant="quiet"
                    icon="ExternalLink"
                    label="Open the PR"
                    compact={compact}
                    accessibilityLabel={`Open the PR ${entry.ref}`}
                    onPress={() => openUrl(pr.url)}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {initiative.local.map((edit) => (
        <Notice key={edit.path} theme={theme} tone="warn">
          {`Edited in ${edit.path}${edit.branch ? ` (${edit.branch})` : ""}, not on origin/main yet: ${edit.fields.join(", ")}.${edit.status ? ` There it is ${edit.status}.` : ""}${edit.nextAction ? ` Its next action there: ${edit.nextAction}` : ""}`}
        </Notice>
      ))}
      {initiative.linear.length > 0 ? (
        <LinkRow theme={theme} label="Linear">
          {initiative.linear.map((id) => (
            <Button
              key={id}
              theme={theme}
              variant="quiet"
              label={id}
              compact={compact}
              accessibilityLabel={`Open ${id} in Linear`}
              onPress={() => openUrl(linearUrl(id))}
            />
          ))}
        </LinkRow>
      ) : null}
      {initiative.prs.length > 0 ? (
        <LinkRow theme={theme} label="PRs">
          {initiative.prs.map((pr) => (
            <Button
              key={pr.ref}
              theme={theme}
              variant="quiet"
              label={pr.state ? `${pr.ref} · ${pr.state}` : pr.ref}
              compact={compact}
              disabled={!pr.url}
              accessibilityLabel={`Open the PR ${pr.ref}${pr.state ? `, ${pr.state}` : ""}`}
              onPress={() => openUrl(pr.url)}
            />
          ))}
        </LinkRow>
      ) : null}
      {initiative.sessions.length > 0 ? (
        <LinkRow theme={theme} label="Sessions">
          {initiative.sessions.map((session) => {
            const agentId = session.agentId;
            return agentId && navigation ? (
              <Button
                key={session.id}
                theme={theme}
                variant="quiet"
                icon="ArrowUpRight"
                label={session.id}
                compact={compact}
                accessibilityLabel={`Open the session ${session.id}`}
                onPress={() => navigation.openAgent({ agentId })}
              />
            ) : (
              <Text key={session.id} style={text.small} selectable>
                {`${session.id} (not a session on this Paseo)`}
              </Text>
            );
          })}
        </LinkRow>
      ) : null}
      {initiative.repos.length > 0 ? <Text style={text.small}>{`Repos: ${initiative.repos.join(", ")}`}</Text> : null}
      {initiative.exit ? <Text style={text.small}>{`Done when: ${initiative.exit}`}</Text> : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: space[2], flexWrap: "wrap" }}>
        <Text style={[text.small, { color: initiative.ideas.open > 0 ? theme.colors.accent : undefined }]}>
          {ideasText(initiative.ideas)}
        </Text>
        {ideas.length > 0 ? (
          <Button
            theme={theme}
            variant="quiet"
            icon={ideasOpen ? "ChevronUp" : "Lightbulb"}
            label={ideasOpen ? "Hide its ideas" : "Show its ideas"}
            compact={compact}
            accessibilityLabel={`${ideasOpen ? "Hide" : "Show"} the ideas for ${initiative.id}`}
            onPress={() => setIdeasOpen((now) => !now)}
          />
        ) : null}
      </View>
      {ideasOpen ? (
        <IdeaList
          theme={theme}
          ideas={ideas}
          today={today}
          compact={compact}
          onAnswered={onAnswered}
          onOpenWork={onOpenWork}
        />
      ) : null}
    </Card>
  );
}

/** The tab: every initiative, or every idea in one inbox. */
export function InitiativesView({
  theme,
  compact,
  navigation,
  onOpenDecision,
  onOpenWork,
}: {
  theme: PluginTheme;
  compact: boolean;
  navigation: Navigation;
  onOpenDecision: (ledger: string, askId: string | null) => void;
  onOpenWork: (id: string) => void;
}) {
  const text = useText(theme);
  const client = useQueryClient();
  const read = useInitiatives();
  const [inbox, setInbox] = useState(false);
  // An answer goes into every read held at once, so the card and the counts say so before the next poll.
  const onAnswered = (answered: DecisionAsk) =>
    client.setQueriesData<InitiativesRead>({ queryKey: QUERY_KEY }, (view) =>
      view ? { ...view, ideas: view.ideas.map((ask) => (sameAsk(ask, answered) ? answered : ask)) } : view,
    );
  if (read.isPending) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (read.isError) {
    return (
      <View style={{ gap: space[3] }}>
        <Notice theme={theme} tone="danger">
          {`Your initiatives could not be read: ${errorText(read.error)}`}
        </Notice>
        <Button theme={theme} label="Try again" onPress={() => void read.refetch()} />
      </View>
    );
  }
  const { controlRepo, today, initiatives, ideas, warnings } = read.data;
  const openIdeas = ideas.filter((ask) => ask.state === "open").length;
  return (
    <Section theme={theme} title="Initiatives" meta={initiativesMeta(initiatives, ideas)}>
      <Text style={text.small}>
        {`Each initiative in ${controlRepo || "your control repo"}/.control/initiatives, as origin/main holds it; a checkout's edit that has not landed is shown beside it. Ideas are answered here: develop files a queued work item, held for you to start; park sets the day it comes back.`}
      </Text>
      {warnings.slice(0, 3).map((warning) => (
        <Notice key={warning} theme={theme} tone="warn">
          {warning}
        </Notice>
      ))}
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: space[2], flexWrap: "wrap" }}>
        <Button
          theme={theme}
          variant={inbox ? "secondary" : "primary"}
          icon="Target"
          label="By initiative"
          compact={compact}
          onPress={() => setInbox(false)}
        />
        <Button
          theme={theme}
          variant={inbox ? "primary" : "secondary"}
          icon="Lightbulb"
          label={`All ideas (${openIdeas} open)`}
          compact={compact}
          onPress={() => setInbox(true)}
        />
      </View>
      {inbox ? (
        <IdeaList
          theme={theme}
          ideas={ideas}
          today={today}
          compact={compact}
          onAnswered={onAnswered}
          onOpenWork={onOpenWork}
        />
      ) : initiatives.length === 0 ? (
        <Card theme={theme}>
          <Text style={text.title}>No initiatives yet</Text>
          <Text style={text.muted}>
            {`An initiative is one file in ${controlRepo || "the control repo"}/.control/initiatives on origin/main. None is there yet.`}
          </Text>
        </Card>
      ) : (
        <View style={{ gap: space[3] }}>
          {initiatives.map((initiative) => (
            <InitiativeCard
              key={`${initiative.home.kind}:${initiative.file}`}
              theme={theme}
              initiative={initiative}
              ideas={ideasOf(ideas, initiative.id)}
              today={today}
              compact={compact}
              navigation={navigation}
              onOpenDecision={onOpenDecision}
              onAnswered={onAnswered}
              onOpenWork={onOpenWork}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

/** Initiatives past their date, where the rest of Maestro shows what needs you: exactly what the header count counts. */
export function InitiativeNotices({
  theme,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  compact: boolean;
  onOpen: () => void;
}) {
  // The one owner of the work.attention read (client/hooks.ts).
  const attention = useAttention();
  const notices = attention.data?.initiatives ?? [];
  if (notices.length === 0) return null;
  return (
    <Notice
      theme={theme}
      tone="warn"
      action={
        <Button
          theme={theme}
          icon="Target"
          label="Open Initiatives"
          compact={compact}
          accessibilityLabel={`Open Initiatives, ${notices.length} need a look`}
          onPress={onOpen}
        />
      }
    >
      {initiativeNoticeText(notices)}
    </Notice>
  );
}
