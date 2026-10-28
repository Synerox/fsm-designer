// The drawing surface. Geometry comes from @fsm/core's planDiagram(), the same
// routing the SVG/PNG/LaTeX exporters use, so the canvas matches the exports.
//
// Gestures follow Evan Wallace's FSM designer:
//   double-click empty space   new state
//   double-click a state       toggle accepting (double circle)
//   drag a state               move (snaps into line with other states)
//   shift-drag state -> state  new transition (back onto itself: self loop)
//   shift-drag empty -> state  start arrow (initial state)
//   drag a transition          bend it / turn a self loop / turn the start arrow
//   ctrl/cmd-drag              box select (states and transitions); ctrl/cmd-click toggles one
//   drag the square handle     resize the selected state
// Plus: drag empty space to pan, wheel to scroll, ctrl/cmd+wheel to zoom.
// Dragging any selected state moves the whole selection. Dragged states line
// up with other states' centres (dashed guides), else snap to the grid when
// snapping is on; hold Alt to place freely.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactElement, SVGProps, SetStateAction } from "react";
import type { PointerEvent as RPointerEvent } from "react";
import { SMALL_SIZE, SUB_LINE_H, drawnSubLines, planDiagram, stateDisplay, stateFontSize, unreachableStates } from "@fsm/core";
import type { DiagramPlan, EdgePlan } from "@fsm/core";
import { drawOptions, mergeSelections, createState, createTransition, edgeTransitions, isEdgeSelected, isStateSelected, multiSelection, selectionParts, setInitial, toggleInSelection, useEditor } from "./store.ts";
import type { Selection } from "./store.ts";
import { GRID, SNAP_PX, angleOf, boxOf, circleHitsBox, edgePoints, inBox, segmentHitsBox, borderPoint, curveThrough, edgeMidpoint, loopPath, snapAngle, snapPoint, snapToGrid, stateAt } from "./geometry.ts";
import type { Guide, Pt } from "./geometry.ts";
import { tr } from "./i18n.ts";

const STROKE = "#1f2937";
const ACCENT = "#2563eb";
const SELECT = "#2383e2";
const CROSSING = "#3fa34d"; // right-to-left box: selects whatever it touches
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface View {
  x: number;
  y: number;
  k: number;
}

export type GridStyle = "line" | "dot" | "none";

export interface GridOptions {
  style: GridStyle;
  snap: boolean;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** Zoom by `factor` keeping screen point (mx, my) still. */
export function zoomAround(v: View, factor: number, mx: number, my: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
  return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
}

type Gesture =
  | { kind: "move"; id: string; dx: number; dy: number; key: string }
  | { kind: "curve"; from: string; to: string; key: string }
  | { kind: "loop"; id: string; key: string }
  | { kind: "initial"; id: string; key: string }
  | { kind: "resize"; id: string; key: string }
  | { kind: "link"; from: string | null; start: Pt }
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "moveMany"; start: Pt; anchor: Pt; orig: Array<{ id: string; x: number; y: number }>; key: string }
  | { kind: "box"; start: Pt; item: SingleItem | null; moved: boolean };

type SingleItem = Exclude<Selection, null | { kind: "multi" }>;

let gestureSeq = 0;

