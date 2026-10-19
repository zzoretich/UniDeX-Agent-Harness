const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sparkline(values: number[], width = 16): string {
  if (values.length === 0) return "";
  const slice = values.length > width ? values.slice(-width) : values;
  let min = Infinity, max = -Infinity;
  for (const v of slice) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max === min) return BLOCKS[3].repeat(slice.length);
  const span = max - min;
  return slice
    .map((v) => BLOCKS[Math.min(7, Math.floor(((v - min) / span) * 7.999))])
    .join("");
}

export function deltaArrow(values: number[]): string {
  if (values.length < 2) return "";
  const a = values[values.length - 1];
  const b = values[values.length - 2];
  if (a > b) return `↑${a - b}`;
  if (a < b) return `↓${b - a}`;
  return "·";
}

// ── SVG sparkline ────────────────────────────────────────────────────────
// sparklineGeometry() is pure (testable); sparklineElement() builds the SVG with
// createElementNS — no markup strings are ever assigned to the DOM.

const SVG_NS = "http://www.w3.org/2000/svg";

interface SparkOpts { width?: number; height?: number; color?: string; }
export interface SparkGeometry { w: number; h: number; line: string; area: string; tail: { x: number; y: number }; }

export function sparklineGeometry(values: number[], opts: SparkOpts = {}): SparkGeometry | null {
  const w = opts.width ?? 160;
  const h = opts.height ?? 24;
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = values.length > 1 ? i * step : w;
    const y = h - ((v - min) / range) * h;
    return { x, y };
  });
  const line = "M " + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" L ");
  const area = line + ` L ${pts[pts.length - 1].x.toFixed(1)},${h} L ${pts[0].x.toFixed(1)},${h} Z`;
  return { w, h, line, area, tail: pts[pts.length - 1] };
}

export function sparklineElement(values: number[], opts: SparkOpts = {}): SVGSVGElement {
  const color = opts.color ?? "var(--aos-cyan)";
  const g = sparklineGeometry(values, opts);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${g?.w ?? opts.width ?? 160} ${g?.h ?? opts.height ?? 24}`);
  svg.setAttribute("preserveAspectRatio", "none");
  if (!g) return svg;
  if (values.length > 1) {
    const area = document.createElementNS(SVG_NS, "path");
    area.setAttribute("d", g.area); area.setAttribute("fill", color); area.setAttribute("opacity", "0.18");
    svg.appendChild(area);
  }
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", g.line); line.setAttribute("fill", "none"); line.setAttribute("stroke", color); line.setAttribute("stroke-width", "1.2");
  svg.appendChild(line);
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", g.tail.x.toFixed(1)); dot.setAttribute("cy", g.tail.y.toFixed(1)); dot.setAttribute("r", "2.2"); dot.setAttribute("fill", color);
  svg.appendChild(dot);
  return svg;
}
