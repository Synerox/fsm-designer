// FSM document model shared by the MCP server and (eventually) the editor UI.
// A diagram is plain JSON so it can be saved as *.fsm.json and loaded anywhere.

export type MachineType = "moore" | "mealy";
export type OutputValue = string | number | boolean;

export interface Signal {
  name: string;
  width: number; // bits, >= 1
  default?: OutputValue; // outputs only: value when nothing drives it (0 if absent)
}

/** A signal as callers may write it: a bare name (1 bit) or an object with optional width. */
export type SignalInput = string | { name: string; width?: number; default?: OutputValue };

export interface ClockSpec {
  name: string;
}

export interface ResetSpec {
  name: string;
  activeLow: boolean;
  async: boolean;
}

export interface State {
  id: string;
  name: string; // Verilog identifier
  label?: string; // free-form text drawn instead of name, e.g. "S_0" or "\beta" (see text.ts)
  x?: number; // centre, px; absent until laid out (see layout.ts)
  y?: number;
  isInitial: boolean;
  isAccepting: boolean;
  outputs: Record<string, OutputValue>; // Moore outputs
  color?: string; // fill colour, e.g. "#e0f2fe"
  radius?: number; // px; absent means STATE_RADIUS. Text never resizes a state.
  fontSize?: number; // px for the name; absent means NAME_SIZE (metrics.ts)
  initialAngle?: number; // initial states: direction the start arrow comes from, radians, screen coords; default left (pi)
}

export interface Transition {
  id: string;
  from: string; // state id
  to: string; // state id
  condition: string; // Verilog boolean expression; "" means always
  outputs: Record<string, OutputValue>; // Mealy outputs
  curve?: number; // px offset of the arc apex from the segment midpoint, 0 = straight; positive bows to the left of travel (SVG coords)
  priority?: number; // lower is checked first; absent means array order
  loopAngle?: number; // self loops: direction of the loop, radians, screen coords; absent means pick a free side
  fontSize?: number; // px for the label; absent means LABEL_SIZE (metrics.ts)
  gap?: number; // px between this line and its opposite when both are straight; absent means PARALLEL_GAP (export/svg.ts)
}

export interface FsmDiagram {
  version: 1;
  name: string;
  type: MachineType;
  clock: ClockSpec;
  reset: ResetSpec;
  inputs: Signal[];
  outputs: Signal[];
  states: State[];
  transitions: Transition[];
}

export const STATE_RADIUS = 30;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class FsmError extends Error {}

export const DEFAULT_CLOCK: ClockSpec = { name: "clk" };
export const DEFAULT_RESET: ResetSpec = { name: "rst_n", activeLow: true, async: true };

export function createDiagram(opts: {
  name?: string;
  type?: MachineType;
  clock?: Partial<ClockSpec>;
  reset?: Partial<ResetSpec>;
  inputs?: SignalInput[];
  outputs?: SignalInput[];
}): FsmDiagram {
  const d: FsmDiagram = {
    version: 1,
    name: opts.name ?? "fsm",
    type: opts.type ?? "moore",
    clock: { ...DEFAULT_CLOCK, ...opts.clock },
    reset: { ...DEFAULT_RESET, ...opts.reset },
    inputs: [],
    outputs: [],
    states: [],
    transitions: [],
  };
  if (d.type !== "moore" && d.type !== "mealy") throw new FsmError(`type must be "moore" or "mealy"`);
  for (const n of [d.clock.name, d.reset.name]) if (!IDENT.test(n)) throw new FsmError(`Clock/reset name "${n}" must be a valid Verilog identifier`);
  if (!IDENT.test(d.name)) throw new FsmError(`Diagram name "${d.name}" must be a valid Verilog identifier`);
  for (const s of opts.inputs ?? []) addSignal(d, "inputs", s);
  for (const s of opts.outputs ?? []) addSignal(d, "outputs", s);
  return d;
}

function normSignal(s: SignalInput): Signal {
  const sig: Signal = typeof s === "string" ? { name: s, width: 1 } : { name: s.name, width: s.width ?? 1 };
  if (typeof s !== "string" && s.default !== undefined) sig.default = s.default;
  if (!IDENT.test(sig.name)) throw new FsmError(`Signal name "${sig.name}" must be a valid Verilog identifier`);
  if (!Number.isInteger(sig.width) || sig.width < 1) throw new FsmError(`Signal "${sig.name}" width must be a positive integer`);
  return sig;
}

