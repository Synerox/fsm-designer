// Editor state: the open diagram, selection, undo history and file info.
// Every edit goes through `edit()`, which records an undo snapshot first.

import { create } from "zustand";
import { current, isDraft, produce } from "immer";
import { addState, addTransition, asciiText, createDiagram, planDiagram, removeState, stateText } from "@fsm/core";
import type { FsmDiagram, PlanOptions, State, Transition } from "@fsm/core";

export type Selection =
  | { kind: "state"; id: string }
  | { kind: "edge"; from: string; to: string } // all transitions between the pair (drawn as one arc)
  | { kind: "initial" }
  | { kind: "multi"; states: string[]; edges: EdgeRef[]; initial: boolean } // box select, Ctrl+click, Ctrl+A
  | null;

export interface EdgeRef {
  from: string;
  to: string;
}

interface EditorState {
  doc: FsmDiagram;
  selection: Selection;
  past: FsmDiagram[];
  future: FsmDiagram[];
  filePath: string | null; // desktop: absolute path; browser: file name
  dirty: boolean;
  /** The doc as last loaded or saved (null if that is not on disk, e.g. an import), so undo back to it is clean. */
  savedDoc: FsmDiagram | null;
  /** Snapshot key of the last coalesced edit (typing, dragging), so one gesture is one undo step. */
  coalesce: string | null;
  /** Text cursor in the selected state's or transition's text; null = at the end. */
  caret: number | null;
  setCaret(caret: number | null): void;
  /** Bumped whenever a different diagram is loaded, so the view can re-fit. */
  loadSeq: number;
  /** Which transition labels are drawn (view setting, also used for exports). */
  labels: LabelMode;
  setLabels(labels: LabelMode): void;

  edit(fn: (d: FsmDiagram) => void, coalesceKey?: string): void;
  select(sel: Selection): void;
  undo(): void;
  redo(): void;
  load(doc: FsmDiagram, filePath: string | null): void;
  /** `doc` is the diagram that was written; it defaults to the current one. */
  markSaved(filePath: string, doc?: FsmDiagram): void;
}

const HISTORY_LIMIT = 500;

/** How the editor draws and exports: transition text exactly as typed (no automatic "else"). */
export const DRAW: PlanOptions = { elseLabels: false };

export type LabelMode = "all" | "none";
const LABELS_KEY = "fsm-designer.labels";
function loadLabels(): LabelMode {
  try { const v = localStorage.getItem(LABELS_KEY); return v === "none" ? v : "all"; } catch { return "all"; }
}

/** Drawing options with the current label setting. */
export function drawOptions(labels: LabelMode = useEditor.getState().labels): PlanOptions {
  return { ...DRAW, labels };
}

/** Name of a new diagram (also the Verilog module name until changed). */
export const DEFAULT_NAME = "State_Diagram";

export function newDiagram(): FsmDiagram {
  return createDiagram({ name: DEFAULT_NAME });
}

const initialDoc = newDiagram();

export const useEditor = create<EditorState>((set, get) => ({
  doc: initialDoc,
  selection: null,
  past: [],
  future: [],
  filePath: null,
  dirty: false,
  savedDoc: initialDoc,
  coalesce: null,
  loadSeq: 0,
  caret: null,
  labels: loadLabels(),
  setLabels(labels) {
    try { localStorage.setItem(LABELS_KEY, labels); } catch { /* storage off */ }
    set({ labels });
  },
  setCaret(caret) {
    set({ caret });
  },

  edit(fn, coalesceKey) {
    const { doc, past, coalesce } = get();
    const next = produce(doc, fn);
    if (next === doc) return;
    const merge = coalesceKey !== undefined && coalesceKey === coalesce;
    set({
      doc: next,
      past: merge ? past : [...past.slice(-HISTORY_LIMIT + 1), doc],
      future: [],
      dirty: true,
      coalesce: coalesceKey ?? null,
    });
  },
  select(selection) {
    set({ selection, coalesce: null, caret: null });
  },
  undo() {
    const { past, doc, future } = get();
    if (!past.length) return;
    const prev = past[past.length - 1];
    set({ doc: prev, past: past.slice(0, -1), future: [doc, ...future], dirty: prev !== get().savedDoc, coalesce: null, selection: keepSelection(prev, get().selection) });
  },
  redo() {
    const { past, doc, future } = get();
    if (!future.length) return;
    const next = future[0];
    set({ doc: next, past: [...past, doc], future: future.slice(1), dirty: next !== get().savedDoc, coalesce: null, selection: keepSelection(next, get().selection) });
  },
  load(doc, filePath) {
    set({ doc, filePath, past: [], future: [], dirty: false, savedDoc: doc, selection: null, coalesce: null, loadSeq: get().loadSeq + 1 });
  },
  markSaved(filePath, doc = get().doc) {
    // An edit made while the save was in flight is not in the file.
    set({ filePath, dirty: get().doc !== doc, savedDoc: doc, coalesce: null });
  },
}));

