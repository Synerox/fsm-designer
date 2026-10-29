// Count sentences shown in the status bar, the inspector and notices. They
// live here, outside the components, so the English plurals can be tested.

import type { FsmDiagram } from "@fsm/core";
import { selectionParts } from "./store.ts";
import type { Selection } from "./store.ts";
import { tr } from "./i18n.ts";

/** A number with its English noun, singular for 1: "1 state", "2 states". (zh and ja have no plural.) */
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Status bar text: what is selected, else the size of the diagram. */
export function statusText(d: FsmDiagram, sel: Selection): string {
  const { states, edges, initial } = selectionParts(sel);
  const kind = d.type === "mealy" ? "Mealy" : "Moore";
  const ns = d.states.length, nt = d.transitions.length;
  if (!sel) return tr(`${d.outputs.length ? `${kind} machine · ` : ""}${count(ns, "state")} · ${count(nt, "transition")}`, `${d.outputs.length ? `${kind} 機 · ` : ""}${ns} 個狀態 · ${nt} 條轉移`, `${d.outputs.length ? `${kind} マシン · ` : ""}状態 ${ns} 個 · 遷移 ${nt} 本`);
  if (sel.kind === "state") return tr("1 state selected · type to edit its text", "已選取 1 個狀態 · 直接打字編輯文字");
  if (sel.kind === "edge") return sel.from === sel.to ? tr("1 self loop selected · type to edit its text", "已選取 1 條自迴圈 · 直接打字編輯文字") : tr("1 transition selected · type to edit its text", "已選取 1 條轉移 · 直接打字編輯文字");
  if (sel.kind === "initial") return tr("Start arrow selected", "已選取起始箭頭");
  const nl = edges.length + (initial ? 1 : 0);
  return tr(`${count(states.length, "state")} and ${count(nl, "line")} selected`, `已選取 ${states.length} 個狀態、${nl} 條線`, `状態 ${states.length} 個、線 ${nl} 本を選択中`);
}

/** The inspector's line for a multiple selection: "2 states, 1 line". The start arrow counts as a line. */
export function selectionSizeText(sel: Extract<Selection, { kind: "multi" }>): string {
  const ns = sel.states.length, nl = sel.edges.length + (sel.initial ? 1 : 0);
  return tr(`${count(ns, "state")}, ${count(nl, "line")}`, `${ns} 個狀態、${nl} 條線`, `状態 ${ns} 個、線 ${nl} 本`);
}

/** The inspector's line about the whole diagram: "1 state, 0 transitions". */
export function diagramSizeText(d: FsmDiagram): string {
  const ns = d.states.length, nt = d.transitions.length;
  return tr(`${count(ns, "state")}, ${count(nt, "transition")}`, `${ns} 個狀態，${nt} 條轉移`, `状態 ${ns} 個、遷移 ${nt} 本`);
}

/** Notice after a Verilog import. */
export function drewText(d: FsmDiagram): string {
  const ns = d.states.length, nt = d.transitions.length;
  return tr(`Drew ${count(ns, "state")} and ${count(nt, "transition")} from Verilog`, `已從 Verilog 畫出 ${ns} 個狀態、${nt} 條轉移`, `Verilog から ${ns} 個の状態と ${nt} 本の遷移を描きました`);
}
