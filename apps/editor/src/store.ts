// Editor state: the open diagram, selection, undo history and file info.
// Every edit goes through `edit()`, which records an undo snapshot first.

import { create } from "zustand";
import { current, isDraft, produce } from "immer";
import { addState, addTransition, asciiText, createDiagram, isUnconditional, outgoing, planDiagram, removeState, stateText, transitionLabel, transitionLines } from "@fsm/core";
import type { DiagramPlan, FsmDiagram, MachineType, PlanOptions, Signal, State, Transition } from "@fsm/core";

export type Selection =
  | { kind: "state"; id: string }
  // All transitions between the pair (drawn as one arc). `tid` is the one whose
  // text typing edits (the label line clicked); absent means the first.
  | { kind: "edge"; from: string; to: string; tid?: string }
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

/** Canvas drawing options: the label setting, and a selected line shows its own text even when labels are hidden. */
export function canvasOptions(labels: LabelMode, sel: Selection): PlanOptions {
  return { ...drawOptions(labels), ...(sel?.kind === "edge" ? { shownEdge: { from: sel.from, to: sel.to } } : {}) };
}

let lastPlan: { doc: FsmDiagram; key: string; plan: DiagramPlan } | null = null;

/**
 * planDiagram for the canvas, shared by the canvas and the inspector so an
 * edit is planned once, not once per panel. An edit that moves nothing (a
 * state's text, colour, accepting ring or outputs) reuses the last plan:
 * lines and label places depend only on where the states are, their sizes
 * and the transitions. The plan's `states[].state` may then be an older
 * version of the state, so callers take a state's text from the doc (and
 * its `bounds`, which grow with that text, are not used from here).
 */
export function viewPlan(doc: FsmDiagram, opts: PlanOptions): DiagramPlan {
  const key = JSON.stringify(opts);
  if (lastPlan && lastPlan.key === key && (lastPlan.doc === doc || sameGeometry(lastPlan.doc, doc))) {
    lastPlan.doc = doc;
    return lastPlan.plan;
  }
  lastPlan = { doc, key, plan: planDiagram(doc, opts) };
  return lastPlan.plan;
}