export function Canvas({ view, setView, grid }: { view: View; setView: Dispatch<SetStateAction<View>>; grid: GridOptions }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const caret = useEditor((s) => s.caret);
  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [link, setLink] = useState<{ from: string | null; start: Pt; at: Pt } | null>(null);
  const [box, setBox] = useState<{ a: Pt; b: Pt } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A selected line keeps its own hidden text, so it can be edited; the rest stay hidden.
  const labels = useEditor((s) => s.labels);
  const shownFrom = selection?.kind === "edge" ? selection.from : undefined;
  const shownTo = selection?.kind === "edge" ? selection.to : undefined;
  const plan = useMemo<DiagramPlan>(
    () => planDiagram(doc, { ...drawOptions(labels), shownEdge: shownFrom && shownTo ? { from: shownFrom, to: shownTo } : undefined }),
    [doc, labels, shownFrom, shownTo],
  );
  // States the initial state never leads to are drawn dashed.
  const lost = useMemo(() => unreachableStates(doc), [doc]);
  // While box selecting, highlight what the box would add to the selection.
  const shown = box ? mergeSelections(selection, boxSelection(plan, box.a, box.b)) : selection;
  const byId = useMemo(() => new Map(plan.states.map((p) => [p.state.id, p])), [plan]);

  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  // Wheel: scroll, or zoom around the cursor with ctrl/cmd (also trackpad pinch).
  // Updates build on the latest view: several wheel events can arrive before
  // React re-renders, and each must add to the one before.
  useEffect(() => {
    const el = svgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
        // A mouse wheel notch (deltaY around 100) zooms 10%; small trackpad
        // pinch deltas zoom smoothly in proportion.
        const factor = Math.abs(dy) >= 50 ? (dy > 0 ? 1 / 1.1 : 1.1) : Math.exp(-dy * 0.01);
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        setView((v) => zoomAround(v, factor, mx, my));
      } else {
        const { deltaX, deltaY } = e;
        setView((v) => ({ ...v, x: v.x - deltaX, y: v.y - deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setView]);

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    svgRef.current!.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    const target = e.target as Element;
    const stateId = target.closest("[data-state]")?.getAttribute("data-state") ?? null;
    const edgeEl = target.closest("[data-edge]");
    const onInitial = !!target.closest("[data-initial]");
    const key = `g${++gestureSeq}`;
    const resizeId = target.closest("[data-resize]")?.getAttribute("data-resize");
    if (resizeId && e.button === 0) {
      gesture.current = { kind: "resize", id: resizeId, key };
      return;
    }

    if (e.button === 1) {
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    const item: SingleItem | null = stateId
      ? { kind: "state", id: stateId }
      : edgeEl
        ? (([from, to]) => ({ kind: "edge" as const, from, to }))(edgeEl.getAttribute("data-edge")!.split(" "))
        : onInitial
          ? { kind: "initial" }
          : null;
    if (e.ctrlKey || e.metaKey) {
      gesture.current = { kind: "box", start: p, item, moved: false };
      return;
    }
    if (e.shiftKey && !edgeEl && !onInitial) {
      gesture.current = { kind: "link", from: stateId, start: p };
      setLink({ from: stateId, start: p, at: p });
      select(null);
      return;
    }
    if (stateId && selection?.kind === "multi" && isStateSelected(selection, stateId)) {
      const orig = selection.states.map((id) => byId.get(id)!.state).map((v) => ({ id: v.id, x: v.x!, y: v.y! }));
      const a = byId.get(stateId)!.state;
      gesture.current = { kind: "moveMany", start: p, anchor: { x: a.x!, y: a.y! }, orig, key };
    } else if (stateId) {
      const s = byId.get(stateId)!.state;
      select({ kind: "state", id: stateId });
      gesture.current = { kind: "move", id: stateId, dx: s.x! - p.x, dy: s.y! - p.y, key };
    } else if (edgeEl) {
      const [from, to] = edgeEl.getAttribute("data-edge")!.split(" ");
      select({ kind: "edge", from, to });
      gesture.current = from === to ? { kind: "loop", id: from, key } : { kind: "curve", from, to, key };
    } else if (onInitial) {
      const init = doc.states.find((s) => s.isInitial)!;
      select({ kind: "initial" });
      gesture.current = { kind: "initial", id: init.id, key };
    } else {
      select(null);
      gesture.current = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    }
  };

  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g) return;
    const p = toWorld(e);
    switch (g.kind) {
      case "pan":
        setView((v) => ({ ...v, x: g.vx + e.clientX - g.sx, y: g.vy + e.clientY - g.sy }));
        break;
      case "link":
        setLink({ from: g.from, start: g.start, at: p });
        break;
      case "box":
        if (!g.moved && Math.hypot(p.x - g.start.x, p.y - g.start.y) * view.k < 4) break;
        g.moved = true;
        setBox({ a: g.start, b: p });
        break;
      case "moveMany": {
        // The grabbed state lines up / snaps; the rest keep their offsets.
        const moving = new Set(g.orig.map((o) => o.id));
        const others = doc.states.filter((s) => !moving.has(s.id)).map((s) => ({ x: s.x!, y: s.y! }));
        const at = { x: g.anchor.x + p.x - g.start.x, y: g.anchor.y + p.y - g.start.y };
        const snapped = snapPoint(at, others, e.altKey ? 0 : SNAP_PX / view.k, grid.snap && !e.altKey);
        setGuides(snapped.guides);
        const dx = snapped.p.x - g.anchor.x, dy = snapped.p.y - g.anchor.y;
        edit((d) => {
          for (const o of g.orig) {
            const s = d.states.find((v) => v.id === o.id);
            if (s) { s.x = o.x + dx; s.y = o.y + dy; }
          }
        }, g.key);
        break;
      }
      case "move": {
        const others = doc.states.filter((s) => s.id !== g.id).map((s) => ({ x: s.x!, y: s.y! }));
        const snapped = snapPoint({ x: p.x + g.dx, y: p.y + g.dy }, others, e.altKey ? 0 : SNAP_PX / view.k, grid.snap && !e.altKey);
        setGuides(snapped.guides);
        edit((d) => {
          const s = d.states.find((v) => v.id === g.id)!;
          s.x = snapped.p.x;
          s.y = snapped.p.y;
        }, g.key);
        break;
      }
      case "curve": {
        const a = byId.get(g.from)!.state, b = byId.get(g.to)!.state;
        const curve = curveThrough({ x: a.x!, y: a.y! }, { x: b.x!, y: b.y! }, p);
        edit((d) => { for (const t of edgeTransitions(d, g.from, g.to)) t.curve = curve; }, g.key);
        break;
      }
      case "loop": {
        const s = byId.get(g.id)!.state;
        const angle = snapAngle(angleOf({ x: s.x!, y: s.y! }, p));
        edit((d) => { for (const t of edgeTransitions(d, g.id, g.id)) t.loopAngle = angle; }, g.key);
        break;
      }
      case "resize": {
        const s = byId.get(g.id)!.state;
        const radius = Math.min(200, Math.max(10, Math.round(Math.hypot(p.x - s.x!, p.y - s.y!))));
        edit((d) => { d.states.find((v) => v.id === g.id)!.radius = radius; }, g.key);
        break;
      }
      case "initial": {
        const s = byId.get(g.id)!.state;
        const angle = snapAngle(angleOf({ x: s.x!, y: s.y! }, p));
        edit((d) => { d.states.find((v) => v.id === g.id)!.initialAngle = angle; }, g.key);
        break;
      }
    }
  };

  const onPointerUp = (e: RPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    gesture.current = null;
    setGuides([]);
    if (g?.kind === "box") {
      setBox(null);
      if (!g.moved) {
        if (g.item) select(toggleInSelection(selection, g.item));
        return;
      }
      select(mergeSelections(selection, boxSelection(plan, g.start, toWorld(e))));
      return;
    }
    if (!g || g.kind !== "link") return;
    setLink(null);
    const p = toWorld(e);
    const target = linkTarget(plan, g.from, p);
    if (!target) return;
    if (g.from) {
      const s = byId.get(g.from)!.state;
      const loopAngle = g.from === target ? (Math.hypot(p.x - s.x!, p.y - s.y!) > 2 ? snapAngle(angleOf({ x: s.x!, y: s.y! }, p)) : -Math.PI / 2) : undefined;
      edit((d) => createTransition(d, g.from!, target, loopAngle));
      select({ kind: "edge", from: g.from, to: target });
    } else {
      const s = byId.get(target)!.state;
      const angle = snapAngle(angleOf({ x: s.x!, y: s.y! }, g.start));
      edit((d) => setInitial(d, target, angle));
      select({ kind: "initial" });
    }
  };

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // Pointer capture retargets click events to the <svg>, so hit-test by position.
    const p = toWorld(e);
    const stateId = stateAt(plan, p);
    if (stateId) {
      edit((d) => {
        const s = d.states.find((v) => v.id === stateId)!;
        s.isAccepting = !s.isAccepting;
      });
      select({ kind: "state", id: stateId });
      return;
    }
    if (document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-edge],[data-initial]")) return;
    let id = "";
    const at = grid.snap && !e.altKey ? { x: snapToGrid(p.x), y: snapToGrid(p.y) } : p;
    edit((d) => { id = createState(d, at.x, at.y).id; });
    select({ kind: "state", id });
  };

  return (
    <svg
      ref={svgRef}
      className="canvas"
      data-testid="canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { gesture.current = null; setLink(null); setGuides([]); }}
      onDoubleClick={onDoubleClick}
      fontFamily={FONT}
    >
      <defs>
        <marker id="c-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={STROKE} />
        </marker>
        <marker id="c-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={SELECT} />
        </marker>
        <marker id="c-arrow-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={ACCENT} />
        </marker>
      </defs>
      {grid.style === "line" && <GridLines view={view} w={size.w} h={size.h} />}
      {grid.style === "dot" && <GridDots view={view} />}
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {plan.edges.map((e) => (
          <Edge key={edgeKey(e)} e={e} selected={isEdgeSelected(shown, e.transitions[0].from, e.transitions[0].to)} caret={shown?.kind === "edge" ? caret : undefined} mid={edgeMidpoint(plan, e)} />
        ))}
        {plan.initialArrow && <InitialArrow a={plan.initialArrow} selected={selectionParts(shown).initial} />}
        {plan.states.map(({ state: s, r }) => {
          const selected = isStateSelected(shown, s.id);
          // Hidden outputs come back while the state is selected, like a line's text.
          const sub = drawnSubLines(doc, s, { labels: selected ? "all" : labels });
          const name = stateDisplay(s);
          const color = selected ? SELECT : STROKE;
          const fs = stateFontSize(s);
          let nameY = s.y!, rule = 0;
          if (sub.length) {
            const total = fs + 6 + sub.length * SUB_LINE_H;
            nameY = s.y! - total / 2 + fs / 2;
            rule = s.y! - total / 2 + fs + 3;
          }
          return (
            <g key={s.id} data-state={s.id} className="state">
              {selected && <circle cx={s.x} cy={s.y} r={r + 4} fill="none" stroke={SELECT} strokeOpacity={0.18} strokeWidth={6} />}
              <circle cx={s.x} cy={s.y} r={r} fill={s.color ?? "#ffffff"} stroke={color} strokeWidth={2} strokeDasharray={lost.has(s.id) ? "6 4" : undefined} />
              {s.isAccepting && <circle cx={s.x} cy={s.y} r={r - 5} fill="none" stroke={color} strokeWidth={1.5} />}
              <CaretText
                x={s.x!}
                y={nameY}
                text={name}
                caret={selected && shown?.kind === "state" ? Math.min(caret ?? name.length, name.length) : null}
                fontSize={fs}
                fontWeight={600}
                fill={color}
              />
              {sub.length > 0 && <line x1={s.x! - r * 0.7} x2={s.x! + r * 0.7} y1={rule} y2={rule} stroke={STROKE} strokeWidth={0.8} opacity={0.45} />}
              {sub.map((l, i) => (
                <text key={i} x={s.x} y={rule + 3 + SUB_LINE_H * (i + 0.5)} fontSize={SMALL_SIZE} textAnchor="middle" dominantBaseline="central" fill={STROKE}>{l}</text>
              ))}
            </g>
          );
        })}
        {shown?.kind === "state" && byId.has(shown.id) && (() => {
          const { state: s, r } = byId.get(shown.id)!;
          const h = 8 / view.k, at = r * Math.SQRT1_2;
          return (
            <rect
              data-resize={s.id}
              className="resize-handle"
              x={s.x! + at - h / 2}
              y={s.y! + at - h / 2}
              width={h}
              height={h}
              fill="#ffffff"
              stroke={SELECT}
              strokeWidth={1.5 / view.k}
            >
              <title>{tr("Drag to resize", "拖曳調整大小")}</title>
            </rect>
          );
        })()}
        {guides.map((gd, i) => {
          const pad = 40;
          return gd.axis === "x"
            ? <line key={i} className="guide" x1={gd.at} x2={gd.at} y1={gd.from - pad} y2={gd.to + pad} stroke="#ec4899" strokeWidth={1 / view.k} strokeDasharray={`${5 / view.k} ${4 / view.k}`} pointerEvents="none" />
            : <line key={i} className="guide" y1={gd.at} y2={gd.at} x1={gd.from - pad} x2={gd.to + pad} stroke="#ec4899" strokeWidth={1 / view.k} strokeDasharray={`${5 / view.k} ${4 / view.k}`} pointerEvents="none" />;
        })}
        {link && <LinkPreview link={link} plan={plan} />}
        {box && (
          <rect
            className="marquee"
            x={Math.min(box.a.x, box.b.x)}
            y={Math.min(box.a.y, box.b.y)}
            width={Math.abs(box.b.x - box.a.x)}
            height={Math.abs(box.b.y - box.a.y)}
            fill={box.b.x < box.a.x ? CROSSING : SELECT}
            fillOpacity={0.08}
            stroke={box.b.x < box.a.x ? CROSSING : SELECT}
            strokeWidth={1 / view.k}
            strokeDasharray={box.b.x < box.a.x ? `${4 / view.k} ${3 / view.k}` : undefined}
            pointerEvents="none"
          />
        )}
      </g>
    </svg>
  );
}

