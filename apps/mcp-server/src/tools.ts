// MCP tool definitions. Every handler loads a diagram from the store, changes
// it with @fsm/core, and saves it back, so the store decides where the
// document actually lives.

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { launchApp } from "./app.ts";
import type { AppOptions } from "./app.ts";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "@fsm/core";
import type { FsmDiagram, Transition } from "@fsm/core";
import { checkName } from "./store.ts";
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

// ---- shared schemas -------------------------------------------------------

const outputValue = z.union([z.number(), z.string(), z.boolean()]);
const outputsMap = z.record(z.string(), outputValue);
const signal = z.union([
  z.string().describe("1-bit signal name"),
  z.object({
    name: z.string(),
    width: z.number().int().min(1).optional().describe("bits, default 1"),
    default: outputValue.optional().describe("outputs only: value when nothing drives it, default 0"),
  }),
]);
const fsmName = z.string().describe("FSM name (letters, digits and _; also the file name)");
const labelMode = z.enum(["all", "noLoops", "none"])
  .describe("which transition labels to draw: all (default), all but self loops' (noLoops), or none (hidden)");
const side = z.enum(["left", "right", "above", "below", "above-left", "above-right", "below-left", "below-right"]);

const stateSpec = z.object({
  id: z.string().optional().describe("optional stable id; defaults to an auto id"),
  name: z.string().describe("state name, a Verilog identifier, e.g. IDLE"),
  isInitial: z.boolean().optional().describe("reset state; the first state is used if none is marked"),
  isAccepting: z.boolean().optional().describe("drawn as a double circle"),
  outputs: outputsMap.optional().describe("Moore outputs in this state, e.g. {\"z\": 1}"),
  label: z.string().optional().describe("text drawn instead of the name, e.g. \"S₀\" or \"β\"; the name stays the identifier"),
  x: z.number().optional(),
  y: z.number().optional(),
  color: z.string().optional().describe("fill colour, e.g. #dbeafe"),
  radius: z.number().min(10).max(200).optional().describe("circle radius in px; default 30, grown by create_fsm/auto_layout to fit long names and outputs"),
  fontSize: z.number().min(6).max(72).optional().describe("px for the name, default 15"),
  initialFrom: side.optional().describe("initial state only: side the start arrow comes from, default left"),
});
const transitionSpec = z.object({
  id: z.string().optional(),
  from: z.string().describe("source state name or id"),
  to: z.string().describe("target state name or id"),
  condition: z.string().optional().describe("Verilog boolean expression over inputs, e.g. \"x && !y\" or \"cnt == 2'd3\"; empty = always"),
  outputs: outputsMap.optional().describe("Mealy outputs on this transition"),
  priority: z.number().optional().describe("lower is checked first; default is list order"),
  curve: z.number().optional().describe("px offset of the arc from the straight line; 0 = straight; omit for automatic"),
  gap: z.number().min(0).max(200).optional().describe("px between this line and the opposite one when both are straight (parallel lines), default 16"),
  loopSide: side.optional().describe("self loops only: side of the state the loop sits on; omit to pick a free side"),
  fontSize: z.number().min(6).max(72).optional().describe("px for the label, default 13"),
});

// ---- spec -> core conversions ---------------------------------------------

/** Screen-coordinate angle (radians, y down) of a side; see State.initialAngle and Transition.loopAngle. */
const SIDE_ANGLE: Record<z.infer<typeof side>, number> = {
  right: 0, "below-right": Math.PI / 4, below: Math.PI / 2, "below-left": (3 * Math.PI) / 4,
  left: Math.PI, "above-left": (-3 * Math.PI) / 4, above: -Math.PI / 2, "above-right": -Math.PI / 4,
};

type StateSpec = Partial<z.infer<typeof stateSpec>>;
type TransitionSpec = Partial<z.infer<typeof transitionSpec>>;

function stateInput<T extends StateSpec>({ initialFrom, ...s }: T) {
  return { ...s, ...(initialFrom ? { initialAngle: SIDE_ANGLE[initialFrom] } : {}) };
}
function transitionInput<T extends TransitionSpec>({ loopSide, ...t }: T) {
  return { ...t, ...(loopSide ? { loopAngle: SIDE_ANGLE[loopSide] } : {}) };
}

// ---- helpers --------------------------------------------------------------

