// The one list dialog every picker is built from: a title, a filter line, a scrolling list with
// group headings and badges, and a line of key hints. Drawn centred on a popover background.
import { Box, Text, useInput, useWindowSize, type Key } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import type { Theme } from "../../themes/types.js";
import { editKey, emptyEditor, type EditorState } from "../editor.js";
import type { Seg } from "../log-lines.js";
import { truncate, width as textWidth } from "../text.js";
import { Segs, segsWidth } from "../components/RowView.js";

export interface ListItem {
  id: string;
  label: string;
  /** Muted text after the label. */
  hint?: string;
  /** Right-aligned badge ("✓ signed in", "free"). */
  badge?: Seg;
  /** A heading the item is listed under. */
  group?: string;
  disabled?: boolean;
  /** Extra words the filter matches. */
  keywords?: string;
}

export interface ListDialogProps {
  theme: Theme;
  title: string;
  subtitle?: string;
  items: ListItem[];
  onSelect: (item: ListItem, query: string) => void;
  onCancel: () => void;
  /** Extra keys; return true when handled. */
  onKey?: (input: string, key: Key, item: ListItem | undefined, query: string) => boolean;
  /** Called when the highlighted item changes (live theme preview). */
  onHighlight?: (item: ListItem | undefined) => void;
  /** Called when the filter text changes; when set, items are not filtered locally. */
  onQuery?: (query: string) => void;
  filter?: boolean;
  placeholder?: string;
  hints?: string;
  loading?: boolean;
  error?: string | null;
  empty?: string;
  initialId?: string;
  width?: number;
}

