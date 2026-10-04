"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { beautyAttendance, beautyCastDays, normalizeBeautyMonth } from "@/domain/beauty-allowance";
import { saveBeautyAllowanceDay } from "@/lib/firebase/repository";
import { Card, Field, StatusPill, currentMonth, yen } from "./ui";
import { TransportModal, shiftTransportMonth, transportCalendarCells } from "./transport-work";
import { useRecoverableState, useUpdateDraftBusy } from "./update-drafts";

type Props = { data: AccountingWorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
type Panel = { id: string; date: string; eligible: boolean | null; originalEligible: boolean | null; hadRecord: boolean; revision: number; context: string };
type Move = { panel: Panel | null; month?: string };

export function beautySourceKey(data: AccountingWorkspaceData, month: string) {
  return JSON.stringify({ month, beauty: data.beautyMonths?.[month], state: data.monthStates.find((row) => row.month === month),
    casts: [...data.casts, ...data.archivedCasts].map((row) => [row.id, row.name, row.status, row.deletedAt, row.updatedAt]),
    closings: data.closings.filter((row) => row.businessDate.startsWith(month + "-")).map((row) => [row.id, row.status, row.updatedAt, row.casts]),
  });
}

export function beautyPanelDirty(panel: Panel | null) { return Boolean(panel?.date && panel.eligible !== panel.originalEligible); }

export function BeautyCalendar({ month, attendance, records, selected, disabled, onSelect }: {
  month: string; attendance: string[]; records: Record<string, boolean>; selected: string; disabled: boolean; onSelect: (date: string) => void;
}) {
  const dates = new Set(attendance);
  return <div className="transport-calendar beauty-calendar" aria-label={month + "の出勤・美容室手当カレンダー"}>
    <div className="transport-calendar-week" aria-hidden="true">{["日", "月", "火", "水", "木", "金", "土"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="transport-calendar-days">{transportCalendarCells(month).map((date, index) => {
      if (!date) return <span className="transport-calendar-blank" key={"blank-" + index} aria-hidden="true" />;
      const recorded = Object.hasOwn(records, date); const present = dates.has(date); const selectable = present || recorded;
      const status = recorded ? records[date] ? "可 500円" : "否 0円" : "未登録";
      return <button type="button" key={date} className={"transport-calendar-day" + (present ? " is-working" : "") + (recorded ? " is-recorded" : "") + (recorded && !records[date] ? " is-ineligible" : "") + (selected === date ? " is-selected" : "")}
        disabled={disabled || !selectable} aria-label={date + " " + (present ? "出勤" : "出勤記録なし") + " 美容室手当 " + status} aria-pressed={selected === date}
        onClick={() => { if (!disabled && selectable) onSelect(date); }}>
        <span className="transport-day-number">{Number(date.slice(-2))}</span><span className="transport-day-status">{present ? "出勤" : "—"}</span>
        {recorded ? <strong>{status}</strong> : present && <small>未登録</small>}
      </button>;
    })}</div>
    <p className="muted transport-calendar-help">送信済み・承認済みの在籍出勤日を選択してください。「否」は登録済みの0円です。</p>
  </div>;
}

export function BeautyAllowanceWork({ data, user, busy, run, onDirtyChange }: Props) {
  const [month, setMonth] = useRecoverableState("store.beauty.month", currentMonth());
  const [panel, setPanel] = useRecoverableState<Panel | null>("store.beauty.panel", null);
  const [confirmation, setConfirmation] = useState<Move | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false); const savingRef = useRef(false);
  const stored = normalizeBeautyMonth(data.beautyMonths?.[month]);
  const monthState = data.monthStates.find((row) => row.month === month);
  const locked = monthState?.status === "closed" || monthState?.status === "closing";
  const waiting = busy || saving;
  const context = useMemo(() => beautySourceKey(data, month), [data, month]);
  const stale = Boolean(panel?.date && panel.context !== context);
  const dirty = beautyPanelDirty(panel);
  // 削除・退店済みやマスタ不在の過去記録も、日次に保存された本人IDで表示する。
  const people = new Map([...data.casts, ...data.archivedCasts].map((row) => [row.id, row]));
  for (const row of data.closings.filter((closing) => closing.businessDate.startsWith(month + "-")).flatMap((closing) => closing.casts || [])) {
    if (row.kind === "regular" && !people.has(row.masterId)) people.set(row.masterId, { id: row.masterId, name: row.name, status: "departed" } as typeof data.casts[number]);
  }
  for (const id of Object.keys(stored.casts)) if (!people.has(id)) people.set(id, { id, name: "保存済みキャスト（" + id + "）", status: "departed" } as typeof data.casts[number]);
  const castRows = [...people.values()].map((cast) => ({ cast, days: beautyCastDays(data, month, cast.id) }))
    .filter(({ cast, days }) => cast.status === "active" && !cast.deletedAt || days.some((day) => day.hasRecord))
    .sort((a, b) => a.cast.name.localeCompare(b.cast.name, "ja"));
  const person = panel ? people.get(panel.id) : undefined;
  const personName = person?.name || "キャスト";
  const canEdit = Boolean(panel && data.casts.some((row) => row.id === panel.id && row.status === "active" && !row.deletedAt));
  const attendanceRows = panel ? beautyAttendance(data, month, panel.id) : [];
  const days = panel ? beautyCastDays(data, month, panel.id) : [];
  const records = Object.fromEntries(days.filter((day) => day.hasRecord && day.eligible !== null).map((day) => [day.businessDate, day.eligible!])) as Record<string, boolean>;
  const selectedSources = panel?.date ? attendanceRows.filter((row) => row.businessDate === panel.date) : [];
  const source = selectedSources.length === 1 ? selectedSources[0] : undefined;
  const savedDay = panel?.date ? stored.casts[panel.id]?.[panel.date] : undefined;
  const needsAttendanceRefresh = Boolean(source && savedDay?.eligible && panel?.eligible === true
    && (source.closingId !== savedDay.attendanceClosingId || source.index !== savedDay.attendanceIndex || source.posCastId !== savedDay.attendancePosCastId));
  const canRepairDeparted = Boolean(panel && data.casts.some((row) => row.id === panel.id && row.status === "departed" && !row.deletedAt)
    && savedDay?.eligible === true && panel.eligible === true && needsAttendanceRefresh);
  const disabled = waiting || locked || stale;
  const canChooseYes = !disabled && Boolean(source) && canEdit;
  const canChooseNo = !disabled && Boolean(panel?.date) && (Boolean(source) && canEdit || Boolean(panel?.hadRecord));
  const canSave = !disabled && Boolean(panel?.date) && panel?.eligible !== null && (dirty || needsAttendanceRefresh)
    && (panel?.eligible ? Boolean(source) && (canEdit || canRepairDeparted) : canChooseNo);
  useUpdateDraftBusy("store.beauty.saving", saving);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  const emptyPanel = (id: string, targetMonth = month): Panel => ({ id, date: "", eligible: null, originalEligible: null, hadRecord: false,
    revision: normalizeBeautyMonth(data.beautyMonths?.[targetMonth]).revision, context: beautySourceKey(data, targetMonth) });
  const move = (next: Panel | null, nextMonth?: string) => {
    if (waiting) return;
    if (dirty) { setConfirmation({ panel: next, month: nextMonth }); return; }
    setPanel(next); if (nextMonth) setMonth(nextMonth); setError("");
  };
  const changeMonth = (value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value === month || waiting) return;
    move(panel ? emptyPanel(panel.id, value) : null, value);
  };
  const selectDay = (date: string) => {
    if (!panel || waiting || !date.startsWith(month + "-")) return;
    const original = days.find((day) => day.businessDate === date);
    if (!attendanceRows.some((row) => row.businessDate === date) && !original?.hasRecord) return;
    move({ ...panel, date, eligible: original?.hasRecord ? original.eligible : null, originalEligible: original?.hasRecord ? original.eligible : null,
      hadRecord: Boolean(original?.hasRecord), revision: stored.revision, context });
  };
  const save = async () => {
    if (!panel || panel.eligible === null || !canSave || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    let detail = "";
    try {
      const success = await run(async () => {
        try { await saveBeautyAllowanceDay(month, panel.id, panel.date, panel.eligible!, panel.revision, user); }
        catch (cause) { detail = cause instanceof Error ? cause.message : "保存できませんでした。"; throw cause; }
      }, personName + "の美容室手当を「" + (panel.eligible ? "可（500円）" : "否（0円）") + "」で保存しました。");
      if (success) { setPanel(emptyPanel(panel.id)); setConfirmation(null); }
      else setError(detail || "保存結果を確認できませんでした。入力を保持しています。最新の記録を確認してください。");
    } finally { savingRef.current = false; setSaving(false); }
  };
  const monthNavigation = <div className="transport-month-control"><button type="button" className="button secondary" aria-label="前の月" disabled={waiting} onClick={() => changeMonth(shiftTransportMonth(month, -1))}>‹</button><Field label="対象月"><input className="input" type="month" value={month} disabled={waiting} onChange={(event) => changeMonth(event.target.value)} /></Field><button type="button" className="button secondary" aria-label="次の月" disabled={waiting} onClick={() => changeMonth(shiftTransportMonth(month, 1))}>›</button></div>;

  return <div className="grid transport-work beauty-work">
    <Card title="美容室手当" description="キャストを選び、出勤日ごとに美容室手当の可否を登録します。可は500円、否は0円です。">
      <div className="transport-toolbar">{monthNavigation}<StatusPill tone={locked ? "warn" : "neutral"}>{monthState?.status === "closed" ? "月次確定済み" : monthState?.status === "closing" ? "月次確定処理中" : "未確定"}</StatusPill></div>
      <p className="muted">在籍として出勤した日が対象です。日次の承認後、キャスト売上・キャスト報酬へ反映します。体入の美容室手当は日次の当日経費で登録してください。</p>
      {locked && <p className="notice warn">この月は確定処理中または確定済みです。記録を閲覧できます。変更する場合は経理で月次確定を解除してください。</p>}
      {error && !panel && <p className="notice error" role="alert">{error}</p>}
      <div className="transport-person-grid">{castRows.map(({ cast, days: rows }) => {
        const yes = rows.filter((day) => day.hasRecord && day.eligible === true).length;
        const no = rows.filter((day) => day.hasRecord && day.eligible === false).length;
        return <button type="button" className="transport-person" key={cast.id} disabled={waiting} onClick={() => move(emptyPanel(cast.id))}>
          <span className="transport-person-heading"><strong>{cast.name}</strong><span aria-hidden="true">›</span></span>
          <span className="transport-person-detail">可 {yes}日 ／ 否 {no}日</span><span className="transport-person-total">{month.slice(5)}月 <b>{yen.format(yes * 500)}</b>{(cast.status !== "active" || cast.deletedAt) && <small>在籍外・過去記録</small>}</span>
        </button>;
      })}</div>{!castRows.length && <p className="muted">在籍キャストと、この月の保存済み記録がありません。</p>}
    </Card>
    {(panel || confirmation) && <TransportModal title={confirmation ? "未保存の入力があります" : personName + "・美容室手当"} busy={waiting} onClose={() => confirmation ? setConfirmation(null) : move(null)}>
      {confirmation ? <div className="stack"><p className="notice">保存していない入力を破棄して移動しますか？</p><div className="actions"><button type="button" className="button danger" disabled={waiting} onClick={() => { if (waiting) return; setPanel(confirmation.panel); if (confirmation.month) setMonth(confirmation.month); setConfirmation(null); setError(""); }}>破棄して移動</button><button type="button" className="button secondary" disabled={waiting} onClick={() => { if (!waiting) setConfirmation(null); }}>戻る</button></div></div>
      : panel && <div className="stack">
        {error && <p className="notice error" role="alert">{error}</p>}
        {stale && <p className="notice warn" role="alert">元データが更新されました。入力を保持しています。内容を控え、この画面を閉じて最新の記録から開き直してください。</p>}
        {locked && <p className="notice warn">月次確定処理中・確定済みのため、記録の変更はできません。</p>}
        {monthNavigation}
        <BeautyCalendar month={month} attendance={attendanceRows.map((row) => row.businessDate)} records={records} selected={panel.date} disabled={waiting} onSelect={selectDay} />
        {!attendanceRows.length && <p className="notice">この月に送信済み・承認済みの在籍出勤日がありません。</p>}
        {panel.date && <section className="transport-day-editor" aria-label={panel.date + "の美容室手当"}>
          <div className="section-head"><h3>{Number(panel.date.slice(5, 7))}月{Number(panel.date.slice(8))}日</h3><StatusPill tone={panel.hadRecord ? "good" : "neutral"}>{panel.hadRecord ? "登録済み" : "未登録"}</StatusPill></div>
          {days.find((day) => day.businessDate === panel.date)?.legacy && <p className="muted">日次で登録された美容室手当を引き継いでいます。</p>}
          {!source && <p className="notice warn">{selectedSources.length > 1 ? "同じ日に複数の出勤記録があるため、出勤データを確認してください。" : "この日の在籍出勤を現在確認できません。新しく「可」にするには出勤データを送信してください。"}{panel.hadRecord && "保存済みの手当は「否」に変更できます。"}</p>}
          {!canEdit && <p className="notice warn">在籍外のため新しく「可」にはできません。保存済みの手当は「否」に変更できます。</p>}
          {needsAttendanceRefresh && <p className="notice warn">出勤情報が更新されています。可否を確認して記録を保存してください。</p>}
          <div className="transport-amounts beauty-choices" role="group" aria-label="美容室手当の可否"><button type="button" className={"transport-amount" + (panel.eligible === true ? " is-selected" : "")} aria-pressed={panel.eligible === true} disabled={!canChooseYes} onClick={() => { if (canChooseYes) setPanel({ ...panel, eligible: true }); }}>可（500円）</button><button type="button" className={"transport-amount" + (panel.eligible === false ? " is-selected" : "")} aria-pressed={panel.eligible === false} disabled={!canChooseNo} onClick={() => { if (canChooseNo) setPanel({ ...panel, eligible: false }); }}>否（0円）</button></div>
          <div className="actions top-gap"><button type="button" className="button" disabled={!canSave} onClick={() => void save()}>記録を保存</button></div>
        </section>}
        <div className="actions"><button type="button" className="button secondary" disabled={waiting} onClick={() => move(null)}>キャスト一覧へ戻る</button></div>
      </div>}
    </TransportModal>}
  </div>;
}
