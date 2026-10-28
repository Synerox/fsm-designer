// The grid annealer's running cost (GridCost in tidy.ts) is updated move by
// move instead of recounted. It must stay exactly what a full recount gives,
// whatever the moves: swaps, moves into empty cells, rows or columns swapped
// or mirrored, and undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GridCost } from "../../src/tidy.ts";

test("the grid cost kept move by move equals a full recount", () => {
  let seed = 12345;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  let checks = 0, holes = 0, blocks = 0;
  for (let trial = 0; trial < 60; trial++) {
    const n = 3 + Math.floor(rnd() * 20), cols = 1 + Math.floor(rnd() * 6), rows = Math.ceil(n / cols) + (rnd() < 0.3 ? 1 : 0);
    const sx = [200, 240, 320][Math.floor(rnd() * 3)], sy = [200, 240][Math.floor(rnd() * 2)], R = 20 + Math.floor(rnd() * 30);
    const cells: Array<{ x: number; y: number }> = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push({ x: c * sx, y: r * sy });
    const C = cells.length;
    const pairs: Array<[number, number]> = [];
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (rnd() < 0.35) pairs.push([a, b]);
    if (!pairs.length) pairs.push([0, 1]);
    const gc = new GridCost(cells, n, pairs, sx, sy, R);
    gc.reset([...cells.keys()].sort(() => rnd() - 0.5).slice(0, n));
    const check = (what: string) => {
      checks++;
      assert.equal(gc.total, gc.full(), `${what}: running total drifted from a full recount (n=${n}, ${cols}x${rows}, ${pairs.length} lines)`);
    };
    check("reset");
    for (let it = 0; it < 300; it++) {
      const states: number[] = [], to: number[] = [];
      if (rnd() < 0.6) {
        // One state to another cell, swapping with the state there if any.
        const a = Math.floor(rnd() * n), k = Math.floor(rnd() * C), from = gc.slot[a];
        if (k === from) continue;
        states.push(a); to.push(k);
        if (gc.owner[k] >= 0) { states.push(gc.owner[k]); to.push(from); } else holes++;
      } else {
        // Rows r and r+1 swapped, columns c and c+1 swapped, or a row or column mirrored.
        const map = new Map<number, number>();
        const m = rnd();
        if (m < 0.3 && rows > 1) { const r = Math.floor(rnd() * (rows - 1)); for (let c = 0; c < cols; c++) { map.set(r * cols + c, (r + 1) * cols + c); map.set((r + 1) * cols + c, r * cols + c); } }
        else if (m < 0.6 && cols > 1) { const c = Math.floor(rnd() * (cols - 1)); for (let r = 0; r < rows; r++) { map.set(r * cols + c, r * cols + c + 1); map.set(r * cols + c + 1, r * cols + c); } }
        else if (m < 0.8) { const r = Math.floor(rnd() * rows); for (let c = 0; c < cols; c++) map.set(r * cols + c, r * cols + cols - 1 - c); }
        else { const c = Math.floor(rnd() * cols); for (let r = 0; r < rows; r++) map.set(r * cols + c, (rows - 1 - r) * cols + c); }
        for (const [from, k] of map) if (from !== k && gc.owner[from] >= 0) { states.push(gc.owner[from]); to.push(k); }
        if (!states.length) continue;
        blocks++;
      }
      const before = gc.total, slots = Int32Array.from(gc.slot);
      gc.move(states, to);
      check(`move of ${states.length}`);
      if (rnd() < 0.5) {
        gc.undo();
        assert.equal(gc.total, before, "undo gives the old total back");
        assert.deepEqual(Int32Array.from(gc.slot), slots, "undo puts every state back");
        for (let c = 0; c < C; c++) assert.equal(gc.owner[c], slots.indexOf(c), "undo empties and fills the same cells");
        check("undo");
      }
    }
  }
  assert.ok(checks > 10000 && holes > 1000 && blocks > 1000, `enough of every kind of move (${checks} checks, ${holes} into holes, ${blocks} block moves)`);
});
