"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { User } from "firebase/auth";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { TRANSPORT_AMOUNTS, normalizeTransportMonth, normalizeTransportSettings, transportAttendance, transportCastDays, transportUnresolvedLegacyInputs, type TransportSettings } from "@/domain/transport";
import { saveCastTransportDay, saveDriverTransportDay, saveTransportSettings } from "@/lib/firebase/repository";
import { secureRandomUUID } from "@/lib/crypto-compat";
import { Card, Field, StatusPill, currentMonth, yen } from "./ui";
import { useRecoverableState, useUpdateDraftBusy } from "./update-drafts";

type Props = { data: AccountingWorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
type PersonKind = "cast" | "driver";
type SettingsPanel = { type: "register" | "castInfo" | "remoteSettings"; id: string; amounts: number[]; original: number[]; revision: number; context: string };
type CalendarPanel = { type: "calendar"; kind: PersonKind; id: string; date: string; amount: number | null; originalAmount: number | null; entries: Record<string, number>; originalEntries: Record<string, number>; hadRecord: boolean; revision: number; context: string };
type Panel = SettingsPanel | CalendarPanel | { type: "castMenu"; id: string };
type Confirmation = { type: "discard"; panel: Panel | null; month?: string } | { type: "blocked" } | { type: "deleteRegistration"; id: string } | { type: "deleteDay" };

export function transportSourceKey(data: AccountingWorkspaceData, month: string) {
  return JSON.stringify({ month, settings: data.transportSettings, transport: data.transportMonths?.[month], legacy: data.transportLegacyInputs?.[month],
    remote: data.transportLegacyRemote?.[month], adjustment: data.adjustments.find((row) => row.month === month),
    state: data.monthStates.find((row) => row.month === month), casts: data.casts.map((row) => [row.id, row.name, row.status, row.updatedAt]),
    drivers: data.drivers.map((row) => [row.id, row.name, row.status, row.updatedAt]),
    closings: data.closings.filter((row) => row.businessDate.startsWith(month)).map((row) => [row.id, row.status, row.updatedAt, row.casts, row.drivers]),
  });
}
const sameAmounts = (left: number[], right: number[]) => JSON.stringify([...left].sort((a, b) => a - b)) === JSON.stringify([...right].sort((a, b) => a - b));
const sameEntries = (left: Record<string, number>, right: Record<string, number>) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());
export function transportPanelDirty(panel: Panel | null) {
  if (!panel || panel.type === "castMenu") return false;
  if (panel.type === "calendar") return panel.amount !== panel.originalAmount || !sameEntries(panel.entries, panel.originalEntries);
  return !sameAmounts(panel.amounts, panel.original) || (panel.type === "register" && Boolean(panel.id));
}
export function shiftTransportMonth(month: string, direction: number) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + direction, 1));
  return date.getUTCFullYear() + "-" + String(date.getUTCMonth() + 1).padStart(2, "0");
}
export function transportCalendarCells(month: string): (string | null)[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, value] = month.split("-").map(Number);
  const leading = new Date(Date.UTC(year, value - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, value, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(leading).fill(null), ...Array.from({ length: count }, (_, i) => month + "-" + String(i + 1).padStart(2, "0"))];
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function TransportCalendar({ month, attendance, records, selected, disabled, onSelect }: {
  month: string; attendance: string[]; records: Record<string, { amount: number; count?: number }>; selected: string; disabled: boolean; onSelect: (date: string) => void;
}) {
  const dates = new Set(attendance);
  return <div className="transport-calendar" aria-label={month + "の出勤・送迎カレンダー"}>
    <div className="transport-calendar-week" aria-hidden="true">{["日", "月", "火", "水", "木", "金", "土"].map((day) => <span key={day}>{day}</span>)}</div>
    <div className="transport-calendar-days">{transportCalendarCells(month).map((date, index) => {
      if (!date) return <span className="transport-calendar-blank" key={"blank-" + index} aria-hidden="true" />;
      const record = records[date]; const present = dates.has(date); const selectable = present || Boolean(record);
      const label = date + " " + (present ? "出勤" : "出勤記録なし") + (record ? " 記録済み " + yen.format(record.amount) + (record.count ? " " + record.count + "件" : "") : " 未記録");
      return <button type="button" key={date} className={"transport-calendar-day" + (present ? " is-working" : "") + (record ? " is-recorded" : "") + (selected === date ? " is-selected" : "")}
        disabled={disabled || !selectable} aria-label={label} aria-pressed={selected === date} onClick={() => { if (!disabled && selectable) onSelect(date); }}>
        <span className="transport-day-number">{Number(date.slice(-2))}</span><span className="transport-day-status">{present ? "出勤" : "—"}</span>
        {record && <strong>{yen.format(record.amount)}{Boolean(record.count && record.count > 1) && <small>{record.count}件</small>}</strong>}
      </button>;
    })}</div>
    <p className="muted transport-calendar-help">出勤日を選択してください。金額のある日は記録済みです。</p>
  </div>;
}

export function TransportAmountChoices({ amounts = [...TRANSPORT_AMOUNTS], selected, multiple = false, disabled, onSelect }: {
  amounts?: number[]; selected: number[]; multiple?: boolean; disabled: boolean; onSelect: (amount: number) => void;
}) {
  return <div className="transport-amounts" role="group" aria-label={multiple ? "利用する金額（複数選択可）" : "送迎金額"}>{amounts.map((amount) =>
    <button type="button" key={amount} className={"transport-amount" + (selected.includes(amount) ? " is-selected" : "")} aria-pressed={selected.includes(amount)} disabled={disabled}
      onClick={() => { if (!disabled) onSelect(amount); }}>{yen.format(amount)}{multiple && selected.includes(amount) && <span aria-hidden="true"> ✓</span>}</button>)}</div>;
}

function TransportModal({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null); const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [title]);
  return <div className="modal-backdrop transport-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal transport-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); if (!busy) onClose(); }
        if (event.key !== "Tab") return;
        const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]'));
        const first = targets[0], last = targets[targets.length - 1];
        if (!first) event.preventDefault();
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="section-head"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="閉じる" disabled={busy} onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>;
}