/**
 * Background grid in screen space: minor lines every GRID units (hidden when
 * zoomed out so far they would crowd), major lines every 5 cells.
 */
function GridLines({ view, w, h }: { view: View; w: number; h: number }) {
  const lines = (step: number, color: string, width: number) => {
    const s = step * view.k;
    if (s < 6) return null;
    const out: ReactElement[] = [];
    const x0 = ((view.x % s) + s) % s, y0 = ((view.y % s) + s) % s;
    for (let x = x0; x <= w; x += s) out.push(<line key={`x${x}`} x1={x} x2={x} y1={0} y2={h} />);
    for (let y = y0; y <= h; y += s) out.push(<line key={`y${y}`} y1={y} y2={y} x1={0} x2={w} />);
    return <g stroke={color} strokeWidth={width} shapeRendering="crispEdges">{out}</g>;
  };
  return (
    <g className="grid" pointerEvents="none" data-testid="grid">
      {lines(GRID, "#f0f0ee", 1)}
      {lines(GRID * 5, "#e2e2df", 1)}
    </g>
  );
}

/** Dot grid: a dot at every grid point, a larger one every 5 cells. */
function GridDots({ view }: { view: View }) {
  const minor = GRID * view.k, major = minor * 5;
  const dots = (id: string, s: number, r: number, color: string) => (
    <pattern id={id} patternUnits="userSpaceOnUse" x={view.x} y={view.y} width={s} height={s}>
      <circle cx={0} cy={0} r={r} fill={color} />
      <circle cx={s} cy={0} r={r} fill={color} />
      <circle cx={0} cy={s} r={r} fill={color} />
      <circle cx={s} cy={s} r={r} fill={color} />
    </pattern>
  );
  return (
    <g className="grid" pointerEvents="none" data-testid="grid">
      <defs>
        {dots("grid-dot-minor", minor, 1.3, "#c4c7c9")}
        {dots("grid-dot-major", major, 1.8, "#9b9ea1")}
      </defs>
      {minor >= 6 && <rect width="100%" height="100%" fill="url(#grid-dot-minor)" />}
      <rect width="100%" height="100%" fill="url(#grid-dot-major)" />
    </g>
  );
}

