import type { FsmLike, Issue, OutputValue } from './types.ts';

// Verilog-2005 keywords plus the common SystemVerilog ones, so generated code
// also survives tools that parse .v files as SystemVerilog.
const RESERVED = new Set(
  `always and assign automatic begin buf bufif0 bufif1 case casex casez cell cmos config deassign default defparam
  design disable edge else end endcase endconfig endfunction endgenerate endmodule endprimitive endspecify endtable
  endtask event for force forever fork function generate genvar highz0 highz1 if ifnone incdir include initial inout
  input instance integer join large liblist library localparam macromodule medium module nand negedge nmos nor
  noshowcancelled not notif0 notif1 or output parameter pmos posedge primitive pull0 pull1 pulldown pullup
  pulsestyle_onevent pulsestyle_ondetect rcmos real realtime reg release repeat rnmos rpmos rtran rtranif0 rtranif1
  scalared showcancelled signed small specify specparam strong0 strong1 supply0 supply1 table task time tran tranif0
  tranif1 tri tri0 tri1 triand trior trireg unsigned use uwire vectored wait wand weak0 weak1 while wire wor xnor xor
  logic bit byte int shortint longint enum struct union typedef always_ff always_comb always_latch unique priority
  interface endinterface package endpackage import export class endclass virtual void return break continue string`
    .split(/\s+/)
    .filter(Boolean),
);

/** Names the generator declares itself; ports and states must not collide with them. */
export const INTERNAL_NAMES = ['state', 'next_state'];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_WIDTH = 1024;

export function isValidIdentifier(name: string): boolean {
  return IDENT.test(name) && !RESERVED.has(name);
}

export interface NormalizedPort {
  name: string;
  width: number;
}

export interface NormalizedOutput extends NormalizedPort {
  /** Verilog expression for the value the output takes when nothing assigns it. */
  defaultValue: string;
}

export interface NormalizedState {
  id: string;
  label: string;
  /** localparam name, e.g. S_IDLE. */
  param: string;
  /** Moore outputs: output name -> Verilog expression. */
  outputs: Map<string, string>;
}

export interface NormalizedTransition {
  /** Index into `states`. */
  to: number;
  /** Verilog expression, or null when the transition is unconditional. */
  condition: string | null;
  /** Mealy outputs: output name -> Verilog expression. */
  outputs: Map<string, string>;
}

export interface NormalizedFsm {
  moduleName: string;
  clock: string;
  reset: { name: string; activeLow: boolean; async: boolean };
  inputs: NormalizedPort[];
  outputs: NormalizedOutput[];
  states: NormalizedState[];
  initial: number;
  /** Per state (same index as `states`), transitions in priority order. */
  transitions: NormalizedTransition[][];
}

export interface ValidationResult {
  fsm: NormalizedFsm | null;
  errors: Issue[];
  warnings: Issue[];
}

/**
 * Check a model and, if it is usable, return a normalized form with every name
 * and value already turned into Verilog text.
 */
