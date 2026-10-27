// MCP tool definitions. Every handler loads a diagram from the store, changes
// it with @fsm/core, and saves it back, so the store decides where the
// document actually lives.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { launchApp } from "./app.ts";
import type { AppOptions } from "./app.ts";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as core from "@fsm/core";
import type { FsmDiagram, Transition } from "@fsm/core";
import { checkName, MAX_NAME } from "./store.ts";
import { checkColor, decodeSource, exportTarget, pngScale, svgSize } from "./check.ts";
import type { DiagramStore } from "./store.ts";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
interface Result {
  [k: string]: unknown;
  content: Content[];
  isError?: boolean;
}

const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });

/** Run a handler, turning thrown errors into tool errors the agent can read and fix. */
function guard<A>(fn: (args: A) => Promise<Result>) {
  return async (args: A): Promise<Result> => {
    try {
      return await fn(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
    }
  };
}

/** Tool annotations: every tool works on the local workspace only (closed world) unless it says otherwise. */
const hints = (h: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }) => ({
  readOnlyHint: false,
  openWorldHint: false,
  ...h,
  ...(h.readOnlyHint ? {} : { destructiveHint: h.destructiveHint ?? false, idempotentHint: h.idempotentHint ?? false }),
});

// ---- shared schemas -------------------------------------------------------
// Factories, not shared instances: the JSON Schema generator turns a reused
// instance into a $ref, which then carries the first use's description.

const outputValue = () => z.union([z.number(), z.string(), z.boolean()]);
const outputsMap = (desc: string) => z.record(z.string(), outputValue()).describe(desc);
/** Outputs in an update: a value sets the output, null removes it. */
const outputsPatch = (desc: string) => z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).describe(desc);
const signal = () => z.union([
  z.string().describe("1-bit signal name"),
  z.object({
    name: z.string().describe("Verilog identifier"),
    width: z.number().int().min(1).max(1024).optional().describe("bits, default 1"),
    default: outputValue().optional().describe("outputs only: value when a state or transition does not set it, default 0"),
  }).strict(),
]);
const NAME_RULE = "letters, digits and _, starting with a letter or _, at most 64 characters";
const fsmName = () => z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, `use ${NAME_RULE}`).max(MAX_NAME).describe(`FSM name (${NAME_RULE}); also the file name <name>.fsm.json`);
const labelMode = () => z.enum(["all", "noLoops", "none"])
  .describe("which text to draw on lines: all (default), all but self loops' (noLoops), or none, which also hides the Moore outputs written in states");
const SIDES = ["left", "right", "above", "below", "above-left", "above-right", "below-left", "below-right"] as const;
const side = (desc: string) => z.enum(SIDES).describe(desc);
const stateRef = (desc = "state name or id") => z.string().describe(desc);

const POSITION = "centre of the circle in px, x to the right and y downward; give x and y together, or neither to place the state automatically";
const stateFields = () => ({
  name: z.string().describe("state name, a Verilog identifier, e.g. IDLE"),
  isInitial: z.boolean().optional().describe("the reset state (start arrow); exactly one state has it"),
  isAccepting: z.boolean().optional().describe("drawn as a double circle"),
  outputs: outputsMap("Moore outputs in this state, e.g. {\"z\": 1}; only declared outputs").optional(),
  label: z.string().optional().describe("text drawn instead of the name, e.g. \"S₀\" or \"β\"; the name stays the identifier"),
  x: z.number().min(-1e6).max(1e6).optional().describe(POSITION),
  y: z.number().min(-1e6).max(1e6).optional().describe(POSITION),
  color: z.string().optional().describe("fill colour: #rrggbb, rgb(...) or a CSS colour name, e.g. #dbeafe"),
  radius: z.number().min(10).max(200).optional().describe("circle radius in px; default 30, grown by create_fsm/auto_layout to fit long names and outputs"),
  fontSize: z.number().min(6).max(72).optional().describe("px for the name, default 15"),
  initialFrom: side("initial state only: side the start arrow comes from, default left").optional(),
});
const transitionFields = () => ({
  from: stateRef("source state name or id"),
  to: stateRef("target state name or id; the same as from for a self loop"),
  condition: z.string().optional().describe("Verilog boolean expression over the declared inputs, e.g. \"x && !y\" or \"cnt == 2'd3\"; empty or left out = always / otherwise"),
  outputs: outputsMap("Mealy outputs on this transition, e.g. {\"z\": 1}; only declared outputs").optional(),
  priority: z.number().min(-1e6).max(1e6).optional().describe("lower is checked first among transitions out of the same state; default is list order"),
  curve: z.number().min(-1000).max(1000).optional().describe("px the line bows out from straight, to the left of the travel direction (negative: to the right); 0 = straight; omit for automatic"),
  gap: z.number().min(0).max(200).optional().describe("when lines run both ways and both are straight: px between the two parallel lines, default 16 (at most 1.6 x the smaller radius is drawn)"),
  loopSide: side("self loops only: side of the state the loop sits on; omit to pick a free side").optional(),
  fontSize: z.number().min(6).max(72).optional().describe("px for the label, default 13"),
});
function stateFieldsExceptName() {
  const { name: _name, ...rest } = stateFields();
  return rest;
}
// Raw angles as stored in .fsm.json, so get_fsm's JSON can be passed back to create_fsm unchanged.
const initialAngle = () => z.number().min(-10).max(10).optional().describe("start arrow direction in radians, as in .fsm.json (initialFrom is easier)");
const loopAngle = () => z.number().min(-10).max(10).optional().describe("self-loop direction in radians, as in .fsm.json (loopSide is easier)");

const stateSpec = () => z.object({
  id: z.string().optional().describe("optional stable id (as in .fsm.json); transitions may refer to it; default: an id is assigned"),
  ...stateFields(),
  initialAngle: initialAngle(),
}).strict();
const transitionSpec = () => z.object({
  id: z.string().optional().describe("optional stable id; default: an id is assigned"),
  ...transitionFields(),
  loopAngle: loopAngle(),
}).strict();
const clockSpec = () => z.object({ name: z.string() }).strict();
const resetSpec = () => z.object({ name: z.string(), activeLow: z.boolean(), async: z.boolean() }).partial().strict();