/** Same lines and states in the same places (immer keeps untouched parts of the doc identical). */
function sameGeometry(a: FsmDiagram, b: FsmDiagram): boolean {
  return a.transitions === b.transitions && a.type === b.type && a.states.length === b.states.length
    && a.states.every((s, i) => {
      const t = b.states[i];
      return s === t || (s.id === t.id && s.x === t.x && s.y === t.y && s.radius === t.radius && s.isInitial === t.isInitial && s.initialAngle === t.initialAngle);
    });
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

/**
 * New transition from `from` to `to`. A state's unconditional transition is
 * its fallback, checked last; a line drawn after it would come later in
 * evaluation order and be shadowed (nothing on the canvas shows the order,
 * and imported diagrams carry priorities the editor can't show either). So
 * the new one is put just before that fallback: in the array, and in
 * priority when the fallback has one (the fallback and those after it move
 * down by one). Of several blank lines from one state, the last in the array
 * stays the fallback, so with blank lines drawn first and labelled later,
 * the first-drawn one that is left blank is the "else".
 */
export function createTransition(d: FsmDiagram, from: string, to: string, loopAngle?: number): void {
  if (edgeTransitions(d, from, to).length) return;
  // The last one, if several: the earlier ones are blank lines of a sketch.
  const fallback = outgoing(d, from).reverse().find(isUnconditional);
  const t = addTransition(d, { from, to, ...(loopAngle !== undefined ? { loopAngle } : {}) });
  if (!fallback) return;
  d.transitions.pop();
  d.transitions.splice(d.transitions.indexOf(fallback), 0, t);
  const p = fallback.priority;
  if (p === undefined) return;
  for (const x of d.transitions) if (x.from === from && x !== t && x.priority !== undefined && x.priority >= p) x.priority++;
  t.priority = p;
}

/** Verilog-2005 reserved words (IEEE 1364-2005 Annex B): never a state's identifier. */
const VERILOG_KEYWORDS = new Set(`always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config
  deassign default defparam design disable edge else end endcase endconfig endfunction endgenerate endmodule
  endprimitive endspecify endtable endtask event for force forever fork function generate genvar highz0 highz1 if
  ifnone incdir include initial inout input instance integer join large liblist library localparam macromodule medium
  module nand negedge nmos nor noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0
  pull1 pulldown pullup pulsestyle_ondetect pulsestyle_onevent rcmos real realtime reg release repeat rnmos rpmos
  rtran rtranif0 rtranif1 scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table
  task time tran tranif0 tranif1 tri tri0 tri1 triand trior trireg unsigned use uwire vectored wait wand weak0 weak1
  while wire wor xnor xor`.split(/\s+/));

/**
 * Whether `name` can be a state's identifier besides `s`: not another
 * state's, and not a name the generated module already uses (a signal, the
 * clock or reset, the module itself, the state registers) or a Verilog
 * keyword, which would read as that signal in conditions or break codegen.
 */
function freeForState(d: FsmDiagram, s: State, name: string): boolean {
  if (!IDENT.test(name) || d.states.some((x) => x !== s && x.name === name)) return false;
  const used = [...d.inputs, ...d.outputs].map((x) => x.name).concat(d.clock.name, d.reset.name, d.name, "state", "next_state");
  return !used.includes(name) && !VERILOG_KEYWORDS.has(name);
}

/**
 * Set the text drawn on a state. Plain identifiers ("IDLE") become the state's
 * name; anything else ("S₀", "β", "q 1", "") is kept as a display label, and
 * its ASCII spelling ("S_0", "beta") becomes the name when that is usable
 * (see freeForState; text that isn't, such as an input's name, is a label too).
 * `before` is the name the state had when this typing began: when the text
 * can't be the name, the state goes back to it, so a prefix typed on the way
 * ("cl" on the way to "clk") doesn't stick as the identifier.
 */
export function setStateText(d: FsmDiagram, id: string, text: string, before?: string): void {
  const s = d.states.find((x) => x.id === id);
  if (!s) return;
  const ascii = asciiText(text);
  const usable = freeForState(d, s, ascii);
  if (usable) s.name = ascii;
  else if (before !== undefined && before !== s.name && freeForState(d, s, before)) s.name = before;
  if (usable && ascii === text) delete s.label;
  else s.label = text;
}

/**
 * Typing on a state (canvas or Inspector): one undo step per typing session,
 * and the name it started with is what setStateText falls back to. The
 * session's first edit pushed the doc as it was onto `past`, so while the
 * session lasts that is past's last entry.
 */
export function typeStateText(id: string, text: string): void {
  const { doc, past, coalesce, edit } = useEditor.getState();
  const key = `text:${id}`;
  const start = coalesce === key ? past[past.length - 1] ?? doc : doc;
  const before = start.states.find((x) => x.id === id)?.name;
  edit((d) => setStateText(d, id, text, before), key);
}

export function getStateText(s: State): string {
  return stateText(s);
}

/**
 * The transition whose text typing edits on a selected line: the one whose
 * label line was clicked (several transitions between one pair share an arc
 * and stack their labels), else the first.
 */
export function editedTransition(d: FsmDiagram, sel: { from: string; to: string; tid?: string }): Transition | undefined {
  const ts = edgeTransitions(d, sel.from, sel.to);
  return ts.find((t) => t.id === sel.tid) ?? ts[0];
}

/** Condition text is stored as typed (spaces included); codegen trims it. `tid` picks the transition (see editedTransition). */
export function setEdgeText(d: FsmDiagram, from: string, to: string, text: string, tid?: string): void {
  const t = editedTransition(d, { from, to, tid });
  if (t) t.condition = text;
}

/**
 * Which transition each label line of an arc belongs to (its index in `ts`,
 * the arc's transitions): the lines are each transition's label lines in
 * turn, in the order the transitions are checked (as planDiagram stacks
 * them), and a transition with no text has none. The lines come from
 * transitionLines, as the drawn ones do, so a " / " in a Moore condition is
 * not taken for an outputs separator that would add a line.
 */
export function lineOwners(d: FsmDiagram, ts: Transition[]): number[] {
  return stackOrder(d, ts).flatMap((i) => transitionLines(d, ts[i], DRAW).map(() => i));
}

/** The indexes in `ts` (an arc's transitions) in the order their labels are stacked: the order they are checked. */
export function stackOrder(d: FsmDiagram, ts: Transition[]): number[] {
  if (!ts.length) return [];
  const order = outgoing(d, ts[0].from);
  return ts.map((_, i) => i).sort((a, b) => order.indexOf(ts[a]) - order.indexOf(ts[b]));
}

/**
 * Where the text cursor before character `caret` of a transition's condition
 * is drawn: which of the transition's own label lines, and how many
 * characters into it. The condition begins the label ("cond / z=1" in
 * Mealy), and a long label is wrapped into lines that each come from it in
 * order, less the spaces at the breaks. Null when the transition draws no text.
 */
export function caretSpot(d: FsmDiagram, t: Transition, caret: number): { line: number; offset: number } | null {
  // The drawn lines (see lineOwners); the condition lines are pieces of the
  // condition in order, so their starts are found in the label, which it begins.
  const text = transitionLabel(d, t, DRAW);
  const lines = transitionLines(d, t, DRAW);
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = text.indexOf(lines[i], from), end = start + lines[i].length;
    if (caret <= end || i === lines.length - 1) return { line: i, offset: Math.min(Math.max(caret - start, 0), lines[i].length) };
    from = end;
  }
  return null;
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
  /** The source diagram's kind and signals, so a paste elsewhere can declare what the copy uses. */
  type: MachineType;
  inputs: Signal[];
  outputs: Signal[];
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
    type: d.type,
    inputs: structuredClone(d.inputs),
    outputs: structuredClone(d.outputs),
  };
  pasteCount = 0;
  return clipboard.states.length + new Set(clipboard.transitions.map((t) => `${t.from} ${t.to}`)).size;
}