function keepSelection(d: FsmDiagram, sel: Selection): Selection {
  if (!sel) return null;
  if (sel.kind === "multi")
    return multiSelection(
      sel.states.filter((id) => d.states.some((s) => s.id === id)),
      sel.edges.filter((e) => edgeTransitions(d, e.from, e.to).length),
      sel.initial && d.states.some((s) => s.isInitial),
    );
  if (sel.kind === "state") return d.states.some((s) => s.id === sel.id) ? sel : null;
  if (sel.kind === "edge") return edgeTransitions(d, sel.from, sel.to).length ? sel : null;
  return d.states.some((s) => s.isInitial) ? sel : null;
}

// ---- Model helpers used by the canvas and inspector ----

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function edgeTransitions(d: FsmDiagram, from: string, to: string): Transition[] {
  return d.transitions.filter((t) => t.from === from && t.to === to);
}

function freeStateName(d: FsmDiagram): string {
  const taken = new Set(d.states.map((s) => s.name));
  let i = 0;
  while (taken.has(`S${i}`)) i++;
  return `S${i}`;
}

/** New state at (x, y), empty label like Evan's editor; the identifier is S0, S1, ... */
export function createState(d: FsmDiagram, x: number, y: number): State {
  return addState(d, { name: freeStateName(d), label: "", x: Math.round(x), y: Math.round(y), isInitial: false });
}

export function createTransition(d: FsmDiagram, from: string, to: string, loopAngle?: number): void {
  if (edgeTransitions(d, from, to).length) return;
  addTransition(d, { from, to, ...(loopAngle !== undefined ? { loopAngle } : {}) });
}

/**
 * Set the text drawn on a state. Plain identifiers ("IDLE") become the state's
 * name; anything else ("S₀", "β", "q 1", "") is kept as a display label, and
 * its ASCII spelling ("S_0", "beta") becomes the name when that is usable.
 */
export function setStateText(d: FsmDiagram, id: string, text: string): void {
  const s = d.states.find((x) => x.id === id);
  if (!s) return;
  const ascii = asciiText(text);
  const usable = IDENT.test(ascii) && !d.states.some((x) => x !== s && x.name === ascii) && !["state", "next_state"].includes(ascii);
  if (usable) s.name = ascii;
  if (usable && ascii === text) delete s.label;
  else s.label = text;
}

export function getStateText(s: State): string {
  return stateText(s);
}

/** Condition text is stored as typed (spaces included); codegen trims it. */
export function setEdgeText(d: FsmDiagram, from: string, to: string, text: string): void {
  const [first] = edgeTransitions(d, from, to);
  if (first) first.condition = text;
}

// ---- Multiple selection ----

/** Build a selection from parts; one item collapses to the plain single selection. */
export function multiSelection(states: string[], edges: EdgeRef[], initial: boolean): Selection {
  const n = states.length + edges.length + (initial ? 1 : 0);
  if (n === 0) return null;
  if (n === 1) {
    if (states.length) return { kind: "state", id: states[0] };
    if (edges.length) return { kind: "edge", ...edges[0] };
    return { kind: "initial" };
  }
  return { kind: "multi", states, edges, initial };
}

