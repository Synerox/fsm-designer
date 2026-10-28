// Menu bar drop-down (File, language), with one level of submenu (Export).

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  onSelect?: () => void;
  submenu?: MenuItem[];
  /** Shown with a check mark (a pick-one list such as the language menu). */
  checked?: boolean;
  /** Language of the label when it differs from the page's (the language names). */
  lang?: string;
}

export function Menu({ label, items, disabled, testId, icon, title }: { label: ReactNode; items: MenuItem[]; disabled?: boolean; testId?: string; icon?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", esc, true); };
  }, [open]);

  const close = () => { setOpen(false); setSub(null); };
  const choose = (item: MenuItem) => { close(); item.onSelect?.(); };

  const list = (entries: MenuItem[], nested: boolean) => (
    <ul className={nested ? "menu-list submenu" : "menu-list"} role="menu">
      {entries.map((item, i) => (
        <li key={item.label} role="none" onPointerEnter={nested ? undefined : () => setSub(item.submenu ? i : null)}>
          <button
            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? sub === i : undefined}
            onClick={() => (item.submenu ? setSub(i) : choose(item))}
          >
            {item.checked !== undefined && <span className="check" aria-hidden="true">{item.checked ? "✓" : ""}</span>}
            <span lang={item.lang}>{item.label}</span>
            {item.shortcut && <span className="shortcut">{item.shortcut}</span>}
            {item.submenu && <span className="chevron" aria-hidden="true">›</span>}
          </button>
          {item.submenu && sub === i && list(item.submenu, true)}
        </li>
      ))}
    </ul>
  );

  return (
    <div className={icon ? "menu icon-menu" : "menu"} ref={ref}>
      <button className={`menu-trigger${open ? " active" : ""}`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} data-testid={testId} title={title} aria-label={title} onClick={() => (open ? close() : setOpen(true))}>
        {label}
        {!icon && <svg className="caret-down" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M0.5 2.25h7L4 6.25Z" fill="currentColor" /></svg>}
      </button>
      {open && list(items, false)}
    </div>
  );
}
