// Round trip over the shared examples: diagram -> Verilog (the old generator,
// kept as a test fixture in test/support) -> import -> diagram. The imported
// diagram must reproduce the hand-written cycle vectors in every coding style
// and state encoding the generator offers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { importVerilog } from "../../src/import/index.ts";
import { stateParamName } from "../support/codegen/validate.ts";
import { generateVerilogOrThrow, VERILOG_STYLES } from "../support/codegen/verilog.ts";
import type { FsmLike } from "../support/codegen/types.ts";
import { simulate } from "./helpers.ts";

const EXAMPLES = join(import.meta.dirname, "..", "fixtures");
const VECTORS = join(import.meta.dirname, "vectors");

interface Vector { in: Record<string, number>; state: string; out: Record<string, number> }

for (const name of ["seq_detector_1011", "traffic_light", "arbiter"]) {
  const model: FsmLike = JSON.parse(readFileSync(join(EXAMPLES, `${name}.fsm.json`), "utf8"));
  const vectors: Vector[] = JSON.parse(readFileSync(join(VECTORS, `${name}.vectors.json`), "utf8")).vectors;
  for (const style of VERILOG_STYLES) {
    for (const encoding of ["binary", "gray", "onehot"] as const) {
      test(`${name} (${style}, ${encoding}): imported diagram matches the vectors`, () => {
        const r = importVerilog(generateVerilogOrThrow(model, { style, encoding }));
        assert.equal(r.diagram.states.length, model.states.length);
        const expectType = name === "traffic_light" ? "moore" : "mealy";
        assert.equal(r.machine, expectType);
        const seq = vectors.map((v) => Object.fromEntries(Object.entries(v.in).map(([k, x]) => [k, BigInt(x)])));
        const got = simulate(r.diagram, seq);
        const stateName = new Map(model.states.map((s) => [s.id, stateParamName(s.name ?? s.id)]));
        vectors.forEach((v, i) => {
          assert.equal(got[i].state, stateName.get(v.state), `cycle ${i} state`);
          for (const [k, x] of Object.entries(v.out)) assert.equal(got[i].out[k], BigInt(x), `cycle ${i} ${k}`);
        });
      });
    }
  }
}
