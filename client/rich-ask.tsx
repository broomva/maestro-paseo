// Decision layer v2, drawn (BRO-3167): what lets you decide an ask at a glance,
// on every answer surface. The owner, of the ask he could not decide: "Asks
// should have urls and links to sources, tickets, documents … we should also
// support multimedia … some details that give enough information at a glance,
// and also include the details if needed".
//
// - RichGlance: the summary, the tradeoff strip, the ask's own media, a Compare
//   button when 2–4 options carry pictures, and the sources as chips.
// - OptionThumbs: an option's pictures under its row; a tap enlarges one.
// - RichDetails: the long form, markdown, behind a disclosure.
//
// A local file is fetched only when it is drawn (`ask.attachment`, by the ask's
// handle and the file's position, never by a path). Video plays inline and an
// HTML doc draws in a sandboxed frame that runs no script, on the desktop (web);
// on the phone app a video or an HTML doc opens its web address when it has one,
// and says where it can be seen when it has none.

import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { createElement, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, ScrollView, Text, View } from "react-native";
import {
  type AskMedia,
  type AskSource,
  type AttachmentRef,
  getAskAttachment,
  isLocalSource,
  mediaName,
  sourceText,
  sourceUrl,
} from "../shared/rich-ask";
import { errorText } from "./format";
import { MarkdownView } from "./markdown-view";
import { useOpenUrl } from "./open-url";
import {
  type AttachmentHandle,
  AXIS_WORDS,
  attachmentQueryKey,
  compareSet,
  mediaOfOption,
  mediaRef,
  type RichView,
  sourceRef,
  tradeoffTable,
} from "./rich-ask-model";
import { radius, size, space, useText } from "./ui";

const web = Platform.OS === "web";

/** A file an ask names, fetched once per reading of the ask (its hash), and only while `enabled`. */
export function useAttachment(handle: AttachmentHandle, ref: AttachmentRef, enabled = true) {
  const get = useRpc(getAskAttachment);
  return useQuery({
    queryKey: attachmentQueryKey(handle, ref),
    queryFn: () => get({ where: handle.where, ledger: handle.ledger, uid: handle.uid, id: handle.id, ref }),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

/** What the viewer shows: one picture or video (with whose it is), or one local source. */
type Viewing =
  | { kind: "media"; media: AskMedia; ref: AttachmentRef; owner: string | null }
  | { kind: "source"; source: AskSource; ref: AttachmentRef }
  | { kind: "compare" };

// ── A picture, or a tile for what is not one ─────────────────────────────────

function MediaPicture({
  theme,
  handle,
  media,
  mediaRefOf,
  width,
  height,
  fit = "cover",
}: {
  theme: PluginTheme;
  handle: AttachmentHandle;
  media: AskMedia;
  mediaRefOf: AttachmentRef;
  width: number | "100%";
  height: number;
  fit?: "cover" | "contain";
}) {
  const pictured = media.kind === "image" || media.kind === "svg";
  const file = useAttachment(handle, mediaRefOf, pictured && media.path !== null);
  const uri = media.url ?? file.data?.dataUrl ?? null;
  const box = {
    width,
    height,
    borderRadius: radius.control,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden" as const,
    alignItems: "center" as const,
    justifyContent: "center" as const,
  };
  if (!pictured) {
    return (
      <View style={[box, { gap: space[1], padding: space[2] }]}>
        <Icon name={media.kind === "video" ? "Play" : "FileText"} size={20} color={theme.colors.foreground} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs }} numberOfLines={2}>
          {media.kind === "video" ? "Video" : "Page"}
        </Text>
      </View>
    );
  }
  if (!uri) {
    return (
      <View style={box}>
        {file.isError ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.xs, padding: space[2] }} numberOfLines={3}>
            {`Not shown: ${errorText(file.error)}`}
          </Text>
        ) : (
          <ActivityIndicator color={theme.colors.foregroundMuted} />
        )}
      </View>
    );
  }
  return (
    <View style={box}>
      <Image
        source={{ uri }}
        resizeMode={fit}
        accessibilityIgnoresInvertColors
        style={{ width: "100%", height: "100%" }}
        accessibilityLabel={mediaName(media)}
      />
    </View>
  );
}