/** Selection as parts, whatever its kind. */
export function selectionParts(sel: Selection): { states: string[]; edges: EdgeRef[]; initial: boolean } {
  if (!sel) return { states: [], edges: [], initial: false };
  if (sel.kind === "multi") return sel;
  if (sel.kind === "state") return { states: [sel.id], edges: [], initial: false };
  if (sel.kind === "edge") return { states: [], edges: [{ from: sel.from, to: sel.to }], initial: false };
  return { states: [], edges: [], initial: true };
}

export function isStateSelected(sel: Selection, id: string): boolean {
  return selectionParts(sel).states.includes(id);
}

export function isEdgeSelected(sel: Selection, from: string, to: string): boolean {
  return selectionParts(sel).edges.some((e) => e.from === from && e.to === to);
}

export function selectAll(d: FsmDiagram): Selection {
  const edges: EdgeRef[] = [];
  for (const t of d.transitions) if (!edges.some((e) => e.from === t.from && e.to === t.to)) edges.push({ from: t.from, to: t.to });
  return multiSelection(d.states.map((s) => s.id), edges, d.states.some((s) => s.isInitial));
}

/** Everything in either selection (box select adds to what was already selected). */
export function mergeSelections(a: Selection, b: Selection): Selection {
  const p = selectionParts(a), q = selectionParts(b);
  const edges = [...p.edges];
  for (const e of q.edges) if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);
  return multiSelection([...new Set([...p.states, ...q.states])], edges, p.initial || q.initial);
}

/** Add an item to the selection, or take it out if it is already in. */
export function toggleInSelection(sel: Selection, item: Exclude<Selection, null | { kind: "multi" }>): Selection {
  const p = selectionParts(sel);
  if (item.kind === "state")
    return multiSelection(p.states.includes(item.id) ? p.states.filter((x) => x !== item.id) : [...p.states, item.id], p.edges, p.initial);
  if (item.kind === "edge") {
    const has = p.edges.some((e) => e.from === item.from && e.to === item.to);
    return multiSelection(p.states, has ? p.edges.filter((e) => !(e.from === item.from && e.to === item.to)) : [...p.edges, { from: item.from, to: item.to }], p.initial);
  }
  return multiSelection(p.states, p.edges, !p.initial);
}

export function deleteSelection(d: FsmDiagram, sel: Selection): void {
  if (!sel) return;
  if (sel.kind === "multi") {
    for (const e of sel.edges) deleteSelection(d, { kind: "edge", ...e });
    if (sel.initial) deleteSelection(d, { kind: "initial" });
    for (const id of sel.states) if (d.states.some((s) => s.id === id)) removeState(d, id);
    return;
  }
  if (sel.kind === "state") removeState(d, sel.id);
  else if (sel.kind === "edge") d.transitions = d.transitions.filter((t) => !(t.from === sel.from && t.to === sel.to));
  else for (const s of d.states) s.isInitial = false;
}

export type AlignMode = "row" | "column" | "spreadX" | "spreadY";

/**
 * Line up states: "row" puts their centres on one horizontal line (the
 * average height), "column" on one vertical line; "spreadX" / "spreadY" keep
 * the two outermost states and space the rest evenly between them.
 * `round` places the shared line (e.g. on the grid).
 */
export function alignStates(d: FsmDiagram, ids: string[], mode: AlignMode, round: (v: number) => number = Math.round): void {
  const st = d.states.filter((s) => ids.includes(s.id));
  if (st.length < 2) return;
  if (mode === "row" || mode === "column") {
    const a = mode === "row" ? "y" : "x";
    const v = round(st.reduce((sum, s) => sum + s[a]!, 0) / st.length);
    for (const s of st) s[a] = v;
    return;
  }
  const a = mode === "spreadX" ? "x" : "y";
  const sorted = [...st].sort((p, q) => p[a]! - q[a]!);
  const lo = sorted[0][a]!, hi = sorted[sorted.length - 1][a]!;
  sorted.forEach((s, i) => { s[a] = Math.round(lo + ((hi - lo) * i) / (sorted.length - 1)); });
}