export function matches(item: ListItem, query: string): boolean {
  const hay = `${item.label} ${item.hint ?? ""} ${item.group ?? ""} ${item.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

/** A centred popover box; the interior is filled so nothing behind shows through. */
export function DialogBox(props: {
  theme: Theme;
  width: number;
  height: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  hints?: string;
}) {
  const size = useWindowSize();
  const c = props.theme.colors;
  const w = Math.min(props.width, Math.max(20, size.columns - 2));
  const h = Math.min(props.height, Math.max(6, size.rows - 2));
  const left = Math.max(0, Math.floor((size.columns - w) / 2));
  const top = Math.max(0, Math.floor((size.rows - h) / 3));
  return (
    <Box
      position="absolute"
      left={left}
      top={top}
      width={w}
      height={h}
      flexDirection="column"
      borderStyle="round"
      borderColor={c.borderFocus}
      borderBackgroundColor={c.popover}
      backgroundColor={c.popover}
      paddingX={1}
    >
      <Text wrap="truncate">
        <Text color={c.accent} bold>
          {"◆ "}
        </Text>
        <Text color={c.text} bold>
          {props.title}
        </Text>
        {props.subtitle ? <Text color={c.faint}>{`  ${props.subtitle}`}</Text> : null}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {props.children}
      </Box>
      {props.hints ? (
        <Text color={c.faint} wrap="truncate">
          {props.hints}
        </Text>
      ) : null}
    </Box>
  );
}

/** The filter / input line with a block cursor. */
export function InputLine({
  theme,
  editor,
  placeholder,
  width,
  mask,
  prefix = "⌕ ",
}: {
  theme: Theme;
  editor: EditorState;
  placeholder?: string;
  width: number;
  mask?: boolean;
  prefix?: string;
}) {
  const c = theme.colors;
  const shown = mask ? "•".repeat(editor.value.length) : editor.value;
  const cursor = mask ? editor.cursor : editor.cursor;
  const before = shown.slice(0, cursor);
  const at = shown.slice(cursor, cursor + 1) || " ";
  const after = shown.slice(cursor + 1);
  const room = Math.max(4, width - textWidth(prefix) - 1);
  const head = textWidth(before) > room - 1 ? `…${before.slice(-(room - 2))}` : before;
  return (
    <Text wrap="truncate">
      <Text color={c.accent}>{prefix}</Text>
      {editor.value ? (
        <>
          <Text color={c.text}>{head}</Text>
          <Text color={c.text} inverse>
            {at}
          </Text>
          <Text color={c.text}>{truncate(after, Math.max(0, room - textWidth(head) - 1))}</Text>
        </>
      ) : (
        <>
          <Text color={c.text} inverse>
            {" "}
          </Text>
          <Text color={c.faint}>{placeholder ? truncate(placeholder, room - 1) : ""}</Text>
        </>
      )}
    </Text>
  );
}

type Line = { kind: "group"; text: string } | { kind: "item"; item: ListItem; index: number };

export function ListDialog(props: ListDialogProps) {
  const size = useWindowSize();
  const { theme } = props;
  const c = theme.colors;
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const query = editor.value;
  const filtered = useMemo(
    () => (props.onQuery || props.filter === false || !query ? props.items : props.items.filter((i) => matches(i, query))),
    [props.items, query, props.onQuery, props.filter],
  );
  const selectable = filtered.filter((i) => !i.disabled);
  const [selected, setSelected] = useState(() => {
    const i = props.initialId ? selectable.findIndex((x) => x.id === props.initialId) : 0;
    return Math.max(0, i);
  });
  const current = selectable[Math.min(selected, selectable.length - 1)];

  useEffect(() => {
    if (selected >= selectable.length) setSelected(Math.max(0, selectable.length - 1));
  }, [selectable.length, selected]);
  useEffect(() => {
    props.onHighlight?.(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);
  useEffect(() => {
    props.onQuery?.(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (props.onKey?.(input, key, current, query)) return;
    if (key.upArrow || (key.ctrl && input === "p")) {
      setSelected((s) => (selectable.length ? (s - 1 + selectable.length) % selectable.length : 0));
      return;
    }
    if (key.downArrow || (key.ctrl && input === "n") || key.tab) {
      setSelected((s) => (selectable.length ? (s + 1) % selectable.length : 0));
      return;
    }
    if (key.pageUp) {
      setSelected((s) => Math.max(0, s - 10));
      return;
    }
    if (key.pageDown) {
      setSelected((s) => Math.min(Math.max(0, selectable.length - 1), s + 10));
      return;
    }
    if (key.return) {
      if (current) props.onSelect(current, query);
      return;
    }
    if (props.filter === false && !props.onQuery) return;
    const r = editKey(editor, input, key);
    if (r.kind === "edit") {
      setEditor(r.state);
      setSelected(0);
    }
  });

  const width = Math.min(props.width ?? 84, size.columns - 2);
  // Rows the list needs: every item plus a heading per group, plus the chrome around it.
  const groups = new Set(filtered.map((i) => i.group).filter(Boolean)).size;
  const chrome = 4 + (props.filter === false && !props.onQuery ? 0 : 1) + (props.hints ? 1 : 0) + (props.loading || props.error ? 1 : 0);
  const height = Math.min(Math.max(10, filtered.length + groups + chrome), Math.max(8, size.rows - 4), 32);
  const innerW = width - 4;
  const listH = height - 2 - 1 - (props.filter === false && !props.onQuery ? 0 : 1) - (props.hints ? 1 : 0) - 1;

  const lines: Line[] = [];
  let lastGroup: string | undefined;
  let idx = 0;
  for (const item of filtered) {
    if (item.group && item.group !== lastGroup) {
      lines.push({ kind: "group", text: item.group });
      lastGroup = item.group;
    }
    if (item.disabled) lines.push({ kind: "item", item, index: -1 });
    else lines.push({ kind: "item", item, index: idx++ });
  }
  const selLine = Math.max(0, lines.findIndex((l) => l.kind === "item" && l.index === selected));
  const start = Math.max(0, Math.min(selLine - Math.floor(listH / 2), lines.length - listH));
  const visible = lines.slice(start, start + Math.max(1, listH));

  return (
    <DialogBox theme={theme} width={width} height={height} title={props.title} subtitle={props.subtitle} hints={props.hints ?? "↑↓ move · enter pick · esc close"}>
      {props.filter === false && !props.onQuery ? null : (
        <InputLine theme={theme} editor={editor} placeholder={props.placeholder ?? "Type to filter"} width={innerW} />
      )}
      {props.loading ? <Text color={c.accent2}>✦ loading…</Text> : null}
      {props.error ? (
        <Text color={c.error} wrap="truncate">
          {`✗ ${props.error}`}
        </Text>
      ) : null}
      {!props.loading && !filtered.length ? <Text color={c.faint}>{props.empty ?? "Nothing here."}</Text> : null}
      {visible.map((line, i) => {
        if (line.kind === "group") {
          return (
            <Text key={`g${start + i}`} color={c.accent2} bold wrap="truncate">
              {line.text}
            </Text>
          );
        }
        const { item } = line;
        const active = line.index === selected && !item.disabled;
        const badgeW = item.badge ? segsWidth([item.badge]) + 1 : 0;
        const labelRoom = Math.max(4, innerW - 2 - badgeW);
        const label = truncate(item.label, labelRoom);
        const hint = item.hint ? truncate(`  ${item.hint}`, Math.max(0, labelRoom - textWidth(label))) : "";
        const pad = Math.max(0, innerW - 2 - textWidth(label) - textWidth(hint) - badgeW);
        const bg = active ? c.selection : c.popover;
        return (
          <Text key={item.id} wrap="truncate">
            <Text color={active ? c.accent : c.faint} backgroundColor={bg}>
              {active ? "› " : "  "}
            </Text>
            <Text color={item.disabled ? c.faint : active ? c.selectionText : c.text} backgroundColor={bg} bold={active}>
              {label}
            </Text>
            <Text color={c.faint} backgroundColor={bg}>
              {hint}
            </Text>
            <Text backgroundColor={bg}>{" ".repeat(pad)}</Text>
            {item.badge ? <Segs segs={[{ text: " ", bg }, { ...item.badge, bg: item.badge.bg ?? bg }]} bg={bg} /> : null}
          </Text>
        );
      })}
    </DialogBox>
  );
}
