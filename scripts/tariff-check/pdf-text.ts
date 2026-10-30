/**
 * Minimal PDF text extraction for the tariff checker (no dependencies).
 *
 * Supports what office-generated text PDFs use: plain and object-stream objects, FlateDecode streams,
 * simple fonts (WinAnsi) and Type0/Identity-H fonts with a ToUnicode CMap, and the text operators
 * BT/ET, Tf, Tm, Td, TD, T*, Tj, TJ, ', " plus cm/q/Q. Output: text runs with page coordinates,
 * grouped into lines. Anything it cannot read (scanned images, encryption, unknown filters) throws
 * PdfError, and the checker then reports UNABLE TO VERIFY instead of guessing.
 */
import { inflateSync } from "node:zlib";

export class PdfError extends Error {}

const MAX_STREAM = 4 * 1024 * 1024;
const MAX_DECODED = 16 * 1024 * 1024;
const MAX_OBJECTS = 10_000;
const MAX_TOKENS = 100_000;
const MAX_TEXT = 1024 * 1024;
const limit = (ok: boolean, what: string) => { if (!ok) throw new PdfError(`PDF ${what} limit exceeded`); };

export interface Run {
  page: number;
  x: number;
  y: number;
  text: string;
}

interface Obj {
  dict: string;
  stream: Buffer | null;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Windows-1252 code points 0x80–0x9F; everything else in WinAnsi equals Latin-1. */
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function readObjects(buf: Buffer): Map<number, Obj> {
  limit(buf.length <= 20 * 1024 * 1024, "input size");
  const s = buf.toString("latin1");
  if (!s.startsWith("%PDF-")) throw new PdfError("not a PDF");
  if (/\/Encrypt\s/.test(s)) throw new PdfError("encrypted PDF");
  const objs = new Map<number, Obj>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  let count = 0;
  let decoded = 0;
  while ((m = re.exec(s))) {
    limit(++count <= MAX_OBJECTS, "object count");
    const start = m.index + m[0].length;
    const end = s.indexOf("endobj", start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si < 0) {
      objs.set(Number(m[1]), { dict: body.trim(), stream: null });
      continue;
    }
    const dict = body.slice(0, si);
    const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const dataEnd = len ? dataStart + Number(len[1]) : start + body.lastIndexOf("endstream");
    const stream = decode(dict, buf.subarray(dataStart, dataEnd));
    decoded += stream.length;
    limit(decoded <= MAX_DECODED, "total decoded size");
    objs.set(Number(m[1]), { dict, stream });
    re.lastIndex = end;
  }
  // Objects packed in object streams (PDF 1.5+).
  for (const o of [...objs.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1]);
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1]);
    limit(Number.isSafeInteger(n) && n >= 0 && n <= MAX_OBJECTS && Number.isSafeInteger(first) && first >= 0 && first <= o.stream.length, "object stream");
    const text = o.stream.toString("latin1");
    const head = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = head[2 * i]!;
      const from = first + head[2 * i + 1]!;
      const to = i + 1 < n ? first + head[2 * i + 3]! : text.length;
      limit(Number.isSafeInteger(num) && num >= 0 && Number.isSafeInteger(from) && from >= first && Number.isSafeInteger(to) && to >= from && to <= text.length, "object stream offsets");
      limit(objs.size < MAX_OBJECTS, "object count");
      if (!objs.has(num)) objs.set(num, { dict: text.slice(from, to).trim(), stream: null });
    }
  }
  return objs;
}

function decode(dict: string, data: Buffer): Buffer {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? "";
  if (!filter) { limit(data.length <= MAX_STREAM, "stream size"); return data; }
  if (filter.replace(/[[\]\s]/g, "") === "/FlateDecode") {
    try {
      return inflateSync(data, { maxOutputLength: MAX_STREAM });
    } catch {
      throw new PdfError("PDF decompression failed or exceeded stream size limit");
    }
  }
  return Buffer.alloc(0); // images (DCT, JPX, …): not text
}

const ref = (dict: string, key: string): number | null => {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
};

/** Contents of a balanced << >> dictionary that follows /key (inline), or of the referenced object. */
function subDict(objs: Map<number, Obj>, dict: string, key: string): string {
  const r = ref(dict, key);
  if (r !== null) return objs.get(r)?.dict ?? "";
  const i = dict.search(new RegExp(`/${key}\\s*<<`));
  if (i < 0) return "";
  let depth = 0;
  for (let j = dict.indexOf("<<", i); j < dict.length; j++) {
    if (dict.startsWith("<<", j)) {
      depth++;
      limit(depth <= 64, "dictionary nesting");
      j++;
    } else if (dict.startsWith(">>", j)) {
      depth--;
      j++;
      if (depth === 0) return dict.slice(dict.indexOf("<<", i) + 2, j - 1);
    }
  }
  return "";
}

interface Font {
  twoByte: boolean;
  map: Map<number, string>;
}

function parseCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  let entries = 0;
  const put = (code: number, value: string) => { limit(++entries <= 65_536, "CMap entries"); map.set(code, value); };
  const hex = (h: string) => {
    let out = "";
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return out;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) put(parseInt(p[1]!, 16), hex(p[2]!));
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1]!, 16);
      const hi = parseInt(p[2]!, 16);
      limit(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && lo >= 0 && hi <= 65_535 && hi >= lo, "CMap range");
      if (p[3]!.startsWith("[")) {
        [...p[3]!.matchAll(/<([0-9a-fA-F]+)>/g)].forEach((d, i) => put(lo + i, hex(d[1]!)));
      } else {
        const base = parseInt(p[3]!.slice(1, -1), 16);
        for (let c = lo; c <= hi; c++) put(c, String.fromCharCode(base + c - lo));
      }
    }
  }
  return map;
}

function loadFont(objs: Map<number, Obj>, dict: string): Font {
  const twoByte = /\/Subtype\s*\/Type0/.test(dict);
  const tu = ref(dict, "ToUnicode");
  const map = tu !== null && objs.get(tu)?.stream ? parseCMap(objs.get(tu)!.stream!.toString("latin1")) : new Map<number, string>();
  if (twoByte && !map.size) throw new PdfError("composite font without ToUnicode map");
  return { twoByte, map };
}

function decodeString(bytes: number[], font: Font | undefined): string {
  let out = "";
  if (font?.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) out += font.map.get((bytes[i]! << 8) | bytes[i + 1]!) ?? "�";
    return out;
  }
  for (const b of bytes) out += font?.map.get(b) ?? CP1252[b] ?? String.fromCharCode(b);
  return out;
}

type Token = { t: "num"; v: number } | { t: "str"; v: number[] } | { t: "name"; v: string } | { t: "op"; v: string } | { t: "arr"; v: Token[] };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const stack: Token[][] = [out];
  let i = 0;
  let count = 0;
  const deadline = performance.now() + 2_000;
  const push = (t: Token) => {
    limit(++count <= MAX_TOKENS, "token count");
    stack[stack.length - 1]!.push(t);
  };
  while (i < src.length) {
    limit(performance.now() <= deadline, "processing time");
    const before = i;
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "%") while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
    else if (c === "(") {
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < src.length && depth > 0) {
        const ch = src[i]!;
        if (ch === "\\") {
          const n = src[i + 1];
          if (n === undefined) throw new PdfError("unterminated PDF string");
          const esc: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
          if (n in esc) {
            bytes.push(esc[n]!);
            i += 2;
          } else if (/[0-7]/.test(n)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0];
            bytes.push(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
          } else if (n === "\r" || n === "\n") i += src[i + 2] === "\n" && n === "\r" ? 3 : 2;
          else {
            bytes.push(n.charCodeAt(0));
            i += 2;
          }
        } else {
          if (ch === "(") { depth++; limit(depth <= 64, "string nesting"); }
          else if (ch === ")" && --depth === 0) break;
          bytes.push(ch.charCodeAt(0));
          i++;
        }
      }
      if (depth !== 0) throw new PdfError("unterminated PDF string");
      i++;
      push({ t: "str", v: bytes });
    } else if (c === "<" && src[i + 1] === "<") {
      // inline dictionaries (marked content properties): skip
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith("<<", i)) { depth++; limit(depth <= 64, "dictionary nesting"); i += 2; }
        else if (src.startsWith(">>", i)) {
          depth--;
          i += 2;
          if (!depth) break;
        } else i++;
      }
    } else if (c === "<") {
      const end = src.indexOf(">", i);
      if (end < 0) throw new PdfError("unterminated PDF hex string");
      const h = src.slice(i + 1, end).replace(/\s/g, "");
      if (!/^[0-9a-f]*$/i.test(h)) throw new PdfError("invalid PDF hex string");
      const bytes: number[] = [];
      for (let j = 0; j < h.length; j += 2) bytes.push(parseInt(h.slice(j, j + 2).padEnd(2, "0"), 16));
      push({ t: "str", v: bytes });
      i = end + 1;
    } else if (c === "[") {
      const arr: Token[] = [];
      push({ t: "arr", v: arr });
      limit(stack.length < 64, "array nesting");
      stack.push(arr);
      i++;
    } else if (c === "]") {
      if (stack.length > 1) stack.pop();
      i++;
    } else if (c === "/") {
      const m = /^\/[^\s/\[\]()<>{}%]*/.exec(src.slice(i))![0];
      push({ t: "name", v: m.slice(1) });
      i += m.length;
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) {
        i++;
        continue;
      }
      push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else {
      const match = /^[^\s/\[\]()<>{}%]+/.exec(src.slice(i));
      if (!match) throw new PdfError("unexpected PDF delimiter");
      const m = match[0];
      if (m === "BI") {
        const end = src.indexOf("EI", i); // inline image data: skip
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      push({ t: "op", v: m });
      i += m.length;
    }
    if (i <= before) throw new PdfError("PDF tokenizer made no progress");
  }
  if (stack.length !== 1) throw new PdfError("unterminated PDF array");
  return out;
}

