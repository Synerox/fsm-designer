// Automatic placement of states: one rule for every diagram (see tidy.ts).

import { STATE_RADIUS } from "./model.ts";
import type { FsmDiagram, State } from "./model.ts";
import { tidyLayout } from "./tidy.ts";
import type { LayoutIssue, TidyResult } from "./tidy.ts";
import type { PlanOptions } from "./export/svg.ts";

export interface LayoutOptions {
  draw?: PlanOptions; // how the diagram is drawn (e.g. labels hidden), so spacing matches
  spacing?: number; // px between state edges, default 90
  margin?: number; // px around the drawing, default 60
}

/** Lay out every state (see tidy.ts); the result says which arrangement won and what it could not fix. */
export async function autoLayout(d: FsmDiagram, opts: LayoutOptions = {}): Promise<TidyResult | undefined> {
  if (d.states.length === 0) return undefined;
  const r = tidyLayout(d, { spacing: opts.spacing ?? 90, margin: opts.margin ?? 60, plan: opts.draw });
  roundPositions(d.states);
  return r;
}

/** Layout issues in words, e.g. "2 line crossings, 1 overlapping label"; empty when there are none. */
export function describeLayoutIssues(issues: LayoutIssue[]): string {
  const words: Record<LayoutIssue["kind"], [string, string]> = {
    crossings: ["line crossing", "line crossings"],
    throughStates: ["line through a state", "lines through states"],
    labelOverlaps: ["overlapping label", "overlapping labels"],
    tooClose: ["pair of states too close", "pairs of states too close"],
  };
  return issues.map((i) => `${i.count} ${words[i.kind][i.count === 1 ? 0 : 1]}`).join(", ");
}

function roundPositions(states: State[]) {
  for (const s of states) {
    s.x = Math.round(s.x!);
    s.y = Math.round(s.y!);
  }
}

/**
 * Make sure every state has coordinates. If none are placed, run the full
 * layout; if only some are, put the new ones in a row under the existing drawing
 * so the agent's (or user's) manual placement is kept.
 */
export async function ensureLayout(d: FsmDiagram): Promise<void> {
  const missing = d.states.filter((s) => s.x === undefined || s.y === undefined);
  if (missing.length === 0) return;
  if (missing.length === d.states.length) { await autoLayout(d); return; }
  const placed = d.states.filter((s) => !missing.includes(s));
  const minX = Math.min(...placed.map((s) => s.x!));
  const maxY = Math.max(...placed.map((s) => s.y!));
  const r = Math.max(STATE_RADIUS, ...d.states.map((s) => s.radius ?? STATE_RADIUS));
  missing.forEach((s, i) => {
    s.x = minX + i * (2 * r + 90);
    s.y = maxY + 2 * r + 120;
  });
}