export function TransportWork({ data, user, busy, run, onDirtyChange }: Props) {
  const [month, setMonth] = useRecoverableState("store.transport.month", currentMonth());
  const [panel, setPanel] = useRecoverableState<Panel | null>("store.transport.panel", null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [query, setQuery] = useState(""); const [error, setError] = useState("");
  const [saving, setSaving] = useState(false); const savingRef = useRef(false);
  const settings = normalizeTransportSettings(data.transportSettings);
  const storedMonth = normalizeTransportMonth(data.transportMonths?.[month]);
  const monthState = data.monthStates.find((row) => row.month === month);
  const locked = monthState?.status === "closed" || monthState?.status === "closing";
  const waiting = busy || saving; const disabled = waiting || locked;
  const context = useMemo(() => transportSourceKey(data, month), [data, month]);
  const stale = Boolean(panel && "context" in panel && (panel.type !== "calendar" || panel.date) && panel.context !== context);
  const dirty = transportPanelDirty(panel);
  const castMasters = [...data.casts, ...data.archivedCasts.filter((row) => !data.casts.some((cast) => cast.id === row.id))];
  const activeCasts = data.casts.filter((row) => row.status === "active" && !row.deletedAt);
  const castRows = castMasters.map((cast) => ({ cast, registration: settings.castRegistrations[cast.id], days: transportCastDays(data, month, cast.id), unresolved: transportUnresolvedLegacyInputs(data, month, cast.id) }))
    .filter((row) => row.registration || row.days.some((day) => day.hasRecord) || row.unresolved.length > 0).sort((a, b) => a.cast.name.localeCompare(b.cast.name, "ja"));
  const legacyRemote = { ...(data.adjustments.find((row) => row.month === month)?.driverRemoteAllowance || {}), ...(data.transportLegacyRemote?.[month] || {}) };
  const driverIds = new Set([...data.drivers.map((row) => row.id), ...Object.keys(storedMonth.drivers), ...Object.keys(legacyRemote).filter((id) => legacyRemote[id] > 0)]);
  const drivers = [...driverIds].map((id) => data.drivers.find((row) => row.id === id) || { id, name: data.closings.flatMap((row) => row.drivers || []).find((row) => row.driverId === id)?.name || "登録済みドライバー", status: "departed" as const }).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const castForPanel = panel ? castMasters.find((row) => row.id === panel.id) : undefined;
  const personName = panel?.type === "calendar" && panel.kind === "driver" ? drivers.find((row) => row.id === panel.id)?.name || "ドライバー" : castForPanel?.name || "キャスト";
  const attendanceRows = panel?.type === "calendar" ? transportAttendance(data, month, panel.id, panel.kind) : [];
  const attendance = attendanceRows.map((row) => row.businessDate);
  const castDays = panel?.type === "calendar" && panel.kind === "cast" ? transportCastDays(data, month, panel.id) : [];
  const driverDays = panel?.type === "calendar" && panel.kind === "driver" ? storedMonth.drivers[panel.id] || {} : {};
  const records: Record<string, { amount: number; count?: number }> = panel?.type === "calendar" && panel.kind === "cast"
    ? Object.fromEntries(castDays.filter((day) => day.hasRecord).map((day) => [day.businessDate, { amount: day.amount }]))
    : Object.fromEntries(Object.entries(driverDays).filter(([, row]) => Object.keys(row.entries).length).map(([date, row]) => [date, { amount: Object.values(row.entries).reduce((sum, amount) => sum + amount, 0), count: Object.keys(row.entries).length }]));
  const candidateAmounts: number[] = panel?.type === "calendar" && panel.kind === "cast" ? settings.castRegistrations[panel.id]?.amounts || [...TRANSPORT_AMOUNTS] : settings.remoteAmounts;
  const calendarCanEdit = panel?.type === "calendar" && (panel.kind === "driver" ? data.drivers.some((driver) => driver.id === panel.id) : activeCasts.some((cast) => cast.id === panel.id));
  const selectedAttended = panel?.type === "calendar" && attendance.includes(panel.date);
  const currentAttendance = panel?.type === "calendar" ? attendanceRows.find((row) => row.businessDate === panel.date) : undefined;
  const savedDay = panel?.type === "calendar" ? (panel.kind === "cast" ? storedMonth.casts[panel.id]?.[panel.date] : storedMonth.drivers[panel.id]?.[panel.date]) : undefined;
  const needsAttendanceRefresh = Boolean(currentAttendance && savedDay && (savedDay.attendanceClosingId !== currentAttendance.closingId || savedDay.attendanceIndex !== currentAttendance.index));
  const canRefreshDepartedAttendance = Boolean(panel?.type === "calendar" && panel.kind === "cast" && !dirty && needsAttendanceRefresh
    && data.casts.some((cast) => cast.id === panel.id && cast.status === "departed" && !cast.deletedAt)
    && savedDay && "amount" in savedDay && savedDay.amount > 0 && panel.amount === savedDay.amount);
  const needsRegistration = panel?.type === "calendar" && panel.kind === "cast" && Boolean(panel.date) && !settings.castRegistrations[panel.id] && !savedDay && !panel.hadRecord;
  const editingDisabled = disabled || stale || !calendarCanEdit || needsRegistration;
  const deletionDisabled = disabled || stale || panel?.type !== "calendar" || !panel.hadRecord;
  useUpdateDraftBusy("store.transport.saving", saving);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);

  const move = (next: Panel | null, nextMonth?: string) => {
    if (waiting) return;
    if (dirty) { setConfirmation({ type: "discard", panel: next, month: nextMonth }); return; }
    setPanel(next); if (nextMonth) setMonth(nextMonth); setError(""); setQuery("");
  };
  const changeMonth = (value: string) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value === month || waiting) return;
    move(panel?.type === "calendar" ? { ...panel, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false,
      revision: normalizeTransportMonth(data.transportMonths?.[value]).revision, context: transportSourceKey(data, value) } : null, value);
  };
  const openSettings = (type: SettingsPanel["type"], id = "") => {
    if (disabled) return;
    const amounts = type === "remoteSettings" ? settings.remoteAmounts : settings.castRegistrations[id]?.amounts || [];
    move({ type, id, amounts: [...amounts], original: [...amounts], revision: settings.revision, context });
  };
  const openCalendar = (kind: PersonKind, id: string) => move({ type: "calendar", kind, id, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false, revision: storedMonth.revision, context });
  const selectDay = (date: string) => {
    if (panel?.type !== "calendar" || waiting) return;
    const original = castDays.find((row) => row.businessDate === date);
    const entries = { ...(driverDays[date]?.entries || {}) };
    move({ ...panel, date, amount: original?.hasRecord ? original.amount : null, originalAmount: original?.hasRecord ? original.amount : null,
      entries, originalEntries: { ...entries }, hadRecord: panel.kind === "cast" ? Boolean(original?.hasRecord) : Boolean(Object.keys(entries).length), revision: storedMonth.revision, context });
  };
  const perform = async (action: () => Promise<unknown>, message: string, next: Panel | null) => {
    if (disabled || savingRef.current || stale) return;
    savingRef.current = true; setSaving(true); setError("");
    let detail = "";
    try {
      const success = await run(async () => { try { return await action(); } catch (cause) { detail = cause instanceof Error ? cause.message : "保存できませんでした。"; throw cause; } }, message);
      if (success) { setPanel(next); setConfirmation(null); }
      else { setError(detail || "保存できませんでした。入力を保持しています。最新の状態を確認してください。"); setConfirmation(null); }
    } finally { savingRef.current = false; setSaving(false); }
  };
  const saveSettings = () => {
    if (!panel || panel.type === "calendar" || panel.type === "castMenu" || !panel.amounts.length || stale || disabled) return;
    const next: TransportSettings = { ...settings, revision: panel.revision, castRegistrations: { ...settings.castRegistrations } };
    if (panel.type === "remoteSettings") next.remoteAmounts = [...panel.amounts];
    else { if (!activeCasts.some((cast) => cast.id === panel.id)) return; next.castRegistrations[panel.id] = { amounts: [...panel.amounts] }; }
    void perform(() => saveTransportSettings(next, month, user), panel.type === "remoteSettings" ? "遠方手当の金額を保存しました。" : "キャスト送迎の登録を保存しました。", panel.type === "remoteSettings" ? null : { type: "castMenu", id: panel.id });
  };
  const deleteRegistration = () => {
    if (panel?.type !== "castInfo" || disabled || stale) return;
    if (transportCastDays(data, month, panel.id).some((day) => day.hasRecord) || transportUnresolvedLegacyInputs(data, month, panel.id).length > 0) { setConfirmation({ type: "blocked" }); return; }
    setConfirmation({ type: "deleteRegistration", id: panel.id });
  };
  const saveDay = (remove = false) => {
    if (panel?.type !== "calendar" || !panel.date || (remove ? deletionDisabled : editingDisabled)) return;
    if (!remove && (!selectedAttended || (panel.kind === "cast" && (panel.amount === null || !(candidateAmounts.includes(panel.amount) || (needsAttendanceRefresh && panel.amount === panel.originalAmount)))))) return;
    const next: CalendarPanel = { ...panel, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false };
    void perform(() => panel.kind === "cast"
      ? saveCastTransportDay(month, panel.id, panel.date, remove ? 0 : panel.amount!, panel.revision, user)
      : saveDriverTransportDay(month, panel.id, panel.date, remove ? {} : panel.entries, panel.revision, user),
    personName + "の" + (panel.kind === "cast" ? "送迎" : "遠方手当") + "記録を" + (remove ? "削除" : "保存") + "しました。", next);
  };
  const refreshDepartedAttendance = () => {
    if (panel?.type !== "calendar" || panel.kind !== "cast" || !panel.date || !canRefreshDepartedAttendance || disabled || stale || !savedDay || !("amount" in savedDay)) return;
    const next: CalendarPanel = { ...panel, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false };
    void perform(() => saveCastTransportDay(month, panel.id, panel.date, savedDay.amount, panel.revision, user), personName + "の送迎金額を保持して出勤情報を更新しました。", next);
  };
  const confirmAction = () => {
    if (!confirmation || waiting) return;
    if (confirmation.type === "blocked") { setConfirmation(null); return; }
    if (confirmation.type === "discard") { setPanel(confirmation.panel); if (confirmation.month) setMonth(confirmation.month); setConfirmation(null); setError(""); setQuery(""); return; }
    if (confirmation.type === "deleteDay") { saveDay(true); return; }
    if (disabled || stale || panel?.type !== "castInfo") return;
    if (transportCastDays(data, month, confirmation.id).some((day) => day.hasRecord) || transportUnresolvedLegacyInputs(data, month, confirmation.id).length > 0) { setConfirmation({ type: "blocked" }); return; }
    const registrations = { ...settings.castRegistrations }; delete registrations[confirmation.id];
    void perform(() => saveTransportSettings({ ...settings, revision: panel.revision, castRegistrations: registrations }, month, user), "キャスト送迎の登録を削除しました。", null);
  };
  const toggleAmount = (amount: number) => {
    if (!panel || panel.type === "calendar" || panel.type === "castMenu" || disabled || stale) return;
    setPanel({ ...panel, amounts: panel.amounts.includes(amount) ? panel.amounts.filter((value) => value !== amount) : [...panel.amounts, amount].sort((a, b) => a - b) });
  };
  const monthNavigation = <div className="transport-month-control"><button type="button" className="button secondary" aria-label="前の月" disabled={waiting} onClick={() => changeMonth(shiftTransportMonth(month, -1))}>‹</button><Field label="対象月"><input className="input" type="month" value={month} disabled={waiting} onChange={(event) => changeMonth(event.target.value)} /></Field><button type="button" className="button secondary" aria-label="次の月" disabled={waiting} onClick={() => changeMonth(shiftTransportMonth(month, 1))}>›</button></div>;
  const title = confirmation ? confirmation.type === "blocked" ? "送迎登録を削除できません" : confirmation.type === "discard" ? "未保存の入力があります" : "削除の確認"
    : panel?.type === "register" ? "キャスト送迎登録" : panel?.type === "remoteSettings" ? "遠方手当の金額設定" : panel?.type === "castInfo" ? personName + "・送迎情報編集"
    : panel?.type === "calendar" ? personName + "・" + (panel.kind === "cast" ? "送迎記録" : "遠方手当") : personName + "・送迎";

  return <div className="grid transport-work">
    <Card title="送迎" description="キャストの送迎代とドライバーの遠方手当を、出勤日ごとに記録します。">
      <div className="transport-toolbar">{monthNavigation}<StatusPill tone={locked ? "warn" : "neutral"}>{monthState?.status === "closed" ? "月次確定済み" : monthState?.status === "closing" ? "月次確定処理中" : "未確定"}</StatusPill></div>
      <div className="actions transport-main-actions"><button type="button" className="button" disabled={disabled} onClick={() => openSettings("register")}>キャスト送迎登録</button><button type="button" className="button secondary" disabled={disabled} onClick={() => openSettings("remoteSettings")}>遠方手当</button></div>
      {locked && <p className="notice warn">この月は確定処理中または確定済みです。記録を閲覧できます。変更する場合は経理で月次確定を解除してください。</p>}
    </Card>
    {error && !panel && <p className="notice error" role="alert">{error}</p>}
    <Card title="キャスト送迎" description="キャスト名から送迎情報の編集・送迎記録を選択します。">
      <div className="transport-person-grid">{castRows.map(({ cast, registration, days, unresolved }) => <button type="button" className="transport-person" key={cast.id} disabled={waiting} onClick={() => move({ type: "castMenu", id: cast.id })}>
        <span className="transport-person-heading"><strong>{cast.name}</strong><span aria-hidden="true">›</span></span><span className="transport-person-detail">{registration ? registration.amounts.map((amount) => yen.format(amount)).join(" / ") : "送迎記録あり・未登録"}</span>
        <span className="transport-person-total">{month.slice(5)}月 <b>{yen.format(days.reduce((sum, day) => sum + day.amount, 0) + unresolved.reduce((sum, input) => sum + input.amount, 0))}</b>{cast.status !== "active" && <small>在籍外</small>}</span>{unresolved.length > 0 && <span className="text-danger">日付確認待ち {unresolved.length}件</span>}
      </button>)}</div>{!castRows.length && <p className="muted">登録されたキャストはいません。「キャスト送迎登録」から追加してください。</p>}
    </Card>
    <Card title="ドライバー遠方手当" description="ドライバー名から出勤日を選びます。同じ日に複数回の手当を記録できます。">
      <div className="transport-person-grid">{drivers.map((driver) => {
        const entries = Object.values(storedMonth.drivers[driver.id] || {}).flatMap((day) => Object.values(day.entries));
        const legacy = legacyRemote[driver.id] || 0;
        return <button type="button" className="transport-person transport-person-driver" key={driver.id} disabled={waiting} onClick={() => openCalendar("driver", driver.id)}>
          <span className="transport-person-heading"><strong>{driver.name}</strong><span aria-hidden="true">›</span></span><span className="transport-person-detail">記録 {entries.length}件{legacy > 0 && " ／ 既存の月額 " + yen.format(legacy)}</span>
          <span className="transport-person-total">{month.slice(5)}月 <b>{yen.format(legacy + entries.reduce((sum, amount) => sum + amount, 0))}</b>{driver.status === "departed" && <small>退店</small>}</span>
        </button>;
      })}</div>{!drivers.length && <p className="muted">ドライバーが登録されていません。共通フォームの「ドライバー」から登録してください。</p>}
    </Card>
    {(panel || confirmation) && <TransportModal title={title} busy={waiting} onClose={() => confirmation ? setConfirmation(null) : move(null)}>
      {confirmation ? <div className="stack"><p className={confirmation.type === "blocked" ? "notice error" : "notice"} role={confirmation.type === "blocked" ? "alert" : undefined}>{confirmation.type === "blocked" ? "当月に送迎記録があるため削除できません" : confirmation.type === "discard" ? "保存していない入力を破棄して移動しますか？" : confirmation.type === "deleteRegistration" ? "キャストの送迎登録を削除しますか？保存済みの過去の送迎記録は残ります。" : "この日の送迎記録を削除しますか？"}</p>{(confirmation.type === "deleteDay" || confirmation.type === "deleteRegistration") && (locked || stale) && <p className="notice warn" role="alert">{locked ? "月次確定処理中・確定済みのため削除できません。" : "元データが更新されています。戻って最新の記録を確認してください。"}</p>}<div className="actions"><button type="button" className={"button" + (confirmation.type === "blocked" ? "" : " danger")} disabled={waiting || ((confirmation.type === "deleteDay" || confirmation.type === "deleteRegistration") && (locked || stale))} onClick={confirmAction}>{confirmation.type === "blocked" ? "閉じる" : confirmation.type === "discard" ? "破棄して移動" : "削除する"}</button>{confirmation.type !== "blocked" && <button type="button" className="button secondary" disabled={waiting} onClick={() => setConfirmation(null)}>戻る</button>}</div></div>
      : <>
        {error && <p className="notice error" role="alert">{error}</p>}
        {stale && <p className="notice warn" role="alert">元データが更新されました。入力を保持しています。内容を控え、この画面を閉じて最新の記録から開き直してください。</p>}
        {locked && <p className="notice warn">月次確定処理中・確定済みのため、記録の変更はできません。</p>}
        {panel?.type === "castMenu" && <div className="transport-menu-actions"><button type="button" className="transport-person" disabled={disabled || (!settings.castRegistrations[panel.id] && !activeCasts.some((cast) => cast.id === panel.id))} onClick={() => openSettings(settings.castRegistrations[panel.id] ? "castInfo" : "register", panel.id)}><strong>{settings.castRegistrations[panel.id] ? "送迎情報編集" : "送迎情報を登録"}</strong><span>候補金額の変更・送迎登録の削除</span></button><button type="button" className="transport-person" disabled={waiting} onClick={() => openCalendar("cast", panel.id)}><strong>送迎記録</strong><span>カレンダーから登録・変更・削除</span></button></div>}
        {panel && (panel.type === "register" || panel.type === "castInfo" || panel.type === "remoteSettings") && <div className="stack">
          {panel.type === "register" && <><Field label="キャストを検索"><input className="input" type="search" value={query} disabled={disabled || stale} placeholder="キャスト名" onChange={(event) => setQuery(event.target.value)} /></Field><div className="transport-cast-picker" role="group" aria-label="送迎を利用する在籍キャスト">{activeCasts.filter((cast) => cast.name.normalize("NFKC").includes(query.normalize("NFKC"))).map((cast) => <button type="button" className={"button secondary" + (panel.id === cast.id ? " is-selected" : "")} aria-pressed={panel.id === cast.id} disabled={disabled || stale || (Boolean(settings.castRegistrations[cast.id]) && panel.id !== cast.id)} key={cast.id} onClick={() => setPanel({ ...panel, id: cast.id })}>{cast.name}{settings.castRegistrations[cast.id] && "（登録済み）"}</button>)}</div>{!activeCasts.length && <p className="muted">登録できる在籍キャストがいません。</p>}</>}
          <p className="muted compact-text">{panel.type === "remoteSettings" ? "全ドライバー共通で使う金額を選択してください。" : "利用する送迎金額を選択してください。"}複数選択できます。翌月以降も引き継がれます。</p>
          <TransportAmountChoices selected={panel.amounts} multiple disabled={disabled || stale || (panel.type === "castInfo" && !activeCasts.some((cast) => cast.id === panel.id))} onSelect={toggleAmount} />
          {panel.type === "castInfo" && !activeCasts.some((cast) => cast.id === panel.id) && <p className="notice">在籍外のため金額は変更できません。対象月に送迎記録がない場合は登録を削除できます。</p>}
          <p className="muted compact-text">候補金額を変更しても、記録済みの金額は変更されません。</p>
          <div className="actions"><button type="button" className="button" disabled={disabled || stale || !panel.amounts.length || (panel.type !== "remoteSettings" && !activeCasts.some((cast) => cast.id === panel.id)) || (panel.type !== "register" && !dirty)} onClick={saveSettings}>設定を保存</button><button type="button" className="button secondary" disabled={waiting} onClick={() => move(panel.type === "castInfo" ? { type: "castMenu", id: panel.id } : null)}>戻る</button>{panel.type === "castInfo" && <button type="button" className="button danger" disabled={disabled || stale} onClick={deleteRegistration}>送迎登録を削除</button>}</div>
        </div>}
        {panel?.type === "calendar" && <div className="stack">
          {monthNavigation}
          {panel.kind === "driver" && Boolean(legacyRemote[panel.id]) && <div className="notice">既存の月額遠方手当 <strong>{yen.format(legacyRemote[panel.id])}</strong><br /><small>日付のない既存分は保持し、日別記録の合計に加算します。</small></div>}
          {panel.kind === "cast" && transportUnresolvedLegacyInputs(data, month, panel.id).length > 0 && <div className="notice warn" role="alert"><strong>日付を確認できない送迎代があります。</strong><p>対象日の店舗データを復旧してから編集してください。</p><ul>{transportUnresolvedLegacyInputs(data, month, panel.id).map((input) => <li key={input.id}>{input.label || "送迎代"}：{yen.format(input.amount)}</li>)}</ul></div>}
          <TransportCalendar month={month} attendance={attendance} records={records} selected={panel.date} disabled={waiting} onSelect={selectDay} />
          {!attendance.length && <p className="notice">この月に送信済み・承認済みの出勤日がありません。</p>}
          {panel.date && <section className="transport-day-editor" aria-label={panel.date + "の記録"}>
            <div className="section-head"><h3>{Number(panel.date.slice(5, 7))}月{Number(panel.date.slice(8))}日</h3><StatusPill tone={panel.hadRecord ? "good" : "neutral"}>{panel.hadRecord ? "記録済み" : "未記録"}</StatusPill></div>
            {needsAttendanceRefresh && <p className="notice warn">出勤情報が更新されています。記録を保存して再確認してください。</p>}
            {!selectedAttended && <p className="notice warn">この日の出勤を現在確認できません。この日の全記録の削除はできます。金額を登録・変更するには出勤データを送信してください。</p>}
            {panel.kind === "cast" ? <>
              {panel.hadRecord && <p>現在の送迎代 <strong>{yen.format(panel.originalAmount || 0)}</strong></p>}
              {!calendarCanEdit && <p className="notice warn">在籍外のため新規記録・金額変更はできません。保存済みの記録は削除できます。</p>}
              {needsRegistration && calendarCanEdit && <div className="notice">この日に新しく記録するには、先に送迎情報を登録してください。<button type="button" className="button secondary mini" disabled={disabled || stale} onClick={() => openSettings("register", panel.id)}>送迎情報を登録</button></div>}
              <TransportAmountChoices amounts={candidateAmounts} selected={panel.amount === null ? [] : [panel.amount]} disabled={editingDisabled || !selectedAttended} onSelect={(amount) => setPanel({ ...panel, amount })} />
            </> : <>
              {!calendarCanEdit && <p className="notice warn">ドライバーの登録が削除されているため金額は変更できません。保存済みの記録は日単位で削除できます。</p>}
              {Object.entries(panel.entries).map(([id, amount], index) => <div className="transport-remote-entry" key={id}><span>{index + 1}件目</span><select className="input" aria-label={index + 1 + "件目の遠方手当"} value={amount} disabled={editingDisabled || !selectedAttended} onChange={(event) => setPanel({ ...panel, entries: { ...panel.entries, [id]: Number(event.target.value) } })}>{[...new Set([...candidateAmounts, amount])].sort((a, b) => a - b).map((value) => <option key={value} value={value}>{yen.format(value)}</option>)}</select><button type="button" className="button danger mini" disabled={editingDisabled} aria-label={index + 1 + "件目の遠方手当を削除"} onClick={() => { if (editingDisabled) return; const entries = { ...panel.entries }; delete entries[id]; setPanel({ ...panel, entries }); }}>削除</button></div>)}
              {!Object.keys(panel.entries).length && <p className="muted">この日の遠方手当はありません。</p>}
              <p className="muted compact-text">金額を押して1件追加します。同じ金額を複数回追加できます。</p>
              <TransportAmountChoices amounts={candidateAmounts} selected={[]} disabled={editingDisabled || !selectedAttended} onSelect={(amount) => setPanel({ ...panel, entries: { ...panel.entries, [secureRandomUUID()]: amount } })} />
              {!candidateAmounts.length && <p className="notice">上部の「遠方手当」から候補金額を登録してください。</p>}
              <p className="transport-day-total">この日の合計 <strong>{yen.format(Object.values(panel.entries).reduce((sum, amount) => sum + amount, 0))}</strong></p>
            </>}
            {canRefreshDepartedAttendance && <div className="actions top-gap"><button type="button" className="button" disabled={disabled || stale} onClick={refreshDepartedAttendance}>同じ金額で出勤情報を更新</button></div>}
            <div className="actions top-gap"><button type="button" className="button" disabled={editingDisabled || (!dirty && !needsAttendanceRefresh) || !selectedAttended || (panel.kind === "cast" && (panel.amount === null || !(candidateAmounts.includes(panel.amount) || (needsAttendanceRefresh && panel.amount === panel.originalAmount))))} onClick={() => saveDay()}>記録を保存</button>{panel.hadRecord && <button type="button" className="button danger" disabled={deletionDisabled} onClick={() => setConfirmation({ type: "deleteDay" })}>この日の記録を削除</button>}</div>
          </section>}
          <div className="actions"><button type="button" className="button secondary" disabled={waiting} onClick={() => move(panel.kind === "cast" ? { type: "castMenu", id: panel.id } : null)}>戻る</button></div>
        </div>}
      </>}
    </TransportModal>}
  </div>;
}