function summary(d: FsmDiagram): string {
  const issues = checks(d);
  return `${core.describe(d)}\n\n${issues}`;
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
  const nm = (id: string) => d.states.find((s) => s.id === id)?.name ?? id;
  return ts.flatMap((t) => {
    const why = conditionProblem(t.condition);
    return why ? [`Transition ${t.id} (${nm(t.from)} -> ${nm(t.to)}): condition "${t.condition}" is not a valid Verilog expression (${why}); it will be drawn as written`] : [];
  });
}

function checks(d: FsmDiagram): string {
  const issues = core.validate(d);
  const lines = [
    ...issues.filter((i) => i.level === "error").map((i) => `ERROR ${i.message}`),
    ...issues.filter((i) => i.level === "warning").map((i) => `warning ${i.message}`),
    ...conditionWarnings(d).map((w) => `warning ${w}`),
  ];
  return lines.length ? `Validation:\n${lines.map((l) => `  ${l}`).join("\n")}` : "Validation: OK";
}

/** Load, change and save one diagram; the store's lock keeps concurrent calls from losing each other's edits. */
async function mutate(store: DiagramStore, name: string, fn: (d: FsmDiagram) => Promise<string> | string): Promise<Result> {
  return store.lock(name, async () => {
    const d = await store.load(name);
    const msg = await fn(d);
    await store.save(d);
    return text(msg);
  });
}

const hasLayout = (d: FsmDiagram) => d.states.every((s) => s.x !== undefined && s.y !== undefined);
const LAYOUT_HINT = "It has no position yet: export_fsm places unplaced states automatically, or call auto_layout to re-arrange the whole diagram once you have finished adding states.";

/** A condition note for the reply of add_transition/update_transition, or "". */
function conditionNote(d: FsmDiagram, t: Transition): string {
  const w = conditionWarnings(d, [t]);
  return w.length ? ` Note: ${w[0]}.` : "";
}

