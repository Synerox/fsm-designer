export type StateEncoding = 'binary' | 'gray' | 'onehot' | 'custom';

export const STATE_ENCODINGS: readonly StateEncoding[] = ['binary', 'gray', 'onehot', 'custom'];

export interface EncodedStates {
  width: number;
  /** One bit string per state, MSB first, each exactly `width` characters. */
  codes: string[];
}

/** Bits needed for `count` binary-encoded values (at least 1). */
export function binaryWidth(count: number): number {
  let width = 1;
  while (2 ** width < count) width++;
  return width;
}

function toBits(value: number, width: number): string {
  return value.toString(2).padStart(width, '0');
}

/**
 * Assign a code to each of `count` states, in order.
 * For 'custom', `customCodes` gives one bit string per state (e.g. "101" or "3'b101").
 */
export function encodeStates(count: number, encoding: StateEncoding, customCodes?: string[]): EncodedStates {
  if (count < 1) throw new Error('an FSM needs at least one state');
  switch (encoding) {
    case 'binary': {
      const width = binaryWidth(count);
      return { width, codes: range(count).map((i) => toBits(i, width)) };
    }
    case 'gray': {
      const width = binaryWidth(count);
      return { width, codes: range(count).map((i) => toBits(i ^ (i >> 1), width)) };
    }
    case 'onehot': {
      // Bit i is set for state i; the code string is MSB first.
      return { width: count, codes: range(count).map((i) => '0'.repeat(count - 1 - i) + '1' + '0'.repeat(i)) };
    }
    case 'custom': {
      if (!customCodes || customCodes.length !== count) {
        throw new Error(`custom encoding needs exactly ${count} codes`);
      }
      const codes = customCodes.map(parseBitCode);
      const width = codes[0].length;
      codes.forEach((code, i) => {
        if (code.length !== width) throw new Error(`custom code #${i} is ${code.length} bits wide, expected ${width}`);
      });
      const seen = new Set<string>();
      codes.forEach((code, i) => {
        if (seen.has(code)) throw new Error(`custom code #${i} (${code}) is used by more than one state`);
        seen.add(code);
      });
      return { width, codes };
    }
    default:
      throw new Error(`unknown state encoding "${encoding as string}"`);
  }
}

/** Accepts "0101", "4'b0101" or "0b0101" (underscores allowed) and returns the bare bits. */
export function parseBitCode(code: string): string {
  const m = /^\s*(?:(\d+)'[bB]|0[bB])?([01_]+)\s*$/.exec(code);
  if (!m) throw new Error(`"${code}" is not a binary state code`);
  const bits = m[2].replace(/_/g, '');
  if (bits.length === 0) throw new Error(`"${code}" is not a binary state code`);
  if (m[1] !== undefined && Number(m[1]) !== bits.length) {
    throw new Error(`"${code}" declares ${m[1]} bits but has ${bits.length}`);
  }
  return bits;
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
