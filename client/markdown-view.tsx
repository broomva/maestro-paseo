// A fleet report drawn from its Markdown (client/markdown.ts), in the host's
// theme. Tables scroll sideways in a wide window; in a compact one each row is
// its own small card, since a phone cannot hold ten columns: the first cell on
// top (with the second when the first is a short number or mark, like a
// class's "4"), every other cell under its column name.

import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, type TextStyle, View } from "react-native";
import { type Block, parseMarkdown, plainText, type Span } from "./markdown";
import { radius, size, space, useText } from "./ui";

function Spans({
  spans,
  style,
  mono,
  header = false,
}: {
  spans: readonly Span[];
  style: TextStyle;
  mono: TextStyle;
  header?: boolean;
}) {
  return (
    <Text style={style} accessibilityRole={header ? "header" : undefined}>
      {spans.map((span, index) =>
        span.code ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reorder.
          <Text key={index} style={[mono, { fontSize: style.fontSize ?? size.sm }]}>
            {span.text}
          </Text>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and never reorder.
          <Text key={index} style={span.bold ? { fontWeight: "600" } : undefined}>
            {span.text}
          </Text>
        ),
      )}
    </Text>
  );
}

/** A column's width in a wide table: from its longest cell, within bounds. */
function columnWidths(block: Extract<Block, { type: "table" }>): number[] {
  return block.header.map((cell, column) => {
    const longest = Math.max(plainText(cell).length, ...block.rows.map((row) => plainText(row[column] ?? []).length));
    return Math.min(320, Math.max(56, longest * 7 + space[3]));
  });
}

function Table({
  block,
  theme,
  compact,
}: {
  block: Extract<Block, { type: "table" }>;
  theme: PluginTheme;
  compact: boolean;
}) {
  const text = useText(theme);
  const cell = { ...text.small, color: theme.colors.foreground };
  if (compact) {
    const names = block.header.map(plainText);
    // A first cell of three characters or fewer ("4", "yes") names nothing alone: it leads, the second follows.
    const lead = (row: Span[][]) => (plainText(row[0] ?? []).trim().length <= 3 && row.length > 1 ? 2 : 1);
    return (
      <View style={{ gap: space[2] }}>
        {block.rows.map((row, index) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: a report's rows are positional.
            key={index}
            style={{
              gap: 2,
              padding: space[2],
              borderRadius: radius.control,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Spans
              spans={lead(row) === 2 ? [...(row[0] ?? []), { text: " · " }, ...(row[1] ?? [])] : (row[0] ?? [])}
              style={{ ...cell, fontWeight: "600" }}
              mono={text.mono}
            />
            {row.slice(lead(row)).map((value, column) => {
              const plain = plainText(value).trim();
              if (!plain || plain === "-") return null;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
                <View key={column} style={{ flexDirection: "row", gap: space[2] }}>
                  <Text style={[text.small, { minWidth: 72 }]}>{names[column + lead(row)] ?? ""}</Text>
                  <View style={{ flex: 1 }}>
                    <Spans spans={value} style={cell} mono={text.mono} />
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }
  const widths = columnWidths(block);
  const line = (cells: readonly Span[][], header: boolean, key: string) => (
    <View
      key={key}
      style={{
        flexDirection: "row",
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        paddingVertical: space[1],
      }}
    >
      {widths.map((width, column) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional.
        <View key={column} style={{ width, paddingRight: space[3] }}>
          <Spans spans={cells[column] ?? []} style={header ? { ...text.label } : cell} mono={text.mono} />
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal>
      <View>
        {line(block.header, true, "header")}
        {block.rows.map((row, index) => line(row, false, String(index)))}
      </View>
    </ScrollView>
  );
}

export function MarkdownView({ source, theme, compact }: { source: string; theme: PluginTheme; compact: boolean }) {
  const text = useText(theme);
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <View style={{ gap: space[3] }}>
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        switch (block.type) {
          case "heading":
            return (
              <View key={key}>
                <Spans
                  header
                  spans={block.spans}
                  style={
                    block.level === 1
                      ? text.title
                      : block.level === 2
                        ? { ...text.body, fontSize: size.base, fontWeight: "600" }
                        : { ...text.body, fontWeight: "600" }
                  }
                  mono={text.mono}
                />
              </View>
            );
          case "paragraph":
            return <Spans key={key} spans={block.spans} style={text.body} mono={text.mono} />;
          case "list":
            return (
              <View key={key} style={{ gap: space[1] }}>
                {block.items.map((item, at) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional.
                  <View key={at} style={{ flexDirection: "row", gap: space[2], paddingLeft: item.depth * space[4] }}>
                    <Text style={text.muted}>•</Text>
                    <View style={{ flex: 1 }}>
                      <Spans spans={item.spans} style={text.body} mono={text.mono} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "table":
            return <Table key={key} block={block} theme={theme} compact={compact} />;
          case "code":
            return (
              <ScrollView key={key} horizontal>
                <Text style={text.mono}>{block.text}</Text>
              </ScrollView>
            );
          default:
            return <View key={key} style={{ height: 1, backgroundColor: theme.colors.border }} />;
        }
      })}
    </View>
  );
}
