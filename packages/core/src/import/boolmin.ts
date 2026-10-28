// Two-level minimisation (Quine-McCluskey with a greedy cover) for transition
// conditions. Variables are numbered 0..n-1; a cube fixes the bits in `care`
// to the matching bits of `val`.

export interface Cube {
  care: number;
  val: number;
}

const bits = (x: number) => { let n = 0; for (; x; x &= x - 1) n++; return n; };

/** Prime implicants of on ∪ dc, then a cover of `on` (essential primes first, then greedy). */
export function minimize(n: number, on: number[], dc: number[]): Cube[] {
  if (!on.length) return [];
  const all = (1 << n) - 1;
  const inF = new Set([...on, ...dc]);
  const off: number[] = [];
  for (let m = 0; m <= all; m++) if (!inF.has(m)) off.push(m);
  // Merging visits every cube inside on ∪ dc, up to 3^n of them, which took
  // about a second for 10 atoms when nearly every minterm is don't-care (the
  // usual case in conditions(): most combinations of atoms are impossible);
  // the few off minterms give the same primes much faster. (Those are put in
  // a fixed order for the cover below: fewer literals first.)
  const primes = off.length * n < inF.size
    ? primesAvoiding(all, off).sort((a, b) => bits(a.care) - bits(b.care) || a.val - b.val || a.care - b.care)
    : primesByMerging(all, on, dc);
  const covers = (c: Cube, m: number) => (m & c.care) === c.val;
  const left = new Set(on);
  const chosen: Cube[] = [];
  // Essential primes.
  for (const m of on) {
    const cs = primes.filter((c) => covers(c, m));
    if (cs.length === 1 && !chosen.includes(cs[0])) chosen.push(cs[0]);
  }
  for (const c of chosen) for (const m of [...left]) if (covers(c, m)) left.delete(m);
  while (left.size) {
    let best: Cube | undefined, bestN = -1;
    for (const c of primes) {
      if (chosen.includes(c)) continue;
      let k = 0;
      for (const m of left) if (covers(c, m)) k++;
      if (k > bestN || (k === bestN && best && bits(c.care) < bits(best.care))) { best = c; bestN = k; }
    }
    if (!best || bestN <= 0) break;
    chosen.push(best);
    for (const m of [...left]) if (covers(best, m)) left.delete(m);
  }
  // Stable, readable order: fewer literals first, then by value.
  return chosen.sort((a, b) => bits(a.care) - bits(b.care) || b.val - a.val);
}

/** Prime implicants of on ∪ dc, by merging cubes that differ in one bit (Quine-McCluskey). */
function primesByMerging(all: number, on: number[], dc: number[]): Cube[] {
  let level = new Map<string, Cube>();
  for (const m of [...on, ...dc]) level.set(`${all}:${m}`, { care: all, val: m });
  const primes: Cube[] = [];
  while (level.size) {
    const next = new Map<string, Cube>();
    const used = new Set<string>();
    const list = [...level.entries()];
    // Group by care mask so only compatible cubes are compared.
    const byCare = new Map<number, Array<[string, Cube]>>();
    for (const e of list) {
      const g = byCare.get(e[1].care) ?? [];
      g.push(e);
      byCare.set(e[1].care, g);
    }
    for (const group of byCare.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const [ka, a] = group[i], [kb, b] = group[j];
          const diff = a.val ^ b.val;
          if (bits(diff) !== 1) continue;
          const c = { care: a.care & ~diff, val: a.val & ~diff };
          next.set(`${c.care}:${c.val}`, c);
          used.add(ka);
          used.add(kb);
        }
      }
    }
    for (const [k, c] of list) if (!used.has(k)) primes.push(c);
    level = next;
  }
  return primes;
}

/**
 * Prime implicants of the function that is 0 exactly on `off`: the product of
 * one clause per off minterm ("differs from it in some bit"), multiplied out
 * with absorption, which leaves exactly the primes.
 */
function primesAvoiding(all: number, off: number[]): Cube[] {
  let cubes: Cube[] = [{ care: 0, val: 0 }];
  for (const r of off) {
    // Cubes that already exclude r stay (and stay minimal); each other one
    // grows by a literal that excludes r, unless a cube with a subset of its
    // literals is already there.
    const kept: Cube[] = [], grown: Cube[] = [];
    for (const c of cubes) {
      if (((r ^ c.val) & c.care) !== 0) { kept.push(c); continue; }
      for (let bit = 1; bit <= all; bit <<= 1) if (!(c.care & bit)) grown.push({ care: c.care | bit, val: c.val | (~r & bit) });
    }
    const within = (c: Cube, d: Cube) => (d.care & c.care) === d.care && (c.val & d.care) === d.val; // d's literals are all in c
    const seen = new Set<number>();
    cubes = kept;
    for (const c of grown) {
      const key = c.care * (all + 1) + c.val;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!kept.some((d) => within(c, d)) && !grown.some((d) => d.care !== c.care && within(c, d))) cubes.push(c);
    }
  }
  return cubes;
}
