// lu-minal's terminal page in the Windows window app: xterm.js (WebGL renderer when the GPU
// allows, the DOM renderer otherwise) wired to the host through window.ipc, plus the cloud
// pane's header and the divider around the place where the host puts the pane's own web view.
// The host calls window.lu.<function>(...); this page posts JSON messages (src/ipc.rs).
import { Terminal } from "./vendor/xterm.mjs";
import { FitAddon } from "./vendor/addon-fit.mjs";
import { Unicode11Addon } from "./vendor/addon-unicode11.mjs";
import { WebglAddon } from "./vendor/addon-webgl.mjs";

/** The Moon terminal palette: MOON_ANSI in src/platform/windows-terminal.ts, value for value. */
export const MOON_THEME = {
  background: "#0b0920",
  foreground: "#e9e4f7",
  cursor: "#e0c880",
  cursorAccent: "#0b0920",
  selectionBackground: "#454069",
  black: "#1d1742",
  red: "#f28b92",
  green: "#7fe3c6",
  yellow: "#f3c766",
  blue: "#9ad7f5",
  magenta: "#b9aefb",
  cyan: "#8ee6e0",
  white: "#e9e4f7",
  brightBlack: "#5d5789",
  brightRed: "#ffa3a9",
  brightGreen: "#a3f0da",
  brightYellow: "#f8d98f",
  brightBlue: "#bfe6fa",
  brightMagenta: "#d6cffd",
  brightCyan: "#b5f2ee",
  brightWhite: "#ffffff",
};

const FONT_FAMILY = '"Cascadia Mono", "Cascadia Code", Consolas, monospace';
// windows-app/src/settings.rs and layout.rs.
const FONT_MIN = 8;
const FONT_MAX = 32;
const FONT_DEFAULT = 14;
const PANE_MIN_WIDTH = 300;
const TERMINAL_MIN_WIDTH = 320;
const DIVIDER_WIDTH = 6;
const NOTICE_MS = 20000;

const $ = (id) => document.getElementById(id);
const app = $("app");
const area = $("terminal-area");
const host = $("terminal");
const divider = $("divider");
const hole = $("pane-hole");
const toast = $("toast");

function post(message) {
  window.ipc.postMessage(JSON.stringify(message));
}

/** The pane's width in a window this wide (layout.rs clamp_pane_width). */
function clampPaneWidth(wish, windowWidth) {
  const room = windowWidth - TERMINAL_MIN_WIDTH - DIVIDER_WIDTH;
  const max = room >= PANE_MIN_WIDTH ? room : Math.max(windowWidth / 2, 0);
  const min = Math.min(PANE_MIN_WIDTH, max);
  return Math.round(Math.min(Math.max(Number.isFinite(wish) ? wish : PANE_MIN_WIDTH, min), max));
}

function decode(base64) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

const state = {
  term: null,
  fit: null,
  fontSize: FONT_DEFAULT,
  paneOpen: false,
  /** The width the user chose; the shown one may be smaller in a narrow window. */
  paneWidth: 520,
  ended: false,
  lastRect: "",
  noticeTimer: 0,
  toastTimer: 0,
};

// ---- layout -------------------------------------------------------------------------------------

function applyPaneWidth() {
  const width = clampPaneWidth(state.paneWidth, window.innerWidth);
  app.style.setProperty("--pane-width", `${width}px`);
}

/** Tells the host where the pane's web view goes (only when it moved). */
function reportPane() {
  // While the divider moves the pane's web view is hidden: its place is sent when it stops.
  if (!state.paneOpen || app.classList.contains("dragging")) return;
  const r = hole.getBoundingClientRect();
  const rect = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
  if (key === state.lastRect) return;
  state.lastRect = key;
  post({ t: "pane-rect", ...rect });
}

let fitQueued = false;
function refit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    if (!state.fit) return;
    try {
      state.fit.fit();
    } catch {
      // not laid out yet
    }
  });
}

new ResizeObserver(refit).observe(host);
new ResizeObserver(() => reportPane()).observe(hole);
window.addEventListener("resize", () => {
  applyPaneWidth();
  requestAnimationFrame(reportPane);
});

function setPaneOpen(open) {
  state.paneOpen = open;
  app.classList.toggle("pane-closed", !open);
  app.classList.toggle("pane-open", open);
  divider.title = open ? "Drag to resize the cloud pane" : "Show the cloud pane (Ctrl+Shift+K)";
  state.lastRect = "";
  applyPaneWidth();
  requestAnimationFrame(reportPane);
  refit();
}

