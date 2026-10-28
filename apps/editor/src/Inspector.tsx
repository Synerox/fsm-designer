// Right-hand panel: edit the selected object with ordinary text fields
// (useful for IME input such as Chinese, which canvas typing can't take).

import { LABEL_SIZE, NAME_SIZE, STATE_RADIUS, expandShortcut } from "@fsm/core";
import { PARALLEL_GAP, planDiagram } from "@fsm/core";
import type { FsmDiagram } from "@fsm/core";
import { useState } from "react";
import type { KeyboardEvent } from "react";
import { DRAW, alignStates, deleteSelection, edgeTransitions, setEdgeShape, getStateText, setEdgeText, setStateText, useEditor } from "./store.ts";

import { snapToGrid } from "./geometry.ts";
import { MOD, tr } from "./i18n.ts";
import { diagramSizeText, selectionSizeText } from "./summary.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Same shortcut rule as typing on the canvas: space after "_0" or "\beta" converts it. */
function expandOnSpace(e: KeyboardEvent<HTMLInputElement>, subscripts: boolean, apply: (text: string) => void) {
  if (e.key !== " " || e.nativeEvent.isComposing) return;
  const el = e.currentTarget;
  if (el.selectionStart !== el.selectionEnd) return;
  const x = expandShortcut(el.value, el.selectionStart ?? el.value.length, { subscripts });
  if (!x) return;
  e.preventDefault();
  apply(x.text);
  requestAnimationFrame(() => el.setSelectionRange(x.caret, x.caret));
}

/**
 * Number box for a size. Empty means "default" (the property is removed).
 * `value` is undefined when nothing is set, or when a multiple selection differs.
 */
function SizeField({ label, value, fallback, min, max, onChange }: {
  label: string; value: number | undefined; fallback: number; min: number; max: number; onChange: (v: number | undefined) => void;
}) {
  // Keep what is typed while it is incomplete (e.g. "1" on the way to "12").
  const [draft, setDraft] = useState<string | null>(null);
  // Arrows and the up/down keys step from the shown value, or from the default when empty.
  const step = (dir: 1 | -1) => {
    setDraft(null);
    onChange(Math.min(max, Math.max(min, (value ?? fallback) + dir)));
  };
  return (
    <label>
      {label}
      <span className="stepper">
        <input
          type="number"
          min={min}
          max={max}
          value={draft ?? value ?? ""}
          placeholder={tr(`Default ${fallback}`, `預設 ${fallback}`, `既定 ${fallback}`)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            step(e.key === "ArrowUp" ? 1 : -1);
          }}
          onWheel={(e) => e.currentTarget.blur()}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            if (raw === "") return onChange(undefined);
            const v = Number(raw);
            if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
          }}
          onBlur={() => setDraft(null)}
        />
        <span className="arrows">
          <button type="button" tabIndex={-1} aria-label={tr("Increase", "加 1")} onClick={(e) => { e.preventDefault(); step(1); }}>
            <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0.5 4.5L4 1l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          <button type="button" tabIndex={-1} aria-label={tr("Decrease", "減 1")} onClick={(e) => { e.preventDefault(); step(-1); }}>
            <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden="true"><path d="M0.5 0.5L4 4l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </span>
      </span>
    </label>
  );
}

/** The shared value of a property across items, or undefined if unset or mixed. */
function common(values: Array<number | undefined>): number | undefined {
  return values.length && values.every((v) => v === values[0]) ? values[0] : undefined;
}

function setOrClear<T extends object, K extends keyof T>(obj: T, key: K, v: T[K] | undefined) {
  if (v === undefined) delete obj[key];
  else obj[key] = v;
}

/** Size controls for a set of states and transitions (one or many). */
function SizeControls({ doc, states, edges, edit, keyPrefix }: {
  doc: FsmDiagram; states: string[]; edges: Array<{ from: string; to: string }>;
  edit: (fn: (d: FsmDiagram) => void, key?: string) => void; keyPrefix: string;
}) {
  const st = doc.states.filter((s) => states.includes(s.id));
  const inEdges = (t: { from: string; to: string }) => edges.some((e) => e.from === t.from && e.to === t.to);
  const ts = doc.transitions.filter(inEdges);
  return (
    <>
      {st.length > 0 && (
        <SizeField label={tr("Circle radius", "圓圈半徑")} value={common(st.map((s) => s.radius))} fallback={STATE_RADIUS} min={10} max={200}
          onChange={(v) => edit((d) => { for (const s of d.states) if (states.includes(s.id)) setOrClear(s, "radius", v); }, `${keyPrefix}:radius`)} />
      )}
      {st.length > 0 && (
        <SizeField label={ts.length ? tr("State font size", "狀態字體大小") : tr("Font size", "字體大小")} value={common(st.map((s) => s.fontSize))} fallback={NAME_SIZE} min={6} max={72}
          onChange={(v) => edit((d) => { for (const s of d.states) if (states.includes(s.id)) setOrClear(s, "fontSize", v); }, `${keyPrefix}:sfont`)} />
      )}
      {ts.length > 0 && (
        <SizeField label={st.length ? tr("Line font size", "線條字體大小") : tr("Font size", "字體大小")} value={common(ts.map((t) => t.fontSize))} fallback={LABEL_SIZE} min={6} max={72}
          onChange={(v) => edit((d) => { for (const t of d.transitions) if (inEdges(t)) setOrClear(t, "fontSize", v); }, `${keyPrefix}:tfont`)} />
      )}
    </>
  );
}