/** Read a Verilog file with an error an agent can act on. */
async function readSource(file: string): Promise<string> {
  try {
    if ((await stat(file)).isDirectory()) throw new Error(`${file} is a folder, not a Verilog file`);
    return await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`File not found: ${file} (relative paths are resolved inside the workspace folder; give an absolute path or pass the source as code)`);
    throw e;
  }
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
        "Declare every signal in inputs/outputs first: conditions may only use inputs, and outputs may only be set for declared outputs. " +
        "Moore machines put outputs on states; Mealy machines put outputs on transitions. Exactly one state is the initial (reset) state. " +
        "Then use export_fsm to get PNG/SVG/LaTeX. To draw an FSM that already exists as Verilog code, use import_verilog instead.",
      inputSchema: {
        name: fsmName,
        type: z.enum(["moore", "mealy"]).default("moore").describe("moore: outputs depend on the state only (set them on states); mealy: outputs depend on state and inputs (set them on transitions)"),
        inputs: z.array(signal).default([]).describe("input ports, e.g. [\"x\", {\"name\":\"cnt\",\"width\":2}]"),
        outputs: z.array(signal).default([]).describe("output ports, e.g. [\"z\", {\"name\":\"led\",\"width\":3,\"default\":0}]"),
        states: z.array(stateSpec).min(1).describe("at least one state; the first one is the initial state unless another has isInitial: true"),
        transitions: z.array(transitionSpec).default([]).describe("from/to are state names from `states`"),
        clock: z.object({ name: z.string() }).optional().describe("default {\"name\":\"clk\"}"),
        reset: z.object({ name: z.string(), activeLow: z.boolean(), async: z.boolean() }).partial().optional()
          .describe("default {\"name\":\"rst_n\",\"activeLow\":true,\"async\":true}"),
        layout: z.boolean().optional().describe("true: auto layout every state, ignoring given x/y; default: only place states given without positions"),
        overwrite: z.boolean().default(false).describe("replace an existing FSM with the same name (otherwise an existing name is an error)"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guard(async (a) => {
      checkName(a.name);
      const states = a.states.map(stateInput);
      const initial = states.filter((s) => s.isInitial);
      if (initial.length > 1) throw new Error(`Only one state can be the initial state; isInitial is set on ${initial.map((s) => s.name).join(", ")}`);
      if (!initial.length) states[0].isInitial = true;
      const d = core.parseDiagram({
        name: a.name, type: a.type, inputs: a.inputs, outputs: a.outputs, clock: a.clock, reset: a.reset,
        states, transitions: a.transitions.map(transitionInput),
      } as unknown);
      // Layout re-routes every arc; keep the curves and loop sides the caller asked for.
      const asked = d.transitions.map((t) => ({ curve: t.curve, loopAngle: t.loopAngle }));
      core.fitStateSizes(d);
      if (a.layout) await core.autoLayout(d);
      else await core.ensureLayout(d);
      d.transitions.forEach((t, i) => {
        if (asked[i].curve !== undefined) t.curve = asked[i].curve;
        if (asked[i].loopAngle !== undefined) t.loopAngle = asked[i].loopAngle;
      });
      const verb = await store.lock(a.name, async () => {
        const existed = await store.exists(a.name);
        if (existed && !a.overwrite)
          throw new Error(`An FSM named "${a.name}" already exists. Pass overwrite: true to replace it, or edit it with add_state/add_transition.`);
        await store.save(d);
        return existed ? "Replaced" : "Created";
      });
      return text(`${verb} "${d.name}" (${store.fileOf?.(d.name) ?? store.location}).\n\n${summary(d)}`);
    }),
  );

  server.registerTool(
    "list_fsms",
    { title: "List FSMs", description: "List the FSM diagrams in the workspace.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () => {
      const names = await store.list();
      if (!names.length) return text(`No FSMs yet in ${store.location}. Create one with create_fsm.`);
      const rows = await Promise.all(names.map(async (n) => {
        try {
          const d = await store.load(n);
          return `${n} (${d.type}, ${d.states.length} states, ${d.transitions.length} transitions)`;
        } catch (e) {
          return `${n} (unreadable: ${(e as Error).message})`;
        }
      }));
      return text(`FSMs in ${store.location}:\n${rows.map((r) => `  ${r}`).join("\n")}`);
    }),
  );

  server.registerTool(
    "get_fsm",
    {
      title: "Get FSM",
      description: "Read an FSM: a readable summary with validation results, and optionally the full .fsm.json.",
      inputSchema: { name: fsmName, json: z.boolean().default(false).describe("also return the raw .fsm.json") },
      annotations: { readOnlyHint: true },
    },
    guard(async ({ name, json }) => {
      const d = await store.load(name);
      return text(summary(d) + (json ? `\n\n${JSON.stringify(d, null, 2)}` : ""));
    }),
  );

  server.registerTool(
    "delete_fsm",
    { title: "Delete FSM", description: "Delete an FSM diagram file from the workspace. This cannot be undone.", inputSchema: { name: fsmName }, annotations: { destructiveHint: true, idempotentHint: false } },
    guard(async ({ name }) =>
      store.lock(name, async () => {
        // exists(), not load(): a corrupt file must still be deletable.
        if (!(await store.exists(name))) throw new Error(`No FSM named "${name}". Existing: ${(await store.list()).join(", ") || "(none)"}.`);
        await store.remove(name);
        return text(`Deleted "${name}".`);
      }),
    ),
  );

  server.registerTool(
    "set_signals",
    {
      title: "Set machine signals and type",
      description:
        "Change machine-level settings: Moore/Mealy type, input and output ports, clock and reset. Fields left out are kept. " +
        "An inputs/outputs list given here replaces the whole existing list (so include the signals you want to keep); " +
        "outputs removed here are also removed from every state and transition.",
      inputSchema: {
        name: fsmName,
        type: z.enum(["moore", "mealy"]).optional(),
        inputs: z.array(signal).optional().describe("the complete new list of input ports"),
        outputs: z.array(signal).optional().describe("the complete new list of output ports"),
        clock: z.object({ name: z.string() }).optional(),
        reset: z.object({ name: z.string(), activeLow: z.boolean(), async: z.boolean() }).partial().optional(),
      },
      annotations: { idempotentHint: true },
    },
    guard(async (a) =>
      mutate(store, a.name, (d) => {
        if (a.type) d.type = a.type;
        if (a.clock) d.clock = { ...d.clock, ...a.clock };
        if (a.reset) d.reset = { ...d.reset, ...a.reset };
        const replace = (kind: "inputs" | "outputs", list: z.infer<typeof signal>[]) => {
          const keep = new Set(list.map((s) => (typeof s === "string" ? s : s.name)));
          for (const s of [...d[kind]]) if (!keep.has(s.name)) core.removeSignal(d, s.name);
          for (const s of [...d[kind]]) d[kind] = d[kind].filter((x) => x !== s); // re-add in the given order
          for (const s of list) core.addSignal(d, kind, s);
        };
        if (a.inputs) replace("inputs", a.inputs);
        if (a.outputs) replace("outputs", a.outputs);
        return `Updated "${d.name}".\n\n${summary(d)}`;
      }),
    ),
  );

  server.registerTool(
    "add_state",
    {
      title: "Add state",
      description: `Add one state to an existing FSM (to build a whole machine, create_fsm is simpler). ${LAYOUT_HINT}`,
      inputSchema: { fsm: fsmName, ...stateSpec.omit({ id: true }).shape },
      annotations: { idempotentHint: true },
    },
    guard(async ({ fsm, ...s }) =>
      mutate(store, fsm, (d) => {
        const st = core.addState(d, stateInput(s));
        const placed = st.x !== undefined && st.y !== undefined;
        return `Added state ${st.name} (id ${st.id})${st.isInitial ? " as the initial state" : ""}. ${d.states.length} states now.${placed ? "" : ` ${LAYOUT_HINT}`}`;
      }),
    ),
  );

  server.registerTool(
    "update_state",
    {
      title: "Update state",
      description: "Rename a state or change its label, outputs, flags, colour, size, font size, start-arrow side or position. Fields left out are kept. " +
        "Output values are merged into the existing ones (remove an output with set_signals). Pass label \"\" to draw the name again, color \"\" for the default fill. " +
        "isInitial: true moves the start arrow to this state.",
      inputSchema: {
        fsm: fsmName,
        state: z.string().describe("state name or id"),
        newName: z.string().optional().describe("new state name, a Verilog identifier"),
        ...stateSpec.omit({ id: true, name: true }).shape,
      },
      annotations: { idempotentHint: true },
    },
    guard(async ({ fsm, state, newName, ...patch }) =>
      mutate(store, fsm, (d) => {
        const { label, ...rest } = stateInput(patch);
        const st = core.updateState(d, state, { ...rest, ...(label !== undefined ? { label: label === "" ? null : label } : {}), ...(newName ? { name: newName } : {}) });
        return `Updated state ${st.name} (id ${st.id}).`;
      }),
    ),
  );

  server.registerTool(
    "remove_state",
    {
      title: "Remove state",
      description: "Remove a state and every transition into or out of it.",
      inputSchema: { fsm: fsmName, state: z.string().describe("state name or id") },
      annotations: { destructiveHint: true },
    },
    guard(async ({ fsm, state }) =>
      mutate(store, fsm, (d) => {
        const n = core.removeState(d, state);
        return `Removed state ${state} and ${n} transition(s).${d.states.length && !d.states.some((s) => s.isInitial) ? " Note: there is no initial state now; set one with update_state." : ""}`;
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
      inputSchema: { fsm: fsmName, ...transitionSpec.omit({ id: true }).shape },
    },
    guard(async ({ fsm, ...t }) =>
      mutate(store, fsm, (d) => {
        const tr = core.addTransition(d, transitionInput(t));
        const nm = (id: string) => d.states.find((s) => s.id === id)!.name;
        return `Added transition ${tr.id}: ${nm(tr.from)} -> ${nm(tr.to)} when ${tr.condition || "(always)"}.${conditionNote(d, tr)}`;
      }),
    ),
  );

  server.registerTool(
    "update_transition",
    {
      title: "Update transition",
      description: "Change a transition's endpoints, condition, outputs (merged), priority, curve, parallel-line gap, loop side or font size. " +
        "Find ids with get_fsm. To make the lines between two states straight or curved, set_line_style is simpler.",
      inputSchema: { fsm: fsmName, id: z.string().describe("transition id, e.g. t3 (get_fsm lists them)"), ...transitionSpec.omit({ id: true }).partial().shape },
      annotations: { idempotentHint: true },
    },
    guard(async ({ fsm, id, ...patch }) =>
      mutate(store, fsm, (d) => {
        const tr = core.updateTransition(d, id, transitionInput(patch));
        const nm = (sid: string) => d.states.find((s) => s.id === sid)!.name;
        return `Updated transition ${tr.id}: ${nm(tr.from)} -> ${nm(tr.to)} when ${tr.condition || "(always)"}.${conditionNote(d, tr)}`;
      }),
    ),
  );

  server.registerTool(
    "remove_transition",
    {
      title: "Remove transition",
      description: "Remove a transition by id.",
      inputSchema: { fsm: fsmName, id: z.string() },
      annotations: { destructiveHint: true },
    },
    guard(async ({ fsm, id }) =>
      mutate(store, fsm, (d) => {
        core.removeTransition(d, id);
        return `Removed transition ${id}.`;
      }),
    ),
  );

  server.registerTool(
    "validate_fsm",
    {
      title: "Validate FSM",
      description: "Check an FSM for errors (no states, no reset state, more than one unconditional transition from a state) and warnings (unreachable states, duplicate conditions, conditions using undeclared inputs).",
      inputSchema: { name: fsmName },
      annotations: { readOnlyHint: true },
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
        "Clears manual curves and loop sides so arcs are re-routed. Export png afterwards to check the result.",
      inputSchema: {
        name: fsmName,
        spacing: z.number().min(20).max(400).optional().describe("px between states, default 90"),
        labels: labelMode.optional().describe("lay out for labels drawn this way (match what you will export); default all"),
      },
      annotations: { idempotentHint: true },
    },
    guard(async ({ name, spacing, labels }) =>
      mutate(store, name, async (d) => {
        core.fitStateSizes(d);
        const r = await core.autoLayout(d, { spacing, draw: labels ? { labels } : undefined });
        const left = r?.issues.length ? ` Could not fix: ${core.describeLayoutIssues(r.issues)}.` : "";
        return `Laid out ${d.states.length} states (${r?.arrangement ?? "empty"}).${left}\n\n${core.describe(d)}`;
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
        "(or `curve` px). 'auto' goes back to automatic routing. Applies to every transition from→to and to→from.",
      inputSchema: {
        fsm: fsmName,
        from: z.string().describe("state name or id"),
        to: z.string().describe("the other state, name or id"),
        style: z.enum(["straight", "curved", "auto"]),
        gap: z.number().min(0).max(200).optional().describe("straight only: px between the two parallel lines"),
        curve: z.number().min(5).max(400).optional().describe("curved only: px the arcs bow out; default automatic"),
      },
      annotations: { idempotentHint: true },
    },
    guard(async ({ fsm, from, to, style, gap, curve }) =>
      mutate(store, fsm, (d) => {
        const a = core.findState(d, from), b = core.findState(d, to);
        if (a === b) throw new Error("from and to are the same state; use update_transition with loopSide for self loops");
        const ts = d.transitions.filter((t) => (t.from === a.id && t.to === b.id) || (t.from === b.id && t.to === a.id));
        if (!ts.length) throw new Error(`No transitions between ${a.name} and ${b.name}`);
        if (!hasLayout(d)) throw new Error("Lay the diagram out first (auto_layout)");
        for (const t of ts) {
          delete t.curve;
          if (style === "straight") {
            t.curve = 0;
            if (gap !== undefined) t.gap = gap;
          }
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
        return `Lines between ${a.name} and ${b.name} (${ts.length} transition(s)) are now ${style}.`;
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
      inputSchema: {
        code: z.string().optional().describe("the Verilog source; give this or path"),
        path: z.string().optional().describe("a .v/.sv file to read (relative paths are inside the workspace folder; absolute paths are read as given)"),
        name: z.string().optional().describe("FSM name to save as (letters, digits and _); default the module name"),
        module: z.string().optional().describe("module to import when the file has several"),
        stateVar: z.string().optional().describe("state register name, if detection picks the wrong one"),
        selfLoops: z.boolean().default(true).describe("draw transitions that stay in the same state"),
        overwrite: z.boolean().default(false).describe("replace an existing FSM with the same name"),
      },
      annotations: { destructiveHint: true, idempotentHint: true },
    },
    guard(async (a) => {
      if (!a.code && !a.path) throw new Error("Give the Verilog source as code, or a file path");
      if (a.name) checkName(a.name);
      const src = a.code ?? (await readSource(store.resolvePath(a.path!)));
      const r = await core.importVerilogLaidOut(src, { module: a.module, stateVar: a.stateVar, selfLoops: a.selfLoops });
      const d = r.diagram;
      if (a.name) d.name = a.name;
      checkName(d.name);
      await store.lock(d.name, async () => {
        if (!a.overwrite && (await store.exists(d.name)))
          throw new Error(`An FSM named "${d.name}" already exists. Pass overwrite: true to replace it, or name: "<other name>" to keep both.`);
        await store.save(d);
      });
      const png = await core.renderPng(d, { scale: 2 });
      const report = [
        `Imported module ${r.module} as "${d.name}": ${r.machine === "mealy" ? "Mealy" : "Moore"} machine (${r.style}).`,
        `State register: ${r.stateVar}${r.nextVar ? `, next state: ${r.nextVar}` : ""}. Codes: ${Object.entries(r.stateCodes).map(([k, v]) => `${k}=${v}`).join(", ")}.`,
        `Moore outputs (in states): ${r.mooreOutputs.join(", ") || "none"}. Mealy outputs (on transitions): ${r.mealyOutputs.join(", ") || "none"}.`,
        ...(r.warnings.length ? ["Warnings:", ...r.warnings.map((w) => `  ${w}`)] : []),
      ].join("\n");
      return { content: [{ type: "text", text: `${report}\n\n${summary(d)}` }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    }),
  );

  server.registerTool(
    "export_fsm",
    {
      title: "Export FSM",
      description:
        "Export a diagram. Formats: png (also returned as an image so you can look at it), svg, latex (TikZ, compiles with pdflatex), " +
        "json (.fsm.json, opens in the FSM Designer app). Text formats are returned inline; give `path` to also write a file " +
        "(relative paths are inside the workspace folder, absolute paths are written as given). " +
        "`labels: \"none\"` hides the text on the lines, like the editor's label switch. States without a position are placed first and that layout is saved.",
      inputSchema: {
        name: fsmName,
        format: z.enum(["png", "svg", "latex", "json"]),
        path: z.string().optional().describe("file to write, e.g. out/seq.png (folders are created)"),
        scale: z.number().min(0.5).max(8).default(2).describe("png only: pixel density (2 = 2 px per diagram px)"),
        background: z.string().optional().describe("svg/png: CSS colour or \"none\" for transparent; default white"),
        standalone: z.boolean().default(true).describe("latex only: full document (true) or just the tikzpicture (false)"),
        labels: labelMode.optional(),
        elseLabels: z.boolean().default(true).describe("write 'else' on an unconditional transition that has siblings (false draws it blank)"),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    guard(async (a) => {
      let placed = "";
      const d = await store.lock(a.name, async () => {
        const d = await store.load(a.name);
        if (!hasLayout(d) && a.format !== "json") {
          await core.ensureLayout(d);
          await store.save(d);
          placed = "Placed the states that had no position and saved the layout. ";
        }
        return d;
      });
      let body: string | Buffer;
      const extra: Content[] = [];
      const draw = { labels: a.labels, elseLabels: a.elseLabels };
      switch (a.format) {
        case "png": {
          body = await core.renderPng(d, { ...draw, scale: a.scale, background: a.background });
          extra.push({ type: "image", data: body.toString("base64"), mimeType: "image/png" });
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
      if (a.path) {
        const target = store.resolvePath(a.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);
        saved = `Wrote ${target} (${body.length} bytes)`;
      }
      if (a.format === "png")
        return { content: [{ type: "text", text: placed + (saved || `PNG rendered (${(body as Buffer).length} bytes). Pass path to save it.`) }, ...extra] };
      return text(placed + (saved ? `${saved}\n\n${body}` : (body as string)));
    }),
  );

  server.registerTool(
    "open_in_app",
    {
      title: "Open in FSM Designer",
      description:
        "Open a diagram in the FSM Designer desktop app so the user can see and keep editing it by hand. " +
        "The app shows the file as it is now: after more tool edits, call this again (the user may need to reopen it).",
      inputSchema: { name: fsmName },
      annotations: { readOnlyHint: true, openWorldHint: true },
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
        resources: (await store.list()).map((n) => ({ uri: `fsm://${n}`, name: n, mimeType: "application/json" })),
      }),
    }),
    { title: "FSM diagram", description: "An FSM diagram as .fsm.json", mimeType: "application/json" },
    async (uri, { name }) => {
      const d = await store.load(String(name));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(d, null, 2) }] };
    },
  );
}