/**
 * Line shape between two states. "straight" sets the curve to 0. "curve"
 * (also the reset in curve mode) uses the automatic bend when there is one
 * (e.g. a pair of opposite lines), else a gentle default bend.
 */
export function setEdgeShape(d: FsmDiagram, from: string, to: string, shape: "straight" | "curve"): void {
  const ts = edgeTransitions(d, from, to);
  if (!ts.length || from === to) return;
  let curve = 0;
  if (shape === "curve") {
    const auto = structuredClone(isDraft(d) ? current(d) : d);
    for (const t of edgeTransitions(auto, from, to)) delete t.curve;
    const e = planDiagram(auto, DRAW).edges.find((p) => p.transitions[0].from === from && p.transitions[0].to === to);
    const a = d.states.find((s) => s.id === from)!, b = d.states.find((s) => s.id === to)!;
    curve = e?.curve || Math.round(Math.max(30, Math.hypot(b.x! - a.x!, b.y! - a.y!) * 0.2));
  }
  for (const t of ts) t.curve = curve;
}

export function setInitial(d: FsmDiagram, id: string, angle: number): void {
  for (const s of d.states) {
    s.isInitial = s.id === id;
    if (s.id === id) s.initialAngle = angle;
  }
}

// ---- Copy / cut / paste ----

/** Copied states and the transitions among them (an in-app clipboard). */
export interface Clip {
  states: State[];
  transitions: Transition[];
}

let clipboard: Clip | null = null;
let pasteCount = 0;

/**
 * Copy the selected states plus every transition between them (selected or
 * not), so a box-selected part of the machine pastes whole. Transitions whose
 * ends are not both copied can't stand alone and are left out.
 * Returns how many objects were copied.
 */
export function copySelection(d: FsmDiagram, sel: Selection): number {
  const ids = new Set(selectionParts(sel).states);
  if (!ids.size) return 0;
  clipboard = {
    states: structuredClone(d.states.filter((s) => ids.has(s.id))),
    transitions: structuredClone(d.transitions.filter((t) => ids.has(t.from) && ids.has(t.to))),
  };
  pasteCount = 0;
  return clipboard.states.length + new Set(clipboard.transitions.map((t) => `${t.from} ${t.to}`)).size;
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/**
 * Paste the clipboard into `d`, offset down-right a little more each time,
 * with fresh ids and names (S0 -> S0_1 when S0 exists). Pasted states are
 * never initial. Returns the selection of what was pasted.
 */
export function pasteClipboard(d: FsmDiagram): Selection {
  if (!clipboard) return null;
  const off = 40 * ++pasteCount; // two grid cells, so grid-aligned states stay aligned
  const names = new Set(d.states.map((s) => s.name));
  const ids = new Set(d.states.map((s) => s.id));
  const idMap = new Map<string, string>();
  const fresh = (base: string, taken: Set<string>) => {
    if (!taken.has(base)) return base;
    let i = 1;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  };
  for (const src of clipboard.states) {
    const s = structuredClone(src);
    s.id = fresh(`s${d.states.length}`, ids);
    s.name = fresh(src.name, names);
    s.x = (src.x ?? 0) + off;
    s.y = (src.y ?? 0) + off;
    s.isInitial = false;
    ids.add(s.id);
    names.add(s.name);
    idMap.set(src.id, s.id);
    d.states.push(s);
  }
  const tids = new Set(d.transitions.map((t) => t.id));
  const edges: EdgeRef[] = [];
  for (const src of clipboard.transitions) {
    const t = structuredClone(src);
    t.id = fresh(`t${d.transitions.length}`, tids);
    t.from = idMap.get(src.from)!;
    t.to = idMap.get(src.to)!;
    tids.add(t.id);
    d.transitions.push(t);
    if (!edges.some((e) => e.from === t.from && e.to === t.to)) edges.push({ from: t.from, to: t.to });
  }
  return multiSelection([...idMap.values()], edges, false);
}