// ---- spec -> core conversions ---------------------------------------------

/** Screen-coordinate angle (radians, y down) of a side; see State.initialAngle and Transition.loopAngle. */
const SIDE_ANGLE: Record<(typeof SIDES)[number], number> = {
  right: 0, "below-right": Math.PI / 4, below: Math.PI / 2, "below-left": (3 * Math.PI) / 4,
  left: Math.PI, "above-left": (-3 * Math.PI) / 4, above: -Math.PI / 2, "above-right": -Math.PI / 4,
};

interface StyleIn { initialFrom?: (typeof SIDES)[number]; initialAngle?: number; label?: string; color?: string; x?: number; y?: number }
interface LoopIn { loopSide?: (typeof SIDES)[number]; loopAngle?: number }

function stateInput<T extends StyleIn>({ initialFrom, initialAngle, label, ...s }: T) {
  if (s.color) checkColor("color", s.color);
  if ((s.x === undefined) !== (s.y === undefined)) throw new Error("Give x and y together (or neither, to place the state automatically)");
  const angle = initialFrom ? SIDE_ANGLE[initialFrom] : initialAngle;
  // An empty label would draw an empty circle; it means "no label", as in update_state.
  return { ...s, ...(label?.trim() ? { label } : {}), ...(angle !== undefined ? { initialAngle: angle } : {}) };
}
function transitionInput<T extends LoopIn>({ loopSide, loopAngle, ...t }: T) {
  const angle = loopSide ? SIDE_ANGLE[loopSide] : loopAngle;
  return { ...t, ...(angle !== undefined ? { loopAngle: angle } : {}) };
}

/** Split an outputs patch into values to set and names to remove. */
function splitOutputs(o: Record<string, core.OutputValue | null> | undefined) {
  if (!o) return { set: undefined, unset: [] as string[] };
  const set: Record<string, core.OutputValue> = {};
  const unset: string[] = [];
  for (const [k, v] of Object.entries(o)) if (v === null) unset.push(k); else set[k] = v;
  return { set, unset };
}

// ---- helpers --------------------------------------------------------------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stateName = (d: FsmDiagram, id: string) => d.states.find((s) => s.id === id)?.name ?? id;
const edgeText = (d: FsmDiagram, t: Transition) => `${t.id}: ${stateName(d, t.from)} -> ${stateName(d, t.to)} when ${t.condition || "(always)"}`;

function summary(d: FsmDiagram, ignore?: Set<string>): string {
  return `${core.describe(d)}\n\n${checks(d, ignore)}`;
}