export function validateModel(model: FsmLike): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (!model || typeof model !== 'object') {
    return { fsm: null, errors: [{ path: '', message: 'model must be an object' }], warnings };
  }

  // Every identifier we emit at module scope lives in one namespace.
  const names = new Map<string, string>(INTERNAL_NAMES.map((n) => [n, 'an internal signal']));
  const claim = (name: string, what: string, path: string) => {
    if (!isValidIdentifier(name)) {
      err(path, `"${name}" is not a legal Verilog identifier (letters, digits, _; not starting with a digit; not a keyword)`);
      return;
    }
    const prior = names.get(name);
    if (prior) err(path, `"${name}" is already used as ${prior}`);
    else names.set(name, what);
  };

  const moduleName = typeof model.name === 'string' ? model.name.trim() : '';
  if (!isValidIdentifier(moduleName)) {
    err('name', `module name "${moduleName}" is not a legal Verilog identifier`);
  }

  const clock = model.clock?.name?.trim() || 'clk';
  claim(clock, 'the clock', 'clock.name');
  const reset = {
    name: model.reset?.name?.trim() || 'rst_n',
    activeLow: model.reset?.activeLow ?? true,
    async: model.reset?.async ?? true,
  };
  claim(reset.name, 'the reset', 'reset.name');

  const readWidth = (w: unknown, path: string): number => {
    if (w === undefined || w === null) return 1;
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > MAX_WIDTH) {
      err(path, `width must be an integer from 1 to ${MAX_WIDTH}`);
      return 1;
    }
    return w;
  };

  const inputs: NormalizedPort[] = (model.inputs ?? []).map((p, i) => {
    const name = String(p?.name ?? '').trim();
    claim(name, 'an input', `inputs[${i}].name`);
    return { name, width: readWidth(p?.width, `inputs[${i}].width`) };
  });
  const inputNames = new Set(inputs.map((p) => p.name));

  const outputs: NormalizedOutput[] = (model.outputs ?? []).map((p, i) => {
    const name = String(p?.name ?? '').trim();
    claim(name, 'an output', `outputs[${i}].name`);
    const width = readWidth(p?.width, `outputs[${i}].width`);
    const def = p?.default === undefined ? 0 : p.default;
    const defaultValue = valueToVerilog(def, width, inputNames, `outputs[${i}].default`, err, warn) ?? (width === 1 ? "1'b0" : `${width}'d0`);
    return { name, width, defaultValue };
  });
  const outputByName = new Map(outputs.map((o) => [o.name, o]));

  const readOutputs = (raw: Record<string, OutputValue> | undefined, path: string): Map<string, string> => {
    const result = new Map<string, string>();
    if (raw === undefined || raw === null) return result;
    if (typeof raw !== 'object') {
      err(path, 'outputs must be an object mapping output names to values');
      return result;
    }
    for (const [key, value] of Object.entries(raw)) {
      const port = outputByName.get(key);
      if (!port) {
        err(`${path}.${key}`, `"${key}" is not a declared output`);
        continue;
      }
      const v = valueToVerilog(value, port.width, inputNames, `${path}.${key}`, err, warn);
      if (v !== null) result.set(key, v);
    }
    return result;
  };

  // States
  const rawStates = Array.isArray(model.states) ? model.states : [];
  if (rawStates.length === 0) err('states', 'the FSM needs at least one state');
  const stateIndex = new Map<string, number>();
  const states: NormalizedState[] = rawStates.map((s, i) => {
    const id = String(s?.id ?? '');
    if (!id) err(`states[${i}].id`, 'state id is missing');
    else if (stateIndex.has(id)) err(`states[${i}].id`, `duplicate state id "${id}"`);
    else stateIndex.set(id, i);
    const label = String(s?.name ?? '').trim() || id || `STATE${i}`;
    const param = stateParamName(label);
    claim(param, `state parameter of "${label}"`, `states[${i}].name`);
    return { id, label, param, outputs: readOutputs(s?.outputs, `states[${i}].outputs`) };
  });

  const initials = rawStates.flatMap((s, i) => (s?.isInitial ? [i] : []));
  let initial = 0;
  if (initials.length > 1) {
    err('states', `only one state may be initial, found ${initials.length}: ${initials.map((i) => states[i].label).join(', ')}`);
  } else if (initials.length === 1) {
    initial = initials[0];
  } else if (states.length > 0) {
    warn('states', `no state is marked initial; using "${states[0].label}"`);
  }

  // Transitions
  const transitions: NormalizedTransition[][] = states.map(() => []);
  const ordered: { from: number; priority: number; order: number; t: NormalizedTransition; path: string }[] = [];
  const rawTransitions = Array.isArray(model.transitions) ? model.transitions : [];
  rawTransitions.forEach((t, i) => {
    const path = `transitions[${i}]`;
    const from = stateIndex.get(String(t?.from));
    const to = stateIndex.get(String(t?.to));
    if (from === undefined) err(`${path}.from`, `unknown state "${t?.from}"`);
    if (to === undefined) err(`${path}.to`, `unknown state "${t?.to}"`);
    const condition = normalizeCondition(t?.condition, inputNames, `${path}.condition`, err);
    const outs = readOutputs(t?.outputs, `${path}.outputs`);
    if (outs.size > 0 && model.type === 'moore') {
      warn(`${path}.outputs`, 'transition outputs make this a Mealy machine even though type is "moore"');
    }
    let priority = Number.POSITIVE_INFINITY;
    if (t?.priority !== undefined && t?.priority !== null) {
      if (typeof t.priority !== 'number' || !Number.isFinite(t.priority)) err(`${path}.priority`, 'priority must be a number');
      else priority = t.priority;
    }
    if (from === undefined || to === undefined || condition === undefined) return;
    ordered.push({ from, priority, order: i, t: { to, condition, outputs: outs }, path });
  });
  ordered.sort((a, b) => a.priority - b.priority || a.order - b.order);

  const seenConditions = states.map(() => new Map<string, string>());
  const unconditionalAt = states.map((): string | null => null);
  for (const { from, t, path } of ordered) {
    const shadowedBy = unconditionalAt[from];
    if (shadowedBy) {
      warn(path, `never taken: ${shadowedBy} out of "${states[from].label}" is unconditional and checked first`);
      continue;
    }
    const key = t.condition === null ? '1' : t.condition.replace(/\s+/g, '');
    const dup = seenConditions[from].get(key);
    if (dup) {
      warn(path, `never taken: ${dup} out of "${states[from].label}" has the same condition and is checked first`);
      continue;
    }
    seenConditions[from].set(key, path);
    if (t.condition === null) unconditionalAt[from] = path;
    transitions[from].push(t);
  }

  // Reachability from the initial state
  if (states.length > 0 && errors.length === 0) {
    const seen = new Set<number>([initial]);
    const queue = [initial];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of transitions[s]) {
        if (!seen.has(t.to)) {
          seen.add(t.to);
          queue.push(t.to);
        }
      }
    }
    states.forEach((s, i) => {
      if (!seen.has(i)) warn(`states[${i}]`, `state "${s.label}" can't be reached from the initial state`);
    });
  }

  if (errors.length > 0) return { fsm: null, errors, warnings };
  return {
    fsm: { moduleName, clock, reset, inputs, outputs, states, initial, transitions },
    errors,
    warnings,
  };
}

