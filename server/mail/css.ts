// Just enough CSS to decide what a human reader can see: inline declarations, colours and contrast,
// font sizes, background images, and simple top-level <style> rules. Not a CSS engine.

// ───────────── Minimal DOM typing (linkedom; the server tsconfig has no DOM lib) ─────────────

export interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  parentNode: DomNode | null;
  remove(): void;
}

export interface DomElement extends DomNode {
  tagName: string;
  innerHTML: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(sel: string): DomElement | null;
  querySelectorAll(sel: string): ArrayLike<DomElement>;
  replaceWith(...nodes: (DomNode | string)[]): void;
  append(...nodes: (DomNode | string)[]): void;
}

export interface DomDocument {
  body: DomElement | null;
  documentElement: DomElement;
  createElement(tag: string): DomElement;
}

export type Style = Map<string, string>;

/** Parses declarations ("a: b; c: d") into lower-cased property → value. `!important` is dropped. */
export function parseStyle(style: string | null | undefined): Style {
  const out: Style = new Map();
  if (!style) return out;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .replace(/!\s*important/i, "")
      .trim()
      .toLowerCase();
    if (prop && value) out.set(prop, value);
  }
  return out;
}

export const isZeroLength = (v: string | undefined) => v !== undefined && /^[-+]?0*\.?0+(?:[a-z%]+)?$/.test(v.trim());

// ───────────── Colours ─────────────

// CSS named colours (CSS Color Module Level 4).
const NAMED_COLORS: Record<string, string> = Object.fromEntries(
  `aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000
  blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00
  chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b
  darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b
  darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f
  darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493
  deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22
  fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f
  grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa
  lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff
  lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a
  lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0
  lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd
  mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a
  mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5
  navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6
  palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9
  peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f
  royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d
  silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f
  steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3
  white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32`
    .trim()
    .split(/\s+/)
    .reduce<[string, string][]>((acc, tok, i, all) => (i % 2 ? acc : [...acc, [tok, `#${all[i + 1]}`]]), []),
);

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** Alpha component: "0.5", "50%". */
const alpha = (s: string | undefined) => (s === undefined ? 1 : s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s));

function hue(s: string): number {
  const n = parseFloat(s);
  if (s.endsWith("turn")) return n * 360;
  if (s.endsWith("grad")) return n * 0.9;
  if (s.endsWith("rad")) return (n * 180) / Math.PI;
  return n;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Normalizes a CSS colour to "#rrggbb", "transparent" (alpha ≈ 0), or null when unknown. */
export function normalizeColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return "transparent";
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const [r, g, b, a] = m[1]!.split("");
    if (a === "0") return "transparent";
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[2] !== undefined && parseInt(m[2], 16) < 13 ? "transparent" : `#${m[1]}`;
  const fn = /^(rgba?|hsla?|hwb)\(\s*([^)]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  if (alpha(parts[3]) < 0.05) return "transparent";
  const pct = (s: string, scale: number) => (s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s));
  if (fn[1]!.startsWith("rgb")) return rgbHex(pct(parts[0]!, 255), pct(parts[1]!, 255), pct(parts[2]!, 255));
  const h = hue(parts[0]!);
  const x = parseFloat(parts[1]!) / 100;
  const y = parseFloat(parts[2]!) / 100;
  if ([h, x, y].some(Number.isNaN)) return null;
  if (fn[1]!.startsWith("hsl")) return rgbHex(...hslToRgb(h, x, y));
  // hwb: whiteness x, blackness y.
  if (x + y >= 1) return rgbHex(...([1, 1, 1].map(() => (x / (x + y)) * 255) as [number, number, number]));
  const [r, g, b] = hslToRgb(h, 1, 0.5).map((c) => (c / 255) * (1 - x - y) + x);
  return rgbHex(r! * 255, g! * 255, b! * 255);
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** WCAG contrast ratio between two "#rrggbb" colours (1 = identical, 21 = black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Images and gradients in a `background` shorthand (they paint over the colour). */
const BG_IMAGE = /url\([^)]*\)|[a-z-]*gradient\((?:[^()]|\([^()]*\))*\)|image-set\([^)]*\)/g;

/** The background colour an element sets, from `background-color`, the `background` shorthand or `bgcolor`. */
export function backgroundColor(style: Style, el: DomElement): string | null {
  const direct = normalizeColor(style.get("background-color"));
  if (direct) return direct;
  const shorthand = style.get("background")?.replace(BG_IMAGE, " ");
  if (shorthand) {
    for (const token of shorthand.match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?|hwb)\([^)]*\)|[a-z]+/g) ?? []) {
      const c = normalizeColor(token);
      if (c) return c;
    }
  }
  return normalizeColor(el.getAttribute("bgcolor"));
}