/**
 * Straight / curved switch for one or more lines (self loops are always round
 * and are left out). With a mix, neither side is lit; "重設彎曲" resets the
 * curved ones to their default bend.
 */
function ShapeControls({ doc, edges, edit }: {
  doc: FsmDiagram; edges: Array<{ from: string; to: string }>; edit: (fn: (d: FsmDiagram) => void, key?: string) => void;
}) {
  const lines = edges.filter((e) => e.from !== e.to);
  if (!lines.length) return null;
  const plan = planDiagram(doc, DRAW);
  const curvedOf = (e: { from: string; to: string }) => plan.edges.find((p) => p.transitions[0].from === e.from && p.transitions[0].to === e.to)?.curve !== 0;
  const curved = lines.filter(curvedOf);
  const allCurved = curved.length === lines.length, allStraight = curved.length === 0;
  const apply = (targets: typeof lines, shape: "straight" | "curve") => edit((d) => { for (const e of targets) setEdgeShape(d, e.from, e.to, shape); });
  // Lines drawn side by side with a straight line going the other way.
  const paired = lines.filter((e) => plan.edges.some((p) => p.offset && p.transitions[0].from === e.from && p.transitions[0].to === e.to));
  const both = (d: FsmDiagram, e: { from: string; to: string }) => d.transitions.filter((t) => (t.from === e.from && t.to === e.to) || (t.from === e.to && t.to === e.from));
  // planDiagram keeps each line inside the smaller circle (half the gap <= 0.8 r).
  const radius = (id: string) => plan.states.find((p) => p.state.id === id)!.r;
  const maxGap = Math.floor(Math.min(...paired.map((e) => Math.min(radius(e.from), radius(e.to)))) * 1.6);
  const gapOf = (e: { from: string; to: string }) => both(doc, e).find((t) => t.gap !== undefined)?.gap;
  return (
    <>
      <div className="field">
        <span className="field-label">{lines.length > 1 ? tr(`Lines (${lines.length})`, `線條（${lines.length} 條）`, `線（${lines.length} 本）`) : tr("Line", "線條")}</span>
        <span className="seg wide" role="group" aria-label={tr("Line shape", "線條形狀")}>
          <button className={allStraight ? "on" : ""} aria-pressed={allStraight} onClick={() => apply(lines, "straight")}>{tr("Straight", "直線")}</button>
          <button className={allCurved ? "on" : ""} aria-pressed={allCurved} onClick={() => apply(lines.filter((e) => !curvedOf(e)), "curve")}>{tr("Curved", "曲線")}</button>
        </span>
      </div>
      {paired.length > 0 && (
        <SizeField label={tr("Gap between lines", "兩線間距")} value={common(paired.map(gapOf))} fallback={PARALLEL_GAP} min={2} max={maxGap}
          onChange={(v) => edit((d) => { for (const e of paired) for (const t of both(d, e)) setOrClear(t, "gap", v); }, `gap:${paired.map((e) => `${e.from}-${e.to}`).join(",")}`)} />
      )}
      {curved.length > 0 && (
        <button title={tr("Back to the default curve (drag a line to adjust it)", "回到預設的彎曲程度（拖曳線條可以自己調整）")} onClick={() => apply(curved, "curve")}>{tr("Reset curve", "重設彎曲")}</button>
      )}
    </>
  );
}