/** localparam name for a state label, e.g. "Wait for ack" -> S_WAIT_FOR_ACK. */
export function stateParamName(label: string): string {
  return 'S_' + label.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
}

const UNCONDITIONAL = new Set(['', '1', "1'b1", "1'd1", "1'h1", 'true', 'else', 'otherwise', '*']);

/** Returns null for "always taken", a checked expression, or undefined after reporting an error. */
function normalizeCondition(
  raw: unknown,
  inputs: Set<string>,
  path: string,
  err: (path: string, message: string) => void,
): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    err(path, 'condition must be a string');
    return undefined;
  }
  const text = raw.trim();
  if (UNCONDITIONAL.has(text.toLowerCase())) return null;
  const problem = checkExpression(text, inputs);
  if (problem) {
    err(path, problem);
    return undefined;
  }
  return text;
}

/** Turn an output value into Verilog. Returns null after reporting an error. */
function valueToVerilog(
  value: unknown,
  width: number,
  inputs: Set<string>,
  path: string,
  err: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
): string | null {
  if (typeof value === 'boolean') value = value ? 1 : 0;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) value = Number(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      err(path, `value ${value} must be a non-negative integer`);
      return null;
    }
    if (width < 53 && value >= 2 ** width) {
      err(path, `value ${value} does not fit in ${width} bit${width === 1 ? '' : 's'}`);
      return null;
    }
    return width === 1 ? `1'b${value}` : `${width}'d${value}`;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    err(path, 'value must be a number, a Verilog literal, or an expression over inputs');
    return null;
  }
  const text = value.trim();
  const sized = /^(\d+)'[sS]?[bBoOdDhH]/.exec(text);
  if (sized && Number(sized[1]) > width && /^\S+$/.test(text)) {
    warn(path, `${text} is wider than the ${width}-bit output and will be truncated`);
  }
  const problem = checkExpression(text, inputs);
  if (problem) {
    err(path, problem);
    return null;
  }
  return text;
}