export function hasClipboard(): boolean {
  return clipboard !== null;
}

/**
 * Paste the clipboard into `d`, offset down-right a little more each time,
 * with fresh ids, names and labels (S0 -> S0_1, S₀ -> S₀′ when taken). Pasted states are
 * never initial. Returns the selection of what was pasted.
 *
 * The clipboard outlives File > New and Open, so the target may not declare
 * the signals the copy uses. A file whose outputs are undeclared cannot be
 * opened again (parseDiagram rejects it), so each output and input the copy
 * uses is declared as it was in the source; one that cannot be (its name is
 * already taken for something else) is dropped. An empty diagram takes the
 * source's machine kind, and Mealy outputs pasted into a Moore machine are
 * dropped, since nothing there draws or edits them. (Outputs a Moore
 * diagram's own transitions carry, hidden, are kept when pasted into a Moore
 * diagram: they came from the file and are not the paste's to drop.)
 */
export function pasteClipboard(d: FsmDiagram): Selection {
  if (!clipboard) return null;
  const clip = clipboard;
  if (!d.states.length && !d.inputs.length && !d.outputs.length) d.type = clip.type;
  const reserved = [d.clock.name, d.reset.name, "state", "next_state"];
  const declared = (kind: "inputs" | "outputs", name: string): boolean => {
    if (d[kind].some((s) => s.name === name)) return true;
    const src = clip[kind].find((s) => s.name === name);
    if (!src || reserved.includes(name) || [...d.inputs, ...d.outputs].some((s) => s.name === name)) return false;
    d[kind].push(structuredClone(src));
    return true;
  };
  const keepDeclared = (outs: Record<string, unknown>) => { for (const k of Object.keys(outs)) if (!declared("outputs", k)) delete outs[k]; };
  const off = 40 * ++pasteCount; // two grid cells, so grid-aligned states stay aligned
  const names = new Set(d.states.map((s) => s.name));
  // Text drawn on the states: a pasted copy must not look the same as its original.
  const shown = new Set(d.states.map((s) => stateText(s)));
  const ids = new Set(d.states.map((s) => s.id));
  const idMap = new Map<string, string>();
  // Names take "_1", "_2"; labels take primes (S₀′, S₀″): "S₀_1" would turn
  // into "S₀₁" when the file is opened again (old shortcut syntax, see upgradeLabels).
  const PRIMES = ["′", "″", "‴"];
  const fresh = (base: string, taken: Set<string>, suffix = (i: number) => `_${i}`) => {
    if (!taken.has(base)) return base;
    let i = 1;
    while (taken.has(base + suffix(i))) i++;
    return base + suffix(i);
  };
  const prime = (i: number) => PRIMES[i - 1] ?? "′".repeat(i);
  for (const src of clipboard.states) {
    const s = structuredClone(src);
    s.id = fresh(`s${d.states.length}`, ids);
    // A label ("S₀") gets a prime ("S₀′"); a state drawn by its name keeps
    // clear of other states' labels too.
    if (src.label) s.label = fresh(src.label, shown, prime);
    s.name = fresh(src.name, src.label ? names : new Set([...names, ...shown]));
    s.x = (src.x ?? 0) + off;
    s.y = (src.y ?? 0) + off;
    s.isInitial = false;
    keepDeclared(s.outputs);
    ids.add(s.id);
    names.add(s.name);
    shown.add(stateText(s));
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
    if (d.type === "moore" && clip.type === "mealy") t.outputs = {};
    keepDeclared(t.outputs);
    // Names in the condition that were the source's inputs (the rest are left as typed).
    for (const name of t.condition.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) if (clip.inputs.some((x) => x.name === name)) declared("inputs", name);
    tids.add(t.id);
    d.transitions.push(t);
    if (!edges.some((e) => e.from === t.from && e.to === t.to)) edges.push({ from: t.from, to: t.to });
  }
  return multiSelection([...idMap.values()], edges, false);
}