/** Why a condition is not a Verilog expression, or undefined when it parses. The editor accepts any text, so this is only a warning. */
function conditionProblem(condition: string): string | undefined {
  if (!condition.trim()) return undefined;
  try {
    core.parseExpression(condition);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function conditionWarnings(d: FsmDiagram, ts: Transition[] = d.transitions): string[] {
  return ts.flatMap((t) => {
    const why = conditionProblem(t.condition);
    return why ? [`Transition ${t.id} (${stateName(d, t.from)} -> ${stateName(d, t.to)}): condition "${t.condition}" is not a valid Verilog expression (${why}); it will be drawn as written`] : [];
  });
}

/** Validation report. `ignore`: names that are known constants, not inputs (Verilog import). */
function checks(d: FsmDiagram, ignore?: Set<string>): string {
  const issues = core.validate(d).filter((i) => {
    const m = /uses "(\w+)", which is not a declared input/.exec(i.message);
    return !(m && ignore?.has(m[1]));
  });
  const lines = [
    ...issues.filter((i) => i.level === "error").map((i) => `ERROR ${i.message}`),
    ...issues.filter((i) => i.level === "warning").map((i) => `warning ${i.message}`),
    ...conditionWarnings(d).map((w) => `warning ${w}`),
  ];
  return lines.length ? `Validation:\n${lines.map((l) => `  ${l}`).join("\n")}` : "Validation: OK";
}

/**
 * Load, change and save one diagram; the store's lock keeps concurrent calls from
 * losing each other's edits. The result is re-parsed before saving, so an edit
 * that would leave a file the server cannot load again fails instead.
 */
async function mutate(store: DiagramStore, name: string, fn: (d: FsmDiagram) => Promise<string> | string): Promise<Result> {
  return store.lock(name, async () => {
    const d = await store.load(name);
    const msg = await fn(d);
    core.parseDiagram(JSON.parse(JSON.stringify(d)));
    await store.save(d);
    return text(msg);
  });
}

const placed = (s: core.State) => s.x !== undefined && s.y !== undefined;
const hasLayout = (d: FsmDiagram) => d.states.every(placed);
/** Largest PNG returned as inline image content (base64 adds a third; hosts reject multi-megabyte messages). */
const MAX_INLINE_PNG = 2_000_000;
const LAYOUT_HINT = "It has no position yet: export_fsm places unplaced states automatically, or call auto_layout to re-arrange the whole diagram once you have finished adding states.";
const NO_INITIAL = " Note: there is no initial (reset) state now; set one with update_state isInitial: true.";

/**
 * When a state is given a name that is another state's id ("s0"), give that
 * other state a new id, so the name means one state only (core does the same
 * when it loads a file). Returns a note for the reply, or "".
 */
function freeName(d: FsmDiagram, name: string): string {
  const other = d.states.find((s) => s.id === name && s.name !== name);
  if (!other) return "";
  const healed = core.parseDiagram(JSON.parse(JSON.stringify(d)));
  Object.assign(d, healed);
  const now = d.states.find((s) => s.name === other.name)!;
  return ` State ${other.name} had the id ${name}; its id is now ${now.id}.`;
}

/** A condition note for the reply of add_transition/update_transition, or "". */
function conditionNote(d: FsmDiagram, t: Transition): string {
  const w = conditionWarnings(d, [t]);
  return w.length ? ` Note: ${w[0]}.` : "";
}

/** Read a Verilog file with an error an agent can act on. */
async function readSource(file: string): Promise<string> {
  let s;
  try {
    s = await stat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`File not found: ${file} (relative paths are resolved inside the workspace folder; give an absolute path or pass the source as code)`);
    throw e;
  }
  if (s.isDirectory()) throw new Error(`${file} is a folder, not a Verilog file`);
  return decodeSource(await readFile(file));
}

/** A name that differs only in case from an existing diagram is the same file on Windows and macOS. */
async function checkNewName(store: DiagramStore, name: string): Promise<void> {
  checkName(name);
  const clash = (await store.list()).find((n) => n !== name && n.toLowerCase() === name.toLowerCase());
  if (clash) throw new Error(`"${name}" differs from the existing FSM "${clash}" only in case; on Windows and macOS that is the same file. Pick another name`);
}

/** Render a PNG no larger than the caps in check.ts; says so when the scale was lowered. */
async function png(d: FsmDiagram, opts: core.PngOptions & { scale: number }): Promise<{ data: Buffer; info: string }> {
  const { w, h } = svgSize(core.renderSvg(d, opts));
  const fit = pngScale(w, h, opts.scale);
  if (opts.background !== undefined) checkColor("background", opts.background, true);
  let data: Buffer;
  try {
    data = await core.renderPng(d, { ...opts, scale: fit.scale });
  } catch (e) {
    throw new Error(`PNG rendering failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const info = `${fit.width}x${fit.height} px at scale ${fit.scale}${fit.clamped ? ` (lowered from ${opts.scale} to keep the image under 40 megapixels)` : ""}`;
  return { data, info };
}

/** Run a layout and describe it for a reply. */
function layoutNote(r: core.TidyResult | undefined): string {
  if (!r) return "";
  return `Layout: ${r.arrangement}.${r.issues.length ? ` Could not fix: ${core.describeLayoutIssues(r.issues)}.` : ""}`;
}

// ---- registration -----------------------------------------------------------

export function registerTools(server: McpServer, store: DiagramStore, app: AppOptions = {}): void {
  server.registerTool(
    "create_fsm",
    {
      title: "Create FSM",
      description:
        "Create (or replace) a whole FSM state diagram in one call. This is the preferred way to build a diagram: " +
        "give the states and transitions, and the server validates it, lays it out automatically (states without x/y), and saves it as <name>.fsm.json in the workspace. " +
        "Declare every signal in inputs/outputs first: conditions may only use inputs, and outputs may only be set for declared outputs; " +
        "do not list the clock or reset there. Moore machines put outputs on states; Mealy machines put outputs on transitions. " +
        "Exactly one state is the initial (reset) state. Unknown fields are errors, so a typo is reported rather than ignored. " +
        "The JSON from get_fsm (json: true) can be passed back unchanged. " +
        "Then use export_fsm to get PNG/SVG/LaTeX. To draw an FSM that already exists as Verilog code, use import_verilog instead.",
      inputSchema: z.object({
        name: fsmName(),
        type: z.enum(["moore", "mealy"]).default("moore").describe("moore: outputs depend on the state only (set them on states); mealy: outputs depend on state and inputs (set them on transitions)"),
        inputs: z.array(signal()).default([]).describe("input ports, e.g. [\"x\", {\"name\":\"cnt\",\"width\":2}]"),
        outputs: z.array(signal()).default([]).describe("output ports, e.g. [\"z\", {\"name\":\"led\",\"width\":3,\"default\":0}]"),
        states: z.array(stateSpec()).min(1).max(1000).describe("at least one state; the first one is the initial state unless another has isInitial: true"),
        transitions: z.array(transitionSpec()).max(5000).default([]).describe("from/to are state names (or ids) from `states`"),
        clock: clockSpec().optional().describe("default {\"name\":\"clk\"}"),
        reset: resetSpec().optional().describe("default {\"name\":\"rst_n\",\"activeLow\":true,\"async\":true}"),
        layout: z.boolean().optional().describe("true: auto layout every state, ignoring given x/y; default: only place states given without positions"),
        overwrite: z.boolean().default(false).describe("replace an existing FSM with the same name (otherwise an existing name is an error)"),
        version: z.literal(1).optional().describe("ignored; accepted so .fsm.json content can be passed as is"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async (a) => {
      await checkNewName(store, a.name);
      const states = a.states.map(stateInput);
      const initial = states.filter((s) => s.isInitial);
      if (initial.length > 1) throw new Error(`Only one state can be the initial state; isInitial is set on ${initial.map((s) => s.name).join(", ")}`);
      const notes: string[] = [];
      if (!initial.length) {
        const pick = states.find((s) => s.isInitial !== false);
        if (!pick) throw new Error("Every state has isInitial: false; mark the reset state with isInitial: true");
        pick.isInitial = true;
        if (pick !== states[0] || a.states[0].isInitial === false) notes.push(`${pick.name} is the initial state (the first state not marked isInitial: false).`);
      }
      const d = core.parseDiagram({
        name: a.name, type: a.type, inputs: a.inputs, outputs: a.outputs, clock: a.clock, reset: a.reset,
        states, transitions: a.transitions.map(transitionInput),
      } as unknown);
      // Layout re-routes every arc and may move the start arrow; keep what the caller asked for.
      const asked = d.transitions.map((t) => ({ curve: t.curve, loopAngle: t.loopAngle }));
      const askedStart = d.states.map((s) => s.initialAngle);
      core.fitStateSizes(d);
      const r = a.layout || !d.states.some(placed) ? await core.autoLayout(d) : (await core.ensureLayout(d), undefined);
      d.transitions.forEach((t, i) => {
        if (asked[i].curve !== undefined) t.curve = asked[i].curve;
        if (asked[i].loopAngle !== undefined) t.loopAngle = asked[i].loopAngle;
      });
      d.states.forEach((s, i) => { if (askedStart[i] !== undefined) s.initialAngle = askedStart[i]; });
      const verb = await store.lock(a.name, async () => {
        const existed = await store.exists(a.name);
        if (existed && !a.overwrite)
          throw new Error(`An FSM named "${a.name}" already exists. Pass overwrite: true to replace it, or edit it with add_state/add_transition.`);
        await store.save(d);
        return existed ? "Replaced" : "Created";
      });
      if (verb === "Created") server.sendResourceListChanged();
      const layout = layoutNote(r);
      return text(`${verb} "${d.name}" (${store.fileOf?.(d.name) ?? store.location}).${layout ? ` ${layout}` : ""}${notes.length ? ` ${notes.join(" ")}` : ""}\n\n${summary(d)}`);
    }),
  );

  server.registerTool(
    "list_fsms",
    { title: "List FSMs", description: "List the FSM diagrams in the workspace folder with their type and size.", inputSchema: z.object({}).strict(), annotations: hints({ readOnlyHint: true }) },
    guard(async () => {
      const names = await store.list();
      const skipped = (await store.ignored?.()) ?? [];
      const note = skipped.length
        ? `\nIgnored (not usable as FSM files: folders, or names that are not ${NAME_RULE}): ${skipped.join(", ")}.`
        : "";
      if (!names.length) return text(`No FSMs yet in ${store.location}. Create one with create_fsm.${note}`);
      const rows = await Promise.all(names.map(async (n) => {
        try {
          const d = await store.load(n);
          return `${n} (${d.type}, ${plural(d.states.length, "state")}, ${plural(d.transitions.length, "transition")})`;
        } catch (e) {
          return `${n} (unreadable: ${(e as Error).message})`;
        }
      }));
      return text(`FSMs in ${store.location}:\n${rows.map((r) => `  ${r}`).join("\n")}${note}`);
    }),
  );

  server.registerTool(
    "get_fsm",
    {
      title: "Get FSM",
      description: "Read an FSM: a readable summary (state ids and names, transition ids, signals) with validation results, and optionally the full .fsm.json. " +
        "Use the ids it lists for update_transition/remove_transition.",
      inputSchema: z.object({ name: fsmName(), json: z.boolean().default(false).describe("also return the raw .fsm.json (can be passed back to create_fsm)") }).strict(),
      annotations: hints({ readOnlyHint: true }),
    },
    guard(async ({ name, json }) => {
      const d = await store.load(name);
      return text(summary(d) + (json ? `\n\n${JSON.stringify(d, null, 2)}` : ""));
    }),
  );

  server.registerTool(
    "delete_fsm",
    { title: "Delete FSM", description: "Delete an FSM diagram file from the workspace. This cannot be undone.", inputSchema: z.object({ name: fsmName() }).strict(), annotations: hints({ destructiveHint: true, idempotentHint: false }) },
    guard(async ({ name }) =>
      store.lock(name, async () => {
        // exists(), not load(): a corrupt file must still be deletable.
        if (!(await store.exists(name))) throw new Error(`No FSM named "${name}". Existing: ${(await store.list()).join(", ") || "(none)"}.`);
        await store.remove(name);
        return text(`Deleted "${name}".`);
      }).then((r) => {
        server.sendResourceListChanged();
        return r;
      }),
    ),
  );

  server.registerTool(
    "set_signals",
    {
      title: "Set machine signals and type",
      description:
        "Change machine-level settings: Moore/Mealy type, input and output ports, clock and reset. Fields left out are kept. " +
        "An inputs/outputs list given here replaces the whole existing list (so include the signals you want to keep; a signal may move between the lists); " +
        "outputs removed here are also removed from every state and transition. Changing the type does not move outputs between states and transitions.",
      inputSchema: z.object({
        name: fsmName(),
        type: z.enum(["moore", "mealy"]).optional(),
        inputs: z.array(signal()).optional().describe("the complete new list of input ports"),
        outputs: z.array(signal()).optional().describe("the complete new list of output ports"),
        clock: clockSpec().optional().describe("e.g. {\"name\":\"clk\"}"),
        reset: resetSpec().optional().describe("e.g. {\"name\":\"rst\",\"activeLow\":false,\"async\":false}; fields left out are kept"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async (a) =>
      mutate(store, a.name, (d) => {
        const notes: string[] = [];
        if (a.type && a.type !== d.type) {
          d.type = a.type;
          const stranded = a.type === "moore"
            ? d.transitions.filter((t) => Object.keys(t.outputs).length).length
            : d.states.filter((s) => Object.keys(s.outputs).length).length;
          if (stranded) notes.push(a.type === "moore"
            ? `${plural(stranded, "transition")} still carry Mealy outputs, which a Moore machine does not draw; move them to states with update_state.`
            : `${plural(stranded, "state")} still carry outputs; on a Mealy machine they are drawn in the state, and you may want them on transitions instead.`);
        }
        if (a.clock) d.clock = { ...d.clock, ...a.clock };
        if (a.reset) d.reset = { ...d.reset, ...a.reset };
        const names = (l: core.SignalInput[]) => new Set(l.map((s) => (typeof s === "string" ? s : s.name)));
        const ins: core.SignalInput[] = a.inputs ?? [...d.inputs];
        const outs: core.SignalInput[] = a.outputs ?? [...d.outputs];
        // Outputs that stop being outputs (removed, or moved to inputs) are cleared from states and transitions.
        const keepOut = names(outs);
        for (const s of [...d.outputs]) if (!keepOut.has(s.name)) core.removeSignal(d, s.name);
        d.inputs = [];
        d.outputs = [];
        for (const s of ins) core.addSignal(d, "inputs", s);
        for (const s of outs) core.addSignal(d, "outputs", s);
        return `Updated "${d.name}".${notes.length ? ` ${notes.join(" ")}` : ""}\n\n${summary(d)}`;
      }),
    ),
  );

  server.registerTool(
    "add_state",
    {
      title: "Add state",
      description: `Add one state to an existing FSM (to build a whole machine, create_fsm is simpler). Without x/y the state has no position yet: export_fsm places it, or call auto_layout when you have finished adding states.`,
      inputSchema: z.object({ fsm: fsmName(), ...stateFields() }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async ({ fsm, ...s }) =>
      mutate(store, fsm, (d) => {
        const before = d.states.find((x) => x.isInitial);
        const st = core.addState(d, stateInput(s));
        const moved = freeName(d, st.name);
        const was = st.isInitial && before && before.id !== st.id ? ` (was ${before.name})` : "";
        return `Added state ${st.name} (id ${st.id})${st.isInitial ? ` as the initial state${was}` : ""}. ${plural(d.states.length, "state")} now.${moved}${placed(st) ? "" : ` ${LAYOUT_HINT}`}`;
      }),
    ),
  );

  server.registerTool(
    "update_state",
    {
      title: "Update state",
      description: "Rename a state or change its label, outputs, flags, colour, size, font size, start-arrow side or position. Fields left out are kept. " +
        "Outputs are merged into the existing ones; give an output the value null to remove it from this state. " +
        "Pass label \"\" to draw the name again, color \"\" for the default fill, and null for radius, fontSize or initialFrom to go back to the default. " +
        "isInitial: true moves the start arrow to this state.",
      inputSchema: z.object({
        fsm: fsmName(),
        state: stateRef(),
        newName: z.string().optional().describe("new state name, a Verilog identifier"),
        ...stateFieldsExceptName(),
        outputs: outputsPatch("Moore outputs to set, e.g. {\"z\": 1}; null removes one, e.g. {\"z\": null}").optional(),
        radius: z.number().min(10).max(200).nullable().optional().describe("circle radius in px; null = default"),
        fontSize: z.number().min(6).max(72).nullable().optional().describe("px for the name; null = default"),
        initialFrom: side("initial state only: side the start arrow comes from; null = default (left)").nullable().optional(),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async ({ fsm, state, newName, outputs, radius, fontSize, initialFrom, ...patch }) =>
      mutate(store, fsm, (d) => {
        const st0 = core.findState(d, state);
        if (patch.x !== undefined || patch.y !== undefined) {
          const x = patch.x ?? st0.x, y = patch.y ?? st0.y;
          if (x === undefined || y === undefined) throw new Error("This state has no position yet; give x and y together");
          patch.x = x;
          patch.y = y;
        }
        if (patch.color) checkColor("color", patch.color);
        const { set, unset } = splitOutputs(outputs);
        const st = core.updateState(d, st0.id, {
          ...patch,
          ...(patch.label !== undefined ? { label: patch.label.trim() === "" ? null : patch.label } : {}),
          ...(set ? { outputs: set } : {}),
          ...(radius != null ? { radius } : {}),
          ...(fontSize != null ? { fontSize } : {}),
          ...(initialFrom ? { initialAngle: SIDE_ANGLE[initialFrom] } : {}),
          ...(newName ? { name: newName } : {}),
        });
        for (const k of unset) {
          if (!d.outputs.some((o) => o.name === k)) throw new Error(`Unknown output "${k}"`);
          delete st.outputs[k];
        }
        if (radius === null) delete st.radius;
        if (fontSize === null) delete st.fontSize;
        if (initialFrom === null) delete st.initialAngle;
        const none = d.states.length && !d.states.some((s) => s.isInitial) ? NO_INITIAL : "";
        const moved = newName ? freeName(d, st.name) : "";
        return `Updated state ${st.name} (id ${st.id}).${moved}${none}`;
      }),
    ),
  );

  server.registerTool(
    "remove_state",
    {
      title: "Remove state",
      description: "Remove a state and every transition into or out of it.",
      inputSchema: z.object({ fsm: fsmName(), state: stateRef() }).strict(),
      annotations: hints({ destructiveHint: true }),
    },
    guard(async ({ fsm, state }) =>
      mutate(store, fsm, (d) => {
        const st = core.findState(d, state);
        const n = core.removeState(d, st.id);
        return `Removed state ${st.name} (id ${st.id}) and ${plural(n, "transition")}.${d.states.length && !d.states.some((s) => s.isInitial) ? NO_INITIAL : ""}`;
      }),
    ),
  );

  server.registerTool(
    "add_transition",
    {
      title: "Add transition",
      description:
        "Add a transition between two states (a self loop if from == to). The condition is a Verilog boolean expression over the inputs. " +
        "Transitions out of a state are checked in priority order, then list order; an empty condition means 'otherwise' and should come last. " +
        "Adding the same from/to/condition twice creates a duplicate; use update_transition to change an existing one.",
      inputSchema: z.object({ fsm: fsmName(), ...transitionFields() }).strict(),
      annotations: hints({ destructiveHint: false, idempotentHint: false }),
    },
    guard(async ({ fsm, ...t }) =>
      mutate(store, fsm, (d) => {
        const tr = core.addTransition(d, transitionInput(t));
        return `Added transition ${edgeText(d, tr)}.${conditionNote(d, tr)}`;
      }),
    ),
  );

  server.registerTool(
    "update_transition",
    {
      title: "Update transition",
      description: "Change a transition's endpoints, condition, outputs, priority, curve, parallel-line gap, loop side or font size. Fields left out are kept. " +
        "Outputs are merged; give an output the value null to remove it. Pass null for priority, curve, gap, loopSide or fontSize to go back to automatic/default. " +
        "Find ids with get_fsm. To make the lines between two states straight or curved, set_line_style is simpler.",
      inputSchema: z.object({
        fsm: fsmName(),
        id: z.string().describe("transition id, e.g. t3 (get_fsm lists them)"),
        ...transitionFields(),
        from: stateRef("new source state name or id").optional(),
        to: stateRef("new target state name or id").optional(),
        outputs: outputsPatch("Mealy outputs to set, e.g. {\"z\": 1}; null removes one").optional(),
        priority: z.number().min(-1e6).max(1e6).nullable().optional().describe("lower is checked first; null = list order"),
        curve: z.number().min(-1000).max(1000).nullable().optional().describe("px the line bows out to the left of travel (negative: right); 0 = straight; null = automatic"),
        gap: z.number().min(0).max(200).nullable().optional().describe("px between parallel straight lines; null = default 16"),
        loopSide: side("self loops only: side the loop sits on; null = pick a free side").nullable().optional(),
        fontSize: z.number().min(6).max(72).nullable().optional().describe("px for the label; null = default"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async ({ fsm, id, outputs, priority, curve, gap, loopSide, fontSize, ...patch }) =>
      mutate(store, fsm, (d) => {
        const { set, unset } = splitOutputs(outputs);
        const tr = core.updateTransition(d, id, {
          ...patch,
          ...(set ? { outputs: set } : {}),
          ...(priority != null ? { priority } : {}),
          ...(curve != null ? { curve } : {}),
          ...(gap != null ? { gap } : {}),
          ...(loopSide ? { loopAngle: SIDE_ANGLE[loopSide] } : {}),
          ...(fontSize != null ? { fontSize } : {}),
        });
        for (const k of unset) {
          if (!d.outputs.some((o) => o.name === k)) throw new Error(`Unknown output "${k}"`);
          delete tr.outputs[k];
        }
        if (priority === null) delete tr.priority;
        if (curve === null) delete tr.curve;
        if (gap === null) delete tr.gap;
        if (loopSide === null) delete tr.loopAngle;
        if (fontSize === null) delete tr.fontSize;
        return `Updated transition ${edgeText(d, tr)}.${conditionNote(d, tr)}`;
      }),
    ),
  );

  server.registerTool(
    "remove_transition",
    {
      title: "Remove transition",
      description: "Remove a transition by id (get_fsm lists the ids).",
      inputSchema: z.object({ fsm: fsmName(), id: z.string().describe("transition id, e.g. t3") }).strict(),
      annotations: hints({ destructiveHint: true }),
    },
    guard(async ({ fsm, id }) =>
      mutate(store, fsm, (d) => {
        const tr = core.findTransition(d, id);
        const what = edgeText(d, tr);
        core.removeTransition(d, id);
        return `Removed transition ${what}.`;
      }),
    ),
  );

  server.registerTool(
    "validate_fsm",
    {
      title: "Validate FSM",
      description: "Check an FSM for errors (no states, no reset state, more than one unconditional transition from a state) and warnings " +
        "(unreachable states, duplicate conditions, conditions that use undeclared inputs or are not Verilog expressions, Moore outputs left unset, outputs on the wrong side for the machine type).",
      inputSchema: z.object({ name: fsmName() }).strict(),
      annotations: hints({ readOnlyHint: true }),
    },
    guard(async ({ name }) => text(checks(await store.load(name)))),
  );

  server.registerTool(
    "auto_layout",
    {
      title: "Auto layout",
      description:
        "Reposition all states automatically, like the editor's Auto Layout button (one rule, no options): islands are laid out " +
        "separately and packed; each is tried as a near-square grid and as left-to-right and top-to-bottom layers from the reset state, " +
        "and the best by one score wins (crossings first); three states all linked to each other become an equilateral triangle; " +
        "states snap to a 20 px grid and arcs and self-loop sides are set. The reply names the arrangement and anything it could not fix. " +
        "Clears manual curves, parallel-line gaps and loop sides so arcs are re-routed. Export png afterwards to check the result.",
      inputSchema: z.object({
        name: fsmName(),
        spacing: z.number().min(20).max(400).optional().describe("px between states, default 90 (the layout may spread states further to make room for labels)"),
        labels: labelMode().optional().describe("lay out for text drawn this way (match what you will export); default all"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async ({ name, spacing, labels }) =>
      mutate(store, name, async (d) => {
        for (const t of d.transitions) delete t.gap;
        core.fitStateSizes(d);
        const r = await core.autoLayout(d, { spacing, draw: labels ? { labels } : undefined });
        const left = r?.issues.length ? ` Could not fix: ${core.describeLayoutIssues(r.issues)}.` : "";
        return `Laid out ${plural(d.states.length, "state")} (${r?.arrangement ?? "empty"}).${left}\n\n${core.describe(d)}`;
      }),
    ),
  );

  server.registerTool(
    "set_line_style",
    {
      title: "Set line style",
      description:
        "Make the lines between two states straight or curved, as in the editor. 'straight' draws both directions as straight lines; " +
        "when lines run both ways they are drawn side by side, `gap` px apart (default 16). 'curved' bows them apart with the automatic bend " +
        "(or `curve` px). 'auto' goes back to automatic routing. Applies to every transition from→to and to→from. Both states need a position.",
      inputSchema: z.object({
        fsm: fsmName(),
        from: stateRef(),
        to: stateRef("the other state, name or id"),
        style: z.enum(["straight", "curved", "auto"]),
        gap: z.number().min(0).max(200).optional().describe("straight only: px between the two parallel lines (at most 1.6 x the smaller radius is drawn)"),
        curve: z.number().min(5).max(400).optional().describe("curved only: px the arcs bow out; default automatic"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async ({ fsm, from, to, style, gap, curve }) =>
      mutate(store, fsm, (d) => {
        const a = core.findState(d, from), b = core.findState(d, to);
        if (a === b) throw new Error("from and to are the same state; use update_transition with loopSide for self loops");
        const ts = d.transitions.filter((t) => (t.from === a.id && t.to === b.id) || (t.from === b.id && t.to === a.id));
        if (!ts.length) throw new Error(`No transitions between ${a.name} and ${b.name}`);
        if (!placed(a) || !placed(b)) throw new Error(`${[a, b].filter((s) => !placed(s)).map((s) => s.name).join(" and ")} has no position yet; call auto_layout (or export_fsm, which places new states) first`);
        const notes: string[] = [];
        if (gap !== undefined && style !== "straight") notes.push(`gap applies to straight lines only and was ignored.`);
        if (curve !== undefined && style !== "curved") notes.push(`curve applies to curved lines only and was ignored.`);
        for (const t of ts) {
          delete t.curve;
          if (style !== "straight") delete t.gap;
          if (style === "straight") {
            t.curve = 0;
            if (gap !== undefined) t.gap = gap;
          }
        }
        if (style === "straight" && gap !== undefined) {
          const most = Math.round(1.6 * Math.min(core.stateRadius(d, a), core.stateRadius(d, b)));
          if (gap > most) notes.push(`The lines are drawn at most ${most} px apart for states this size.`);
        }
        if (style === "curved") {
          // Each direction bows to its own left, so the same value separates a two-way pair.
          let bend = curve;
          if (bend === undefined) {
            const plan = core.planDiagram(d);
            const auto = plan.edges.find((e) => ts.includes(e.transitions[0]) && e.curve !== 0)?.curve;
            bend = auto || Math.round(Math.max(30, Math.hypot(b.x! - a.x!, b.y! - a.y!) * 0.2));
          }
          for (const t of ts) t.curve = bend;
        }
        return `Lines between ${a.name} and ${b.name} (${plural(ts.length, "transition")}) are now ${style}.${notes.length ? ` ${notes.join(" ")}` : ""}`;
      }),
    ),
  );

  server.registerTool(
    "import_verilog",
    {
      title: "Import Verilog",
      description:
        "Draw the state diagram of an FSM written in Verilog or SystemVerilog. The code is analysed, not guessed: the state register, " +
        "reset state, every transition with its condition, and the outputs are extracted by executing the logic symbolically for each state. " +
        "Outputs that depend on the state only are drawn in the states (Moore); outputs that also depend on inputs go on the transitions " +
        "(Mealy). Handles one, two or three always blocks, parameter/localparam/`define/enum state codes, case/casez/if-else, one-hot and " +
        "SystemVerilog always_ff/always_comb. The diagram is laid out, saved under `name` (default: the module name) and returned as PNG. " +
        "Saving over an existing FSM of that name needs overwrite: true.",
      inputSchema: z.object({
        code: z.string().optional().describe("the Verilog source; give this or path, not both"),
        path: z.string().optional().describe("a .v/.sv file to read (relative paths are inside the workspace folder; absolute paths are read as given); UTF-8 or UTF-16 with BOM"),
        name: fsmName().optional().describe(`FSM name to save as (${NAME_RULE}); default the module name`),
        module: z.string().optional().describe("module to import when the file has several"),
        stateVar: z.string().optional().describe("state register name, if detection picks the wrong one or the module has several FSMs (the report lists the others)"),
        selfLoops: z.boolean().default(true).describe("draw transitions that stay in the same state (false leaves them out, except loops that set Mealy outputs)"),
        overwrite: z.boolean().default(false).describe("replace an existing FSM with the same name"),
        png: z.boolean().default(true).describe("also return the drawing as a PNG image"),
        scale: z.number().min(0.5).max(8).default(2).describe("pixel density of that PNG"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async (a) => {
      const hasCode = a.code !== undefined && a.code.trim() !== "";
      if (hasCode && a.path) throw new Error("Give either code or path, not both");
      if (!hasCode && !a.path) throw new Error("Give the Verilog source as code, or a file path");
      if (a.name) checkName(a.name);
      const src = hasCode ? a.code! : await readSource(store.resolvePath(a.path!));
      const r = await core.importVerilogLaidOut(src, { module: a.module, stateVar: a.stateVar, selfLoops: a.selfLoops });
      const d = r.diagram;
      if (a.name) d.name = a.name;
      await checkNewName(store, d.name);
      const verb = await store.lock(d.name, async () => {
        const existed = await store.exists(d.name);
        if (existed && !a.overwrite)
          throw new Error(`An FSM named "${d.name}" already exists. Pass overwrite: true to replace it, or name: "<other name>" to keep both.`);
        await store.save(d);
        return existed ? "replaced" : "saved";
      });
      if (verb === "saved") server.sendResourceListChanged();
      const constants = Object.entries(r.constants ?? {});
      const defaults = d.outputs.filter((o) => o.default !== undefined);
      const report = [
        `Imported module ${r.module} as "${d.name}" (${verb} ${store.fileOf?.(d.name) ?? `in ${store.location}`}): ${r.machine === "mealy" ? "Mealy" : "Moore"} machine (${r.style}).`,
        `State register: ${r.stateVar}${r.nextVar ? `, next state: ${r.nextVar}` : ""}. Codes: ${Object.entries(r.stateCodes).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
        `Moore outputs (in states): ${r.mooreOutputs.join(", ") || "none"}. Mealy outputs (on transitions): ${r.mealyOutputs.join(", ") || "none"}.`,
        ...(defaults.length ? [`Output defaults (values left out of the states): ${defaults.map((o) => `${o.name}=${o.default}`).join(", ")}.`] : []),
        ...(constants.length ? [`Constants in conditions/outputs: ${constants.map(([k, v]) => `${k}=${v}`).join(", ")}.`] : []),
        ...(r.warnings.length ? ["Warnings:", ...r.warnings.map((w) => `  ${w}`)] : []),
      ].join("\n");
      const content: Content[] = [{ type: "text", text: `${report}\n\n${summary(d, new Set(constants.map(([k]) => k)))}` }];
      if (a.png) {
        const img = await png(d, { scale: a.scale });
        if (img.data.length <= MAX_INLINE_PNG) content.push({ type: "image", data: img.data.toString("base64"), mimeType: "image/png" });
        else content.push({ type: "text", text: `The PNG (${img.info}, ${img.data.length} bytes) is too large to return; use export_fsm with a smaller scale or a path.` });
      }
      return { content };
    }),
  );

  server.registerTool(
    "export_fsm",
    {
      title: "Export FSM",
      description:
        "Export a diagram. Formats: png (also returned as an image so you can look at it), svg, latex (TikZ, compiles with pdflatex), " +
        "json (.fsm.json, opens in the FSM Designer app). Text formats are returned as text; give `path` to write a file instead (inline: true returns both) " +
        "(relative paths are inside the workspace folder, absolute paths and ~ are used as given, a folder gets <name>.<ext>; " +
        "the workspace's own .fsm.json files are never overwritten). " +
        "`labels: \"none\"` hides the text on the lines and the outputs in states, like the editor's label switch. " +
        "States without a position are placed first and that layout is saved. Very large PNGs are rendered at a lower scale.",
      inputSchema: z.object({
        name: fsmName(),
        format: z.enum(["png", "svg", "latex", "json"]),
        path: z.string().optional().describe("file to write, e.g. out/seq.png (folders are created)"),
        scale: z.number().min(0.5).max(8).default(2).describe("png only: pixel density (2 = 2 px per diagram px)"),
        background: z.string().optional().describe("svg/png: #rrggbb, rgb(...), a CSS colour name, or \"none\" for transparent; default white"),
        standalone: z.boolean().default(true).describe("latex only: full document (true) or just the tikzpicture (false)"),
        labels: labelMode().optional(),
        elseLabels: z.boolean().default(true).describe("write 'else' on an unconditional transition that has siblings (false draws it blank)"),
        inline: z.boolean().optional().describe("svg/latex/json with path: also return the text (default: only when no path is given)"),
      }).strict(),
      annotations: hints({ destructiveHint: true, idempotentHint: true }),
    },
    guard(async (a) => {
      if (a.background !== undefined) checkColor("background", a.background, true);
      const target = a.path ? await exportTarget(store.location, a.path, a.format, a.name) : undefined;
      let placedNote = "";
      // Read without the lock, so a read-only workspace can still export; lock only to save a new layout.
      let d = await store.load(a.name);
      if (a.format !== "json" && !hasLayout(d)) {
        try {
          d = await store.lock(a.name, async () => {
            const fresh = await store.load(a.name);
            const missing = fresh.states.filter((s) => !placed(s)).map((s) => s.name);
            if (missing.length) {
              await core.ensureLayout(fresh);
              await store.save(fresh);
              placedNote = `Placed ${missing.join(", ")}, which had no position, and saved the layout. `;
            }
            return fresh;
          });
        } catch (e) {
          const missing = d.states.filter((s) => !placed(s)).map((s) => s.name);
          await core.ensureLayout(d);
          placedNote = `Placed ${missing.join(", ")}, which had no position, for this export only: the layout could not be saved (${(e as Error).message}). `;
        }
      }
      let body: string | Buffer;
      let info = "";
      const draw = { labels: a.labels, elseLabels: a.elseLabels };
      switch (a.format) {
        case "png": {
          const img = await png(d, { ...draw, scale: a.scale, background: a.background });
          body = img.data;
          info = img.info;
          break;
        }
        case "svg":
          body = core.renderSvg(d, { ...draw, background: a.background });
          break;
        case "latex":
          body = core.renderLatex(d, { ...draw, standalone: a.standalone });
          break;
        case "json":
          body = JSON.stringify(d, null, 2) + "\n";
          break;
      }
      let saved = "";
      if (target) {
        const existed = await stat(target.file).then(() => true, () => false);
        try {
          await mkdir(dirname(target.file), { recursive: true });
          await writeFile(target.file, body);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ENOTDIR") throw new Error(`Cannot write ${target.file}: part of that path is a file, not a folder`);
          if (code === "EACCES" || code === "EPERM") throw new Error(`Cannot write ${target.file}: permission denied`);
          throw e;
        }
        saved = `${existed ? "Overwrote" : "Wrote"} ${target.file} (${body.length} bytes)${target.note}.`;
      }
      if (a.format === "png") {
        const size = body.length;
        const parts = [placedNote + (saved || `PNG rendered (${size} bytes). Pass path to save it.`), `Image: ${info}.`];
        const content: Content[] = [];
        if (size <= MAX_INLINE_PNG) content.push({ type: "image", data: body.toString("base64"), mimeType: "image/png" });
        else parts.push(`It is too large to return inline; ${target ? "open the file" : "pass path to save it"} or use a smaller scale.`);
        return { content: [{ type: "text", text: parts.join(" ") }, ...content] };
      }
      return text(placedNote + (!saved ? (body as string) : a.inline ? `${saved}\n\n${body}` : saved));
    }),
  );

  server.registerTool(
    "open_in_app",
    {
      title: "Open in FSM Designer",
      description:
        "Open a diagram in the FSM Designer desktop app on this computer so the user can see and keep editing it by hand. " +
        "The app shows the file as it is now: after more tool edits, call this again (the user may need to reopen it).",
      inputSchema: z.object({ name: fsmName() }).strict(),
      annotations: hints({ readOnlyHint: true, openWorldHint: true }),
    },
    guard(async ({ name }) => {
      await store.load(name);
      if (!store.fileOf) throw new Error("This workspace has no files the app can open");
      const file = store.fileOf(name);
      const how = await launchApp(file, app);
      return text(`Opened ${file} in FSM Designer (${how}).`);
    }),
  );

  server.registerResource(
    "fsm",
    new ResourceTemplate("fsm://{name}", {
      list: async () => ({
        resources: (await store.list()).map((n) => ({ uri: `fsm://${n}`, name: n, title: `FSM ${n}`, mimeType: "application/json" })),
      }),
      complete: { name: async (prefix) => (await store.list()).filter((n) => n.startsWith(prefix ?? "")) },
    }),
    { title: "FSM diagram", description: "An FSM diagram as .fsm.json", mimeType: "application/json" },
    async (uri, { name }) => {
      const n = decodeURIComponent(String(name));
      // -32002 is MCP's "resource not found".
      if (!(await store.exists(n))) throw new McpError(-32002, `Resource not found: ${uri.href}`, { uri: uri.href });
      const d = await store.load(n);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(d, null, 2) }] };
    },
  );
}
