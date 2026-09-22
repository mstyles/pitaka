// The browser demo's stand-in for `search_library`: the same query syntax,
// matching, bm25 ranking and snippets as `db::search`, ported from the Rust
// query builder (`to_fts_query`) and SQLite's FTS5 (the unicode61 and porter
// tokenizers, bm25() and snippet()). `search.test.ts` checks it against
// results the core wrote to `src/test/fixtures/demo-search.json`.
import type { BookSummary, ChapterContent, ContentBlockRow, SearchMode, SearchResult } from "../types";
import { porterStem } from "./porter";

/** snippet()'s last argument in `db::search`: the most tokens to show. */
const SNIPPET_TOKENS = 12;

type Token = { term: string; start: number; end: number };

// unicode61: a token is a run of letters, numbers and private-use characters;
// combining marks can continue a token but not start one.
const TOKEN = /[\p{L}\p{N}\p{Co}][\p{L}\p{N}\p{Co}\p{M}]*/gu;

/** remove_diacritics 2 plus lowercasing, as unicode61 folds each token. */
function fold(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function tokenize(text: string, mode: SearchMode): Token[] {
  return Array.from(text.matchAll(TOKEN), (m) => {
    const folded = fold(m[0]);
    return {
      term: mode === "stemmed" ? porterStem(folded) : folded,
      start: m.index,
      end: m.index + m[0].length,
    };
  });
}

// --- Query parsing --------------------------------------------------------

type Operator = "AND" | "OR" | "NOT";
type QueryPart = { op: Operator } | { text: string; prefix: boolean };

/**
 * A port of `to_fts_query`: every word is a quoted term; "quoted phrases",
 * a trailing `*`, and uppercase AND/OR/NOT between two terms are kept.
 */
function parseQuery(query: string): QueryPart[] {
  const chars = Array.from(query);
  const isSpace = (c: string) => /\s/u.test(c);
  const hasClosingQuote = (at: number) => chars.indexOf('"', at + 1) >= 0;
  const parts: QueryPart[] = [];
  let lastIsTerm = false;
  let i = 0;

  while (i < chars.length) {
    if (isSpace(chars[i])) {
      i++;
      continue;
    }
    let text = "";
    const isPhrase = chars[i] === '"' && hasClosingQuote(i);
    if (isPhrase) {
      for (i++; chars[i] !== '"'; i++) text += chars[i];
      i++;
    } else {
      for (; i < chars.length; i++) {
        if (isSpace(chars[i]) || (chars[i] === '"' && hasClosingQuote(i))) break;
        text += chars[i];
      }
    }

    if (!isPhrase && (text === "AND" || text === "OR" || text === "NOT") && lastIsTerm) {
      parts.push({ op: text });
      lastIsTerm = false;
      continue;
    }
    let prefix = false;
    if (isPhrase) {
      if (chars[i] === "*") {
        prefix = true;
        i++;
      }
    } else if (text.endsWith("*")) {
      prefix = true;
      text = text.replace(/\*+$/, "");
    }
    if (!text.trim()) continue;
    parts.push({ text, prefix });
    lastIsTerm = true;
  }
  if (!lastIsTerm) parts.pop(); // a trailing operator, e.g. "neural OR"
  return parts;
}

// --- Expression -----------------------------------------------------------

type Phrase = { terms: string[]; prefix: boolean };
type Expr =
  | { kind: "phrase"; phrase: number }
  | { kind: "none" } // a phrase with no tokens, e.g. "--": matches nothing
  | { kind: "and" | "or"; children: Expr[] }
  | { kind: "not"; left: Expr; right: Expr };

const PRECEDENCE: Record<Operator, number> = { OR: 1, AND: 2, NOT: 3 };

/**
 * Builds FTS5's expression tree. Terms written next to each other bind
 * tightest (an implicit AND that drops empty phrases), then NOT, AND and OR,
 * all left-associative.
 */
function buildExpr(parts: QueryPart[], mode: SearchMode): { expr: Expr; phrases: Phrase[] } {
  const phrases: Phrase[] = [];
  const operands: Expr[] = [];
  const operators: Operator[] = [];

  let run: Expr[] = [];
  const endRun = () => {
    const kept = run.filter((e) => e.kind !== "none");
    operands.push(kept.length === 0 ? { kind: "none" } : kept.length === 1 ? kept[0] : { kind: "and", children: kept });
    run = [];
  };
  const reduce = () => {
    const right = operands.pop()!;
    const left = operands.pop()!;
    const op = operators.pop()!;
    operands.push(op === "NOT" ? { kind: "not", left, right } : { kind: op === "AND" ? "and" : "or", children: [left, right] });
  };

  for (const part of parts) {
    if ("op" in part) {
      endRun();
      while (operators.length && PRECEDENCE[operators[operators.length - 1]] >= PRECEDENCE[part.op]) reduce();
      operators.push(part.op);
    } else {
      const terms = tokenize(part.text, mode).map((t) => t.term);
      if (terms.length === 0) {
        run.push({ kind: "none" });
      } else {
        phrases.push({ terms, prefix: part.prefix });
        run.push({ kind: "phrase", phrase: phrases.length - 1 });
      }
    }
  }
  endRun();
  while (operators.length) reduce();
  return { expr: operands[0], phrases };
}

/** Token positions where the phrase starts in a row. */
function phrasePositions(phrase: Phrase, terms: string[]): number[] {
  const n = phrase.terms.length;
  const positions: number[] = [];
  for (let i = 0; i + n <= terms.length; i++) {
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      const want = phrase.terms[k];
      ok = phrase.prefix && k === n - 1 ? terms[i + k].startsWith(want) : terms[i + k] === want;
    }
    if (ok) positions.push(i);
  }
  return positions;
}