/** A background image or gradient, so the background colour may not be what's behind the text. */
export function hasBackgroundImage(style: Style, el: DomElement): boolean {
  const image = style.get("background-image");
  BG_IMAGE.lastIndex = 0;
  return (!!image && image !== "none") || BG_IMAGE.test(style.get("background") ?? "") || el.hasAttribute("background");
}

// ───────────── Sizes ─────────────

const ROOT_FONT_PX = 16;
const ABSOLUTE_PX: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

/** A font-size value in px given the parent's size; null when it isn't a size. */
function sizePx(raw: string, parent: number): number | null {
  const v = raw.trim();
  if (SIZE_KEYWORDS[v] !== undefined) return SIZE_KEYWORDS[v];
  if (v === "smaller") return parent / 1.2;
  if (v === "larger") return parent * 1.2;
  if (v === "inherit" || v === "unset") return parent;
  if (v === "initial") return ROOT_FONT_PX;
  const m = /^([+-]?\d*\.?\d+)([a-z%]*)$/.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = m[2]!;
  if (!unit) return n === 0 ? 0 : null;
  if (ABSOLUTE_PX[unit] !== undefined) return n * ABSOLUTE_PX[unit];
  if (unit === "em") return n * parent;
  if (unit === "%") return (n / 100) * parent;
  if (unit === "rem") return n * ROOT_FONT_PX;
  if (unit === "ex" || unit === "ch") return (n * parent) / 2;
  // Viewport and container units: only zero is certain.
  return n === 0 ? 0 : parent;
}

/** Effective font size in px from `font-size` or the `font` shorthand ("bold 0/0 a", "12px/1.4 Arial"). */
export function fontSizePx(style: Style, parent: number): number {
  const explicit = style.get("font-size");
  if (explicit !== undefined) return sizePx(explicit, parent) ?? parent;
  const shorthand = style.get("font");
  if (shorthand) {
    for (const token of shorthand.split(/\s+/)) {
      const size = sizePx(token.split("/")[0]!, parent);
      if (size !== null) return size;
    }
  }
  return parent;
}

export const DEFAULT_FONT_PX = ROOT_FONT_PX;

// ───────────── Stylesheets ─────────────

/** Properties taken from <style> rules: only the ones that can hide content. */
const SHEET_PROPS = new Set(["display", "visibility", "opacity", "font-size", "font", "overflow", "height", "max-height", "width", "max-width"]);

interface Rule {
  selectors: string[];
  decls: Style;
}

/** Splits CSS into top-level rules and the rules nested in conditional groups (@media, @supports). */
function parseRules(css: string): { top: Rule[]; conditional: Rule[] } {
  const top: Rule[] = [];
  const conditional: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/<!--|-->/g, " ");
  const block = (from: number): number => {
    // Index just past the "}" matching the "{" at `from`.
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i + 1;
    }
    return text.length;
  };
  const walk = (start: number, end: number, into: Rule[], nested: boolean) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) break;
      const prelude = text.slice(i, open).trim();
      const close = block(open);
      if (prelude.startsWith("@")) {
        if (/^@(media|supports|document|container)\b/i.test(prelude) && !nested) walk(open + 1, close - 1, conditional, true);
      } else {
        into.push({ selectors: prelude.split(",").map((s) => s.trim()).filter(Boolean), decls: parseStyle(text.slice(open + 1, close - 1)) });
      }
      i = close;
    }
  };
  walk(0, text.length, top, false);
  return { top, conditional };
}

function select(root: DomElement, selector: string): DomElement[] {
  // Pseudo-classes/elements (:hover, ::before) describe other states; never apply them.
  if (selector.includes(":")) return [];
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/**
 * Hiding-related declarations that top-level <style> rules apply to each element (later rules win).
 * Elements also matched by a rule inside @media/@supports are skipped: a conditional rule may reveal
 * them on some device, so they count as visible.
 */
export function stylesheetHiding(doc: DomDocument): Map<DomElement, Style> {
  const out = new Map<DomElement, Style>();
  const root = doc.documentElement;
  const css = Array.from(root.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  if (!css.trim()) return out;
  const { top, conditional } = parseRules(css);
  const revealable = new Set<DomElement>();
  for (const rule of conditional) for (const sel of rule.selectors) for (const el of select(root, sel)) revealable.add(el);
  for (const rule of top) {
    const decls = [...rule.decls].filter(([p]) => SHEET_PROPS.has(p));
    if (!decls.length) continue;
    for (const sel of rule.selectors) {
      for (const el of select(root, sel)) {
        if (revealable.has(el)) continue;
        const style = out.get(el) ?? new Map<string, string>();
        for (const [p, v] of decls) style.set(p, v);
        out.set(el, style);
      }
    }
  }
  return out;
}
