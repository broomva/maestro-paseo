import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  Clock3,
  Command,
  FileText,
  Inbox,
  Layers3,
  LockKeyhole,
  Maximize2,
  MessageSquare,
  Moon,
  RefreshCw,
  Search,
  Sun,
  Target,
  Workflow,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Snapshot, SnapshotSchema, VIEWS, type View } from "../../shared/mcp";
import "./style.css";

declare global {
  interface Window {
    __MAESTRO_PREVIEW__?: Snapshot;
  }
}
type Ask = NonNullable<Snapshot["asks"]>[number];
type Work = NonNullable<Snapshot["work"]>[number];
const tabs = [
  { id: "feed", title: "Feed", icon: Inbox },
  { id: "decisions", title: "Decisions", icon: MessageSquare },
  { id: "work", title: "Work", icon: Layers3 },
  { id: "health", title: "Health", icon: Activity },
  { id: "initiatives", title: "Initiatives", icon: Target },
] as const;
const words = (value: string) => value.replaceAll("_", " ").replaceAll("-", " ");
function time(value: string | null) {
  if (!value) return "Not observed";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({ title = "Nothing here right now", children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Check size={21} />
      <h3>{title}</h3>
      <p>{children ?? "New work and decisions will appear here."}</p>
    </div>
  );
}
function Section({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-heading">
        <h2>
          {title}
          {count !== undefined && <span className="count">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function Metric({
  value,
  label,
  detail,
  tone = "",
  onClick,
}: {
  value: number | string;
  label: string;
  detail: string;
  tone?: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
      <span className="metric-detail">{detail}</span>
    </>
  );
  return onClick ? (
    <button type="button" className={`metric ${tone}`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={`metric ${tone}`}>{content}</div>
  );
}

function Maestro() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined") {
      const q = new URLSearchParams(window.location.search).get("view");
      if (q && (VIEWS as readonly string[]).includes(q)) return q as View;
      const h = window.location.hash.replace("#", "");
      if (h && (VIEWS as readonly string[]).includes(h)) return h as View;
    }
    return "feed";
  });
  const [search, setSearch] = useState("");
  const [healthTab, setHealthTab] = useState("overview");
  const [workTab, setWorkTab] = useState("list");
  const [filter, setFilter] = useState("all");
  const [ledger, setLedger] = useState("all");
  const [selectedAsk, setSelectedAsk] = useState<Ask | null>(null);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [answersOpen, setAnswersOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [armedAskKey, setArmedAskKey] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const [workSelection, setSelectedWork] = useState<Work | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { option: string; note: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [toast, setToast] = useState("");
  const app = useRef<App | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const hasData = useRef(false);
  const preview =
    typeof window !== "undefined" && (window.__MAESTRO_PREVIEW__ !== undefined || window.parent === window);

  const adopt = useCallback((raw: unknown) => {
    const next = SnapshotSchema.parse(raw);
    if (next.source === "unavailable" && hasData.current) {
      setError(next.errors.connection ?? "Maestro could not be refreshed.");
      return;
    }
    setSnapshot(next);
    hasData.current = next.source !== "unavailable";
    setError(null);
  }, []);
  async function refresh() {
    if (busy) return;
    setBusy(true);
    try {
      if (window.__MAESTRO_PREVIEW__) adopt(window.__MAESTRO_PREVIEW__);
      else if (app.current) {
        const result = await app.current.callServerTool({ name: "maestro_snapshot", arguments: {} });
        if (result.isError) throw new Error("Maestro could not be refreshed. Try again.");
        adopt((result.structuredContent as { snapshot?: unknown })?.snapshot);
      } else {
        const response = await fetch("/api/snapshot", { cache: "no-store" });
        if (!response.ok) throw new Error("The preview could not read Maestro. Try again.");
        adopt(await response.json());
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Maestro could not be refreshed.");
    } finally {
      setBusy(false);
    }
  }
  refreshRef.current = refresh;
  useEffect(() => {
    let disposed = false;
    if (preview) {
      document.documentElement.dataset.theme = "dark";
      void refreshRef.current();
      return;
    }
    const client = new App({ name: "Maestro", version: "0.1.0" }, {});
    app.current = client;
    const style = (ctx: ReturnType<App["getHostContext"]>) => {
      if (ctx?.theme) {
        applyDocumentTheme(ctx.theme);
        setTheme(ctx.theme);
      }
      if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };
    client.onhostcontextchanged = (ctx) => style(ctx);
    client.ontoolresult = (result) => {
      if (disposed) return;
      try {
        const data = result.structuredContent as { snapshot?: unknown; view?: View };
        adopt(data.snapshot);
        if (data.view && VIEWS.includes(data.view)) setView(data.view);
      } catch {
        setError("Maestro returned an unreadable snapshot. Refresh to try again.");
      }
    };
    client.onteardown = async () => {
      disposed = true;
      return {};
    };
    client
      .connect()
      .then(() => {
        if (!disposed) {
          style(client.getHostContext());
          setConnected(true);
        }
      })
      .catch(() => {
        if (!disposed) setError("The connection to T3 was interrupted. Reopen Maestro to reconnect.");
      });
    return () => {
      disposed = true;
      app.current = null;
      void client.close();
    };
  }, [preview, adopt]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden && hasData.current && !window.__MAESTRO_PREVIEW__) void refreshRef.current();
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  async function discuss(ask: Ask) {
    if (!app.current || snapshot?.source !== "live") return;
    try {
      await app.current.sendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: `Help me understand this Maestro decision: ${ask.title}\nLedger: ${ask.ledger}; ask: ${ask.id}. Read the current ask and explain the options. Do not answer it on my behalf.`,
          },
        ],
      });
    } catch {
      setToast("The message was not sent. You can ask about this decision in chat.");
    }
  }
  const q = search.toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(q);
  const work = snapshot?.work ?? [];
  const selectedWork = work.find((w) => w.id === workSelection?.id) ?? null;
  const asks = snapshot?.asks?.filter((a) => a.state === "open") ?? [];
  const notices = snapshot?.notices ?? [];
  const needs = snapshot?.needs;
  const running = work.filter((w) => w.state === "running");
  const initiatives = snapshot?.initiatives ?? [];
  const due = initiatives.filter((i) => i.due);
  const askQueue = asks.filter(
    (a) =>
      (ledger === "all" || a.ledger === ledger) &&
      (filter !== "waiting" || a.waiting) &&
      matches(`${a.title} ${a.ledger}`),
  );
  const decision = selectedAsk ?? askQueue[0] ?? null;
  const currentAsk = decision && snapshot?.asks?.find((a) => a.key === decision.key);
  const changedAsk = decision && selectedAsk && (currentAsk?.state !== "open" || currentAsk.hash !== decision.hash);
  const draft = decision ? (drafts[decision.key] ?? { option: "", note: "" }) : { option: "", note: "" };
  function updateDraft(next: Partial<typeof draft>) {
    if (decision) setDrafts((old) => ({ ...old, [decision.key]: { ...draft, ...next } }));
  }
  function chooseView(next: View) {
    setView(next);
    setSearch("");
    setFilter("all");
    setSelectedWork(null);
    if (next === "decisions") {
      setSheetOpen(true);
    }
  }
  function openNeed(need: NonNullable<Snapshot["needs"]>["rows"][number]) {
    const target = need.target;
    if (target?.kind === "initiative") chooseView("initiatives");
    else if (target?.kind === "ask") {
      const a = asks.find((a) => a.key === target.id);
      if (a) {
        setSelectedAsk(a);
        setSheetOpen(true);
        chooseView("decisions");
      } else setToast("This decision is not in the current snapshot. Refresh or open it in Paseo.");
    } else if (target?.kind === "work") {
      chooseView("work");
      const item = work.find((w) => w.id === target.id);
      if (item) setSelectedWork(item);
      else setToast("This work item is not in the current snapshot. Refresh or open it in Paseo.");
    } else setToast("Open this hold in Paseo to see its context.");
  }
  interface AskSeries {
    id: string;
    title: string;
    ledger: string;
    asks: Ask[];
    open: number;
    waits: number;
    blocking: boolean;
    oldest: string;
  }

  const seriesMap = new Map<string, AskSeries>();
  for (const ask of askQueue) {
    const ledgerKey = ask.ledger;
    const scope = "maestro";
    const id = `${scope}/${ledgerKey}`;
    const cleanLedger = ledgerKey.replace(/\.ya?ml$/, "");
    const title = `${scope} · ${words(cleanLedger)}`;
    let s = seriesMap.get(id);
    if (!s) {
      s = { id, title, ledger: ledgerKey, asks: [], open: 0, waits: 0, blocking: false, oldest: "" };
      seriesMap.set(id, s);
    }
    s.asks.push(ask);
    s.open += 1;
    if (ask.waiting) {
      s.waits += 1;
      s.blocking = true;
    }
    if (ask.askedAt && (s.oldest === "" || ask.askedAt < s.oldest)) {
      s.oldest = ask.askedAt;
    }
  }
  const seriesList = Array.from(seriesMap.values());
  const activeSeries = seriesList.find((s) => s.asks.some((a) => a.key === decision?.key)) ?? seriesList[0] ?? null;
  const activeSeriesAsks = activeSeries ? activeSeries.asks : [];
  const currentAskIndex = decision ? activeSeriesAsks.findIndex((a) => a.key === decision.key) : 0;

  const onDragStart = (clientY: number) => {
    dragStartY.current = clientY;
    setIsDragging(true);
  };
  const onDragMove = (clientY: number) => {
    if (!isDragging) return;
    const diff = clientY - dragStartY.current;
    setDragY(diff > 0 ? diff : 0);
  };
  const onDragEnd = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (dragY > 110) {
      setSheetOpen(false);
      setSelectedAsk(null);
    }
    setDragY(0);
  };

  async function handleAnswer() {
    if (!decision) return;
    const chosenOptionId = draft.option || null;
    if (!chosenOptionId) {
      setToast("Choose an option first before answering.");
      return;
    }
    const pickedOption = decision.options.find((o) => o.id === chosenOptionId);

    if (pickedOption?.reversible === false && armedAskKey !== decision.key) {
      setArmedAskKey(decision.key);
      setToast("Irreversible option selected. Tap again to confirm.");
      return;
    }

    setSubmitting(true);
    try {
      let newSnapshot: Snapshot | undefined;
      if (app.current) {
        const toolRes = await app.current.callServerTool({
          name: "maestro_answer_ask",
          arguments: {
            ledger: decision.ledger,
            id: decision.id,
            option: chosenOptionId,
            note: draft.note || "",
          },
        });
        if (toolRes.isError) {
          const msg = (toolRes.content as Array<{ text?: string }>)?.[0]?.text || "Answer could not be recorded.";
          throw new Error(msg);
        }
        const data = toolRes.structuredContent as { ok?: boolean; ask?: unknown; snapshot?: Snapshot };
        if (data?.snapshot) newSnapshot = data.snapshot;
      } else {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ledger: decision.ledger,
            id: decision.id,
            option: chosenOptionId,
            note: draft.note || "",
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "Answer could not be recorded.");
        }
        if (data.snapshot) newSnapshot = data.snapshot;
      }

      setArmedAskKey(null);
      setToast(`Answer recorded for "${decision.title}"`);

      if (newSnapshot) {
        adopt(newSnapshot);
      } else {
        setSnapshot((old) => {
          if (!old || !old.asks) return old;
          return {
            ...old,
            asks: old.asks.map((a) => (a.key === decision.key ? { ...a, state: "answered" as const } : a)),
            answers: old.answers ? { ...old.answers, acted: (old.answers.acted ?? 0) + 1 } : old.answers,
          };
        });
      }

      const remainingInSeries = activeSeriesAsks.filter((a) => a.key !== decision.key && a.state === "open");
      if (remainingInSeries.length > 0) {
        setSelectedAsk(remainingInSeries[0]);
      } else {
        setSelectedAsk(null);
        setSheetOpen(false);
        setToast(`${activeSeries?.title ?? "Series"}: nothing left to answer`);
      }

      void refresh();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Failed to record answer.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSkip() {
    if (!decision || !activeSeries) return;
    const nextIdx = currentAskIndex + 1;
    if (nextIdx < activeSeriesAsks.length) {
      setSelectedAsk(activeSeriesAsks[nextIdx]);
      setArmedAskKey(null);
    } else {
      setToast(`${activeSeries.title}: reached end of series`);
      setSheetOpen(false);
      setSelectedAsk(null);
    }
  }
  const badgeCounts = {
    feed: needs?.total,
    decisions: asks.length,
    work: running.length,
    health: notices.length,
    initiatives: due.length,
  };
  const partial = Object.keys(snapshot?.errors ?? {}).length > 0;

  return (
    <main className="maestro">
      <div className="chrome">
        <header className="toolbar">
          <div className="identity">
            <div className="mark">
              <Command size={17} />
            </div>
            <div>
              <h1>Maestro</h1>
              <span className="subtitle">Your work, under control</span>
            </div>
          </div>
          <div className="toolbar-actions">
            <Badge tone={snapshot?.source === "sample" ? "warning" : "neutral"}>
              {snapshot?.source === "sample" ? "Sample data" : "Read only"}
            </Badge>
            {preview && (
              <button
                type="button"
                className="icon-button"
                aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
                onClick={() => {
                  const next = theme === "dark" ? "light" : "dark";
                  setTheme(next);
                  document.documentElement.dataset.theme = next;
                }}
              >
                {theme === "dark" ? <Sun /> : <Moon />}
              </button>
            )}
            {connected && (
              <button
                type="button"
                className="icon-button"
                aria-label="Open Maestro full screen"
                onClick={() => {
                  void app.current
                    ?.requestDisplayMode({ mode: "fullscreen" })
                    .catch(() => setToast("Full screen isn't available in this client."));
                }}
              >
                <Maximize2 />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label="Refresh Maestro"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <RefreshCw className={busy ? "refreshing" : ""} />
            </button>
          </div>
        </header>
        <div className="navigation">
          <nav className="tabs" aria-label="Maestro views">
            {tabs.map((t) => (
              <button
                type="button"
                key={t.id}
                aria-current={view === t.id ? "page" : undefined}
                onClick={() => chooseView(t.id)}
              >
                <t.icon size={14} />
                <span>{t.title}</span>
                {badgeCounts[t.id] !== undefined && badgeCounts[t.id] !== 0 && (
                  <span className="tab-count">{badgeCounts[t.id]}</span>
                )}
              </button>
            ))}
          </nav>
          <label className="search">
            <Search size={14} />
            <input
              aria-label="Search this view"
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" aria-label="Clear search" onClick={() => setSearch("")}>
                <X size={12} />
              </button>
            )}
          </label>
        </div>
      </div>
      <div className="status-line">
        <span>
          <span className={`connection-dot ${snapshot?.source === "live" && !error && !partial ? "online" : ""}`} />
          {snapshot?.source === "sample"
            ? "Preview with fictional work"
            : snapshot?.source === "live"
              ? error || partial
                ? "Some information is unavailable"
                : "Connected to Maestro"
              : "Waiting for Maestro"}
        </span>
        <span>{snapshot ? `Updated ${time(snapshot.capturedAt)}` : "Connecting…"}</span>
      </div>
      {(error || partial) && (
        <div className="notice" role="status">
          <CircleAlert size={15} />
          <div>
            <strong>{error ?? "Some sources could not be read"}</strong>
            {!error && (
              <p>
                {Object.entries(snapshot?.errors ?? {})
                  .map(([key, value]) => `${words(key)}: ${value}`)
                  .join(" ")}
              </p>
            )}
          </div>
        </div>
      )}
      {!snapshot ? (
        <Empty title={error ? "Maestro couldn't connect" : "Opening Maestro"}>
          {error ?? "Reading the latest work and decisions."}
        </Empty>
      ) : snapshot.source === "unavailable" ? (
        <Empty title="Maestro isn't connected">
          The read-only bridge is not available yet. Connect it in Paseo, then use Refresh.
        </Empty>
      ) : (
        <>
          {view === "feed" && (
            <>
              <div className="metrics">
                <Metric
                  value={needs?.total ?? "—"}
                  label="Needs you"
                  detail="Holds waiting on your decision"
                  tone="attention"
                  onClick={() => setFilter(filter === "holds" ? "all" : "holds")}
                />
                <Metric
                  value={snapshot.work ? running.length : "—"}
                  label="Running"
                  detail="Sessions taking turns"
                  onClick={() => chooseView("work")}
                />
                <Metric
                  value={snapshot.answers?.acted ?? "—"}
                  label="Acted on"
                  detail="Answers with a recorded outcome"
                  onClick={() => chooseView("decisions")}
                />
              </div>
              <div className="feed-layout">
                <div>
                  <Section title="Needs your attention" count={needs?.total}>
                    {needs === null ? (
                      <Empty title="Holds couldn't be read">This does not mean nothing needs you.</Empty>
                    ) : (needs?.rows.filter((n) => matches(n.title)) ?? []).length ? (
                      needs?.rows
                        .filter((n) => matches(n.title))
                        .map((n) => (
                          <button type="button" className="need-row" key={n.key} onClick={() => openNeed(n)}>
                            <span className="need-icon">
                              {n.kind === "ask" ? <MessageSquare /> : <ArrowDownLeft />}
                            </span>
                            <span className="row-content">
                              <span className="row-meta">
                                {n.scope} <span>·</span> {words(n.kind)}
                              </span>
                              <strong>{n.title}</strong>
                              <span className="row-hint">Open the context before deciding</span>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))
                    ) : (
                      <Empty title={search ? "No matching holds" : "You're clear for now"}>
                        Work can continue without a decision from you.
                      </Empty>
                    )}
                  </Section>
                  {filter !== "holds" && (
                    <Section title="In motion" count={running.length}>
                      {running
                        .filter((w) => matches(w.title))
                        .map((w) => (
                          <button
                            type="button"
                            className="work-row"
                            key={w.id}
                            onClick={() => {
                              chooseView("work");
                              setSelectedWork(w);
                            }}
                          >
                            <span className="running-dot" />
                            <span className="row-content">
                              <strong>{w.title}</strong>
                              <span className="row-meta">
                                {w.ticket ?? w.scope} <span>·</span> {w.provider ?? "Worker"}
                              </span>
                            </span>
                            <Badge tone="info">Running</Badge>
                          </button>
                        ))}
                      {!running.length && <p className="muted small">No running work was observed.</p>}
                    </Section>
                  )}
                </div>
                <aside>
                  <Section title="Decide when you're ready" count={asks.filter((a) => !a.waiting).length}>
                    {asks
                      .filter((a) => !a.waiting)
                      .slice(0, 3)
                      .map((a) => (
                        <button
                          type="button"
                          key={a.key}
                          className="quiet-card"
                          onClick={() => {
                            chooseView("decisions");
                            setSelectedAsk(a);
                          }}
                        >
                          <span className="row-meta">{a.ledger}</span>
                          <strong>{a.title}</strong>
                          <span className="small muted">Not blocking work</span>
                        </button>
                      ))}
                    {!asks.some((a) => !a.waiting) && (
                      <p className="muted small">No open decisions beyond your current holds.</p>
                    )}
                  </Section>
                  <div className="callout">
                    <LockKeyhole size={15} />
                    <p>
                      Your decisions stay yours. This first version reads Maestro without starting work or submitting
                      answers.
                    </p>
                  </div>
                </aside>
              </div>
            </>
          )}
          {view === "decisions" && (
            <>
              <div className="view-controls">
                <div className="segmented">
                  <button
                    type="button"
                    aria-pressed={filter !== "waiting"}
                    onClick={() => {
                      setFilter("all");
                      setSelectedAsk(null);
                    }}
                  >
                    All open
                  </button>
                  <button
                    type="button"
                    aria-pressed={filter === "waiting"}
                    onClick={() => {
                      setFilter("waiting");
                      setSelectedAsk(null);
                    }}
                  >
                    Waits on you
                  </button>
                </div>
                <label className="select-label">
                  Ledger{" "}
                  <select
                    aria-label="Filter by ledger"
                    value={ledger}
                    onChange={(e) => {
                      setLedger(e.target.value);
                      setSelectedAsk(null);
                    }}
                  >
                    <option value="all">All ledgers</option>
                    {[...new Set(asks.map((a) => a.ledger))].map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>

              {/* Answers Summary (Accordion) */}
              <div className="answers-summary-card">
                <button
                  type="button"
                  className="answers-summary-header"
                  aria-expanded={answersOpen}
                  onClick={() => setAnswersOpen(!answersOpen)}
                >
                  <div className="answers-summary-info">
                    <strong>Your answers</strong>
                    <span className="answers-summary-line">
                      {[
                        `${snapshot.answers?.waitingToLand ?? 0} waiting to land`,
                        `${snapshot.answers?.routed ?? 0} routed`,
                        `${snapshot.answers?.acted ?? 0} acted on`,
                        `${snapshot.answers?.held ?? 0} held`,
                      ].join(" · ")}
                    </span>
                  </div>
                  {answersOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
                {answersOpen && (
                  <div className="answers-summary-body">
                    <div className="answer-stages">
                      <div>
                        <strong>{asks.length}</strong>
                        <span>Open</span>
                      </div>
                      <div>
                        <strong>{snapshot.answers?.waitingToLand ?? "—"}</strong>
                        <span>Waiting to land</span>
                      </div>
                      <div>
                        <strong>{snapshot.answers?.routed ?? "—"}</strong>
                        <span>Routed</span>
                      </div>
                      <div>
                        <strong>{snapshot.answers?.acted ?? "—"}</strong>
                        <span>Acted on</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Decisions layout: Series List on left/main, and Draggable Bottom Sheet/Card on right/overlay */}
              <div className="decision-layout">
                <div className="decision-dashboard-series">
                  <Section title="Open series" count={seriesList.length}>
                    <div className="series-list">
                      {seriesList.map((s) => {
                        const isSelected = activeSeries?.id === s.id;
                        return (
                          <button
                            type="button"
                            key={s.id}
                            className={`series-row quiet-card ${isSelected ? "selected" : ""}`}
                            onClick={() => {
                              setSelectedAsk(s.asks[0] ?? null);
                              setSheetOpen(true);
                            }}
                          >
                            <span className={`status-dot ${s.waits > 0 ? "needs" : "muted"}`} />
                            <div className="row-content">
                              <strong>{s.title}</strong>
                              <span className="row-meta">
                                {s.open} open {s.waits > 0 ? `· ${s.waits} wait on you` : ""}{" "}
                                {s.oldest ? `· ${time(s.oldest)}` : ""}
                              </span>
                            </div>
                            {s.blocking && <Badge tone="attention">Blocking</Badge>}
                            <ChevronRight size={16} className="muted" />
                          </button>
                        );
                      })}
                      {!seriesList.length && (
                        <Empty title={snapshot.asks === null ? "Decisions couldn't be read" : "No open decisions"}>
                          All caught up. New decisions requiring your input will appear here.
                        </Empty>
                      )}
                    </div>
                  </Section>
                </div>

                {decision && (
                  <>
                    {/* Mobile Sheet Backdrop Scrim */}
                    {sheetOpen && (
                      <div
                        className="sheet-backdrop"
                        aria-hidden="true"
                        onClick={() => {
                          setSheetOpen(false);
                          setSelectedAsk(null);
                        }}
                      />
                    )}

                    {/* Draggable Bottom Sheet Modal (Mobile) / Side Card (Desktop) */}
                    <div
                      className={`inspector-sheet ${sheetOpen ? "open" : "closed"}`}
                      style={
                        dragY > 0
                          ? { transform: `translateY(${dragY}px)`, transition: isDragging ? "none" : undefined }
                          : undefined
                      }
                    >
                      {/* Draggable Header (DetailHeader) */}
                      <div
                        className="sheet-header"
                        onTouchStart={(e) => onDragStart(e.touches[0].clientY)}
                        onTouchMove={(e) => onDragMove(e.touches[0].clientY)}
                        onTouchEnd={onDragEnd}
                      >
                        <div className="drag-handle" />
                        <div className="sheet-header-nav">
                          <button
                            type="button"
                            className="round-icon-button"
                            aria-label="Close decision details"
                            onClick={() => {
                              setSheetOpen(false);
                              setSelectedAsk(null);
                            }}
                          >
                            <ChevronDown size={18} />
                          </button>
                          <div className="sheet-header-title">
                            <strong>
                              Ask · {currentAskIndex + 1} of {activeSeriesAsks.length}
                            </strong>
                            <div className="segments-bar">
                              {activeSeriesAsks.length <= 12 ? (
                                activeSeriesAsks.map((a, idx) => {
                                  const segState =
                                    idx < currentAskIndex ? "done" : idx === currentAskIndex ? "current" : "todo";
                                  return <span key={a.key} className={`segment ${segState}`} />;
                                })
                              ) : (
                                <div className="progress-bar-track">
                                  <div
                                    className="progress-bar-fill"
                                    style={{
                                      width: `${(Math.min(currentAskIndex + 1, activeSeriesAsks.length) / activeSeriesAsks.length) * 100}%`,
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                          {connected && snapshot.source === "live" ? (
                            <button
                              type="button"
                              className="round-icon-button"
                              aria-label="Discuss in chat"
                              onClick={() => void discuss(decision)}
                            >
                              <MessageSquare size={16} />
                            </button>
                          ) : (
                            <div style={{ width: 32 }} />
                          )}
                        </div>
                      </div>

                      {/* Scrollable Decision Card Body */}
                      <div className="sheet-scroll">
                        <article className="decision-card">
                          <div className="decision-top">
                            <span className="row-meta">
                              <MessageSquare size={13} />
                              {decision.ledger}
                            </span>
                            <Badge tone={decision.waiting ? "info" : "neutral"}>
                              {decision.waiting ? "Waits on you" : "Not blocking"}
                            </Badge>
                          </div>
                          <h2>{decision.title}</h2>
                          {decision.summary && <p className="decision-summary">{decision.summary}</p>}
                          {decision.question && decision.question !== decision.title && (
                            <p className="muted">{decision.question}</p>
                          )}
                          {(changedAsk || decision.refusal) && (
                            <div className="notice">
                              <CircleAlert size={14} />
                              <p>
                                {decision.refusal ??
                                  "This decision changed or is no longer open. The original card is kept here so it cannot be replaced under your selection."}
                              </p>
                            </div>
                          )}
                          <div className="decision-reasons">
                            {decision.stakes && (
                              <div>
                                <span>What waiting costs</span>
                                <p>{decision.stakes}</p>
                              </div>
                            )}
                            {decision.whyYou && (
                              <div>
                                <span>Why you</span>
                                <p>{decision.whyYou}</p>
                              </div>
                            )}
                          </div>
                          <fieldset className="options">
                            <legend className="sr-only">Decision options</legend>
                            {decision.options.map((o) => (
                              <label className={`option ${draft.option === o.id ? "selected" : ""}`} key={o.id}>
                                <input
                                  type="radio"
                                  name="decision-option"
                                  checked={draft.option === o.id}
                                  onChange={() => {
                                    updateDraft({ option: o.id });
                                    setArmedAskKey(null);
                                  }}
                                />
                                <span>
                                  <strong>
                                    {o.label}
                                    {o.recommended && <span className="recommended">Recommended</span>}
                                  </strong>
                                  {o.consequence && <span className="option-detail">{o.consequence}</span>}
                                  {o.reversible === false && <span className="irreversible">Cannot be undone</span>}
                                </span>
                              </label>
                            ))}
                          </fieldset>
                          {decision.fallback && (
                            <p className="silence">
                              <Clock3 size={13} />
                              <span>If you say nothing: {decision.fallback}</span>
                            </p>
                          )}
                          <label className="note-label">
                            Your note <span>Kept with this answer</span>
                            <textarea
                              value={draft.note}
                              onChange={(e) => updateDraft({ note: e.target.value })}
                              placeholder="A condition or a question to discuss…"
                            />
                          </label>
                          {(decision.details || decision.sources.length > 0) && (
                            <details className="details">
                              <summary>
                                Evidence and details
                                <FileText size={13} />
                              </summary>
                              {decision.details && <p className="prewrap">{decision.details}</p>}
                              {decision.sources.map((s) => (
                                <div className="source-row" key={`${s.label}:${s.ref}`}>
                                  <FileText size={13} />
                                  <span>
                                    {s.label}
                                    <small>{s.ref}</small>
                                  </span>
                                </div>
                              ))}
                            </details>
                          )}
                        </article>
                      </div>

                      {/* Viewport-Pinned Action Bar: ALWAYS ON VIEWPORT */}
                      <div className="sheet-bar">
                        <button type="button" className="skip-button" onClick={handleSkip} disabled={submitting}>
                          Skip
                        </button>
                        <button
                          type="button"
                          className={`answer-button ${armedAskKey === decision.key ? "armed" : ""}`}
                          onClick={() => void handleAnswer()}
                          disabled={submitting}
                        >
                          {submitting ? (
                            "Recording…"
                          ) : armedAskKey === decision.key ? (
                            "Confirm: Cannot be undone"
                          ) : (
                            <>
                              <span>Answer</span>
                              <ArrowRight size={14} />
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {view === "work" && (
            <>
              <div className="view-controls">
                <div className="segmented">
                  {["list", "board"].map((t) => (
                    <button type="button" key={t} aria-pressed={workTab === t} onClick={() => setWorkTab(t)}>
                      {t === "list" ? "List" : "Board"}
                    </button>
                  ))}
                </div>
                <label className="select-label">
                  State
                  <select aria-label="Filter work by state" value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="all">All work</option>
                    {[...new Set(work.map((w) => w.state))].map((s) => (
                      <option key={s} value={s}>
                        {words(s)}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>
              {workTab === "list" ? (
                <Section title="Work" count={work.length}>
                  {work
                    .filter((w) => (filter === "all" || w.state === filter) && matches(`${w.title} ${w.ticket ?? ""}`))
                    .map((w) => (
                      <button type="button" className="work-row" key={w.id} onClick={() => setSelectedWork(w)}>
                        {w.state === "done" ? (
                          <Check size={15} className="success-text" />
                        ) : w.state === "running" ? (
                          <span className="running-dot" />
                        ) : (
                          <Circle size={14} className="muted" />
                        )}
                        <span className="row-content">
                          <strong>{w.title}</strong>
                          <span className="row-meta">
                            {w.ticket ?? w.scope} {w.provider && ` · ${w.provider}`}
                          </span>
                        </span>
                        <Badge tone={w.state === "running" ? "info" : w.state === "review" ? "warning" : "neutral"}>
                          {words(w.state)}
                        </Badge>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                  {!work.length && <Empty title={snapshot.work === null ? "Work couldn't be read" : "No work yet"} />}
                </Section>
              ) : (
                <div className="board">
                  {["queued", "running", "blocked", "review", "done"].map((state) => (
                    <section key={state}>
                      <h2>
                        {words(state)}
                        <span className="count">{work.filter((w) => w.group === state).length}</span>
                      </h2>
                      {work
                        .filter(
                          (w) => w.group === state && matches(w.title) && (filter === "all" || w.state === filter),
                        )
                        .map((w) => (
                          <button type="button" className="board-card" key={w.id} onClick={() => setSelectedWork(w)}>
                            <span className="row-meta">{w.ticket ?? w.scope}</span>
                            <strong>{w.title}</strong>
                            <span className="small muted">{w.provider ?? "Not started"}</span>
                          </button>
                        ))}
                    </section>
                  ))}
                </div>
              )}
              {workSelection && !selectedWork && (
                <div className="notice" role="status">
                  This work item is no longer available in the current snapshot. Close or refresh the view to read it
                  again.
                </div>
              )}
              {selectedWork && (
                <div className="inspector">
                  <div className="section-heading">
                    <span className="row-meta">{selectedWork.ticket ?? selectedWork.scope}</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Close work details"
                      onClick={() => setSelectedWork(null)}
                    >
                      <X />
                    </button>
                  </div>
                  <h2>{selectedWork.title}</h2>
                  <Badge>{words(selectedWork.state)}</Badge>
                  <p>{selectedWork.reason ?? "The latest observed state is shown above."}</p>
                  <Section title="Acceptance checks">
                    {selectedWork.checks.length ? (
                      selectedWork.checks.map((c) => (
                        <div className="check-row" key={c.name}>
                          <FileText size={14} />
                          <div>
                            <strong>{c.name}</strong>
                            <code>{c.run}</code>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted small">No acceptance checks were included in this snapshot.</p>
                    )}
                  </Section>
                  <div className="callout">
                    <LockKeyhole size={14} />
                    <p>Dispatch, review and stop controls remain in Paseo. Reading this item changes nothing.</p>
                  </div>
                </div>
              )}
            </>
          )}
          {view === "health" && (
            <>
              <div className="view-controls">
                <div className="segmented">
                  {["overview", "fleet", "loops"].map((t) => (
                    <button type="button" key={t} aria-pressed={healthTab === t} onClick={() => setHealthTab(t)}>
                      {words(t)}
                    </button>
                  ))}
                </div>
                <span className="small muted">Observation only</span>
              </div>
              {healthTab === "overview" && (
                <>
                  <div className="metrics">
                    <Metric
                      value={snapshot.fleet?.length ?? "—"}
                      label="Fleet scopes"
                      detail="Reported by the existing observer"
                    />
                    <Metric
                      value={snapshot.loops?.length ?? "—"}
                      label="Tracked loops"
                      detail="Intent beside observed behavior"
                    />
                    <Metric
                      value={snapshot.notices?.length ?? "—"}
                      label="Want a look"
                      detail="Warnings, not holds"
                      tone="watch"
                    />
                  </div>
                  <Section title="Open notices" count={notices.length}>
                    {notices
                      .filter((n) => matches(n.title))
                      .map((n) => (
                        <div className="notice-row" key={n.key}>
                          <CircleAlert size={15} />
                          <div className="row-content">
                            <strong>{n.title}</strong>
                            <span className="row-meta">
                              {n.scope} · {words(n.kind)}
                            </span>
                            <p>{n.detail}</p>
                          </div>
                        </div>
                      ))}
                    {!notices.length && (
                      <Empty title={snapshot.notices === null ? "Health couldn't be read" : "Nothing needs a look"} />
                    )}
                  </Section>
                  <div className="callout">
                    <Workflow size={15} />
                    <p>
                      Maestro reconciles and routes. Fleet observes and reports. The coordinator owns its tick policy.
                      This view starts none of them.
                    </p>
                  </div>
                </>
              )}
              {healthTab === "fleet" && (
                <Section title="Fleet scopes" count={snapshot.fleet?.length}>
                  {snapshot.fleet?.map((s) => (
                    <article className="fleet-card" key={s.id}>
                      <div className="section-heading">
                        <h2>{s.id}</h2>
                        <Badge tone={s.health === "ok" ? "success" : "warning"}>{words(s.health)}</Badge>
                      </div>
                      <p>{s.reason}</p>
                      <div className="fleet-meta">
                        <span>
                          {s.mode ?? "Mode unknown"}
                          {s.dryRun === true ? " · dry run" : s.dryRun === false ? " · live" : ""}
                        </span>
                        <span>Last tick {time(s.lastTick)}</span>
                        <span>{s.openAsks} open asks</span>
                      </div>
                    </article>
                  ))}
                  {!snapshot.fleet?.length && (
                    <Empty title={snapshot.fleet === null ? "Fleet couldn't be read" : "No fleet scopes observed"} />
                  )}
                </Section>
              )}
              {healthTab === "loops" && (
                <Section title="Schedules and loops" count={snapshot.loops?.length}>
                  {snapshot.loops
                    ?.filter((l) => matches(l.title))
                    .map((l) => (
                      <details className="loop-row" key={l.id}>
                        <summary>
                          <Clock3 size={15} />
                          <span className="row-content">
                            <strong>{l.title}</strong>
                            <span className="row-meta">
                              {l.cadence ?? "Cadence not stated"} · {l.scope}
                            </span>
                          </span>
                          <Badge tone={l.drift.length ? "warning" : l.status === "ok" ? "success" : "neutral"}>
                            {l.drift.length ? "Drift observed" : words(l.status)}
                          </Badge>
                          <ChevronDown size={12} />
                        </summary>
                        <div className="loop-detail">
                          <p>{l.detail}</p>
                          {l.drift.map((d) => (
                            <p key={d} className="warning-text">
                              {d}
                            </p>
                          ))}
                        </div>
                      </details>
                    ))}
                  {!snapshot.loops?.length && (
                    <Empty title={snapshot.loops === null ? "Loops couldn't be read" : "No loops observed"} />
                  )}
                </Section>
              )}
            </>
          )}
          {view === "initiatives" && (
            <>
              <div className="view-controls">
                <div className="segmented">
                  {["all", "due", "active", "parked"].map((f) => (
                    <button type="button" key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f === "due" ? "Review due" : words(f)}
                    </button>
                  ))}
                </div>
              </div>
              <Section title="Initiatives" count={initiatives.length}>
                {initiatives
                  .filter(
                    (i) => matches(i.title) && (filter === "all" || (filter === "due" && i.due) || i.status === filter),
                  )
                  .map((i) => (
                    <article className="initiative" key={i.id}>
                      <Target size={16} />
                      <div className="row-content">
                        <div className="initiative-title">
                          <h2>{i.title}</h2>
                          <Badge tone={i.due ? "warning" : "neutral"}>
                            {i.due ? "Review due" : words(i.status ?? "unknown")}
                          </Badge>
                        </div>
                        {i.summary && <p>{i.summary}</p>}
                        {i.nextAction && <span className="small">Next: {i.nextAction}</span>}
                        {i.reviewBy && <span className="row-meta">Review {i.reviewBy}</span>}
                      </div>
                    </article>
                  ))}
                {!initiatives.length && (
                  <Empty
                    title={snapshot.initiatives === null ? "Initiatives couldn't be read" : "No initiatives yet"}
                  />
                )}
              </Section>
            </>
          )}
        </>
      )}
      <footer className="app-footer">
        <span>
          <LockKeyhole size={11} /> Read-only connection
        </span>
        <span>
          Maestro <span className="footer-dot">·</span> built for your workspace
        </span>
      </footer>
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Maestro />);