const OPERATORS = [
  '===', '!==', '~&', '~|', '~^', '^~', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>',
  '!', '~', '&', '|', '^', '<', '>', '+', '-', '*', '/', '%', '?', ':', '(', ')', '[', ']', '{', '}', ',',
];
const LITERAL = /^(?:\d+)?'[sS]?(?:[bB][01xXzZ?_]+|[oO][0-7xXzZ?_]+|[dD][0-9_]+|[hH][0-9a-fA-FxXzZ?_]+)/;

type Token = { kind: 'operand' | 'op'; text: string };

function tokenize(expr: string, inputs: Set<string>): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const rest = expr.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      i += ws[0].length;
      continue;
    }
    const lit = LITERAL.exec(rest) ?? /^\d[\d_]*/.exec(rest);
    if (lit) {
      tokens.push({ kind: 'operand', text: lit[0] });
      i += lit[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest);
    if (id) {
      if (!inputs.has(id[0])) {
        const known = [...inputs].join(', ') || 'none declared';
        return `"${id[0]}" is not a declared input (inputs: ${known})`;
      }
      tokens.push({ kind: 'operand', text: id[0] });
      i += id[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => rest.startsWith(o));
    if (!op) return `unexpected "${rest[0]}" in expression "${expr}"`;
    tokens.push({ kind: 'op', text: op });
    i += op.length;
  }
  return tokens;
}

const BINARY = new Set([
  '===', '!==', '==', '!=', '<=', '>=', '<', '>', '<<', '>>', '&&', '||',
  '&', '|', '^', '~^', '^~', '+', '-', '*', '/', '%',
]);
const UNARY = new Set(['!', '~', '&', '|', '^', '~&', '~|', '~^', '^~', '+', '-']);

/**
 * Check that `expr` is a side-effect-free Verilog expression over the
 * declared inputs. Returns a message describing the first problem, or null.
 * It parses the expression grammar (operands, unary/binary operators,
 * ?:, bit and part selects, concatenation and replication) without
 * precedence, which is enough to reject typos, dangling operators, undeclared
 * names and anything that could break out of the expression (`;`, `=`, ...).
 */
export function checkExpression(expr: string, inputs: Set<string>): string | null {
  const tokens = tokenize(expr, inputs);
  if (typeof tokens === 'string') return tokens;
  if (tokens.length === 0) return 'expression is empty';
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (text: string) => peek()?.kind === 'op' && peek().text === text;
  const fail = (what: string): never => {
    const at = peek() ? `"${peek().text}"` : 'end of expression';
    throw new Error(`expected ${what} but found ${at} in "${expr}"`);
  };
  const expect = (text: string) => {
    if (!isOp(text)) fail(`"${text}"`);
    pos++;
  };

  // expression := binary ('?' expression ':' expression)?
  const expression = (): void => {
    binary();
    if (isOp('?')) {
      pos++;
      expression();
      expect(':');
      expression();
    }
  };
  // binary := unary (binop unary)*
  const binary = (): void => {
    unary();
    while (peek()?.kind === 'op' && BINARY.has(peek().text)) {
      pos++;
      unary();
    }
  };
  // unary := unop* primary
  const unary = (): void => {
    while (peek()?.kind === 'op' && UNARY.has(peek().text)) pos++;
    primary();
  };
  // primary := operand select? | '(' expression ')' | concatenation
  const primary = (): void => {
    const t = peek();
    if (!t) fail('an operand');
    if (t.kind === 'operand') {
      pos++;
      if (/^[A-Za-z_]/.test(t.text) && isOp('[')) {
        pos++;
        expression();
        if (isOp(':')) {
          pos++;
          expression();
        }
        expect(']');
      }
      return;
    }
    if (t.text === '(') {
      pos++;
      expression();
      expect(')');
      return;
    }
    if (t.text === '{') {
      pos++;
      expression();
      if (isOp('{')) {
        // replication: {n{a, b}}
        pos++;
        list();
        expect('}');
      } else {
        while (isOp(',')) {
          pos++;
          expression();
        }
      }
      expect('}');
      return;
    }
    fail('an operand');
  };
  const list = () => {
    expression();
    while (isOp(',')) {
      pos++;
      expression();
    }
  };

  try {
    expression();
    if (pos < tokens.length) fail('an operator');
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}