// ---- the divider --------------------------------------------------------------------------------

divider.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0) return;
  ev.preventDefault();
  if (!state.paneOpen) {
    post({ t: "pane", action: "open" });
    return;
  }
  divider.setPointerCapture(ev.pointerId);
  app.classList.add("dragging");
  // The pane's web view steps aside while the divider moves (it would take the pointer).
  post({ t: "drag", active: true });
  const move = (e) => {
    state.paneWidth = Math.max(PANE_MIN_WIDTH, window.innerWidth - e.clientX - DIVIDER_WIDTH / 2);
    applyPaneWidth();
  };
  const end = () => {
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", end);
    divider.removeEventListener("pointercancel", end);
    app.classList.remove("dragging");
    state.paneWidth = clampPaneWidth(state.paneWidth, window.innerWidth);
    applyPaneWidth();
    state.lastRect = "";
    reportPane();
    post({ t: "pane-width", width: state.paneWidth });
    post({ t: "drag", active: false });
    state.term?.focus();
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", end);
  divider.addEventListener("pointercancel", end);
});

// ---- the pane's header --------------------------------------------------------------------------

for (const [id, action] of [
  ["pane-back", "back"],
  ["pane-reload", "reload"],
  ["pane-browser", "browser"],
  ["pane-close", "close"],
]) {
  const button = $(id);
  // The keyboard stays with the terminal.
  button.addEventListener("mousedown", (ev) => ev.preventDefault());
  button.addEventListener("click", () => post({ t: "pane", action }));
}

function hideNotice() {
  clearTimeout(state.noticeTimer);
  $("pane-notice").hidden = true;
}
$("pane-notice-close").addEventListener("mousedown", (ev) => ev.preventDefault());
$("pane-notice-close").addEventListener("click", hideNotice);

function showToast(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, NOTICE_MS);
}
toast.addEventListener("click", () => {
  toast.hidden = true;
});

// ---- keys, clipboard, mouse ---------------------------------------------------------------------

function copySelection() {
  const term = state.term;
  if (!term?.hasSelection()) return false;
  post({ t: "copy", text: term.getSelection() });
  term.clearSelection();
  return true;
}

function setFontSize(size) {
  const term = state.term;
  const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size * 2) / 2));
  if (!term || next === term.options.fontSize) return;
  term.options.fontSize = next;
  state.fontSize = next;
  refit();
  post({ t: "font-size", size: next });
}

/** Keys the window handles itself; false keeps them from xterm.js (and lu-minal). */
function onKey(ev) {
  if (ev.type !== "keydown") return true;
  if (state.ended) {
    if (!["Control", "Shift", "Alt", "Meta", "CapsLock"].includes(ev.key)) post({ t: "close" });
    return false;
  }
  const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const handled = () => {
    ev.preventDefault();
    return false;
  };
  // The host takes Ctrl+Shift+K before the page sees it; this is in case it could not.
  if (ctrl && ev.shiftKey && ev.code === "KeyK") {
    post({ t: "pane", action: "toggle" });
    return handled();
  }
  if (ctrl && ev.shiftKey && ev.code === "KeyC") {
    copySelection();
    return handled();
  }
  if (ctrl && !ev.shiftKey && ev.code === "KeyC" && copySelection()) return handled();
  if ((ctrl && ev.code === "KeyV") || (ev.shiftKey && !ev.ctrlKey && !ev.altKey && key === "Insert")) {
    post({ t: "paste" });
    return handled();
  }
  if (ctrl && !ev.shiftKey && key === "Insert") {
    copySelection();
    return handled();
  }
  if (ctrl && (key === "=" || key === "+" || ev.code === "NumpadAdd")) {
    setFontSize(state.fontSize + 1);
    return handled();
  }
  if (ctrl && !ev.shiftKey && (key === "-" || ev.code === "NumpadSubtract")) {
    setFontSize(state.fontSize - 1);
    return handled();
  }
  if (ctrl && !ev.shiftKey && (key === "0" || ev.code === "Numpad0")) {
    setFontSize(FONT_DEFAULT);
    return handled();
  }
  return true;
}