function matches(expr: Expr, hits: number[][]): boolean {
  switch (expr.kind) {
    case "phrase":
      return hits[expr.phrase].length > 0;
    case "none":
      return false;
    case "and":
      return expr.children.every((c) => matches(c, hits));
    case "or":
      return expr.children.some((c) => matches(c, hits));
    case "not":
      return matches(expr.left, hits) && !matches(expr.right, hits);
  }
}

/** The phrases whose matches count in a matching row: not those under NOT's right side, or an OR branch that didn't match. */
function reportedPhrases(expr: Expr, hits: number[][], out: Set<number>) {
  switch (expr.kind) {
    case "phrase":
      out.add(expr.phrase);
      break;
    case "none":
      break;
    case "and":
    case "or":
      for (const c of expr.children) if (matches(c, hits)) reportedPhrases(c, hits, out);
      break;
    case "not":
      reportedPhrases(expr.left, hits, out);
      break;
  }
}

// --- Index, ranking and snippets ------------------------------------------

type Row = { block: ContentBlockRow; content: ChapterContent; tokens: Token[]; terms: string[] };
type Instance = { phrase: number; pos: number; size: number };

/** Search over the demo's chapters. The index for each mode is built on first use. */
export function createSearch(contents: ChapterContent[]) {
  const indexes: Partial<Record<SearchMode, Row[]>> = {};
  const rowsFor = (mode: SearchMode) =>
    (indexes[mode] ??= contents.flatMap((content) =>
      content.blocks.map((block) => {
        const tokens = tokenize(block.text, mode);
        return { block, content, tokens, terms: tokens.map((t) => t.term) };
      }),
    ));

  return function search(books: BookSummary[], query: string, mode: SearchMode, limit = 50): SearchResult[] {
    const parts = parseQuery(query);
    if (parts.length === 0) return [];
    const { expr, phrases } = buildExpr(parts, mode);
    const titles = new Map(books.map((b) => [b.id, b.title]));
    const rows = rowsFor(mode).filter((r) => titles.has(r.content.book_id));
    if (rows.length === 0) return [];

    const rowHits = rows.map((r) => phrases.map((p) => phrasePositions(p, r.terms)));
    const avgdl = rows.reduce((n, r) => n + r.tokens.length, 0) / rows.length;
    const idf = phrases.map((_, i) => {
      const nHit = rowHits.filter((hits) => hits[i].length > 0).length;
      const value = Math.log((rows.length - nHit + 0.5) / (nHit + 0.5));
      return value <= 0 ? 1e-6 : value;
    });

    const results: SearchResult[] = [];
    rows.forEach((row, r) => {
      const hits = rowHits[r];
      if (!matches(expr, hits)) return;
      const reported = new Set<number>();
      reportedPhrases(expr, hits, reported);
      const instances: Instance[] = [...reported]
        .flatMap((phrase) => hits[phrase].map((pos) => ({ phrase, pos, size: phrases[phrase].terms.length })))
        .sort((a, b) => a.pos - b.pos || a.phrase - b.phrase);

      const k1 = 1.2;
      const b = 0.75;
      let score = 0;
      phrases.forEach((_, i) => {
        const freq = instances.filter((inst) => inst.phrase === i).length;
        score += idf[i] * ((freq * (k1 + 1.0)) / (freq + k1 * (1 - b + (b * row.tokens.length) / avgdl)));
      });

      results.push({
        book_id: row.content.book_id,
        book_title: titles.get(row.content.book_id) ?? null,
        chapter_id: row.content.chapter_id,
        chapter_idx: row.content.chapter_idx,
        chapter_title: row.content.chapter_title,
        block_idx: row.block.block_idx,
        content_block_id: row.block.id,
        snippet: snippet(row, instances, phrases.length),
        rank: -1.0 * score,
      });
    });

    return results.sort((a, b) => a.rank - b.rank || a.content_block_id - b.content_block_id).slice(0, limit);
  };
}

