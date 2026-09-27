"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Field } from "./ui";

export type CastInputPickerRow = { id: string; name: string; attendanceDays: number };
type Props = {
  month: string;
  rows: CastInputPickerRow[];
  selected: string;
  disabled: boolean;
  busy: boolean;
  onSelect: (castId: string) => void;
  onClose: () => void;
};

export function filterCastInputPickerRows(rows: CastInputPickerRow[], query: string) {
  const text = query.normalize("NFKC").trim().toLocaleLowerCase("ja");
  return rows.filter((row) => row.name.normalize("NFKC").toLocaleLowerCase("ja").includes(text));
}

export function CastInputPickerTable({ rows, selected, disabled, onSelect }: Pick<Props, "rows" | "selected" | "disabled" | "onSelect">) {
  return <div className="table-wrap cast-input-picker-table"><table>
    <thead><tr><th scope="col">キャスト</th><th scope="col">承認済み出勤</th><th scope="col">選択</th></tr></thead>
    <tbody>{rows.length ? rows.map((row) => <tr key={row.id} className={selected === row.id ? "is-selected" : undefined}>
      <th scope="row">{row.name}</th><td>{row.attendanceDays ? row.attendanceDays + "日" : <span className="muted">出勤なし</span>}</td>
      <td><button type="button" className="button secondary mini" disabled={disabled || !row.attendanceDays}
        aria-label={row.name + (selected === row.id ? "を選択中" : "を選択")} aria-pressed={selected === row.id}
        onClick={() => onSelect(row.id)}>{selected === row.id ? "選択中" : "選択"}</button></td>
    </tr>) : <tr><td colSpan={3} className="muted">該当する在籍キャストがいません。</td></tr>}</tbody>
  </table></div>;
}

/** 選択だけを行うダイアログ。閉じる操作では元の入力内容に触れない。 */
export function CastInputPicker({ month, rows, selected, disabled, busy, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const helpId = useId();
  const filtered = useMemo(() => filterCastInputPickerRows(rows, query), [rows, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    searchRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialogRef} className="cast-input-picker" aria-labelledby={titleId} aria-describedby={helpId} aria-modal="true" aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
      const first = targets[0], last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <div className="section-head"><h2 id={titleId}>キャストを選択</h2>
      <button type="button" className="icon-button" aria-label="キャスト選択を閉じる" onClick={onClose}>×</button>
    </div>
    <p id={helpId} className="muted compact-text">{month} ／ 現在の在籍キャストを表示しています。本人の承認済み出勤がある場合に選択できます。</p>
    <Field label="名前で検索"><input ref={searchRef} className="input" type="search" value={query} disabled={busy} placeholder="キャスト名を入力" onChange={(event) => setQuery(event.target.value)} /></Field>
    {disabled && <p className="notice warn">この月は確定済み、または確定処理中のため選択できません。</p>}
    <p className="muted compact-text" role="status">{filtered.length}人表示 ／ 在籍 {rows.length}人</p>
    <CastInputPickerTable rows={filtered} selected={selected} disabled={disabled || busy} onSelect={onSelect} />
    <div className="actions cast-input-picker-footer"><button type="button" className="button secondary" onClick={onClose}>閉じる</button></div>
  </dialog>, document.body);
}