function runsOfPage(objs: Map<number, Obj>, page: Obj, pageNo: number): Run[] {
  const fontsDict = subDict(objs, subDict(objs, page.dict, "Resources"), "Font");
  const fonts = new Map<string, Font>();
  for (const m of fontsDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const f = objs.get(Number(m[2]));
    if (f) fonts.set(m[1]!, loadFont(objs, f.dict));
  }
  const contentIds: number[] = [];
  const arr = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
  if (arr) for (const m of arr[1]!.matchAll(/(\d+)\s+\d+\s+R/g)) contentIds.push(Number(m[1]));
  else {
    const r = ref(page.dict, "Contents");
    if (r !== null) contentIds.push(r);
  }
  limit(contentIds.length <= MAX_OBJECTS, "content references");
  let contentBytes = 0;
  const src = contentIds.map((id) => {
    const stream = objs.get(id)?.stream;
    contentBytes += (stream?.length ?? 0) + 1;
    limit(contentBytes <= MAX_STREAM, "page content size");
    return stream?.toString("latin1") ?? "";
  }).join("\n");

  const runs: Run[] = [];
  let ctm: Matrix = IDENTITY;
  const ctmStack: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let font: Font | undefined;
  let operands: Token[] = [];
  const num = (k: number) => {
    const t = operands[operands.length - k];
    return t && t.t === "num" ? t.v : 0;
  };
  const nextLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  let textSize = 0;
  const show = (text: string) => {
    textSize += text.length;
    limit(textSize <= MAX_TEXT && runs.length < 10_000, "page text size");
    if (!text) return;
    const m = mul(tm, ctm);
    const last = runs[runs.length - 1];
    // Consecutive shows without repositioning continue the same run.
    if (last && last.page === pageNo && Math.abs(last.y - m[5]) < 0.5 && last.x === m[4]) last.text += text;
    else runs.push({ page: pageNo, x: m[4], y: m[5], text });
  };
  for (const tok of tokenize(src)) {
    if (tok.t !== "op") {
      operands.push(tok);
      continue;
    }
    switch (tok.v) {
      case "q": limit(ctmStack.length < 64, "graphics nesting"); ctmStack.push(ctm); break;
      case "Q": ctm = ctmStack.pop() ?? IDENTITY; break;
      case "cm": ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
      case "BT": tm = tlm = IDENTITY; break;
      case "Tf": {
        const n = operands[operands.length - 2];
        font = n && n.t === "name" ? fonts.get(n.v) : undefined;
        break;
      }
      case "TL": leading = num(1); break;
      case "Tm": tm = tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; break;
      case "Td": nextLine(num(2), num(1)); break;
      case "TD": leading = -num(1); nextLine(num(2), num(1)); break;
      case "T*": nextLine(0, -leading); break;
      case "Tj":
      case "'":
      case '"': {
        if (tok.v !== "Tj") nextLine(0, -leading);
        const s = operands[operands.length - 1];
        if (s && s.t === "str") show(decodeString(s.v, font));
        break;
      }
      case "TJ": {
        const a = operands[operands.length - 1];
        if (a && a.t === "arr") {
          let text = "";
          for (const p of a.v) {
            if (p.t === "str") text += decodeString(p.v, font);
            else if (p.t === "num" && p.v < -250) text += " "; // a large kerning gap is a word space
          }
          show(text);
        }
        break;
      }
    }
    operands = [];
  }
  return runs;
}

/** All text runs of the document, in page order. */
export function extractRuns(buf: Buffer): Run[] {
  const objs = readObjects(buf);
  const pages = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Page(?!s)\b/.test(o.dict)).sort(([a], [b]) => a - b);
  if (!pages.length) throw new PdfError("no pages found");
  limit(pages.length <= 100, "page count");
  const runs: Run[] = [];
  let textSize = 0;
  for (const [i, [, page]] of pages.entries()) {
    const next = runsOfPage(objs, page, i + 1);
    textSize += next.reduce((n, r) => n + r.text.length, 0);
    limit(textSize <= MAX_TEXT && runs.length + next.length <= 10_000, "document text size");
    runs.push(...next);
  }
  return runs;
}

/** Runs grouped into visual lines (top to bottom), each a list of cells (left to right). */
export function extractCells(buf: Buffer): string[][] {
  const runs = extractRuns(buf).filter((r) => r.text.trim());
  runs.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: Run[][] = [];
  for (const r of runs) {
    const line = lines[lines.length - 1];
    if (line && line[0]!.page === r.page && Math.abs(line[0]!.y - r.y) < 3) line.push(r);
    else lines.push([r]);
  }
  return lines.map((l) => l.sort((a, b) => a.x - b.x).map((r) => r.text.replace(/\s+/g, " ").trim()));
}

/**
 * Joins a line's cells into text. Office PDFs split numbers into several runs ("23" "0" ",00"), so
 * numeric fragments are joined without a space; everything else gets one space. A wrong join can
 * only break the strict value/unit patterns of the parser (→ UNABLE TO VERIFY), never invent a value.
 */
export function joinCells(cells: readonly string[]): string {
  let out = "";
  for (const c of cells) out += out && !(/[\d,.]$/.test(out) && /^[\d,.]/.test(c)) ? ` ${c}` : c;
  return out;
}

export const extractLines = (buf: Buffer): string[] => extractCells(buf).map(joinCells);