/**
 * Where a shift-drag ends: the state under the pointer, or, for a drag that
 * starts on a state and ends in empty space close to it, that same state
 * (a self loop pointing toward the pointer, which is easier to aim than
 * Evan's "release inside the circle").
 */
function linkTarget(plan: DiagramPlan, from: string | null, p: Pt): string | null {
  const hit = stateAt(plan, p);
  if (hit || !from) return hit;
  const { state: s, r } = plan.states.find((v) => v.state.id === from)!;
  return Math.hypot(p.x - s.x!, p.y - s.y!) < r * 3.5 ? from : null;
}

const edgeKey = (e: EdgePlan) => `${e.transitions[0].from} ${e.transitions[0].to}`;
/**
 * Box select, as in Analog Canvas (and CAD tools): dragging left to right is a
 * window (only what lies wholly inside), right to left is a crossing (anything
 * the box touches).
 */
function boxSelection(plan: DiagramPlan, a: Pt, b: Pt): Selection {
  const box = boxOf(a, b);
  const crossing = b.x < a.x;
  const states = plan.states
    .filter(({ state: s, r }) => {
      const c = { x: s.x!, y: s.y! };
      return crossing ? circleHitsBox(box, c, r) : inBox(box, { x: c.x - r, y: c.y - r }) && inBox(box, { x: c.x + r, y: c.y + r });
    })
    .map(({ state: s }) => s.id);
  const edges = plan.edges
    .filter((e) => {
      const pts = edgePoints(plan, e);
      return crossing ? pts.some((p, i) => i > 0 && segmentHitsBox(box, pts[i - 1], p)) : pts.every((p) => inBox(box, p));
    })
    .map((e) => ({ from: e.transitions[0].from, to: e.transitions[0].to }));
  const arrow = plan.initialArrow;
  const initial = !!arrow && (crossing ? segmentHitsBox(box, arrow.from, arrow.to) : inBox(box, arrow.from) && inBox(box, arrow.to));
  return multiSelection(states, edges, initial);
}

