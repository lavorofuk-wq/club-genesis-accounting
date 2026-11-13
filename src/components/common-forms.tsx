"use client";

import { useEffect, useMemo, useRef } from "react";
import type { User } from "firebase/auth";
import { castHasApprovedRegularWork, castHasApprovedWork, castIntroducerForDisplay, castIntroducerOverrideForMonth, castSharedIntroducerMemberForMonth, castStatusForMonth, castTrialRateForMonth } from "@/domain/cast-monthly";
import type { CastRecord, DriverRecord, IntroducerFeeType, IntroducerRecord, LiquorRecord, StaffRecord, WorkspaceData } from "@/domain/gms";
import { dayAfterIsoDate, rateForMonth } from "@/domain/gms";
import { monthlyRatesForSave } from "@/domain/master-pay-validation";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { STAFF_MONTHLY_RATES_START_MONTH, staffMonthlyRateForMonth, staffMonthlyRates, staffMonthlyRatesStartMonth } from "@/domain/staff-rates";
import {
  cancelCastConversion, convertTrialCast, convertTrialStaff, deleteCast, deleteDriver, deleteIntroducer, deleteLiquor, deleteStaff,
  departCast, departStaff, restoreCast, restoreStaff, saveCashFloat, saveCast, saveDriver, saveIntroducer, saveLiquor, saveStaff
} from "@/lib/firebase/repository";
import { Card, Field, Modal, MoneyInput, StatusPill, Table, currentMonth, today, yen } from "./ui";
import { useRecoverableState } from "./update-drafts";

type CommonWorkspaceData = WorkspaceData & Partial<Pick<AccountingWorkspaceData, "archivedCasts" | "introducerMonthEvents" | "introducerDeletionCommits" | "monthStates">>;
type Props = { data: CommonWorkspaceData; user: User; busy: boolean; section: "casts" | "staff" | "drivers" | "introducers" | "liquor" | "cash"; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };

function useCommonDirty(onDirtyChange: Props["onDirtyChange"], dirty: boolean) {
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
}

