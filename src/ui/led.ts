/**
 * SVG seven-segment display. Each digit has all 7 segments plus a decimal point drawn
 * once; updates only toggle the "on" class, so unlit segments remain as faint ghosts.
 */
const NS = "http://www.w3.org/2000/svg";

// Digit geometry in viewBox units (unskewed). W×H digit box, T segment thickness.
const W = 48;
const H = 88;
const T = 9;
const HALF = T / 2;
const GAP = 1.6;
const PITCH = 64; // digit advance, leaves room for the decimal point
const COLON_PITCH = 22;
const SKEW = -6; // degrees; real meters use slightly slanted digits

function hSeg(x1: number, x2: number, y: number): string {
  return `${x1},${y} ${x1 + HALF},${y - HALF} ${x2 - HALF},${y - HALF} ${x2},${y} ${x2 - HALF},${y + HALF} ${x1 + HALF},${y + HALF}`;
}
function vSeg(x: number, y1: number, y2: number): string {
  return `${x},${y1} ${x + HALF},${y1 + HALF} ${x + HALF},${y2 - HALF} ${x},${y2} ${x - HALF},${y2 - HALF} ${x - HALF},${y1 + HALF}`;
}

const SEGMENTS: Record<string, string> = {
  a: hSeg(HALF + GAP, W - HALF - GAP, HALF),
  b: vSeg(W - HALF, HALF + GAP, H / 2 - GAP),
  c: vSeg(W - HALF, H / 2 + GAP, H - HALF - GAP),
  d: hSeg(HALF + GAP, W - HALF - GAP, H - HALF),
  e: vSeg(HALF, H / 2 + GAP, H - HALF - GAP),
  f: vSeg(HALF, HALF + GAP, H / 2 - GAP),
  g: hSeg(HALF + GAP, W - HALF - GAP, H / 2),
};

/** Shared with the icon generator (scripts/icons.ts) so the app icon uses the meter's own digits. */
export const LED_GEOMETRY = { W, H, T, SKEW, SEGMENTS } as const;

const GLYPHS: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
  "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
  "-": "g", " ": "",
};

interface Cell {
  kind: "digit" | "colon";
  char: string;
  dot: boolean;
}

/** "551.94" -> cells; a "." lights the previous digit's decimal point. Left-padded to `minDigits`. */
export function parseLed(text: string, minDigits: number): Cell[] {
  const cells: Cell[] = [];
  for (const ch of text) {
    if (ch === ".") {
      const prev = cells[cells.length - 1];
      if (prev && prev.kind === "digit") prev.dot = true;
      else cells.push({ kind: "digit", char: " ", dot: true });
    } else if (ch === ":") cells.push({ kind: "colon", char: ":", dot: false });
    else {
      if (!(ch in GLYPHS)) throw new Error(`LED cannot show "${ch}"`);
      cells.push({ kind: "digit", char: ch, dot: false });
    }
  }
  const digits = cells.filter((c) => c.kind === "digit").length;
  for (let i = digits; i < minDigits; i++) cells.unshift({ kind: "digit", char: " ", dot: false });
  return cells;
}

export interface Led {
  readonly el: SVGSVGElement;
  set(text: string): void;
}

/** Creates an LED with at least `minDigits` digit cells. The SVG scales to its container. */
export function createLed(minDigits: number, className = ""): Led {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", `led ${className}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  let layout = "";
  let last: string | null = null;
  let parts: { segs: Record<string, SVGElement>; dot: SVGElement | null }[] = [];

  function build(cells: Cell[]): void {
    svg.replaceChildren();
    parts = [];
    let x = 0;
    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${H * Math.tan((-SKEW * Math.PI) / 180)} 0) skewX(${SKEW})`);
    for (const cell of cells) {
      if (cell.kind === "colon") {
        for (const cy of [H * 0.32, H * 0.68]) {
          const c = document.createElementNS(NS, "circle");
          c.setAttribute("cx", String(x + COLON_PITCH / 2 - 4));
          c.setAttribute("cy", String(cy));
          c.setAttribute("r", String(HALF));
          c.setAttribute("class", "seg on");
          g.append(c);
        }
        parts.push({ segs: {}, dot: null });
        x += COLON_PITCH;
        continue;
      }
      const segs: Record<string, SVGElement> = {};
      for (const [name, pts] of Object.entries(SEGMENTS)) {
        const p = document.createElementNS(NS, "polygon");
        p.setAttribute("points", pts);
        p.setAttribute("transform", `translate(${x} 0)`);
        p.setAttribute("class", "seg");
        g.append(p);
        segs[name] = p;
      }
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", String(x + W + 8));
      dot.setAttribute("cy", String(H - HALF));
      dot.setAttribute("r", String(HALF + 0.5));
      dot.setAttribute("class", "seg");
      g.append(dot);
      parts.push({ segs, dot });
      x += PITCH;
    }
    const width = x - (PITCH - W - 14) + 6;
    svg.setAttribute("viewBox", `0 0 ${width} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMaxYMid meet");
    svg.style.setProperty("--ar", String(width / H)); // lets CSS shrink height with width, no letterboxing
    svg.append(g);
  }

  return {
    el: svg,
    set(text: string) {
      if (text === last) return;
      last = text;
      const cells = parseLed(text, minDigits);
      const key = cells.map((c) => c.kind[0]).join("");
      if (key !== layout) {
        build(cells);
        layout = key;
      }
      cells.forEach((cell, i) => {
        const part = parts[i]!;
        if (cell.kind === "colon") return;
        const lit = GLYPHS[cell.char]!;
        for (const [name, el] of Object.entries(part.segs)) el.classList.toggle("on", lit.includes(name));
        part.dot?.classList.toggle("on", cell.dot);
      });
    },
  };
}