export function addSignal(d: FsmDiagram, kind: "inputs" | "outputs", s: SignalInput): Signal {
  const sig = normSignal(s);
  if ([...d.inputs, ...d.outputs].some((x) => x.name === sig.name)) throw new FsmError(`Signal "${sig.name}" already exists`);
  if ([d.clock.name, d.reset.name, "state", "next_state"].includes(sig.name)) throw new FsmError(`"${sig.name}" is reserved`);
  d[kind].push(sig);
  return sig;
}

export function removeSignal(d: FsmDiagram, name: string): void {
  const before = d.inputs.length + d.outputs.length;
  d.inputs = d.inputs.filter((s) => s.name !== name);
  d.outputs = d.outputs.filter((s) => s.name !== name);
  if (d.inputs.length + d.outputs.length === before) throw new FsmError(`No signal named "${name}"`);
  for (const st of d.states) delete st.outputs[name];
  for (const t of d.transitions) delete t.outputs[name];
}

function uniqueId(prefix: string, taken: Set<string>): string {
  let i = 0;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

/** Find a state by id or (case-sensitive) name. */
export function findState(d: FsmDiagram, ref: string): State {
  const s = d.states.find((x) => x.id === ref) ?? d.states.find((x) => x.name === ref);
  if (!s) throw new FsmError(`No state with id or name "${ref}". Existing: ${d.states.map((x) => x.name).join(", ") || "(none)"}`);
  return s;
}

export function findTransition(d: FsmDiagram, id: string): Transition {
  const t = d.transitions.find((x) => x.id === id);
  if (!t) throw new FsmError(`No transition with id "${id}"`);
  return t;
}

function checkOutputs(d: FsmDiagram, outputs: Record<string, OutputValue> | undefined): Record<string, OutputValue> {
  const out: Record<string, OutputValue> = {};
  for (const [k, v] of Object.entries(outputs ?? {})) {
    if (!d.outputs.some((s) => s.name === k)) throw new FsmError(`Unknown output "${k}". Declare it first (outputs: ${d.outputs.map((s) => s.name).join(", ") || "none"})`);
    out[k] = v;
  }
  return out;
}

export interface StateInput {
  name: string;
  label?: string;
  initialAngle?: number;
  radius?: number;
  fontSize?: number;
  isInitial?: boolean;
  isAccepting?: boolean;
  outputs?: Record<string, OutputValue>;
  x?: number;
  y?: number;
  color?: string;
}

export function addState(d: FsmDiagram, s: StateInput): State {
  if (!IDENT.test(s.name)) throw new FsmError(`State name "${s.name}" must be a valid Verilog identifier (letters, digits, _)`);
  if (d.states.some((x) => x.name === s.name)) throw new FsmError(`State "${s.name}" already exists`);
  const st: State = {
    id: uniqueId("s", new Set(d.states.map((x) => x.id))),
    name: s.name,
    ...(s.label !== undefined ? { label: s.label } : {}),
    ...(s.x !== undefined ? { x: s.x } : {}),
    ...(s.y !== undefined ? { y: s.y } : {}),
    isInitial: s.isInitial ?? d.states.length === 0,
    isAccepting: s.isAccepting ?? false,
    outputs: checkOutputs(d, s.outputs),
    ...(s.color ? { color: s.color } : {}),
    ...(s.initialAngle !== undefined ? { initialAngle: s.initialAngle } : {}),
    ...(s.radius !== undefined ? { radius: s.radius } : {}),
    ...(s.fontSize !== undefined ? { fontSize: s.fontSize } : {}),
  };
  if (st.isInitial) for (const x of d.states) x.isInitial = false;
  d.states.push(st);
  return st;
}

export function updateState(d: FsmDiagram, ref: string, patch: Partial<Omit<StateInput, "label">> & { label?: string | null }): State {
  const st = findState(d, ref);
  if (patch.name !== undefined && patch.name !== st.name) {
    if (!IDENT.test(patch.name)) throw new FsmError(`State name "${patch.name}" must be a valid Verilog identifier`);
    if (d.states.some((x) => x.name === patch.name)) throw new FsmError(`State "${patch.name}" already exists`);
    st.name = patch.name;
  }
  if (patch.label === null) delete st.label;
  else if (patch.label !== undefined) st.label = patch.label;
  if (patch.initialAngle !== undefined) st.initialAngle = patch.initialAngle;
  if (patch.radius !== undefined) st.radius = patch.radius;
  if (patch.fontSize !== undefined) st.fontSize = patch.fontSize;
  if (patch.x !== undefined) st.x = patch.x;
  if (patch.y !== undefined) st.y = patch.y;
  if (patch.isAccepting !== undefined) st.isAccepting = patch.isAccepting;
  if (patch.color !== undefined) st.color = patch.color || undefined;
  if (patch.outputs !== undefined) st.outputs = { ...st.outputs, ...checkOutputs(d, patch.outputs) };
  if (patch.isInitial) for (const x of d.states) x.isInitial = x === st;
  else if (patch.isInitial === false) st.isInitial = false;
  return st;
}

export function removeState(d: FsmDiagram, ref: string): number {
  const st = findState(d, ref);
  d.states = d.states.filter((x) => x !== st);
  const before = d.transitions.length;
  d.transitions = d.transitions.filter((t) => t.from !== st.id && t.to !== st.id);
  return before - d.transitions.length;
}

export interface TransitionInput {
  from: string;
  to: string;
  condition?: string;
  outputs?: Record<string, OutputValue>;
  curve?: number;
  priority?: number;
  loopAngle?: number;
  fontSize?: number;
  gap?: number;
}

export function addTransition(d: FsmDiagram, t: TransitionInput): Transition {
  const from = findState(d, t.from);
  const to = findState(d, t.to);
  const tr: Transition = {
    id: uniqueId("t", new Set(d.transitions.map((x) => x.id))),
    from: from.id,
    to: to.id,
    condition: (t.condition ?? "").trim(),
    outputs: checkOutputs(d, t.outputs),
    ...(t.curve !== undefined ? { curve: t.curve } : {}),
    ...(t.priority !== undefined ? { priority: t.priority } : {}),
    ...(t.loopAngle !== undefined ? { loopAngle: t.loopAngle } : {}),
    ...(t.fontSize !== undefined ? { fontSize: t.fontSize } : {}),
    ...(t.gap !== undefined ? { gap: t.gap } : {}),
  };
  d.transitions.push(tr);
  return tr;
}

export function updateTransition(d: FsmDiagram, id: string, patch: Partial<TransitionInput>): Transition {
  const tr = findTransition(d, id);
  if (patch.from !== undefined) tr.from = findState(d, patch.from).id;
  if (patch.to !== undefined) tr.to = findState(d, patch.to).id;
  if (patch.condition !== undefined) tr.condition = patch.condition.trim();
  if (patch.outputs !== undefined) tr.outputs = { ...tr.outputs, ...checkOutputs(d, patch.outputs) };
  if (patch.curve !== undefined) tr.curve = patch.curve;
  if (patch.priority !== undefined) tr.priority = patch.priority;
  if (patch.loopAngle !== undefined) tr.loopAngle = patch.loopAngle;
  if (patch.fontSize !== undefined) tr.fontSize = patch.fontSize;
  if (patch.gap !== undefined) tr.gap = patch.gap;
  return tr;
}

export function removeTransition(d: FsmDiagram, id: string): void {
  findTransition(d, id);
  d.transitions = d.transitions.filter((t) => t.id !== id);
}

/** Outgoing transitions of a state in evaluation order (priority, then array order). */
export function outgoing(d: FsmDiagram, stateId: string): Transition[] {
  return d.transitions
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.from === stateId)
    .sort((a, b) => (a.t.priority ?? Infinity) - (b.t.priority ?? Infinity) || a.i - b.i)
    .map(({ t }) => t);
}

