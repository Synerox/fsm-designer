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

// Field checks. Diagrams also come from hand-written or agent-written JSON, so
// every field is checked for its type here: a wrong one would otherwise be kept
// and fail much later, in the renderer, with a message that names nothing.
// null counts as "not given", as JSON writers often say it that way.

/** RegExp.test turns its argument into a string (undefined -> "undefined"), so check the type first. */
function isIdent(x: unknown): x is string {
  return typeof x === "string" && IDENT.test(x);
}

/** A value as an error message shows it: strings quoted, others as JSON, cut short. */
function show(x: unknown): string {
  const s = typeof x === "string" ? `"${x}"` : typeof x === "number" || x === undefined ? String(x) : JSON.stringify(x);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function optNum(v: unknown, what: string, range: "any" | "positive" | "nonNegative" = "any"): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || (range === "positive" && v <= 0) || (range === "nonNegative" && v < 0))
    throw new FsmError(`${what} must be a ${range === "any" ? "finite" : range === "positive" ? "positive" : "non-negative"} number, got ${show(v)}`);
  return v;
}

function optBool(v: unknown, what: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new FsmError(`${what} must be true or false, got ${show(v)}`);
  return v;
}

function optStr(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new FsmError(`${what} must be text, got ${show(v)}`);
  return v;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function outputValue(v: unknown, what: string): OutputValue {
  if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return v;
  throw new FsmError(`${what} must be a number, text or true/false, got ${show(v)}`);
}

/** Sets an optional field, or removes it when the value is undefined (so JSON and the object agree). */
function put<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v === undefined) delete o[k];
  else o[k] = v;
}

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
  for (const k of ["clock", "reset"] as const)
    if (opts[k] != null && !isObject(opts[k])) throw new FsmError(`${k} must be an object like {"name": "${k === "clock" ? "clk" : "rst_n"}"}, got ${show(opts[k])}`);
  // Field by field, so that a field given as undefined or null keeps its default instead of erasing it.
  const reset = opts.reset ?? {};
  const d: FsmDiagram = {
    version: 1,
    name: opts.name ?? "fsm",
    type: opts.type ?? "moore",
    clock: { name: opts.clock?.name ?? DEFAULT_CLOCK.name },
    reset: {
      name: reset.name ?? DEFAULT_RESET.name,
      activeLow: optBool(reset.activeLow, "reset.activeLow") ?? DEFAULT_RESET.activeLow,
      async: optBool(reset.async, "reset.async") ?? DEFAULT_RESET.async,
    },
    inputs: [],
    outputs: [],
    states: [],
    transitions: [],
  };
  if (d.type !== "moore" && d.type !== "mealy") throw new FsmError(`type must be "moore" or "mealy"`);
  for (const n of [d.clock.name, d.reset.name]) if (!isIdent(n)) throw new FsmError(`Clock/reset name ${show(n)} must be a valid Verilog identifier`);
  if (!isIdent(d.name)) throw new FsmError(`Diagram name ${show(d.name)} must be a valid Verilog identifier`);
  for (const s of opts.inputs ?? []) addSignal(d, "inputs", s);
  for (const s of opts.outputs ?? []) addSignal(d, "outputs", s);
  return d;
}