function Thumb({
  theme,
  handle,
  media,
  refOf,
  compact,
  onOpen,
}: {
  theme: PluginTheme;
  handle: AttachmentHandle;
  media: AskMedia;
  refOf: AttachmentRef;
  compact: boolean;
  onOpen: () => void;
}) {
  const text = useText(theme);
  const width = compact ? 104 : 132;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Enlarge ${mediaName(media)}`}
      onPress={onOpen}
      style={({ pressed }: { pressed: boolean }) => ({ width, gap: 4, opacity: pressed ? 0.8 : 1 })}
    >
      <MediaPicture
        theme={theme}
        handle={handle}
        media={media}
        mediaRefOf={refOf}
        width={width}
        height={compact ? 72 : 88}
      />
      {media.caption ? (
        <Text style={text.small} numberOfLines={2}>
          {media.caption}
        </Text>
      ) : null}
    </Pressable>
  );
}

// ── Video and HTML, inline on the desktop ────────────────────────────────────

function InlineVideo({ src, label }: { src: string; label: string }) {
  if (!web) return null;
  return createElement("video", {
    src,
    controls: true,
    playsInline: true,
    preload: "metadata",
    "aria-label": label,
    style: { width: "100%", maxHeight: "60vh", borderRadius: radius.control, background: "#000" },
  });
}

/** An HTML file in a frame that runs no script and reaches nothing (the server locked it, server/rich-ask.ts). */
function SandboxedPage({ html, label }: { html: string; label: string }) {
  if (!web) return null;
  return createElement("iframe", {
    srcDoc: html,
    sandbox: "",
    referrerPolicy: "no-referrer",
    title: label,
    style: { width: "100%", height: "70vh", border: 0, borderRadius: radius.control, background: "#fff" },
  });
}

function MediaFull({
  theme,
  handle,
  media,
  refOf,
  compact,
}: {
  theme: PluginTheme;
  handle: AttachmentHandle;
  media: AskMedia;
  refOf: AttachmentRef;
  compact: boolean;
}) {
  const text = useText(theme);
  const openUrl = useOpenUrl();
  const local = media.path !== null;
  const needsFile = local && (media.kind !== "video" && media.kind !== "html" ? true : web);
  const file = useAttachment(handle, refOf, needsFile);
  if (media.kind === "image" || media.kind === "svg") {
    return (
      <MediaPicture
        theme={theme}
        handle={handle}
        media={media}
        mediaRefOf={refOf}
        width="100%"
        height={compact ? 420 : 560}
        fit="contain"
      />
    );
  }
  const src = media.url ?? file.data?.dataUrl ?? null;
  const page = file.data?.text ?? null;
  if (web && media.kind === "video" && src) return <InlineVideo src={src} label={mediaName(media)} />;
  if (web && media.kind === "html" && page) return <SandboxedPage html={page} label={mediaName(media)} />;
  if (needsFile && !file.data) {
    return file.isError ? (
      <Text style={text.small}>{`Not shown: ${errorText(file.error)}`}</Text>
    ) : (
      <ActivityIndicator color={theme.colors.foregroundMuted} />
    );
  }
  // The phone app: no inline video or frame. A web address opens; a local file says where it can be seen.
  const away = media.url ?? file.data?.webUrl ?? null;
  return away ? (
    <ChipButton theme={theme} icon="ExternalLink" label="Open it in the browser" onPress={() => openUrl(away)} />
  ) : (
    <Text
      style={text.small}
    >{`${media.kind === "video" ? "This video" : "This page"} plays on the desktop: open Maestro there.`}</Text>
  );
}

// ── The viewer: one item, or the options side by side ───────────────────────

function Viewer({
  theme,
  view,
  viewing,
  compact,
  onClose,
}: {
  theme: PluginTheme;
  view: RichView;
  viewing: Viewing | null;
  compact: boolean;
  onClose: () => void;
}) {
  const text = useText(theme);
  const title =
    viewing?.kind === "compare"
      ? "Compare the options"
      : viewing?.kind === "media"
        ? [viewing.owner, mediaName(viewing.media)].filter(Boolean).join(" · ")
        : viewing?.kind === "source"
          ? sourceText(viewing.source)
          : "";
  return (
    <Modal
      title={title}
      icon={
        <Icon name={viewing?.kind === "compare" ? "Columns2" : "FileText"} size={18} color={theme.colors.foreground} />
      }
      open={viewing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content>
        {viewing?.kind === "media" ? (
          <View style={{ gap: space[2] }}>
            <MediaFull theme={theme} handle={view.handle} media={viewing.media} refOf={viewing.ref} compact={compact} />
            {viewing.media.caption ? <Text style={text.muted}>{viewing.media.caption}</Text> : null}
          </View>
        ) : viewing?.kind === "compare" ? (
          <Compare theme={theme} view={view} compact={compact} />
        ) : viewing?.kind === "source" ? (
          <SourceFile
            theme={theme}
            handle={view.handle}
            source={viewing.source}
            refOf={viewing.ref}
            compact={compact}
          />
        ) : null}
      </Modal.Content>
    </Modal>
  );
}

/** Two to four options' first pictures side by side: a row on the desktop, one under another on the phone. */
function Compare({ theme, view, compact }: { theme: PluginTheme; view: RichView; compact: boolean }) {
  const text = useText(theme);
  const set = compareSet(view);
  return (
    <View
      accessibilityLabel={`${set.length} options side by side`}
      style={{ flexDirection: compact ? "column" : "row", gap: space[3], alignItems: "flex-start" }}
    >
      {set.map((entry) => (
        <View
          key={entry.option}
          style={{ flex: compact ? undefined : 1, width: compact ? "100%" : undefined, gap: space[1] }}
        >
          <Text style={[text.body, { fontWeight: "600" }]}>{entry.label}</Text>
          <MediaPicture
            theme={theme}
            handle={view.handle}
            media={entry.media}
            mediaRefOf={mediaRef(entry.option, entry.index)}
            width="100%"
            height={compact ? 360 : 420}
            fit="contain"
          />
          {entry.media.caption ? <Text style={text.small}>{entry.media.caption}</Text> : null}
        </View>
      ))}
    </View>
  );
}

function SourceFile({
  theme,
  handle,
  source,
  refOf,
  compact,
}: {
  theme: PluginTheme;
  handle: AttachmentHandle;
  source: AskSource;
  refOf: AttachmentRef;
  compact: boolean;
}) {
  const text = useText(theme);
  const openUrl = useOpenUrl();
  const file = useAttachment(handle, refOf);
  if (!file.data) {
    return file.isError ? (
      <Text style={text.small}>{`Not shown: ${errorText(file.error)}`}</Text>
    ) : (
      <ActivityIndicator color={theme.colors.foregroundMuted} />
    );
  }
  const { mime, text: body, dataUrl, webUrl } = file.data;
  const onGitHub = webUrl ? (
    <ChipButton theme={theme} icon="ExternalLink" label="Open on GitHub" onPress={() => openUrl(webUrl)} />
  ) : null;
  return (
    <View style={{ gap: space[3] }}>
      <Text style={[text.small, { fontFamily: "ui-monospace, Menlo, monospace" }]} selectable>
        {source.ref}
      </Text>
      {dataUrl ? (
        <Image source={{ uri: dataUrl }} resizeMode="contain" style={{ width: "100%", height: 480 }} />
      ) : mime === "text/markdown" && body ? (
        <MarkdownView source={body} theme={theme} compact={compact} />
      ) : mime === "text/html" && body ? (
        web ? (
          <SandboxedPage html={body} label={sourceText(source)} />
        ) : (
          <Text style={text.small}>This page draws on the desktop: open Maestro there, or on GitHub.</Text>
        )
      ) : body ? (
        <ScrollView horizontal>
          <Text style={[text.small, { fontFamily: "ui-monospace, Menlo, monospace" }]} selectable>
            {body.slice(0, 20_000)}
          </Text>
        </ScrollView>
      ) : null}
      {onGitHub}
    </View>
  );
}

// ── Chips ────────────────────────────────────────────────────────────────────

function ChipButton({
  theme,
  icon,
  label,
  onPress,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? (icon === "ExternalLink" ? "link" : "button") : "text"}
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 32,
        paddingHorizontal: space[2] + 2,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: (pressed || hovered) && onPress ? theme.colors.surface2 : "transparent",
        maxWidth: "100%",
      })}
    >
      <Icon name={icon} size={13} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foreground, fontSize: size.xs, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const SOURCE_ICON: Record<AskSource["kind"], string> = {
  ticket: "Ticket",
  pr: "GitPullRequest",
  doc: "FileText",
  spec: "FileText",
  file: "FileText",
  url: "ExternalLink",
  session: "MessageSquare",
};

function SourceChips({
  theme,
  sources,
  onLocal,
}: {
  theme: PluginTheme;
  sources: readonly AskSource[];
  onLocal: (source: AskSource, index: number) => void;
}) {
  const openUrl = useOpenUrl();
  return (
    <View accessibilityLabel="Sources" style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2] }}>
      {sources.map((source, index) => {
        const url = sourceUrl(source);
        const label = sourceText(source);
        return (
          <ChipButton
            // biome-ignore lint/suspicious/noArrayIndexKey: sources are positional, as the ledger lists them.
            key={index}
            theme={theme}
            icon={SOURCE_ICON[source.kind]}
            label={label}
            accessibilityLabel={`${source.kind} ${label}`}
            onPress={url ? () => openUrl(url) : isLocalSource(source) ? () => onLocal(source, index) : undefined}
          />
        );
      })}
    </View>
  );
}

// ── The tradeoff strip ───────────────────────────────────────────────────────

function Tradeoffs({
  theme,
  view,
  options,
  compact,
}: {
  theme: PluginTheme;
  view: RichView;
  options: readonly { id: string; label: string }[];
  compact: boolean;
}) {
  const text = useText(theme);
  const { columns, lines } = tradeoffTable(view.rich?.tradeoffs ?? [], options);
  if (lines.length === 0) return null;
  if (compact) {
    // A phone holds no five-column table: each row is its name, then its cells labelled.
    return (
      <View accessibilityLabel="Tradeoffs" style={{ gap: space[2] }}>
        {lines.map((line) => (
          <View key={line.name} style={{ gap: 2 }}>
            <Text style={[text.small, { color: theme.colors.foreground, fontWeight: "600" }]}>{line.name}</Text>
            <Text style={text.small}>
              {line.cells
                .filter((cell) => cell.text)
                .map((cell) => `${AXIS_WORDS[cell.axis]}: ${cell.text}`)
                .join(" · ")}
            </Text>
          </View>
        ))}
      </View>
    );
  }
  const cell = { flex: 1, paddingVertical: space[1] + 2, paddingHorizontal: space[2] } as const;
  return (
    <View
      accessibilityLabel="Tradeoffs"
      style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: radius.control, overflow: "hidden" }}
    >
      <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface2 }}>
        <Text style={[text.small, cell, { fontWeight: "600" }]}>Option</Text>
        {columns.map((axis) => (
          <Text key={axis} style={[text.small, cell, { fontWeight: "600" }]}>
            {AXIS_WORDS[axis]}
          </Text>
        ))}
      </View>
      {lines.map((line) => (
        <View key={line.name} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          <Text style={[text.small, cell, { color: theme.colors.foreground, fontWeight: "600" }]}>{line.name}</Text>
          {line.cells.map((one) => (
            <Text key={one.axis} style={[text.small, cell, { color: theme.colors.foreground }]}>
              {one.text ?? "—"}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

// ── What a surface places ────────────────────────────────────────────────────

/**
 * The at-a-glance block, under the headline: summary, tradeoffs, the ask's own media, Compare, sources. Draws
 * nothing for an ask that carries none of them.
 */
export function RichGlance({
  theme,
  view,
  options,
  compact,
}: {
  theme: PluginTheme;
  view: RichView | null;
  options: readonly { id: string; label: string }[];
  compact: boolean;
}) {
  const text = useText(theme);
  const [viewing, setViewing] = useState<Viewing | null>(null);
  if (!view) return null;
  const rich = view.rich;
  const compare = compareSet(view);
  const askMedia = rich?.media ?? [];
  return (
    <View style={{ gap: space[3] }}>
      {rich?.summary ? (
        <Text style={[text.body, { lineHeight: 21 }]} accessibilityLabel={`Summary: ${rich.summary}`} selectable>
          {rich.summary}
        </Text>
      ) : null}
      <Tradeoffs theme={theme} view={view} options={options} compact={compact} />
      {askMedia.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
          {askMedia.map((media, index) => (
            <Thumb
              // biome-ignore lint/suspicious/noArrayIndexKey: media are positional, as the ledger lists them.
              key={index}
              theme={theme}
              handle={view.handle}
              media={media}
              refOf={mediaRef(null, index)}
              compact={compact}
              onOpen={() => setViewing({ kind: "media", media, ref: mediaRef(null, index), owner: null })}
            />
          ))}
        </ScrollView>
      ) : null}
      {compare.length > 0 || (rich?.sources.length ?? 0) > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2], alignItems: "center" }}>
          {compare.length > 0 ? (
            <ChipButton
              theme={theme}
              icon="Columns2"
              label={`Compare ${compare.length} side by side`}
              onPress={() => setViewing({ kind: "compare" })}
            />
          ) : null}
          {rich?.sources.length ? (
            <SourceChips
              theme={theme}
              sources={rich.sources}
              onLocal={(source, index) => setViewing({ kind: "source", source, ref: sourceRef(index) })}
            />
          ) : null}
        </View>
      ) : null}
      <Viewer theme={theme} view={view} viewing={viewing} compact={compact} onClose={() => setViewing(null)} />
    </View>
  );
}

/** An option's pictures, under its row; a tap enlarges one. Nothing for an option without. */
export function OptionThumbs({
  theme,
  view,
  option,
  label,
  compact,
}: {
  theme: PluginTheme;
  view: RichView | null;
  option: string;
  label: string;
  compact: boolean;
}) {
  const [viewing, setViewing] = useState<Viewing | null>(null);
  const media = mediaOfOption(view, option);
  if (!view || media.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space[2], marginTop: space[1] }}>
      {media.map((entry, index) => (
        <Thumb
          // biome-ignore lint/suspicious/noArrayIndexKey: media are positional, as the ledger lists them.
          key={index}
          theme={theme}
          handle={view.handle}
          media={entry}
          refOf={mediaRef(option, index)}
          compact={compact}
          onOpen={() => setViewing({ kind: "media", media: entry, ref: mediaRef(option, index), owner: label })}
        />
      ))}
      <Viewer theme={theme} view={view} viewing={viewing} compact={compact} onClose={() => setViewing(null)} />
    </View>
  );
}

/** The long form, markdown, behind a disclosure. Nothing for an ask without details. */
export function RichDetails({ theme, view, compact }: { theme: PluginTheme; view: RichView | null; compact: boolean }) {
  const text = useText(theme);
  const [open, setOpen] = useState(false);
  const details = view?.rich?.details;
  if (!details) return null;
  return (
    <View style={{ gap: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? "Hide the details" : "Read the details"}
        onPress={() => setOpen((now) => !now)}
        style={{ flexDirection: "row", alignItems: "center", gap: space[1], minHeight: compact ? 44 : 32 }}
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={[text.small, { color: theme.colors.foreground, fontWeight: "600" }]}>
          {open ? "Hide the details" : "Read the details"}
        </Text>
      </Pressable>
      {open ? <MarkdownView source={details} theme={theme} compact={compact} /> : null}
    </View>
  );
}