export function isUnconditional(t: Transition): boolean {
  const c = t.condition.replace(/\s+/g, "");
  return c === "" || c === "1" || c === "1'b1";
}

/** Parse and sanity-check a diagram loaded from JSON. */
export function parseDiagram(json: unknown): FsmDiagram {
  const raw = (typeof json === "string" ? JSON.parse(json) : json) as Partial<FsmDiagram>;
  if (!raw || typeof raw !== "object") throw new FsmError("Diagram JSON must be an object");
  const d = createDiagram({ name: raw.name, type: raw.type, clock: raw.clock, reset: raw.reset, inputs: raw.inputs, outputs: raw.outputs });
  const idMap = new Map<string, string>();
  for (const s of raw.states ?? []) {
    const st = addState(d, { ...s, isInitial: !!s.isInitial });
    if (s.id && !d.states.some((x) => x.id === s.id)) st.id = s.id;
    idMap.set(s.id ?? s.name, st.id);
  }
  for (const t of raw.transitions ?? []) {
    const tr = addTransition(d, { ...t, from: idMap.get(t.from) ?? t.from, to: idMap.get(t.to) ?? t.to });
    if (t.id && !d.transitions.some((x) => x.id === t.id)) tr.id = t.id;
  }
  return d;
}

export interface ValidationIssue {
  level: "error" | "warning";
  message: string;
}

