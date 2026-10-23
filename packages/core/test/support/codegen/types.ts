// Structural view of the .fsm.json model that the code generator reads.
// The canonical FsmDiagram type (src/model.ts) is assignable to FsmLike;
// layout-only fields (x, y, color, curve, ...) are ignored here.

export type OutputValue = number | string | boolean;

export interface PortLike {
  name: string;
  width?: number;
}

export interface OutputPortLike extends PortLike {
  default?: OutputValue;
}

export interface StateLike {
  id: string;
  name?: string;
  isInitial?: boolean;
  outputs?: Record<string, OutputValue>;
}

export interface TransitionLike {
  id?: string;
  from: string;
  to: string;
  condition?: string;
  outputs?: Record<string, OutputValue>;
  priority?: number;
}

export interface FsmLike {
  name: string;
  type?: 'moore' | 'mealy';
  clock?: { name?: string };
  reset?: { name?: string; activeLow?: boolean; async?: boolean };
  inputs?: PortLike[];
  outputs?: OutputPortLike[];
  states: StateLike[];
  transitions: TransitionLike[];
}

export interface Issue {
  /** JSON-path-like location, e.g. "transitions[2].condition". */
  path: string;
  message: string;
}