/** fts5SnippetScore: 1000 per phrase seen in the window, 1 per repeat. */
function snippetScore(instances: Instance[], nPhrase: number, docSize: number, iPos: number) {
  const seen = new Array<boolean>(nPhrase).fill(false);
  const end = iPos + SNIPPET_TOKENS;
  let score = 0;
  let first = -1;
  let last = 0;
  for (const inst of instances) {
    if (inst.pos >= iPos && inst.pos < end) {
      score += seen[inst.phrase] ? 1 : 1000;
      seen[inst.phrase] = true;
      if (first < 0) first = inst.pos;
      last = inst.pos + inst.size;
    }
  }
  let adj = first - Math.trunc((SNIPPET_TOKENS - (last - first)) / 2);
  if (adj + SNIPPET_TOKENS > docSize) adj = docSize - SNIPPET_TOKENS;
  if (adj < 0) adj = 0;
  return { score, adj };
}

/** snippet(fts, 0, '[', ']', '...', 12), following fts5SnippetFunction. */
function snippet(row: Row, instances: Instance[], nPhrase: number): string {
  const text = row.block.text;
  const tokens = row.tokens;
  const docSize = tokens.length;

  // Sentence starts: the first token, and any token after whitespace that
  // follows a '.' or ':'.
  const sentenceStarts: number[] = [];
  tokens.forEach((tok, i) => {
    if (i === 0) return void sentenceStarts.push(0);
    let j = tok.start - 1;
    while (j >= 0 && " \t\n\r".includes(text[j])) j--;
    const c = j >= 0 ? text[j] : text[0];
    if (j !== tok.start - 1 && (c === "." || c === ":")) sentenceStarts.push(i);
  });

  let bestScore = 0;
  let bestStart = 0;
  for (const inst of instances) {
    const { score, adj } = snippetScore(instances, nPhrase, docSize, inst.pos);
    if (score > bestScore) {
      bestScore = score;
      bestStart = adj;
    }
    if (sentenceStarts.length && docSize > SNIPPET_TOKENS) {
      let jj = 0;
      while (jj < sentenceStarts.length - 1 && sentenceStarts[jj + 1] <= inst.pos) jj++;
      const start = sentenceStarts[jj];
      if (start < inst.pos) {
        const sentenceScore = snippetScore(instances, nPhrase, docSize, start).score + (start === 0 ? 120 : 100);
        if (sentenceScore > bestScore) {
          bestScore = sentenceScore;
          bestStart = start;
        }
      }
    }
  }

  // Coalesced instances: overlapping matches are highlighted as one.
  const spans: { start: number; end: number }[] = [];
  for (const inst of instances) {
    const end = inst.pos + inst.size - 1;
    const prev = spans[spans.length - 1];
    if (prev && inst.pos <= prev.end) prev.end = Math.max(prev.end, end);
    else spans.push({ start: inst.pos, end });
  }
  let s = spans.findIndex((sp) => sp.start >= bestStart);
  if (s < 0) s = spans.length;
  const span = () => spans[s] ?? { start: -1, end: -1 };

  // fts5HighlightCb over the snippet's token range.
  const rangeEnd = bestStart + SNIPPET_TOKENS - 1;
  let out = bestStart > 0 ? "..." : "";
  let off = 0;
  let open = false;
  tokens.forEach((tok, pos) => {
    if (pos < bestStart || pos > rangeEnd) return;
    if (bestStart && pos === bestStart) off = tok.start;
    if (open && (pos <= span().start || span().start < 0) && tok.start > off) {
      out += "]";
      open = false;
    }
    if (pos === span().start && !open) {
      out += text.slice(off, tok.start) + "[";
      off = tok.start;
      open = true;
    }
    if (pos === span().end) {
      if (!open) {
        out += "[";
        open = true;
      }
      out += text.slice(off, tok.end);
      off = tok.end;
      s++;
    }
    if (pos === rangeEnd) {
      if (open) {
        if (span().start >= 0 && pos >= span().start) {
          out += text.slice(off, tok.end);
          off = tok.end;
        }
        out += "]";
        open = false;
      }
      out += text.slice(off, tok.end);
      off = tok.end;
    }
  });
  if (open) out += "]";
  out += rangeEnd >= docSize - 1 ? text.slice(off) : "...";
  return out;
}