/**
 * Centred SVG text with an optional text cursor before character `caret`,
 * placed by measuring the rendered glyphs so the text itself never shifts.
 */
function CaretText({ x, y, text, caret, fontSize, ...rest }: { x: number; y: number; text: string; caret: number | null; fontSize: number } & SVGProps<SVGTextElement>) {
  const ref = useRef<SVGTextElement>(null);
  const [cx, setCx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    let next: number | null = null;
    if (el && caret !== null) {
      const n = el.getNumberOfChars();
      if (n === 0) next = x;
      else {
        const left = el.getStartPositionOfChar(0).x;
        next = left + (caret <= 0 ? 0 : el.getSubStringLength(0, Math.min(caret, n)));
      }
    }
    if (next !== cx) setCx(next);
  });
  return (
    <>
      <text ref={ref} x={x} y={y} fontSize={fontSize} textAnchor="middle" dominantBaseline="central" {...rest}>{text}</text>
      {caret !== null && cx !== null && (
        <line className="caret-line" x1={cx} x2={cx} y1={y - fontSize * 0.62} y2={y + fontSize * 0.62} stroke={SELECT} strokeWidth={1.4} pointerEvents="none" />
      )}
    </>
  );
}

function Edge({ e, selected, caret: caretAt, mid }: { e: EdgePlan; selected: boolean; caret: number | null | undefined; mid: Pt }) {
  const color = selected ? SELECT : STROKE;
  const lines = e.lines;
  const showCaret = selected && caretAt !== undefined;
  const cond = e.transitions[0].condition;
  // Caret position within the condition text (the first label line).
  const at = showCaret && cond ? Math.min(caretAt ?? cond.length, cond.length) : null;
  const caret: Pt | null = showCaret && !cond ? (e.label && lines.length ? null : mid) : null;
  const lh = e.fontSize * 1.3;
  const top = e.label ? e.label.y - (lines.length * lh) / 2 + lh / 2 : 0;
  return (
    <g data-edge={edgeKey(e)} className="edge">
      <path d={e.path} fill="none" stroke="transparent" strokeWidth={14} />
      {selected && <path d={e.path} fill="none" stroke={SELECT} strokeOpacity={0.18} strokeWidth={7} />}
      <path d={e.path} fill="none" stroke={color} strokeWidth={1.6} markerEnd={`url(#${selected ? "c-arrow-sel" : "c-arrow"})`} />
      {e.label && lines.map((l, i) => (
        <CaretText
          key={i}
          x={e.label!.x}
          y={top + i * lh}
          text={l}
          caret={i === 0 && at !== null && l === cond ? at : i === 0 && showCaret && !cond ? 0 : null}
          fontSize={e.fontSize}
          fill={color}
          stroke="#ffffff"
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
        />
      ))}
      {caret && <line className="caret-line" x1={caret.x} x2={caret.x} y1={caret.y - 8} y2={caret.y + 8} stroke={SELECT} strokeWidth={1.4} pointerEvents="none" />}
    </g>
  );
}