function isValidIsoDate(value: string) {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateInMonth(month: string) {
  const currentDate = today();
  return currentDate.startsWith(`${month}-`) ? currentDate : `${month}-01`;
}

function promptDepartureDate(month?: string) {
  const message = month ? `${month}月度の退店日をYYYY-MM-DDで入力してください。` : "退店日をYYYY-MM-DDで入力してください。";
  const input = window.prompt(message, month ? dateInMonth(month) : today());
  if (input === null) return null;
  const value = input.trim();
  if (!isValidIsoDate(value)) {
    window.alert("退店日は実在する日付をYYYY-MM-DD形式で入力してください。（例：2026-09-04）");
    return null;
  }
  if (month && value.slice(0, 7) !== month) {
    window.alert("表示中の対象月内の退店日を入力してください。別の月に退店登録する場合は、対象月を切り替えてください。");
    return null;
  }
  return value;
}

function castEntryCancellationReason(cast: CastRecord, trialMonth: string | undefined, data: CommonWorkspaceData) {
  if (!trialMonth) return "元の体入キャストを確認できないため入店取消できません。";
  if (castHasApprovedRegularWork(data.closings, cast.id)) return "承認済みの在籍勤務があるため入店取消できません。";
  const hireMonth = cast.hiredAt?.slice(0, 7);
  const state = data.monthStates?.find((row) => row.month === hireMonth);
  if (state?.status === "closing") return `${hireMonth}月度の月次確定処理が完了するまで入店取消できません。`;
  if (state?.status === "closed") return `入店取消するには${hireMonth}月度の月次確定を解除してください。`;
  return "";
}

export function CommonForms(props: Props) {
  if (props.section === "casts") return <CastManager {...props} />;
  if (props.section === "staff") return <StaffManager {...props} />;
  if (props.section === "drivers") return <DriverManager {...props} />;
  if (props.section === "introducers") return <IntroducerManager {...props} />;
  if (props.section === "liquor") return <LiquorManager {...props} />;
  return <CashSetting {...props} />;
}

function CastManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useRecoverableState<CastRecord["status"]>("common.casts.tab", "active");
  const [editing, setEditing] = useRecoverableState<Partial<CastRecord> | null>("common.casts.editing", null);
  const [sourceTrialId, setSourceTrialId] = useRecoverableState("common.casts.sourceTrialId", "");
  const [introducerOnly, setIntroducerOnly] = useRecoverableState("common.casts.introducerOnly", false);
  const [month, setMonth] = useRecoverableState("common.casts.month", currentMonth());
  const [rate, setRate] = useRecoverableState("common.casts.rate", 0);
  const editedCast = data.casts.find((row) => row.id === editing?.id);
  const [introducerDirty, setIntroducerDirty] = useRecoverableState("common.casts.introducerDirty", () =>
    Boolean(editing && editedCast && editing.updatedAt === editedCast.updatedAt && (
      editing.introducerId !== editedCast.introducerId || editing.attendanceAdvisoryFee !== editedCast.attendanceAdvisoryFee
      || editing.entryAdvisoryFee !== editedCast.entryAdvisoryFee
    )));
  useCommonDirty(onDirtyChange, Boolean(editing));
  const tabs = { active: "在籍キャスト", trial: "体入キャスト", departed: "退店キャスト" };
  const rows = useMemo(() => {
    const grouped: Record<CastRecord["status"], CastRecord[]> = { active: [], trial: [], departed: [] };
    for (const row of data.casts) {
      const status = castStatusForMonth(row, month);
      if (status) grouped[status].push(row);
    }
    grouped.active.sort((a, b) => (b.hiredAt || "").localeCompare(a.hiredAt || ""));
    grouped.trial.sort((a, b) => (b.trialDate || "").localeCompare(a.trialDate || ""));
    grouped.departed.sort((a, b) => (b.departedAt || "").localeCompare(a.departedAt || ""));
    return grouped;
  }, [data.casts, month]);
  const knownCasts = useMemo(() => [...data.casts, ...(data.archivedCasts || [])], [data.casts, data.archivedCasts]);
  const draftDate = editing?.status === "trial" ? editing.trialDate : editing?.hiredAt;
  const newRegistration = editing && (!editing.id || Boolean(sourceTrialId));
  const useDateMonth = newRegistration || editing?.status === "trial";
  const editMonth = useDateMonth && draftDate && isValidIsoDate(draftDate) ? draftDate.slice(0, 7) : month;
  const sharedMember = editedCast && !newRegistration ? castSharedIntroducerMemberForMonth(editedCast, month, knownCasts) : undefined;
  const sharedIntroducer = sharedMember && sharedMember.id !== editedCast?.id ? sharedMember : undefined;
  const introducer = data.introducers.find((row) => row.id === editing?.introducerId);
  const historicalIntroducer = !introducer && editing?.introducerId && editedCast
    ? castIntroducerForDisplay(editedCast, month, data) : undefined;
  const canSetNoIntroducer = editedCast && !newRegistration && !editing?.introducerId && !introducerDirty
    && castIntroducerOverrideForMonth(editedCast, month) !== false;
  const entryFeeMonth = editing?.status !== "trial" && editing?.hiredAt?.slice(0, 7) === editMonth;

  const begin = (row?: CastRecord, mode: "details" | "conversion" | "introducer" = "details") => {
    const converting = mode === "conversion";
    setSourceTrialId(converting && row ? row.id : "");
    setIntroducerOnly(mode === "introducer");
    setIntroducerDirty(false);
    setRate(row && row.status !== "trial" ? rateForMonth(row.hourlyRates, month) : 0);
    if (!row) {
      const date = dateInMonth(month);
      setEditing({ status: tab, name: "", legalName: "", hiredAt: date, trialDate: date, hourlyRates: {}, trialHourlyRate: 0, note: "" });
      return;
    }
    const terms = castIntroducerForDisplay(row, month, data);
    const value = {
      ...row,
      introducerId: terms?.id,
      attendanceAdvisoryFee: terms?.attendanceAdvisoryFee,
      entryAdvisoryFee: terms?.entryAdvisoryFee,
      trialHourlyRate: row.status === "trial" ? castTrialRateForMonth(row, month) : row.trialHourlyRate,
    };
    const currentDate = today();
    setEditing(converting ? { ...value, status: "active", hiredAt: row.trialDate && row.trialDate > currentDate ? row.trialDate : currentDate, hourlyRates: {} } : value);
  };

  const cancelEntry = async (row: CastRecord, trialMonth: string) => {
    const hasUnapprovedWork = data.closings.some((closing) => closing.status !== "approved"
      && closing.casts.some((cast) => cast.kind === "regular" && cast.masterId === row.id));
    const recheck = hasUnapprovedWork ? "\n承認前の日次は残ります。再送・承認の前にキャスト照合を修正してください。" : "";
    if (!window.confirm(`「${row.name}」の入店を取り消し、${trialMonth}月度の体入キャストに戻しますか？\n入店顧問料も取り消します。${recheck}`)) return;
    if (await run(() => cancelCastConversion(row.id, row.updatedAt, user), "入店を取り消し、元の体入キャストに戻しました。")) {
      setMonth(trialMonth);
      setTab("trial");
    }
  };

  return <div className="grid">
    <Card><div className="month-toolbar"><Field label="対象月"><input className="input" type="month" value={month} disabled={busy || Boolean(editing)} onChange={(event) => {
      const next = event.target.value;
      if (isValidIsoDate(`${next}-01`)) setMonth(next);
    }} /></Field></div></Card>
    <div className="tabs" role="tablist">{(["active", "trial", "departed"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{tabs[value]}<b>{rows[value].length}</b></button>)}</div>
    <Card title={`${tabs[tab]}データ`} description={`${month}月度のキャスト・時給・紹介者を管理します。`} action={tab !== "departed" ? <button className="button" disabled={busy} onClick={() => begin()}>新規登録</button> : null}>
      <Table headers={["キャスト名", "本名", tab === "trial" ? "体入時給" : "月度時給", tab === "trial" ? "体入日" : tab === "departed" ? "退店日" : "採用日", "紹介者", "備考", "操作"]}>
        {rows[tab].map((row) => {
          const rowRate = tab === "trial" ? castTrialRateForMonth(row, month) : rateForMonth(row.hourlyRates, month);
          const terms = castIntroducerForDisplay(row, month, data);
          const canRegisterDeparture = row.status === "active";
          const hasApprovedWork = canRegisterDeparture && castHasApprovedWork(data.closings, knownCasts, month, row.id);
          const converted = tab === "trial" ? knownCasts.find((item) => !item.entryCancelledAt
            && (item.id === row.convertedToCastId || item.convertedFromTrialId === row.id)) : undefined;
          const shared = castSharedIntroducerMemberForMonth(row, month, knownCasts);
          const hasEntryConversion = row.status === "active" && Boolean(row.convertedFromTrialId);
          const entryTrial = hasEntryConversion ? data.casts.find((item) => item.id === row.convertedFromTrialId
            && item.status === "trial" && item.convertedToCastId === row.id && !item.deletedAt) : undefined;
          const trialMonth = entryTrial?.trialDate && isValidIsoDate(entryTrial.trialDate) ? entryTrial.trialDate.slice(0, 7) : undefined;
          const cancelReason = hasEntryConversion ? castEntryCancellationReason(row, trialMonth, data) : "";
          return <tr key={row.id}>
            <td><strong>{row.name}</strong></td><td>{row.legalName || "—"}</td><td>{rowRate > 0 ? yen.format(rowRate) : "—"}</td>
            <td>{tab === "trial" ? row.trialDate : tab === "departed" ? row.departedAt : row.hiredAt}</td>
            <td>{terms?.name || "—"}</td><td className="wrap-cell">{row.note || "—"}</td>
            <td><div className="row-actions">
              <button className="button secondary mini" disabled={busy} onClick={() => begin(row)}>編集</button>
              {canRegisterDeparture && <button className="button secondary mini" disabled={busy || hasApprovedWork} onClick={() => {
                const date = promptDepartureDate(month);
                if (date) void run(() => departCast(row.id, date, row.updatedAt, user), "退店を登録しました。");
              }}>退店</button>}
              {hasEntryConversion && <button type="button" className="button danger mini" disabled={busy || Boolean(cancelReason)} onClick={() => {
                if (trialMonth && !cancelReason) return cancelEntry(row, trialMonth);
              }}>入店取消</button>}
              {tab === "trial" && (row.convertedToCastId || converted
                ? <StatusPill tone="good">{converted?.hiredAt ? `${converted.hiredAt} 入店` : "入店済み"}</StatusPill>
                : <button className="button secondary mini" disabled={busy} onClick={() => begin(row, "conversion")}>入店</button>)}
              {shared.id !== row.id && !shared.deletedAt && <button className="button secondary mini" disabled={busy} onClick={() => begin(shared, "introducer")}>紹介者変更</button>}
              {tab === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => restoreCast(row.id, row.updatedAt, user), "退店登録を取り消しました。")}>退店取消</button>}
              {(tab === "trial" || tab === "departed") && <button className="button danger mini" disabled={busy} onClick={() => {
                const message = tab === "trial" ? `体入キャスト「${row.name}」を完全削除しますか？\n過去の送信済み日次データは削除されません。` : `「${row.name}」を完全削除しますか？`;
                if (window.confirm(message)) void run(() => deleteCast(row.id, row.updatedAt, user), "キャストデータを完全削除しました。");
              }}>完全削除</button>}
            </div>{hasApprovedWork && <div><small className="muted">対象月に承認済みの勤務があるため退店できません。</small></div>}
            {cancelReason && <div><small className="muted">{cancelReason}</small></div>}</td>
          </tr>;
        })}
      </Table>
    </Card>
    {editing && <Modal title={introducerOnly ? `${editing.name}の紹介者変更` : sourceTrialId ? "体入キャストを入店登録" : editing.id ? "キャストデータ編集" : editing.status === "trial" ? "体入キャスト登録" : "新規キャスト入店"} disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      if (introducerOnly && !introducerDirty) return;
      const value = { ...editing } as Parameters<typeof saveCast>[0];
      if (!entryFeeMonth) delete value.entryAdvisoryFee;
      if (sharedIntroducer || (!newRegistration && !introducerDirty)) {
        delete value.introducerId;
        delete value.attendanceAdvisoryFee;
        delete value.entryAdvisoryFee;
      }
      let saved: boolean;
      if (introducerOnly) {
        delete value.hourlyRates;
        saved = await run(() => saveCast(value, user, editMonth), "月度の紹介者を更新しました。");
      } else if (sourceTrialId) saved = await run(() => convertTrialCast(sourceTrialId, { ...value, hiredAt: value.hiredAt || dateInMonth(editMonth), hourlyRates: { [editMonth]: rate } }, user, editMonth), "体入キャストを在籍登録しました。");
      else saved = await run(() => saveCast({
        ...value,
        hourlyRates: value.status !== "trial"
          ? monthlyRatesForSave(value.hourlyRates || {}, editMonth, rate, !value.id)
          : value.hourlyRates || {},
        trialHourlyRate: value.status === "trial" ? value.trialHourlyRate : undefined,
      }, user, editMonth), value.id ? "キャストデータを更新しました。" : "キャストデータを登録しました。");
      if (saved) {
        setEditing(null);
        if (editMonth !== month) setMonth(editMonth);
        if (sourceTrialId) setTab("active");
      }
    }}>
      {!introducerOnly && <>
      <div className="grid two"><Field label="キャスト名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="本名"><input className="input" required value={editing.legalName || ""} onChange={(e) => setEditing({ ...editing, legalName: e.target.value })} /></Field></div>
      {editing.status === "trial"
        ? <div className="grid two"><Field label="体入日"><input className="input" type="date" required value={editing.trialDate || ""} onChange={(e) => setEditing({ ...editing, trialDate: e.target.value })} /></Field><Field label={`${editMonth}月度の体入時給`}><MoneyInput min={1} value={editing.trialHourlyRate || 0} onChange={(value) => setEditing({ ...editing, trialHourlyRate: value })} /></Field></div>
        : <div className="grid two"><Field label="採用日"><input className="input" type="date" required min={sourceTrialId ? editing.trialDate : undefined} value={editing.hiredAt || ""} onChange={(e) => setEditing({ ...editing, hiredAt: e.target.value })} /></Field><Field label={`${editMonth}月度の時給`}><MoneyInput min={1} value={rate} onChange={setRate} /></Field></div>}
      </>}
      {sharedIntroducer ? <Field label={`${month}月度の紹介者`} hint={sharedIntroducer.deletedAt ? "同月に入店した在籍記録と共有しています。" : "同月の在籍記録と共有しています。変更は一覧の「紹介者変更」から行えます。"}>
        <output>{castIntroducerForDisplay(sharedIntroducer, month, data)?.name || "—"}</output>
      </Field> : <Field label={`${editMonth}月度の紹介者`} hint="未確定月は対象月全体に選択した紹介者を適用します。「紹介者なし」の紹介料・顧問料は0円です。確定済みの支払は確定時の金額を使用します。"><select className="input" value={editing.introducerId || (canSetNoIntroducer ? "__unset__" : "")} onChange={(e) => {
        const introducerId = e.target.value || undefined;
        const selectedIntroducer = data.introducers.find((row) => row.id === introducerId);
        setIntroducerDirty(true);
        setEditing({
          ...editing,
          introducerId,
          attendanceAdvisoryFee: selectedIntroducer?.attendanceAdvisoryEnabled ? editing.attendanceAdvisoryFee : undefined,
          entryAdvisoryFee: selectedIntroducer?.entryAdvisoryEnabled ? editing.entryAdvisoryFee : undefined,
        });
      }}>{canSetNoIntroducer && <option value="__unset__" disabled>月度の紹介者未設定</option>}<option value="">紹介者なし</option>{!introducer && editing.introducerId && <option value={editing.introducerId} disabled>{historicalIntroducer?.name || "紹介者"}（削除済み）</option>}{data.introducers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>}
      {editing.status !== "trial" && introducer && <div className="grid two">
        {introducer.attendanceAdvisoryEnabled && <Field label="1出勤あたり顧問料"><MoneyInput value={editing.attendanceAdvisoryFee || 0} onChange={(value) => {
          setIntroducerDirty(true);
          setEditing({ ...editing, attendanceAdvisoryFee: value });
        }} /></Field>}
        {entryFeeMonth && introducer.entryAdvisoryEnabled && <Field label="入店顧問料"><MoneyInput showZero value={editing.entryAdvisoryFee ?? 0} onChange={(value) => {
          setIntroducerDirty(true);
          setEditing({ ...editing, entryAdvisoryFee: value });
        }} /><small>0円で保存すると、未確定の入店顧問料を取り消します。</small></Field>}
      </div>}
      {!introducerOnly && <Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>}
      <div className="actions"><button className="button" disabled={busy || (introducerOnly && !introducerDirty)}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div>
    </form></Modal>}
  </div>;
}