function normSignal(s: SignalInput): Signal {
  if (typeof s !== "string" && !isObject(s)) throw new FsmError(`A signal must be a name or {"name": ..., "width": ...}, got ${show(s)}`);
  const sig: Signal = typeof s === "string" ? { name: s, width: 1 } : { name: s.name, width: s.width ?? 1 };
  if (!isIdent(sig.name)) throw new FsmError(`Signal name ${show(sig.name)} must be a valid Verilog identifier`);
  if (!Number.isInteger(sig.width) || sig.width < 1) throw new FsmError(`Signal "${sig.name}" width must be a positive integer`);
  if (typeof s !== "string" && s.default != null) sig.default = outputValue(s.default, `Signal "${sig.name}" default`);
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

/**
 * Output values for a state or transition, merged onto base (empty for a new one).
 * A value of null or undefined means "not driven here": it is left out, or
 * removed from base, so an update can take an output off again.
 */
function checkOutputs(d: FsmDiagram, outputs: Record<string, OutputValue> | undefined, base: Record<string, OutputValue> = {}): Record<string, OutputValue> {
  if (outputs != null && !isObject(outputs)) throw new FsmError(`Outputs must be an object like {"z": 1}, got ${show(outputs)}`);
  const out = { ...base };
  for (const [k, v] of Object.entries(outputs ?? {})) {
    if (!d.outputs.some((s) => s.name === k)) throw new FsmError(`Unknown output "${k}". Declare it first (outputs: ${d.outputs.map((s) => s.name).join(", ") || "none"})`);
    if (v == null) delete out[k];
    else out[k] = outputValue(v, `Output "${k}"`);
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
  if (!isIdent(s.name)) throw new FsmError(`State name ${show(s.name)} must be a valid Verilog identifier (letters, digits, _)`);
  if (d.states.some((x) => x.name === s.name)) throw new FsmError(`State "${s.name}" already exists`);
  const f = `State "${s.name}":`;
  const label = optStr(s.label, `${f} label`);
  const x = optNum(s.x, `${f} x`);
  const y = optNum(s.y, `${f} y`);
  const color = optStr(s.color, `${f} color`);
  const initialAngle = optNum(s.initialAngle, `${f} initialAngle`);
  const radius = optNum(s.radius, `${f} radius`, "positive");
  const fontSize = optNum(s.fontSize, `${f} fontSize`, "positive");
  const st: State = {
    id: uniqueId("s", new Set(d.states.map((x) => x.id))),
    name: s.name,
    ...(label !== undefined ? { label } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    isInitial: optBool(s.isInitial, `${f} isInitial`) ?? d.states.length === 0,
    isAccepting: optBool(s.isAccepting, `${f} isAccepting`) ?? false,
    outputs: checkOutputs(d, s.outputs),
    ...(color ? { color } : {}),
    ...(initialAngle !== undefined ? { initialAngle } : {}),
    ...(radius !== undefined ? { radius } : {}),
    ...(fontSize !== undefined ? { fontSize } : {}),
  };
  if (st.isInitial) for (const x of d.states) x.isInitial = false;
  d.states.push(st);
  return st;
}

export function updateState(d: FsmDiagram, ref: string, patch: Partial<Omit<StateInput, "label">> & { label?: string | null }): State {
  const st = findState(d, ref);
  if (patch.name !== undefined && patch.name !== st.name) {
    if (!isIdent(patch.name)) throw new FsmError(`State name ${show(patch.name)} must be a valid Verilog identifier`);
    if (d.states.some((x) => x.name === patch.name)) throw new FsmError(`State "${patch.name}" already exists`);
  }
  // Check every field before changing any, so a bad patch leaves the state as it was.
  // A field given as null is removed (its default applies again), as label always did.
  const f = `State "${st.name}":`;
  const has = (k: keyof typeof patch) => patch[k] !== undefined;
  const set: Partial<State> = {};
  if (has("label")) set.label = optStr(patch.label, `${f} label`);
  if (has("initialAngle")) set.initialAngle = optNum(patch.initialAngle, `${f} initialAngle`);
  if (has("radius")) set.radius = optNum(patch.radius, `${f} radius`, "positive");
  if (has("fontSize")) set.fontSize = optNum(patch.fontSize, `${f} fontSize`, "positive");
  if (has("x")) set.x = optNum(patch.x, `${f} x`);
  if (has("y")) set.y = optNum(patch.y, `${f} y`);
  if (has("color")) set.color = optStr(patch.color, `${f} color`) || undefined;
  const isAccepting = optBool(patch.isAccepting, `${f} isAccepting`);
  const isInitial = optBool(patch.isInitial, `${f} isInitial`);
  const outputs = has("outputs") ? checkOutputs(d, patch.outputs, st.outputs) : undefined;

  if (patch.name !== undefined) st.name = patch.name;
  for (const k of Object.keys(set) as (keyof typeof set)[]) put(st, k, set[k]);
  if (isAccepting !== undefined) st.isAccepting = isAccepting;
  if (outputs) st.outputs = outputs;
  if (isInitial) for (const x of d.states) x.isInitial = x === st;
  else if (isInitial === false) st.isInitial = false;
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

/** The optional numeric fields of a transition, checked; undefined where not given. */
function transitionNums(t: Partial<TransitionInput>, f: string) {
  return {
    curve: optNum(t.curve, `${f} curve`),
    priority: optNum(t.priority, `${f} priority`),
    loopAngle: optNum(t.loopAngle, `${f} loopAngle`),
    fontSize: optNum(t.fontSize, `${f} fontSize`, "positive"),
    gap: optNum(t.gap, `${f} gap`, "nonNegative"),
  };
}

export function addTransition(d: FsmDiagram, t: TransitionInput): Transition {
  const from = findState(d, t.from);
  const to = findState(d, t.to);
  const f = `Transition ${from.name} -> ${to.name}:`;
  const nums = transitionNums(t, f);
  const tr: Transition = {
    id: uniqueId("t", new Set(d.transitions.map((x) => x.id))),
    from: from.id,
    to: to.id,
    condition: (optStr(t.condition, `${f} condition`) ?? "").trim(),
    outputs: checkOutputs(d, t.outputs),
  };
  for (const k of Object.keys(nums) as (keyof typeof nums)[]) put(tr, k, nums[k]);
  d.transitions.push(tr);
  return tr;
}

export function updateTransition(d: FsmDiagram, id: string, patch: Partial<TransitionInput>): Transition {
  const tr = findTransition(d, id);
  // Check every field before changing any; a numeric field given as null is removed (back to automatic).
  const f = `Transition ${id}:`;
  const from = patch.from !== undefined ? findState(d, patch.from).id : undefined;
  const to = patch.to !== undefined ? findState(d, patch.to).id : undefined;
  const condition = patch.condition !== undefined ? (optStr(patch.condition, `${f} condition`) ?? "").trim() : undefined;
  const outputs = patch.outputs !== undefined ? checkOutputs(d, patch.outputs, tr.outputs) : undefined;
  const nums = transitionNums(patch, f);

  if (from !== undefined) tr.from = from;
  if (to !== undefined) tr.to = to;
  if (condition !== undefined) tr.condition = condition;
  if (outputs) tr.outputs = outputs;
  for (const k of Object.keys(nums) as (keyof typeof nums)[]) if (patch[k] !== undefined) put(tr, k, nums[k]);
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

/**
 * Whether a transition is always taken: no condition, or a literal 1 in any
 * Verilog spelling (1, 1'b1, 1'd1, 'b1, 2'b01, 4'h1, (1)).
 */
export function isUnconditional(t: Transition): boolean {
  let c = t.condition.replace(/\s+/g, "");
  while (c.startsWith("(") && c.endsWith(")")) c = c.slice(1, -1);
  return c === "" || /^(0*1|\d*'[sS]?([bBoOdDhH])0*1)$/.test(c);
}

/** Runs one entry's add, naming the entry (e.g. "states[2]") in any error it throws. */
function inEntry<T>(where: string, add: () => T): T {
  try {
    return add();
  } catch (e) {
    throw e instanceof FsmError ? new FsmError(`${where}: ${e.message}`) : e;
  }
}

/** Parse and sanity-check a diagram loaded from JSON. Anything malformed throws an FsmError that says what and where. */
export function parseDiagram(json: unknown): FsmDiagram {
  let raw = json;
  if (typeof json === "string") {
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new FsmError(`Not a diagram: the text is not valid JSON (${(e as Error).message})`);
    }
  }
  if (!isObject(raw)) throw new FsmError("Diagram JSON must be an object");
  // Saved diagrams have a version, agent-made ones at least states. Without either
  // it is some other JSON file ({}, a package.json), and opening it as an empty
  // diagram would let a later Save overwrite it.
  if (raw.version === undefined && raw.states === undefined) throw new FsmError(`Not an FSM Designer diagram: there is no "states" list`);
  // A newer format may mean fields this version would silently drop.
  if (raw.version !== undefined && raw.version !== 1)
    throw new FsmError(typeof raw.version === "number" && raw.version > 1
      ? `This diagram is version ${raw.version}, from a newer FSM Designer; this one reads version 1`
      : `Not an FSM Designer diagram (version ${show(raw.version)})`);
  const list = (k: "inputs" | "outputs" | "states" | "transitions"): unknown[] => {
    const v = raw[k];
    if (v == null) return [];
    if (!Array.isArray(v)) throw new FsmError(`"${k}" must be a list, got ${show(v)}`);
    return v;
  };
  const entry = <T>(k: string, i: number, x: unknown): T => {
    if (!isObject(x)) throw new FsmError(`${k}[${i}] must be an object, got ${show(x)}`);
    return x as T;
  };
  const r = raw as Partial<FsmDiagram>;
  const d = createDiagram({ name: r.name, type: r.type, clock: r.clock, reset: r.reset });
  for (const k of ["inputs", "outputs"] as const)
    for (const [i, s] of list(k).entries()) inEntry(`${k}[${i}]`, () => addSignal(d, k, s as SignalInput));
  const idMap = new Map<string, string>();
  const initial: string[] = [];
  for (const [i, x] of list("states").entries()) {
    const s = entry<State>("states", i, x);
    // addState makes the first state initial when none is marked; a file says so itself.
    const st = inEntry(`states[${i}]`, () => addState(d, { ...s, isInitial: s.isInitial ?? false }));
    if (s.id && !d.states.some((x) => x.id === s.id)) st.id = s.id;
    idMap.set(s.id ?? s.name, st.id);
    if (st.isInitial) initial.push(`"${st.name}"`);
  }
  // addState keeps only the last one, which would hide that the file is ambiguous.
  if (initial.length > 1) throw new FsmError(`States ${initial.join(", ")} are all marked initial; a machine has one initial (reset) state`);
  for (const [i, x] of list("transitions").entries()) {
    const t = entry<Transition>("transitions", i, x);
    const tr = inEntry(`transitions[${i}]`, () => addTransition(d, { ...t, from: idMap.get(t.from) ?? t.from, to: idMap.get(t.to) ?? t.to }));
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
  // Booleans as 1/0, as the drawing shows them (formatOutputs in metrics.ts).
  const outs = (o: Record<string, OutputValue>) => Object.entries(o).map(([k, v]) => `${k}=${typeof v === "boolean" ? Number(v) : v}`).join(", ");
  const lines = [
    `Diagram "${d.name}" (${d.type}), ${d.states.length} states, ${d.transitions.length} transitions`,
    `Inputs: ${d.inputs.map(sig).join(", ") || "none"}`,
    `Outputs: ${d.outputs.map(sig).join(", ") || "none"}`,
    `Clock: ${d.clock.name}, reset: ${d.reset.name} (${d.reset.activeLow ? "active-low" : "active-high"}, ${d.reset.async ? "async" : "sync"})`,
    "States:",
    ...d.states.map((s) =>
      `  ${s.id} ${s.name}${s.label !== undefined ? ` label ${JSON.stringify(s.label)}` : ""}${s.isInitial ? " [initial]" : ""}${s.isAccepting ? " [accepting]" : ""}${s.x !== undefined && s.y !== undefined ? ` @(${Math.round(s.x)},${Math.round(s.y)})` : ""}${Object.keys(s.outputs).length ? ` outputs: ${outs(s.outputs)}` : ""}`),
    "Transitions:",
    ...d.transitions.map((t) =>
      `  ${t.id} ${nm(t.from)} -> ${nm(t.to)} when ${t.condition || "(always)"}${t.priority !== undefined ? ` (priority ${t.priority})` : ""}${Object.keys(t.outputs).length ? ` / ${outs(t.outputs)}` : ""}`),
  ];
  return lines.join("\n");
}