function InitialArrow({ a, selected }: { a: NonNullable<DiagramPlan["initialArrow"]>; selected: boolean }) {
  const d = `M ${a.from.x} ${a.from.y} L ${a.to.x} ${a.to.y}`;
  return (
    <g data-initial="1" className="edge">
      <path d={d} stroke="transparent" strokeWidth={14} />
      {selected && <path d={d} stroke={SELECT} strokeOpacity={0.2} strokeWidth={8} />}
      <path d={d} stroke={ACCENT} strokeWidth={2} markerEnd="url(#c-arrow-accent)" />
    </g>
  );
}

function LinkPreview({ link, plan }: { link: { from: string | null; start: Pt; at: Pt }; plan: DiagramPlan }) {
  const find = (id: string) => plan.states.find((p) => p.state.id === id)!;
  const over = linkTarget(plan, link.from, link.at);
  let d: string;
  if (link.from) {
    const { state: s, r } = find(link.from);
    const c = { x: s.x!, y: s.y! };
    if (over === link.from) {
      d = loopPath(c, r, Math.hypot(link.at.x - c.x, link.at.y - c.y) > 2 ? snapAngle(angleOf(c, link.at)) : -Math.PI / 2);
    } else {
      const end = over ? (() => { const t = find(over); return borderPoint({ x: t.state.x!, y: t.state.y! }, t.r + 1, c); })() : link.at;
      const a = borderPoint(c, r, end);
      d = `M ${a.x} ${a.y} L ${end.x} ${end.y}`;
    }
  } else {
    const end = over ? (() => { const t = find(over); return borderPoint({ x: t.state.x!, y: t.state.y! }, t.r + 1, link.start); })() : link.at;
    d = `M ${link.start.x} ${link.start.y} L ${end.x} ${end.y}`;
  }
  return <path d={d} fill="none" stroke={SELECT} strokeWidth={1.6} strokeDasharray="5 4" markerEnd="url(#c-arrow-sel)" pointerEvents="none" />;
}