function StaffManager(props: Props) {
  const [kind, setKind] = useRecoverableState<"hourly" | "employee">("common.staff.kind", "hourly");
  return <div className="grid">
    <div className="tabs"><button className={kind === "hourly" ? "active" : ""} disabled={props.busy} onClick={() => setKind("hourly")}>アルバイトスタッフ</button><button className={kind === "employee" ? "active" : ""} disabled={props.busy} onClick={() => setKind("employee")}>社員</button></div>
    {kind === "employee" ? <EmployeeStaffManager {...props} />
      : <HourlyStaffManager {...props} data={{ ...props.data, staff: props.data.staff.filter((row) => row.employmentType !== "employee") }} />}
  </div>;
}

function EmployeeStaffManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useRecoverableState<"active" | "departed">("common.employees.tab", "active");
  const [editing, setEditing] = useRecoverableState<Partial<StaffRecord> | null>("common.employees.editing", null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  const employees = data.staff.filter((row) => row.employmentType === "employee");
  return <div className="grid">
    <div className="tabs">{(["active", "departed"] as const).map((status) => <button key={status} className={tab === status ? "active" : ""} onClick={() => setTab(status)}>{status === "active" ? "在籍社員" : "退職社員"}<b>{employees.filter((row) => row.status === status).length}</b></button>)}</div>
    <Card title="社員データ" action={tab === "active" ? <button className="button" disabled={busy} onClick={() => setEditing({ employmentType: "employee", status: "active", name: "", hiredAt: today(), note: "" })}>社員を追加</button> : null}>
      <Table headers={["名前", "入社日", ...(tab === "departed" ? ["退職日"] : []), "操作"]}>{employees.filter((row) => row.status === tab).map((row) => <tr key={row.id}>
        <td><strong>{row.name}</strong></td><td>{row.hiredAt}</td>{tab === "departed" && <td>{row.departedAt}</td>}
        <td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing({ ...row })}>編集</button>
          {row.status === "active" ? <button className="button secondary mini" disabled={busy} onClick={() => {
            const entered = window.prompt("退職日をYYYY-MM-DDで入力してください。", today());
            if (entered === null) return;
            const date = entered.trim();
            if (!isValidIsoDate(date)) { window.alert("退職日は実在する日付をYYYY-MM-DD形式で入力してください。"); return; }
            void run(() => departStaff(row.id, date, row.updatedAt, user), "社員の退職を登録しました。");
          }}>退職</button> : <>
            <button className="button secondary mini" disabled={busy} onClick={() => void run(() => restoreStaff(row.id, row.updatedAt, user), "退職登録を取り消しました。")}>退職取消</button>
            <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？\n過去の送信済み日払い・確定済みデータは保持します。`)) void run(() => deleteStaff(row.id, row.updatedAt, user), "社員を完全削除しました。"); }}>完全削除</button>
          </>}
        </div></td>
      </tr>)}</Table>
    </Card>
    {editing && <Modal title="社員登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      const saved = await run(() => saveStaff({ ...editing, employmentType: "employee", name: editing.name || "", status: editing.status === "departed" ? "departed" : "active" }, user), editing.id ? "社員を更新しました。" : "社員を登録しました。");
      if (saved) setEditing(null);
    }}>
      <Field label="名前"><input className="input" required value={editing.name || ""} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field>
      <Field label="入社日"><input className="input" type="date" required value={editing.hiredAt || ""} onChange={(event) => setEditing({ ...editing, hiredAt: event.target.value })} /></Field>
      <div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div>
    </form></Modal>}
  </div>;
}

function HourlyStaffManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useRecoverableState<StaffRecord["status"]>("common.staff.tab", "active");
  const [editing, setEditing] = useRecoverableState<Partial<StaffRecord> | null>("common.staff.editing", null);
  const [sourceTrialId, setSourceTrialId] = useRecoverableState("common.staff.sourceTrialId", "");
  const defaultMonth = currentMonth() < STAFF_MONTHLY_RATES_START_MONTH ? STAFF_MONTHLY_RATES_START_MONTH : currentMonth();
  const [month, setMonth] = useRecoverableState("common.staff.month", defaultMonth);
  const [rate, setRate] = useRecoverableState("common.staff.rate", () => editing?.status !== "trial" && editing
    ? staffMonthlyRateForMonth(editing, month) : 0);
  useCommonDirty(onDirtyChange, Boolean(editing));
  const rows = data.staff.filter((row) => row.status === tab);
  const sourceTrial = sourceTrialId ? data.staff.find((row) => row.id === sourceTrialId) : undefined;
  const minimumHireDate = dayAfterIsoDate(sourceTrial?.trialDate);
  const minimumPayMonth = staffMonthlyRatesStartMonth(editing || undefined);
  const begin = (status: StaffRecord["status"], row?: StaffRecord) => {
    const selectedMonth = [defaultMonth, staffMonthlyRatesStartMonth(row)].sort().at(-1)!;
    setSourceTrialId(""); setMonth(selectedMonth);
    setRate(row && status !== "trial" ? staffMonthlyRateForMonth(row, selectedMonth) : 0);
    setEditing(row ? { ...row, ...(status === "trial" ? {} : { hourlyRates: staffMonthlyRates(row) }) }
      : { status, name: "", hourlyRates: {}, hourlyRate: 0, trialHourlyRate: 0, hiredAt: today(), trialDate: today(), note: "" });
  };
  return <div className="grid"><div className="tabs">{(["active", "trial", "departed"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "active" ? "在籍スタッフ" : value === "trial" ? "体入スタッフ" : "退店スタッフ"}<b>{data.staff.filter((row) => row.status === value).length}</b></button>)}</div>
    <Card title="スタッフデータ" description="2026年9月以降の在籍時給は月度ごとに設定し、未設定月は直前の設定を引き継ぎます。" action={tab !== "departed" ? <button className="button" disabled={busy} onClick={() => begin(tab)}>新規登録</button> : null}>
      <Table headers={["名前", tab === "trial" ? "体入時給" : "当月時給", "日付", "備考", "操作"]}>{rows.map((row) => <tr key={row.id}>
        <td><strong>{row.name}</strong></td><td>{yen.format(row.status === "trial" ? row.trialHourlyRate || 0 : staffMonthlyRateForMonth(row, currentMonth()))}</td>
        <td>{row.status === "trial" ? row.trialDate : row.status === "departed" ? row.departedAt : row.hiredAt}</td><td>{row.note || "—"}</td><td><div className="row-actions">
          <button className="button secondary mini" disabled={busy} onClick={() => begin(row.status, row)}>編集</button>
          {row.status === "trial" && (row.convertedToStaffId ? <StatusPill tone="good">入店済み</StatusPill> : <button className="button secondary mini" disabled={busy} onClick={() => {
            const firstHireDate = dayAfterIsoDate(row.trialDate);
            const hiredAt = firstHireDate && today() < firstHireDate ? firstHireDate : today();
            begin("active"); setSourceTrialId(row.id); setMonth([defaultMonth, hiredAt.slice(0, 7)].sort().at(-1)!);
            setEditing({ ...row, status: "active", hiredAt, hourlyRates: {}, hourlyRate: 0 });
          }}>入店</button>)}
          {row.status === "trial" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`体入スタッフ「${row.name}」を完全削除しますか？\n過去の送信済み日次データは削除されません。`)) void run(() => deleteStaff(row.id, row.updatedAt, user), "体入スタッフを完全削除しました。"); }}>完全削除</button>}
          {row.status === "active" && <button className="button secondary mini" disabled={busy} onClick={() => { const date = promptDepartureDate(); if (date) void run(() => departStaff(row.id, date, row.updatedAt, user), "退店スタッフへ移管しました。"); }}>退店</button>}
          {row.status === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => restoreStaff(row.id, row.updatedAt, user), "退店登録を取り消しました。")}>退店取消</button>}
          {row.status === "departed" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？`)) void run(() => deleteStaff(row.id, row.updatedAt, user), "スタッフを完全削除しました。"); }}>完全削除</button>}
        </div></td>
      </tr>)}</Table>
    </Card>
    {editing && <Modal title={sourceTrialId ? "体入スタッフを入店登録" : "スタッフ登録・編集"} disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      const row = editing as StaffRecord;
      const value = row.status === "trial" ? row : {
        ...row,
        hourlyRates: monthlyRatesForSave(staffMonthlyRates(row), month, rate, !row.id || Boolean(sourceTrialId)),
        // 8月以前の互換単価は維持し、9月以降は月度設定を使用する。
        hourlyRate: row.id && !sourceTrialId ? row.hourlyRate : rate,
      };
      const saved = sourceTrialId
        ? await run(() => convertTrialStaff(sourceTrialId, { ...value, hiredAt: row.hiredAt || today(), hourlyRate: rate }, user), "体入スタッフを在籍登録しました。")
        : await run(() => saveStaff(value, user), row.id ? "スタッフを更新しました。" : "スタッフを登録しました。");
      if (saved) setEditing(null);
    }}>
      <Field label="名前"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
      <div className="grid two"><Field label={editing.status === "trial" ? "体入日" : "採用日"}><input className="input" type="date" required min={sourceTrialId ? minimumHireDate : undefined} value={(editing.status === "trial" ? editing.trialDate : editing.hiredAt) || ""} onChange={(e) => {
        if (editing.status === "trial") setEditing({ ...editing, trialDate: e.target.value });
        else {
          setEditing({ ...editing, hiredAt: e.target.value });
          const nextMinimum = staffMonthlyRatesStartMonth({ hiredAt: e.target.value });
          if (month < nextMinimum) setMonth(nextMinimum);
        }
      }} />{sourceTrialId && <small>採用日は体入日の翌日以降を指定してください。</small>}</Field>
        {editing.status === "trial" ? <Field label="体入時給"><MoneyInput min={1} value={editing.trialHourlyRate || 0} onChange={(value) => setEditing({ ...editing, trialHourlyRate: value })} /></Field>
          : <Field label="時給の対象月"><input className="input" type="month" required min={minimumPayMonth} value={month} onChange={(e) => { setMonth(e.target.value); setRate(staffMonthlyRateForMonth(editing, e.target.value)); }} /></Field>}
      </div>
      {editing.status !== "trial" && <Field label={`${month} 月度時給`} hint="保存すると表示中の対象月・時給を登録します。未確定月は対象月の全勤務へ反映し、確定済み月と保存済みの日払い・現金照合は変更しません。"><MoneyInput min={1} value={rate} onChange={setRate} /></Field>}
      <Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
      <div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div>
    </form></Modal>}
  </div>;
}

function DriverManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useRecoverableState<"active" | "departed">("common.drivers.tab", "active");
  const [editing, setEditing] = useRecoverableState<Partial<DriverRecord> | null>("common.drivers.editing", null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <div className="grid"><div className="tabs"><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>在籍ドライバー<b>{data.drivers.filter((r) => r.status === "active").length}</b></button><button className={tab === "departed" ? "active" : ""} onClick={() => setTab("departed")}>退店ドライバー<b>{data.drivers.filter((r) => r.status === "departed").length}</b></button></div><Card title="送迎ドライバーデータ" action={tab === "active" ? <button className="button" disabled={busy} onClick={() => setEditing({ name: "", hiredAt: today(), dailyRate: 0, status: "active", note: "" })}>新規登録</button> : null}><Table headers={tab === "departed" ? ["名前", "採用日", "退店日", "日給", "備考", "操作"] : ["名前", "採用日", "日給", "備考", "操作"]}>{data.drivers.filter((r) => r.status === tab).map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hiredAt}</td>{tab === "departed" && <td>{row.departedAt || "—"}</td>}<td>{yen.format(row.dailyRate)}</td><td>{row.note || "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button>{row.status === "active" && <button className="button secondary mini" disabled={busy} onClick={() => { const date = promptDepartureDate(); if (date) void run(() => saveDriver({ ...row, status: "departed", departedAt: date }, user), "退店ドライバーへ移管しました。"); }}>退店</button>}{row.status === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => saveDriver({ ...row, status: "active", departedAt: undefined }, user), "退店登録を取り消しました。")}>退店取消</button>}{row.status === "departed" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？`)) void run(() => deleteDriver(row.id, row.updatedAt, user), "ドライバーを完全削除しました。"); }}>完全削除</button>}</div></td></tr>)}</Table></Card>{editing && <Modal title="ドライバー登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveDriver(editing as DriverRecord, user), editing.id ? "ドライバーを更新しました。" : "ドライバーを登録しました。"); if (saved) setEditing(null); }}><Field label="名前"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid two"><Field label="採用日"><input className="input" required type="date" value={editing.hiredAt || ""} onChange={(e) => setEditing({ ...editing, hiredAt: e.target.value })} /></Field><Field label="日給"><MoneyInput min={1} value={editing.dailyRate || 0} onChange={(value) => setEditing({ ...editing, dailyRate: value })} /></Field></div><Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</div>;
}