/** States no path of transitions leads to from the initial state (none when there is no initial state). */
export function unreachableStates(d: FsmDiagram): Set<string> {
  const initial = d.states.find((s) => s.isInitial);
  if (!initial) return new Set();
  const seen = new Set([initial.id]);
  const queue = [initial.id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const t of d.transitions) if (t.from === cur && !seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
  }
  return new Set(d.states.filter((s) => !seen.has(s.id)).map((s) => s.id));
}

export function validate(d: FsmDiagram): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const name = (id: string) => d.states.find((s) => s.id === id)?.name ?? id;
  if (d.states.length === 0) issues.push({ level: "error", message: "Diagram has no states" });
  const initial = d.states.filter((s) => s.isInitial);
  if (d.states.length && initial.length === 0) issues.push({ level: "error", message: "No initial (reset) state" });

  // Reachability from the initial state.
  if (initial.length) {
    const lost = unreachableStates(d);
    for (const s of d.states) if (lost.has(s.id)) issues.push({ level: "warning", message: `State "${s.name}" is unreachable from the initial state` });
  }

  for (const s of d.states) {
    const outs = outgoing(d, s.id);
    const unconditional = outs.filter(isUnconditional);
    if (unconditional.length > 1) issues.push({ level: "error", message: `State "${s.name}" has ${unconditional.length} unconditional transitions` });
    if (unconditional.length === 1 && outs.length > 1 && outs[outs.length - 1] !== unconditional[0])
      issues.push({ level: "warning", message: `State "${s.name}": the unconditional transition is not last, so later transitions are shadowed in Verilog priority order` });
    const conds = outs.map((t) => t.condition.replace(/\s+/g, ""));
    const dup = conds.find((c, i) => c && conds.indexOf(c) !== i);
    if (dup) issues.push({ level: "warning", message: `State "${s.name}" has more than one transition with condition "${dup}"` });
  }

  const ids = new Set(d.inputs.map((s) => s.name));
  for (const t of d.transitions) {
    for (const tok of t.condition.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
      if (!ids.has(tok) && !/^\d/.test(tok) && !/^[bdhoBDHO][0-9a-fA-F_xXzZ]+$/.test(tok))
        issues.push({ level: "warning", message: `Transition ${t.id} (${name(t.from)} -> ${name(t.to)}) uses "${tok}", which is not a declared input` });
    }
  }
  if (d.type === "moore") {
    for (const s of d.states) for (const o of d.outputs) if (!(o.name in s.outputs))
      issues.push({ level: "warning", message: `Moore state "${s.name}" does not set output "${o.name}" (uses default ${o.default ?? 0})` });
  }
  return issues;
}

/** Human/agent readable summary of the diagram. */
export function describe(d: FsmDiagram): string {
  const nm = (id: string) => d.states.find((s) => s.id === id)?.name ?? id;
  const sig = (s: Signal) => (s.width > 1 ? `${s.name}[${s.width - 1}:0]` : s.name);
  const outs = (o: Record<string, OutputValue>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ");
  const lines = [
    `Diagram "${d.name}" (${d.type}), ${d.states.length} states, ${d.transitions.length} transitions`,
    `Inputs: ${d.inputs.map(sig).join(", ") || "none"}`,
    `Outputs: ${d.outputs.map(sig).join(", ") || "none"}`,
    `Clock: ${d.clock.name}, reset: ${d.reset.name} (${d.reset.activeLow ? "active-low" : "active-high"}, ${d.reset.async ? "async" : "sync"})`,
    "States:",
    ...d.states.map((s) =>
      `  ${s.id} ${s.name}${s.isInitial ? " [initial]" : ""}${s.isAccepting ? " [accepting]" : ""}${s.x !== undefined && s.y !== undefined ? ` @(${Math.round(s.x)},${Math.round(s.y)})` : ""}${Object.keys(s.outputs).length ? ` outputs: ${outs(s.outputs)}` : ""}`),
    "Transitions:",
    ...d.transitions.map((t) =>
      `  ${t.id} ${nm(t.from)} -> ${nm(t.to)} when ${t.condition || "(always)"}${t.priority !== undefined ? ` (priority ${t.priority})` : ""}${Object.keys(t.outputs).length ? ` / ${outs(t.outputs)}` : ""}`),
  ];
  return lines.join("\n");
}