// Right click: copy the selection, or paste (as in Windows Terminal). lu-minal only uses the
// wheel, so the right button is never reported to it.
area.addEventListener(
  "mousedown",
  (ev) => {
    if (ev.button === 2) ev.stopPropagation();
  },
  true,
);
area.addEventListener(
  "mouseup",
  (ev) => {
    if (ev.button === 2) ev.stopPropagation();
  },
  true,
);
document.addEventListener("contextmenu", (ev) => {
  ev.preventDefault();
  if (!area.contains(ev.target) || !state.term || state.ended) return;
  if (!copySelection()) post({ t: "paste" });
  state.term.focus();
});
// Nothing is dropped onto the page itself (the host turns dropped files into a paste).
document.addEventListener("dragover", (ev) => ev.preventDefault());
document.addEventListener("drop", (ev) => ev.preventDefault());
window.addEventListener("focus", () => state.term?.focus());

// ---- what the host calls ------------------------------------------------------------------------

window.lu = {
  async init(options) {
    if (state.term) return;
    state.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, Number(options.fontSize) || FONT_DEFAULT));
    state.paneWidth = Number(options.paneWidth) || state.paneWidth;
    applyPaneWidth();
    try {
      await document.fonts.load(`${state.fontSize}px "Cascadia Mono"`);
    } catch {
      // the fallbacks will do
    }
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: FONT_FAMILY,
      fontSize: state.fontSize,
      theme: MOON_THEME,
      cursorBlink: true,
      scrollback: 5000,
      rightClickSelectsWord: false,
      windowsPty: { backend: "conpty", buildNumber: Number(options.windowsBuild) || undefined },
      linkHandler: {
        activate(ev, uri) {
          if (ev.ctrlKey) post({ t: "link", uri });
        },
        hover(_ev, uri) {
          host.title = `Ctrl+click to open ${uri}`;
        },
        leave() {
          host.title = "";
        },
      },
    });
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL here: the DOM renderer draws instead.
    }
    state.term = term;
    state.fit = fit;
    try {
      fit.fit();
    } catch {
      // laid out on the next resize
    }
    term.attachCustomKeyEventHandler(onKey);
    term.onData((data) => post({ t: "input", data }));
    term.onBinary((data) => post({ t: "binary", data }));
    term.onResize(({ cols, rows }) => post({ t: "resize", cols, rows }));
    term.onTitleChange((title) => post({ t: "title", title }));
    term.focus();
    post({ t: "ready", cols: term.cols, rows: term.rows });
  },

  /** Output from lu-minal: base64, and the byte count to acknowledge once it is parsed. */
  output(base64, count) {
    const term = state.term;
    if (!term) return;
    const bytes = decode(base64);
    term.write(bytes, () => {
      if (count) post({ t: "ack", bytes: count });
    });
  },

  paste(text) {
    state.term?.paste(text);
  },

  /** Nothing as text on the clipboard: lu-minal reads it itself on an empty bracketed paste. */
  pasteEmpty() {
    const term = state.term;
    if (term?.modes.bracketedPasteMode) post({ t: "input", data: "\x1b[200~\x1b[201~" });
  },

  setPane(open, width) {
    if (Number.isFinite(width)) state.paneWidth = width;
    if (!open) hideNotice();
    setPaneOpen(Boolean(open));
  },

  paneUrl(display, canGoBack) {
    const label = $("pane-url");
    label.textContent = display || "claude.ai";
    label.title = display || "";
    $("pane-back").disabled = !canGoBack;
  },

  notice(text) {
    if (!state.paneOpen) {
      showToast(text);
      return;
    }
    $("pane-notice-text").textContent = text;
    $("pane-notice").hidden = false;
    clearTimeout(state.noticeTimer);
    state.noticeTimer = setTimeout(hideNotice, NOTICE_MS);
  },

  exited(code) {
    state.ended = true;
    const term = state.term;
    if (!term) return;
    term.options.cursorBlink = false;
    const how = code ? ` (exit code ${code})` : "";
    term.write(`\r\n\r\n\x1b[38;2;185;174;251m[lu-minal ended] Press any key to close\x1b[0m${how ? `\x1b[38;2;112;108;125m${how}\x1b[0m` : ""}\r\n`);
    term.focus();
  },

  /** The smoke test: the terminal's text once everything written so far is parsed. */
  smokeCollect() {
    const term = state.term;
    if (!term) {
      post({ t: "smoke", text: "" });
      return;
    }
    term.write("", () => {
      const buffer = term.buffer.active;
      const lines = [];
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
      post({ t: "smoke", text: lines.join("\n") });
    });
  },
};

post({ t: "hello" });