export function Inspector({ snap }: { snap: boolean }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const edit = useEditor((s) => s.edit);
  const select = useEditor((s) => s.select);
  const round = (v: number) => (snap ? snapToGrid(v) : Math.round(v));
  const del = () => { edit((d) => deleteSelection(d, selection)); select(null); };

  if (selection?.kind === "state") {
    const s = doc.states.find((v) => v.id === selection.id);
    if (!s) return <aside className="inspector" />;
    const text = getStateText(s);
    return (
      <aside className="inspector">
        <h3>{tr("State", "狀態")}</h3>
        <label>
          {tr("Label", "標籤")}
          <input
            value={text}
            placeholder={tr("Enter label", "輸入標籤")}
            onKeyDown={(e) => expandOnSpace(e, true, (v) => edit((d) => setStateText(d, s.id, v), `text:${s.id}`))}
            onChange={(e) => edit((d) => setStateText(d, s.id, e.target.value), `text:${s.id}`)}
          />
        </label>
        <SizeControls doc={doc} states={[s.id]} edges={[]} edit={edit} keyPrefix={s.id} />
        <label className="check">
          <input type="checkbox" checked={s.isAccepting} onChange={(e) => edit((d) => { d.states.find((x) => x.id === s.id)!.isAccepting = e.target.checked; })} />
          {tr("Accepting", "接受狀態")}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={s.isInitial}
            onChange={(e) => edit((d) => { for (const x of d.states) x.isInitial = e.target.checked && x.id === s.id; })}
          />
          {tr("Initial", "起始狀態")}
        </label>
        <button className="danger" onClick={del}>{tr("Delete state", "刪除狀態")}</button>
      </aside>
    );
  }

  if (selection?.kind === "edge") {
    const ts = edgeTransitions(doc, selection.from, selection.to);
    if (!ts.length) return <aside className="inspector" />;
    const name = (id: string) => { const s = doc.states.find((x) => x.id === id)!; return getStateText(s) || s.name; };
    return (
      <aside className="inspector">
        <h3>{selection.from === selection.to ? tr("Self loop", "自迴圈") : tr("Transition", "轉移")}</h3>
        <p className="hint">{name(selection.from)} → {name(selection.to)}</p>
        <label>
          {tr("Label / condition", "標籤 / 條件")}
          <input
            value={ts[0].condition}
            placeholder={tr("Enter label", "輸入標籤")}
            onKeyDown={(e) => expandOnSpace(e, false, (v) => edit((d) => setEdgeText(d, selection.from, selection.to, v), `text:${ts[0].id}`))}
            onChange={(e) => edit((d) => setEdgeText(d, selection.from, selection.to, e.target.value), `text:${ts[0].id}`)} />
        </label>
        {ts.length > 1 && <p className="hint">{tr(`${ts.length - 1} more in the same direction: `, `另有 ${ts.length - 1} 條同方向轉移：`, `同じ向きの遷移がほかに ${ts.length - 1} 本：`)}{ts.slice(1).map((t) => t.condition || tr("(no condition)", "（無條件）")).join(tr(", ", "、"))}</p>}
        <SizeControls doc={doc} states={[]} edges={[selection]} edit={edit} keyPrefix={ts[0].id} />
        <ShapeControls doc={doc} edges={[selection]} edit={edit} />
        <button className="danger" onClick={del}>{tr("Delete transition", "刪除轉移")}</button>
      </aside>
    );
  }

  if (selection?.kind === "multi") {
    return (
      <aside className="inspector">
        <h3>{tr("Multiple items selected", "已選取多個物件")}</h3>
        <p className="hint">
          {selectionSizeText(selection)}{selection.initial ? tr(" (including the start arrow)", "（含起始箭頭）") : ""}
        </p>
        <SizeControls doc={doc} states={selection.states} edges={selection.edges} edit={edit} keyPrefix="multi" />
        <ShapeControls doc={doc} edges={selection.edges} edit={edit} />
        {selection.states.length >= 2 && (
          <div className="align">
            <span className="hint">{tr("Align states", "對齊狀態")}</span>
            <div className="row">
              <button title={tr("Put the centers on one horizontal line", "圓心排成同一條水平線")} onClick={() => edit((d) => alignStates(d, selection.states, "row", round))}>{tr("Align row", "水平對齊")}</button>
              <button title={tr("Put the centers on one vertical line", "圓心排成同一條垂直線")} onClick={() => edit((d) => alignStates(d, selection.states, "column", round))}>{tr("Align column", "垂直對齊")}</button>
            </div>
            {selection.states.length >= 3 && (
              <div className="row">
                <button title={tr("Keep the ends, space the rest evenly left to right", "左右兩端不動，中間等距排開")} onClick={() => edit((d) => alignStates(d, selection.states, "spreadX"))}>{tr("Space evenly ↔", "水平等距")}</button>
                <button title={tr("Keep the ends, space the rest evenly top to bottom", "上下兩端不動，中間等距排開")} onClick={() => edit((d) => alignStates(d, selection.states, "spreadY"))}>{tr("Space evenly ↕", "垂直等距")}</button>
              </div>
            )}
          </div>
        )}
        <p className="hint">{tr(`Drag any of the states to move them together; Delete removes them all; ${MOD}+click adds to or removes from the selection.`, `拖曳其中一個狀態可以一起移動；按 Delete 全部刪除；${MOD}+點一下可以加入或移出選取。`, `どれか 1 つの状態をドラッグするとまとめて移動します。Delete ですべて削除、${MOD}+クリックで選択に追加／選択から外せます。`)}</p>
        <button className="danger" onClick={del}>{tr("Delete selected", "刪除選取的物件")}</button>
      </aside>
    );
  }

  if (selection?.kind === "initial") {
    return (
      <aside className="inspector">
        <h3>{tr("Start arrow", "起始箭頭")}</h3>
        <p className="hint">{tr("Drag the arrow to change its direction.", "拖曳箭頭可以改變方向。")}</p>
        <button className="danger" onClick={del}>{tr("Remove start arrow", "移除起始箭頭")}</button>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <h3>{tr("State diagram", "狀態轉移圖")}</h3>
      <label>
        {tr("Name", "名稱")}
        <input
          defaultValue={doc.name}
          key={doc.name}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!IDENT.test(v)) { e.target.value = doc.name; return; }
            if (v !== doc.name) edit((d) => { d.name = v; });
          }}
        />
      </label>
      <p className="hint">{diagramSizeText(doc)}</p>
    </aside>
  );
}
