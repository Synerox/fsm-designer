# Verilog → FSM diagram

`importVerilog(source, options)` reads Verilog-2001 / SystemVerilog source and
returns the state machine in it as an `FsmDiagram`, plus a report.
`importVerilogLaidOut` does the same and runs the automatic layout (the
"tidy" layout in `src/tidy.ts`: symmetric grid templates, scored for readability). The editor
(File ▸ Import Verilog) and the MCP tool `import_verilog` both use it.

```ts
const r = await importVerilogLaidOut(code, { selfLoops: true });
r.diagram;        // states, transitions, inputs, outputs, clock, reset
r.machine;        // "moore" | "mealy"
r.stateVar;       // e.g. "state"; r.nextVar e.g. "next_state"
r.stateCodes;     // { IDLE: "2'b00", ... }
r.mooreOutputs;   // outputs drawn in the states
r.mealyOutputs;   // outputs drawn on the transitions
r.warnings;       // anything that could not be followed
```

Options: `module` (which module, when the file has several), `stateVar` (the
state register, when detection picks the wrong one), `selfLoops: false` (leave
out transitions that stay put, unless they carry Mealy outputs).
`listStateMachines(source)` lists every `{ module, stateVar }` found, for
files with several FSMs (the editor shows it as a drop-down).

## How it works (no guessing)

1. **Parse.** `lexer.ts` handles comments, attributes and the preprocessor
   (`define / `ifdef / `else / `endif; a `define whose body is a constant
   keeps its name, so states keep theirs). `parser.ts` reads module headers
   (ANSI and non-ANSI ports, `#(parameter …)`), declarations, `parameter`,
   `localparam`, `typedef enum`, `assign`, and `always` / `always_ff` /
   `always_comb` blocks with `begin/end`, `if/else`, `case/casez/casex`,
   `unique/priority`. Instances, functions and loops are skipped and reported.
2. **Find the state register**: a register written in a clocked block that
   takes two or more constant values (directly, or through a combinational
   next-state variable written as `state <= next`) and is used as a case
   subject, compared with constants or bit-tested (`state[IDLE]`, one-hot).
   Counters (`n <= n + 1`) are ruled out.
3. **Clock and reset** come from the sensitivity list and the first `if` of the
   state register's block (`if (!rst_n)`, `if (rst)`, or
   `state <= !rst_n ? IDLE : next`); the reset state is what that block
   assigns with reset asserted. Without a reset, an initial value is used.
4. **Slicing.** Only logic that matters to this FSM runs: outputs whose value
   depends on the state register (directly or through combinational logic)
   and the combinational signals that feed them. Outputs of other circuits
   in the module (a second FSM, a FIFO) are left out with a warning, and
   wires that do not depend on the state (`wire empty = wp == rp`) stay as
   named inputs.
5. **Symbolic execution.** For each state, the combinational blocks (in
   dependency order) and then the clocked blocks run with the state register
   fixed to that state; statements that write nothing of interest are passed
   over. An `if`/`case`/`?:` on a signal that is still unknown
   splits the run in two (one per truth value of the smallest sub-condition),
   and impossible combinations (`sel == 1` and `sel == 2`) are pruned by
   checking each signal's values. Every finished run is a set of input
   conditions with a next state and output values. New states found this way
   are explored too. XOR chains stay whole, and a state whose conditions
   still have too many parts to enumerate keeps them as written.
6. **Moore or Mealy.** A combinational output that has the same value in every
   run of a state depends on the state only: it is drawn in the state (Moore).
   One that varies with the inputs is drawn on the transitions as
   `condition / output=value` (Mealy); the machine is Mealy if it has any.
   A value computed from internal data (`tx = shreg[0]`) is shown as written.
   A registered output (written in a clocked block, e.g. a one-block FSM) that
   always takes the same value when entering a state is that state's Moore
   output; otherwise it goes on the transitions, with a warning.
7. **Conditions.** Runs with the same next state and Mealy outputs are merged
   and the condition is minimised (Quine–McCluskey, `boolmin.ts`), so the
   conditions out of a state are mutually exclusive and cover every case.

## Tests

`test/import/import.test.ts` imports hand-written FSMs in different styles
(`test/import/fixtures`) and, when Icarus Verilog is installed, simulates the
original source and the imported diagram with the same random inputs and
compares state and outputs every cycle. `roundtrip.test.ts` runs the old
diagram → Verilog generator (now only a test fixture in `test/support/codegen`)
over the examples in every style and state encoding and checks the imported
diagrams against the hand-written vectors. `stress.test.ts` covers a big
UART module with two FSMs, two FSMs in one module, an FSM in a submodule, a
16-input parity, one-hot `case (1'b1)` and 32-state machines.
