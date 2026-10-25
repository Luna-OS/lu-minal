// A rough structural check for Luau source, for tests: it tokenizes (strings, long strings,
// comments, interpolated strings) and checks that blocks (function / if / do / repeat against
// end / until) and brackets balance, that then / elseif / else sit inside an if, and that no
// statement starts with "(" where Luau would read it as a call. It is no parser, but it catches the
// mistakes an edit of the plugin most often makes (a missing `end`, an unclosed table).

interface Token {
  kind: "name" | "op" | "str" | "num";
  value: string;
  line: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const longLevel = (at: number): number => {
    if (src[at] !== "[") return -1;
    let j = at + 1;
    let level = 0;
    while (src[j] === "=") {
      level++;
      j++;
    }
    return src[j] === "[" ? level : -1;
  };
  const skipLong = (at: number, level: number): number => {
    const close = `]${"=".repeat(level)}]`;
    const end = src.indexOf(close, at);
    if (end < 0) throw new Error(`line ${line}: unclosed long bracket`);
    for (let k = at; k < end; k++) if (src[k] === "\n") line++;
    return end + close.length;
  };
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && src[i + 1] === "-") {
      const level = longLevel(i + 2);
      if (level >= 0) {
        i = skipLong(i + 4 + level, level);
      } else {
        while (i < n && src[i] !== "\n") i++;
      }
    } else if (c === "[" && longLevel(i) >= 0) {
      const level = longLevel(i);
      const start = line;
      i = skipLong(i + 2 + level, level);
      tokens.push({ kind: "str", value: "[[...]]", line: start });
    } else if (c === '"' || c === "'" || c === "`") {
      const start = line;
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") throw new Error(`line ${start}: newline inside a string`);
        i++;
      }
      if (i >= n) throw new Error(`line ${start}: unclosed string`);
      i++;
      tokens.push({ kind: "str", value: "...", line: start });
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /\w/.test(src[j])) j++;
      tokens.push({ kind: "name", value: src.slice(i, j), line });
      i = j;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < n && /[\w.]/.test(src[j])) j++;
      tokens.push({ kind: "num", value: src.slice(i, j), line });
      i = j;
    } else {
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      const op = ["...", "..=", "//="].includes(three)
        ? three
        : ["==", "~=", "<=", ">=", "..", "::", "->", "+=", "-=", "*=", "/=", "%=", "^=", "//"].includes(two)
          ? two
          : c;
      tokens.push({ kind: "op", value: op, line });
      i += op.length;
    }
  }
  return tokens;
}

/** Tokens after which an `if` starts an if-expression rather than an if-statement. */
const EXPRESSION_BEFORE = new Set(["=", "(", ",", "return", "..", "and", "or", "not", "{", "[", "==", "~=", "+", "-", "*", "/", "%", "^", "<", ">", "<=", ">=", "then", "else", "+=", "-=", "..=", "::"]);
const BRACKETS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Problems found in `src`; an empty list when it looks well-formed. */
export function checkLuauStructure(src: string): string[] {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const problems: string[] = [];
  const stack: Array<{ value: string; line: number }> = [];
  const top = () => stack[stack.length - 1];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    const prev = tokens[k - 1];
    const v = tok.value;
    if (tok.kind === "name") {
      if (v === "if") {
        // `x = if a then b else c`: an expression, closed by its `else` branch.
        const expression = prev !== undefined && EXPRESSION_BEFORE.has(prev.value) && !(prev.value === "then" || prev.value === "else")
          ? true
          : prev !== undefined && (prev.value === "then" || prev.value === "else") && top()?.value === "ifexpr";
        stack.push({ value: expression ? "ifexpr" : "if", line: tok.line });
      } else if (v === "function" || v === "repeat" || v === "do") {
        stack.push({ value: v, line: tok.line });
      } else if (v === "end") {
        const open = stack.pop();
        if (!open) problems.push(`line ${tok.line}: "end" without an open block`);
        else if (!["if", "function", "do"].includes(open.value)) problems.push(`line ${tok.line}: "end" closes "${open.value}" from line ${open.line}`);
      } else if (v === "until") {
        const open = stack.pop();
        if (open?.value !== "repeat") problems.push(`line ${tok.line}: "until" without "repeat"`);
      } else if (v === "then" || v === "elseif") {
        const open = top()?.value;
        if (open !== "if" && open !== "ifexpr") problems.push(`line ${tok.line}: "${v}" outside an if`);
      } else if (v === "else") {
        const open = top()?.value;
        if (open === "ifexpr") stack.pop();
        else if (open !== "if") problems.push(`line ${tok.line}: "else" outside an if`);
      }
    } else if (tok.kind === "op") {
      if (v === "(" || v === "[" || v === "{") {
        stack.push({ value: v, line: tok.line });
        // A statement that starts with "(" right after an expression reads as a call in Luau.
        if (v === "(" && prev && prev.line < tok.line && (prev.kind === "name" || prev.kind === "str" || prev.value === ")" || prev.value === "]")) {
          const keyword = ["then", "do", "else", "end", "repeat", "return", "and", "or", "not", "local", "in"].includes(prev.value);
          const afterParams = prev.value === ")" && isParameterListEnd(tokens, k - 1);
          if (!keyword && !afterParams) problems.push(`line ${tok.line}: a line starting with "(" continues the previous line's expression`);
        }
      } else if (v in BRACKETS) {
        const open = stack.pop();
        if (open?.value !== BRACKETS[v]) problems.push(`line ${tok.line}: "${v}" closes "${open?.value ?? "nothing"}" from line ${open?.line ?? "?"}`);
      }
    }
  }
  for (const open of stack) problems.push(`line ${open.line}: "${open.value}" is never closed`);
  return problems;
}

/** Whether the ")" at `index` ends a function's parameter list (`function(a, b)` + return type). */
function isParameterListEnd(tokens: Token[], index: number): boolean {
  let depth = 0;
  for (let k = index; k >= 0; k--) {
    const v = tokens[k].value;
    if (v === ")") depth++;
    else if (v === "(") {
      depth--;
      if (depth === 0) {
        const before = tokens[k - 1];
        const beforeThat = tokens[k - 2];
        return before?.value === "function" || beforeThat?.value === "function";
      }
    }
  }
  return false;
}