const feeLabels: Record<IntroducerFeeType, string> = { sales10: "本指名売上10%", netSales10: "酒代原価引き売上10%", gross10: "総支給額10%", higherSalesGross10: "売上10%・総支給額10%の高い方", higherNetSalesGross10: "原価引き売上10%・総支給額10%の高い方" };

export function introducerDeletionConfirmation(introducerName: string, linkedCasts: Pick<CastRecord, "name" | "status">[]) {
  if (!linkedCasts.length) return `「${introducerName}」を削除しますか？`;
  const statusLabels: Record<CastRecord["status"], string> = { active: "在籍", trial: "体入", departed: "退店" };
  const castList = [...linkedCasts]
    .sort((left, right) => left.name.localeCompare(right.name, "ja") || left.status.localeCompare(right.status))
    .map((cast) => `・${cast.name}（${statusLabels[cast.status]}）`)
    .join("\n");
  return `「${introducerName}」には次のキャストが紐づいています。\n\n${castList}\n\nこのまま削除すると、上記キャストは削除した月の紹介者報酬（歩合・出勤顧問料・入店顧問料）が発生しません。\n同じ月に有効な紹介者を設定し直した場合のみ、その紹介者を当月全体の算出対象にします。\n\n削除を続けますか？`;
}

function IntroducerManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [editing, setEditing] = useRecoverableState<Partial<IntroducerRecord> | null>("common.introducers.editing", null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <Card title="紹介者データ" description="報酬形態と顧問料の有無を管理します。" action={<button className="button" disabled={busy} onClick={() => setEditing({ name: "", feeType: "sales10", attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false, note: "" })}>新規登録</button>}><Table headers={["紹介者", "報酬形態", "出勤顧問料", "入店顧問料", "備考", "操作"]}>{data.introducers.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td className="wrap-cell">{feeLabels[row.feeType]}</td><td>{row.attendanceAdvisoryEnabled ? "あり" : "なし"}</td><td>{row.entryAdvisoryEnabled ? "あり" : "なし"}</td><td>{row.note || "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button><button className="button danger mini" disabled={busy} onClick={() => { const linkedCasts = data.casts.filter((cast) => cast.introducerId === row.id); if (window.confirm(introducerDeletionConfirmation(row.name, linkedCasts))) void run(() => deleteIntroducer(row.id, row.updatedAt, linkedCasts.map(({ id, updatedAt }) => ({ id, updatedAt })), user), "紹介者を削除しました。"); }}>削除</button></div></td></tr>)}</Table>{editing && <Modal title="紹介者登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveIntroducer(editing as IntroducerRecord, user), editing.id ? "紹介者を更新しました。" : "紹介者を登録しました。"); if (saved) setEditing(null); }}><Field label="紹介者名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="紹介者報酬形態"><select className="input" value={editing.feeType} onChange={(e) => setEditing({ ...editing, feeType: e.target.value as IntroducerFeeType })}>{Object.entries(feeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><div className="grid two"><label className="check-row"><input type="checkbox" checked={editing.attendanceAdvisoryEnabled || false} onChange={(e) => setEditing({ ...editing, attendanceAdvisoryEnabled: e.target.checked })} />出勤顧問料あり</label><label className="check-row"><input type="checkbox" checked={editing.entryAdvisoryEnabled || false} onChange={(e) => setEditing({ ...editing, entryAdvisoryEnabled: e.target.checked })} />入店顧問料あり</label></div><Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</Card>;
}

function LiquorManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useRecoverableState<LiquorRecord["kind"]>("common.liquor.tab", "champagneWine");
  const [editing, setEditing] = useRecoverableState<Partial<LiquorRecord> | null>("common.liquor.editing", null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <div className="grid"><div className="tabs"><button className={tab === "champagneWine" ? "active" : ""} onClick={() => setTab("champagneWine")}>シャンパン・ワイン</button><button className={tab === "keepBottle" ? "active" : ""} onClick={() => setTab("keepBottle")}>キープボトル</button></div><Card title="酒代原価データ" action={<button className="button" disabled={busy} onClick={() => setEditing({ kind: tab, name: "", salePrice: 0, costPrice: 0 })}>新規登録</button>}><Table headers={["ボトル名", "販売金額", "酒代原価", "原価率", "操作"]}>{data.liquor.filter((row) => row.kind === tab).map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{yen.format(row.salePrice)}</td><td>{yen.format(row.costPrice)}</td><td>{row.salePrice ? `${Math.round(row.costPrice / row.salePrice * 1000) / 10}%` : "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button><button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を削除しますか？`)) void run(() => deleteLiquor(row.id, row.updatedAt, user), "酒代原価を削除しました。"); }}>削除</button></div></td></tr>)}</Table>{editing && <Modal title="酒代原価登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveLiquor(editing as LiquorRecord, user), editing.id ? "酒代原価を更新しました。" : "酒代原価を登録しました。"); if (saved) setEditing(null); }}><Field label="区分"><select className="input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as LiquorRecord["kind"] })}><option value="champagneWine">シャンパン・ワイン</option><option value="keepBottle">キープボトル</option></select></Field><Field label="ボトル名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid two"><Field label="販売金額"><MoneyInput value={editing.salePrice || 0} onChange={(value) => setEditing({ ...editing, salePrice: value })} /></Field><Field label="酒代原価"><MoneyInput value={editing.costPrice || 0} onChange={(value) => setEditing({ ...editing, costPrice: value })} /></Field></div><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</Card></div>;
}

function CashSetting({ data, user, busy, run, onDirtyChange }: Props) {
  const [amount, setAmount] = useRecoverableState("common.cash.amount", data.cashFloat);
  const loadedCashFloat = useRef(data.cashFloat);
  useEffect(() => {
    if (loadedCashFloat.current === data.cashFloat) return;
    loadedCashFloat.current = data.cashFloat;
    setAmount(data.cashFloat);
  }, [data.cashFloat, setAmount]);
  useCommonDirty(onDirtyChange, amount !== data.cashFloat);
  return <Card title="現金照合設定" description="営業開始時につり銭として用意する金額です。"><div className="setting-row"><Field label="つり銭設定額"><MoneyInput value={amount} onChange={setAmount} /></Field><button className="button" disabled={busy || amount < 0} onClick={() => void run(() => saveCashFloat(amount, user), "つり銭金額を保存しました。")}>保存</button></div></Card>;
}
