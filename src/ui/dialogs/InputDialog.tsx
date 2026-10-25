// A one-field dialog: a question, optional help lines, and a text (or masked secret) input.
// Also the small confirm and message dialogs.
import { Text, useInput, useWindowSize } from "ink";
import React, { useState } from "react";
import type { Theme } from "../../themes/types.js";
import { editKey, type EditorState } from "../editor.js";
import { wrap } from "../text.js";
import { DialogBox, InputLine } from "./ListDialog.js";

export function InputDialog(props: {
  theme: Theme;
  title: string;
  lines?: string[];
  initial?: string;
  placeholder?: string;
  mask?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  /** Extra key: Ctrl+O runs this (e.g. open the key page in the browser). */
  onOpen?: () => void;
  openHint?: string;
  allowEmpty?: boolean;
}) {
  const size = useWindowSize();
  const c = props.theme.colors;
  const [editor, setEditor] = useState<EditorState>({ value: props.initial ?? "", cursor: (props.initial ?? "").length });
  const width = Math.min(84, size.columns - 2);
  const text = (props.lines ?? []).flatMap((l) => wrap(l, width - 4));
  useInput((input, key) => {
    if (key.escape) return props.onCancel();
    if (key.ctrl && input === "o" && props.onOpen) return props.onOpen();
    const r = editKey(editor, input, key);
    if (r.kind === "submit") {
      if (editor.value.trim() || props.allowEmpty) props.onSubmit(editor.value.trim());
      return;
    }
    if (r.kind === "edit") setEditor(r.state);
  });
  const hints = `enter ok · esc cancel${props.onOpen ? ` · ctrl+o ${props.openHint ?? "open in browser"}` : ""}`;
  return (
    <DialogBox theme={props.theme} width={width} height={text.length + 6} title={props.title} hints={hints}>
      {text.map((l, i) => (
        <Text key={i} color={c.muted} wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      <InputLine theme={props.theme} editor={editor} placeholder={props.placeholder} width={width - 4} mask={props.mask} prefix="› " />
    </DialogBox>
  );
}

export function ConfirmDialog(props: {
  theme: Theme;
  title: string;
  lines: string[];
  yes?: string;
  no?: string;
  onYes: () => void;
  onNo: () => void;
  /** Enter means no (and "no" is the highlighted answer): only y says yes. For risky questions. */
  defaultNo?: boolean;
}) {
  const size = useWindowSize();
  const c = props.theme.colors;
  const width = Math.min(72, size.columns - 2);
  const text = props.lines.flatMap((l) => wrap(l, width - 4));
  useInput((input, key) => {
    if (key.escape || input === "n" || input === "N") return props.onNo();
    if (input === "y" || input === "Y") return props.onYes();
    if (key.return) return props.defaultNo ? props.onNo() : props.onYes();
  });
  const button = (label: string, highlighted: boolean) =>
    highlighted ? (
      <Text color={c.bg} backgroundColor={c.accent} bold>
        {label}
      </Text>
    ) : (
      <Text color={c.muted}>{label}</Text>
    );
  return (
    <DialogBox theme={props.theme} width={width} height={text.length + 5} title={props.title}>
      {text.map((l, i) => (
        <Text key={i} color={c.muted} wrap="truncate">
          {l}
        </Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate">
        {button(` y ${props.yes ?? "yes"} `, !props.defaultNo)}
        <Text>{"  "}</Text>
        {button(` n ${props.no ?? "no"} `, Boolean(props.defaultNo))}
      </Text>
    </DialogBox>
  );
}

/** A dialog that only shows text (and can be updated while open, e.g. a waiting sign-in). */
export function MessageDialog(props: {
  theme: Theme;
  title: string;
  lines: Array<string | { text: string; color?: string }>;
  hints?: string;
  hintsColor?: string;
  onClose: () => void;
  onKey?: (input: string) => boolean;
}) {
  const size = useWindowSize();
  const c = props.theme.colors;
  const width = Math.min(90, size.columns - 2);
  const rows = props.lines.flatMap((l) => {
    const item = typeof l === "string" ? { text: l } : l;
    return wrap(item.text, width - 4).map((t) => ({ text: t, color: item.color }));
  });
  const height = Math.min(rows.length + 4, Math.max(6, size.rows - 2));
  // Only the rows that fit (more would be squashed over each other); the arrows scroll the rest in.
  const room = Math.max(1, height - 4);
  const maxTop = Math.max(0, rows.length - room);
  const [top, setTop] = useState(0);
  const first = Math.min(top, maxTop);
  useInput((input, key) => {
    if (props.onKey?.(input)) return;
    if (key.upArrow) return setTop(Math.max(0, first - 1));
    if (key.downArrow) return setTop(Math.min(maxTop, first + 1));
    if (key.pageUp) return setTop(Math.max(0, first - room));
    if (key.pageDown) return setTop(Math.min(maxTop, first + room));
    if (key.escape || key.return) props.onClose();
  });
  const hints = props.hints ?? "enter / esc close";
  return (
    <DialogBox theme={props.theme} width={width} height={height} title={props.title} hints={maxTop ? `↑↓ scroll · ${hints}` : hints} hintsColor={props.hintsColor}>
      {rows.slice(first, first + room).map((r, i) => (
        <Text key={first + i} color={r.color ?? c.muted} wrap="truncate">
          {r.text || " "}
        </Text>
      ))}
    </DialogBox>
  );
}
