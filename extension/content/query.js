// Boolean find queries → predicate over a text blob. Pure; no DOM.
//
//   foo bar            implicit AND
//   foo AND bar        also && &
//   foo OR bar         also || |
//   NOT foo            also !foo  -foo
//   "a phrase"         quoted phrase (case-insensitive substring)
//   /re+gex/flags      regex; `i` added when no flags given
//   ( ... )            grouping;  NOT > AND > OR
//
// parseQuery("") → null. Syntax errors throw { message, pos }.

const WORD_END = /[\s()]/;
const norm = (s) => s.replace(/\s+/g, " ").toLowerCase();

class QueryError extends Error {
  constructor(message, pos) {
    super(message);
    this.pos = pos;
  }
}

export function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === "(" || ch === ")") {
      toks.push({ t: ch, pos: start });
      i++;
    } else if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) throw new QueryError("unterminated quote", start);
      toks.push({ t: "term", kind: "phrase", v: src.slice(i + 1, end), pos: start });
      i = end + 1;
    } else if (ch === "/") {
      let j = i + 1;
      while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) throw new QueryError("unterminated regex", start);
      const body = src.slice(i + 1, j);
      j++;
      let flags = "";
      while (j < src.length && /[a-z]/i.test(src[j])) flags += src[j++];
      toks.push({ t: "term", kind: "regex", v: body, flags, pos: start });
      i = j;
    } else if (ch === "&" || ch === "|") {
      const two = src[i + 1] === ch;
      toks.push({ t: ch === "&" ? "AND" : "OR", pos: start });
      i += two ? 2 : 1;
    } else if (ch === "!" || (ch === "-" && i + 1 < src.length && !WORD_END.test(src[i + 1]))) {
      toks.push({ t: "NOT", pos: start });
      i++;
    } else {
      let j = i;
      while (j < src.length && !WORD_END.test(src[j])) j++;
      const w = src.slice(i, j);
      const up = w.toUpperCase();
      if (up === "AND" || up === "OR" || up === "NOT") toks.push({ t: up, pos: start });
      else toks.push({ t: "term", kind: "word", v: w, pos: start });
      i = j;
    }
  }
  return toks;
}

// Grammar:  or := and (OR and)* ;  and := not ((AND)? not)* ;  not := NOT not | atom ;
//           atom := '(' or ')' | term
export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => (toks[p]?.t === t ? toks[p++] : null);
  const atEnd = () => p >= toks.length;

  function or() {
    let left = and();
    while (eat("OR")) left = { op: "or", a: left, b: and() };
    return left;
  }
  function and() {
    let left = not();
    for (;;) {
      if (eat("AND")) {
        left = { op: "and", a: left, b: not() };
        continue;
      }
      const nx = peek();
      if (nx && (nx.t === "term" || nx.t === "(" || nx.t === "NOT")) {
        left = { op: "and", a: left, b: not() };
        continue;
      }
      return left;
    }
  }
  function not() {
    if (eat("NOT")) return { op: "not", a: not() };
    return atom();
  }
  function atom() {
    const tk = peek();
    if (!tk) throw new QueryError("unexpected end of query", src.length);
    if (eat("(")) {
      const inner = or();
      if (!eat(")")) throw new QueryError("missing )", peek()?.pos ?? src.length);
      return inner;
    }
    if (tk.t === "term") {
      p++;
      return { op: "term", ...tk };
    }
    throw new QueryError(`unexpected ${tk.t === ")" ? ")" : tk.t}`, tk.pos);
  }

  if (!toks.length) return null;
  const ast = or();
  if (!atEnd()) throw new QueryError(`unexpected ${peek().t === ")" ? ")" : peek().t}`, peek().pos);
  return ast;
}

export function compile(ast) {
  switch (ast.op) {
    case "or": {
      const a = compile(ast.a), b = compile(ast.b);
      return (t) => a(t) || b(t);
    }
    case "and": {
      const a = compile(ast.a), b = compile(ast.b);
      return (t) => a(t) && b(t);
    }
    case "not": {
      const a = compile(ast.a);
      return (t) => !a(t);
    }
    case "term": {
      if (ast.kind === "regex") {
        let re;
        try {
          re = new RegExp(ast.v, ast.flags || "i");
        } catch (e) {
          throw new QueryError(`bad regex: ${e.message}`, ast.pos);
        }
        return (t) => {
          re.lastIndex = 0;
          return re.test(t.raw);
        };
      }
      const needle = norm(ast.v);
      if (!needle) return () => true;
      return (t) => t.norm.includes(needle);
    }
  }
  throw new QueryError("bad ast", 0);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A matcher finds every [start, end) range of one term in raw text. Used for highlighting,
// so it works on the raw text (no whitespace collapse): phrase spaces become \s+.
export function termMatcher(term) {
  let re;
  if (term.kind === "regex") {
    const flags = term.flags || "i";
    try {
      re = new RegExp(term.v, flags.includes("g") ? flags : flags + "g");
    } catch {
      return () => [];
    }
  } else {
    const needle = norm(term.v);
    if (!needle) return () => [];
    re = new RegExp(needle.split(" ").map(escapeRe).join("\\s+"), "gi");
  }
  return (raw) => {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(raw))) {
      if (m[0].length === 0) {
        re.lastIndex++; // zero-length match: step forward, nothing to highlight
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
    return out;
  };
}

export const matchRanges = (matchers, raw) => matchers.flatMap((f) => f(raw));

// Returns null for an empty query, else { pred(text:string) → bool, ast, terms, highlight }.
// highlight = matchers for the terms under an even number of NOTs (the ones a match "contains").
export function parseQuery(src) {
  const ast = parse(src || "");
  if (!ast) return null;
  const inner = compile(ast);
  const terms = [];
  const positive = [];
  (function walk(n, neg) {
    if (n.op === "term") {
      terms.push(n);
      if (!neg) positive.push(n);
    } else if (n.op === "not") walk(n.a, !neg);
    else {
      walk(n.a, neg);
      walk(n.b, neg);
    }
  })(ast, false);
  const pred = (text) => {
    const raw = String(text ?? "");
    return inner({ raw, norm: norm(raw) });
  };
  return { pred, ast, terms, highlight: positive.map(termMatcher) };
}
