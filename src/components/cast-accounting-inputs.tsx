"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { CastAccountingInput } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { castAccountingAttendanceDays, castAccountingInputAmount, castAccountingInputTotals, normalizeCastAccountingInputs, resolveCastAccountingInputs } from "@/domain/cast-accounting-inputs";
import { secureRandomUUID } from "@/lib/crypto-compat";
import { saveCastAccountingInputs } from "@/lib/firebase/repository";
import { isProductionEnvironment } from "@/lib/firebase/client";
import { Card, Field, StatusPill, Table, currentMonth, yen } from "./ui";
import { useRecoverableState } from "./update-drafts";
import { CastInputPicker } from "./cast-input-picker";

type Props = { data: AccountingWorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
type Editing = { input: CastAccountingInput; amountText: string; original?: CastAccountingInput; revision: number; context: string };
const labels = { sales: "売上", allowance: "手当", transport: "送迎" } as const;
const hints = {
  sales: "10円未満を切り捨て、キャストの売上報酬計算に加算します。本指名・場内延長売上、POSの店舗売上は変更しません。",
  allowance: "1円単位で入力します。時給＋バックと売上報酬を比較した後に加算します。",
  transport: "500円単位で入力します。店舗入力の送迎代に追加して控除します。",
} as const;

export function castInputSourceKey(data: AccountingWorkspaceData, month: string) {
  return JSON.stringify({
    month,
    adjustments: data.adjustments.find((row) => row.month === month),
    state: data.monthStates.find((row) => row.month === month),
    closings: data.closings.filter((row) => row.businessDate.startsWith(month)).map((row) => [row.id, row.status, row.updatedAt, row.checksum, row.submissionId, row.casts.map((cast) => [cast.masterId, cast.posCastId, cast.name, cast.kind])]),
    casts: [...data.archivedCasts, ...data.casts].map((cast) => [cast.id, cast.status, cast.name, cast.updatedAt]),
  });
}

export function CastAccountingInputs(props: Props) {
  if (isProductionEnvironment()) return <Card title="キャストデータ入力"><p>この機能は開発環境で確認中です。</p></Card>;
  return <CastAccountingInputForm {...props} />;
}

function CastAccountingInputForm({ data, user, busy, run, onDirtyChange }: Props) {
  const [month, setMonth] = useRecoverableState("accounting.castInputs.month", currentMonth());
  const [selected, setSelected] = useRecoverableState("accounting.castInputs.selected", "");
  const [editing, setEditing] = useRecoverableState<Editing | null>("accounting.castInputs.editing", null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsCastId, setDetailsCastId] = useState<string | null>(() => selected || null);
  const detailsId = useId();
  const savingRef = useRef(false);
  const stored = data.adjustments.find((row) => row.month === month);
  const revision = stored?.revision || 0;
  const state = data.monthStates.find((row) => row.month === month);
  const snapshot = state?.status === "closed" ? data.monthSnapshots.find((row) => row.month === month && row.revision === state.currentSnapshotRevision) : undefined;
  const inputs: CastAccountingInput[] = state?.status === "closed" ? snapshot?.castSalesReports.flatMap((row) => row.totals.accountingInputs || []) || [] : stored?.castInputs || [];
  const locked = state?.status === "closed" || state?.status === "closing";
  const disabled = busy || saving || locked;
  const context = useMemo(() => castInputSourceKey(data, month), [data, month]);
  const stale = Boolean(editing && (editing.context !== context || editing.revision !== revision));
  const casts = useMemo(() => [...data.archivedCasts, ...data.casts], [data.archivedCasts, data.casts]);
  const active = useMemo(() => data.casts.filter((cast) => cast.status === "active"), [data.casts]);
  const pickerRows = useMemo(() => active.map((cast) => ({ id: cast.id, name: cast.name, attendanceDays: castAccountingAttendanceDays(data.closings, casts, month, cast.id).length })).sort((left, right) => left.name.localeCompare(right.name, "ja")), [active, casts, data.closings, month]);
  const selectedCast = active.find((cast) => cast.id === selected);
  const inputCastId = editing?.input.castId || selected;
  const days = useMemo(() => inputCastId ? castAccountingAttendanceDays(data.closings, casts, month, inputCastId) : [], [casts, data.closings, month, inputCastId]);
  const resolved = useMemo(() => state?.status === "closed"
    ? { inputs: snapshot?.castSalesReports.flatMap((row) => row.totals.accountingInputs || []) || [], issues: snapshot ? [] : ["確定時の入力明細を読み込めません。現在の日次データから再計算はしていません。"] }
    : resolveCastAccountingInputs(stored || { month, castInputs: [] }, data.closings, casts, month), [casts, data.closings, month, snapshot, state?.status, stored]);
  const groups = new Map<string, CastAccountingInput[]>();
  inputs.forEach((input) => groups.set(input.castId, [...(groups.get(input.castId) || []), input]));
  useEffect(() => { onDirtyChange?.(Boolean(editing)); return () => onDirtyChange?.(false); }, [editing, onDirtyChange]);

  const changeMonth = (value: string) => {
    if (!/^\d{4}-\d{2}$/.test(value) || busy || saving || value === month) return;
    if (editing && !window.confirm("保存していない入力を破棄して対象月を変更しますか？")) return;
    setEditing(null); setSelected(""); setDetailsCastId(null); setPickerOpen(false); setError(""); setMonth(value);
  };
  const chooseCast = (castId: string) => {
    if (disabled) return;
    const cast = active.find((row) => row.id === castId);
    if (!cast || !castAccountingAttendanceDays(data.closings, casts, month, castId).length) return;
    if (castId === selected) { setPickerOpen(false); return; }
    if (editing && !window.confirm("保存していない入力を破棄してキャストを変更しますか？")) return;
    setEditing(null); setError(""); setSelected(castId); setDetailsCastId(castId); setPickerOpen(false);
  };
  const open = (kind: CastAccountingInput["kind"], original?: CastAccountingInput) => {
    if (disabled) return;
    const cast = active.find((row) => row.id === (original?.castId || selected));
    if (!cast) { setError("追加・変更できるのは現在の在籍キャストのみです。"); return; }
    if (!castAccountingAttendanceDays(data.closings, casts, month, cast.id).length) { setError("対象月に本人の承認済み出勤データがありません。"); return; }
    if (editing && !window.confirm("保存していない入力を破棄して別の項目を開きますか？")) return;
    const input = original ? { ...original, castName: cast.name } : { id: secureRandomUUID(), castId: cast.id, castName: cast.name, kind, label: "", amount: 0 };
    setSelected(cast.id); setDetailsCastId(cast.id);
    setEditing({ input, amountText: original ? String(original.amount) : "", original: original && { ...original }, revision, context });
    setError("");
  };
  const patch = (change: Partial<CastAccountingInput>) => setEditing((value) => value ? { ...value, input: { ...value.input, ...change } } : value);
  const candidate = useMemo(() => {
    if (!editing) return { input: undefined, amount: undefined, date: "", error: "" };
    try {
      if (!editing.amountText.trim()) throw new Error("金額を入力してください。");
      const amount = castAccountingInputAmount(editing.input.kind, Number(editing.amountText));
      const input = normalizeCastAccountingInputs([{ ...editing.input, label: editing.input.label.trim(), amount }])[0];
      const next = [...inputs.filter((row) => row.id !== input.id), input];
      castAccountingInputTotals(next);
      // Other saved rows may be awaiting date repair after a return; validate only this changed row.
      const result = resolveCastAccountingInputs({ month, castInputs: [input] }, data.closings, casts, month);
      if (result.issues.length) throw new Error(result.issues.join("\n"));
      return { input, amount, date: result.inputs.find((row) => row.id === input.id)?.businessDate || "", error: "" };
    } catch (cause) { return { input: undefined, amount: undefined, date: "", error: cause instanceof Error ? cause.message : "入力内容を確認してください。" }; }
  }, [casts, data.closings, editing, inputs, month, stored]);
  const save = async () => {
    if (!editing || !candidate.input || stale || disabled || savingRef.current) return;
    if (!active.some((cast) => cast.id === editing.input.castId)) { setError("退店したキャストの入力は変更できません。"); return; }
    savingRef.current = true; setSaving(true); setError("");
    try {
      const next = [...inputs.filter((row) => row.id !== candidate.input!.id), candidate.input];
      if (await run(() => saveCastAccountingInputs(month, next, editing.revision, user), month + "の" + editing.input.castName + "の" + labels[editing.input.kind] + "を保存しました。")) setEditing(null);
    } finally { savingRef.current = false; setSaving(false); }
  };
  const remove = async (input: CastAccountingInput) => {
    if (disabled || editing || savingRef.current) return;
    if (!window.confirm(month + " " + input.castName + "の" + labels[input.kind] + "「" + input.label + "」" + yen.format(input.amount) + "を削除しますか？\n店舗の日次原本・支払実績は変更しません。")) return;
    savingRef.current = true; setSaving(true);
    try { await run(() => saveCastAccountingInputs(month, inputs.filter((row) => row.id !== input.id), revision, user), "入力項目を削除しました。"); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const recheck = () => {
    if (!editing || disabled) return;
    const current = inputs.find((row) => row.id === editing.input.id);
    if (editing.original ? JSON.stringify(current) !== JSON.stringify(editing.original) : Boolean(current)) {
      setError("編集中の項目が別の操作で変更・削除されています。入力を控えて閉じ、最新の明細から開き直してください。"); return;
    }
    const currentCast = active.find((cast) => cast.id === editing.input.castId);
    if (!currentCast) { setError("このキャストは在籍外になったため変更できません。入力内容は保持しています。"); return; }
    setEditing({ ...editing, input: { ...editing.input, castName: currentCast.name }, revision, context }); setError("");
  };

  return <div className="grid cast-accounting-inputs">
    <Card title="キャストデータ入力" description="店舗の日次原本を変更せず、月次の売上・手当・追加送迎を名目別に登録します。現金の支払実績を訂正する場合は差戻しから行ってください。">
      <div className="month-toolbar"><Field label="対象月"><input className="input" type="month" value={month} disabled={busy || saving} onChange={(event) => changeMonth(event.target.value)} /></Field><StatusPill tone={locked ? "warn" : "neutral"}>{state?.status === "closed" ? "月次確定済み" : state?.status === "closing" ? "月次確定処理中" : "未確定"}</StatusPill></div>
      {locked && <p className="notice warn">この月は追加・変更・削除できません。保存済みの明細は閲覧できます。</p>}
    </Card>
    {error && <div className="notice error" role="alert">{error}</div>}
    {resolved.issues.length > 0 && <div className="notice error"><strong>保存済み入力の対象日・出勤を確認してください。</strong><ul>{resolved.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
    <Card title="キャストを選択" description="対象月に本人の承認済み出勤がある在籍キャストに入力できます。">
      <div className="cast-input-selected">
        <div>{selectedCast ? <><strong>{selectedCast.name}</strong><span className="muted">承認済み出勤 {pickerRows.find((row) => row.id === selectedCast.id)?.attendanceDays || 0}日</span></> : <span className="muted">キャストが選択されていません。</span>}</div>
        <button type="button" className="button secondary" disabled={disabled} aria-haspopup="dialog" onClick={() => setPickerOpen(true)}>{selectedCast ? "キャストを変更" : "キャストを選ぶ"}</button>
      </div>
    </Card>
    {pickerOpen && <CastInputPicker month={month} rows={pickerRows} selected={selected} disabled={locked} busy={busy || saving} onSelect={chooseCast} onClose={() => setPickerOpen(false)} />}
    <Card title={selectedCast ? selectedCast.name + "の入力" : "売上・手当・送迎の入力"}>
        {selectedCast && <div className="actions">{(["sales", "allowance", "transport"] as const).map((kind) => <button type="button" key={kind} className="button secondary" disabled={disabled || !days.length} onClick={() => open(kind)}>{labels[kind]}入力</button>)}</div>}
        {editing && <div className="stack top-gap">
          <h3>{editing.input.castName}・{labels[editing.input.kind]}入力</h3>
          <p className="muted compact-text">{hints[editing.input.kind]}</p>
          {!active.some((cast) => cast.id === editing.input.castId) && <p className="notice warn">このキャストは在籍外になったため変更できません。入力内容は保持しています。</p>}
          {stale && <div className="notice warn" role="alert">参照データが更新されています。入力内容は保持しています。最新データを確認してから保存してください。<button className="button secondary mini top-gap" disabled={disabled} onClick={recheck}>入力を保持して最新データと再確認</button></div>}
          <fieldset disabled={disabled} className="cast-input-fields">
            <div className="grid form-row">
              <Field label="名目"><input className="input" value={editing.input.label} maxLength={100} onChange={(event) => patch({ label: event.target.value })} /></Field>
              <Field label="金額"><input className="input money-input" type="number" min="0" step={editing.input.kind === "transport" ? 500 : 1} value={editing.amountText} onChange={(event) => setEditing((value) => value ? { ...value, amountText: event.target.value } : value)} /></Field>
              <Field label={editing.input.kind === "sales" ? "営業日（必須）" : "営業日（任意）"} hint={editing.input.kind === "sales" ? "本人の承認済み出勤日から選択" : "未指定の場合は本人の最終承認済み出勤日に計上"}>
                <select className="input" value={editing.input.businessDate || ""} onChange={(event) => patch({ businessDate: event.target.value || undefined })}>
                  <option value="">{editing.input.kind === "sales" ? "営業日を選択" : "最終出勤日に計上"}</option>
                  {days.map((day) => <option key={day} value={day}>{day}</option>)}
                  {editing.input.businessDate && !days.includes(editing.input.businessDate) && <option value={editing.input.businessDate}>{editing.input.businessDate}（現在は対象外）</option>}
                </select>
              </Field>
            </div>
          </fieldset>
          {candidate.error ? <p className="muted">{candidate.error}</p> : <p className="notice">反映額 {yen.format(candidate.amount || 0)} ／ 計上日 {candidate.date}</p>}
          <div className="actions"><button type="button" className="button" disabled={disabled || stale || !candidate.input || !active.some((cast) => cast.id === editing.input.castId)} onClick={() => void save()}>{saving ? "保存中…" : "この入力を保存"}</button><button type="button" className="button secondary" disabled={busy || saving} onClick={() => { if (window.confirm("保存していない入力を破棄して閉じますか？")) { setEditing(null); setError(""); } }}>入力を閉じる</button></div>
        </div>}
        {!selectedCast && !editing && <p className="muted">「キャストを選ぶ」から対象者を選択してください。</p>}
    </Card>
    <Card title="入力済みキャスト一覧" description={month + "に登録した名目別の入力です。退店後も保存済み明細は残ります。"}>
      {!groups.size ? <p className="muted">この月の入力はありません。</p> : <div className="table-wrap cast-input-summary"><table>
        <thead><tr><th scope="col">キャスト</th><th scope="col">売上</th><th scope="col">手当</th><th scope="col">追加送迎</th><th scope="col">件数</th><th scope="col">詳細</th></tr></thead>
        <tbody>{[...groups].map(([castId, rows]) => {
          const name = rows[0].castName;
          const isActive = active.some((cast) => cast.id === castId);
          const total = (kind: CastAccountingInput["kind"]) => rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.amount, 0);
          const expanded = detailsCastId === castId;
          const regionId = detailsId + "-" + castId;
          return <Fragment key={castId}>
            <tr className={expanded ? "is-selected" : undefined}>
              <th scope="row">{name}{!isActive && "（在籍外）"}</th>
              <td className="money-cell">{yen.format(total("sales"))}</td><td className="money-cell">{yen.format(total("allowance"))}</td><td className="money-cell">{yen.format(total("transport"))}</td><td>{rows.length}件</td>
              <td><button type="button" className="button secondary mini" aria-expanded={expanded} aria-controls={regionId} aria-label={name + "の明細" + (expanded ? "を閉じる" : "を表示")} onClick={() => setDetailsCastId(expanded ? null : castId)}>{expanded ? "閉じる" : "詳細"}</button></td>
            </tr>
            {expanded && <tr className="cast-input-detail-row"><td colSpan={6}><section id={regionId} aria-label={name + "の入力明細"} className="cast-input-detail">
              <h3>{name}の入力明細</h3>
              <Table headers={["区分", "名目", "金額", "指定日・計上日", "操作"]}>{rows.map((row) => {
                const day = resolved.inputs.find((item) => item.id === row.id)?.businessDate;
                return <tr key={row.id}><td>{labels[row.kind]}</td><td className="wrap-cell">{row.label}</td><td>{yen.format(row.amount)}</td><td>{row.businessDate || "最終出勤日" + (day ? "（" + day + "）" : "（要確認）")}</td><td><div className="row-actions"><button type="button" className="button secondary mini" disabled={disabled || !isActive} onClick={() => open(row.kind, row)}>編集</button><button type="button" className="button danger mini" disabled={disabled || Boolean(editing)} onClick={() => void remove(row)}>削除</button></div></td></tr>;
              })}</Table>
            </section></td></tr>}
          </Fragment>;
        })}</tbody>
      </table></div>}
    </Card>
  </div>;
}
