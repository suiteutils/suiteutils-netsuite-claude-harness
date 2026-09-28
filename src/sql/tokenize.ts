/** Minimal SuiteQL tokenizer: enough structure for lint rules, not a parser. */

export type TokType = "word" | "num" | "str" | "qid" | "op" | "lp" | "rp" | "comma" | "dot" | "star" | "semi" | "param";

export interface Tok {
  type: TokType;
  /** Lower-cased for words; raw text otherwise (string literals without quotes). */
  value: string;
  raw: string;
  start: number;
  end: number;
  depth: number;
}

export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let depth = 0;
  const push = (type: TokType, value: string, start: number, end: number, d = depth) =>
    toks.push({ type, value, raw: sql.slice(start, end), start, end, depth: d });

  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    const start = i;
    if (c === "'") {
      let v = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else v += sql[i++];
      }
      push("str", v, start, i);
      continue;
    }
    if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      i = e < 0 ? sql.length : e + 1;
      push("qid", sql.slice(start + 1, i - 1).toLowerCase(), start, i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      while (i < sql.length && /[0-9.eE]/.test(sql[i])) i++;
      push("num", sql.slice(start, i), start, i);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$#]/.test(sql[i])) i++;
      push("word", sql.slice(start, i).toLowerCase(), start, i);
      continue;
    }
    if (c === "(") {
      push("lp", c, i, ++i, depth);
      depth++;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      push("rp", c, i, ++i, depth);
      continue;
    }
    if (c === ",") {
      push("comma", c, i, ++i);
      continue;
    }
    if (c === ".") {
      push("dot", c, i, ++i);
      continue;
    }
    if (c === "*") {
      push("star", c, i, ++i);
      continue;
    }
    if (c === ";") {
      push("semi", c, i, ++i);
      continue;
    }
    if (c === "?" || c === ":") {
      i++;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      push("param", sql.slice(start, i), start, i);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "||"].includes(two)) {
      i += 2;
      push("op", two, start, i);
      continue;
    }
    push("op", c, i, ++i);
  }
  return toks;
}

export interface Scope {
  /** Index of the opening paren token, or -1 for the top level. */
  open: number;
  /** Index of the closing paren token, or toks.length for the top level. */
  close: number;
  depth: number;
  /** Token indices directly inside this scope (not in nested parens). */
  direct: number[];
  isQuery: boolean;
}

const SET_OPS = new Set(["union", "minus", "intersect", "except"]);

/**
 * Split tokens into paren scopes. A scope is a query when its first direct token is SELECT/WITH,
 * or when it starts with a parenthesized query and is either the top level (`(SELECT …) ORDER BY 1
 * OFFSET …`) or a compound (`((SELECT …) UNION (SELECT …))`): its trailing ORDER BY / FETCH /
 * OFFSET / LIMIT belong to it.
 */
export function scopes(toks: Tok[]): Scope[] {
  const out: Scope[] = [];
  const stack: Scope[] = [{ open: -1, close: toks.length, depth: 0, direct: [], isQuery: false }];
  toks.forEach((t, i) => {
    if (t.type === "lp") {
      stack[stack.length - 1].direct.push(i);
      stack.push({ open: i, close: -1, depth: t.depth + 1, direct: [], isQuery: false });
    } else if (t.type === "rp") {
      if (stack.length > 1) {
        const s = stack.pop()!;
        s.close = i;
        out.push(s);
      }
      stack[stack.length - 1].direct.push(i);
    } else stack[stack.length - 1].direct.push(i);
  });
  while (stack.length > 1) {
    const s = stack.pop()!;
    s.close = toks.length;
    out.push(s);
  }
  out.push(stack[0]);
  // Children come before their parents in `out` (pushed on close), so a child's isQuery is set first.
  const byOpen = new Map(out.filter((s) => s.open >= 0).map((s) => [s.open, s]));
  for (const s of out) {
    const first = toks[s.direct[0]];
    if (first?.type === "word") s.isQuery = first.value === "select" || first.value === "with";
    else if (first?.type === "lp" && byOpen.get(s.direct[0])?.isQuery) {
      s.isQuery = s.open < 0 || s.direct.some((i) => toks[i].type === "word" && SET_OPS.has(toks[i].value));
    }
  }
  return out;
}
