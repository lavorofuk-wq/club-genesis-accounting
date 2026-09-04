"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import type { CastRecord, DriverRecord, IntroducerFeeType, IntroducerRecord, LiquorRecord, StaffRecord, WorkspaceData } from "@/domain/gms";
import { rateForMonth } from "@/domain/gms";
import {
  convertTrialCast, convertTrialStaff, deleteCast, deleteDriver, deleteIntroducer, deleteLiquor, deleteStaff,
  departCast, departStaff, restoreCast, restoreStaff, saveCashFloat, saveCast, saveDriver, saveIntroducer, saveLiquor, saveStaff
} from "@/lib/firebase/repository";
import { Card, Field, Modal, MoneyInput, StatusPill, Table, currentMonth, today, yen } from "./ui";

type Props = { data: WorkspaceData; user: User; busy: boolean; section: "casts" | "staff" | "drivers" | "introducers" | "liquor" | "cash"; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };

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

function promptDepartureDate() {
  const input = window.prompt("退店日をYYYY-MM-DDで入力してください。", today());
  if (input === null) return null;
  const value = input.trim();
  if (!isValidIsoDate(value)) {
    window.alert("退店日は実在する日付をYYYY-MM-DD形式で入力してください。（例：2026-09-04）");
    return null;
  }
  return value;
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
  const [tab, setTab] = useState<CastRecord["status"]>("active");
  const [editing, setEditing] = useState<Partial<CastRecord> | null>(null);
  const [sourceTrialId, setSourceTrialId] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [rate, setRate] = useState(0);
  useCommonDirty(onDirtyChange, Boolean(editing));
  const rows = useMemo(() => data.casts.filter((row) => row.status === tab).sort((a, b) => (b.trialDate || b.hiredAt || "").localeCompare(a.trialDate || a.hiredAt || "")), [data.casts, tab]);
  const begin = (status: CastRecord["status"], row?: CastRecord) => {
    setSourceTrialId(""); setTab(status); setMonth(currentMonth());
    setRate(row && status !== "trial" ? rateForMonth(row.hourlyRates, currentMonth()) : 0);
    setEditing(row ? { ...row } : { status, name: "", legalName: "", hiredAt: today(), trialDate: today(), hourlyRates: {}, trialHourlyRate: 0, note: "" });
  };
  const introducer = data.introducers.find((row) => row.id === editing?.introducerId);
  return <div className="grid">
    <div className="tabs" role="tablist">{(["active", "trial", "departed"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "active" ? "在籍キャスト" : value === "trial" ? "体入キャスト" : "退店キャスト"}<b>{data.casts.filter((row) => row.status === value).length}</b></button>)}</div>
    <Card title={tab === "active" ? "在籍キャストデータ" : tab === "trial" ? "体入キャストデータ" : "退店キャストデータ"} description="登録時点の情報と月度時給を管理します。" action={tab !== "departed" ? <button className="button" disabled={busy} onClick={() => begin(tab)}>新規登録</button> : null}>
      <Table headers={["キャスト名", "本名", tab === "trial" ? "体入時給" : "当月時給", tab === "trial" ? "体入日" : tab === "departed" ? "退店日" : "採用日", "紹介者", "備考", "操作"]}>
        {rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{row.legalName || "—"}</td><td>{yen.format(row.status === "trial" ? row.trialHourlyRate || 0 : rateForMonth(row.hourlyRates, currentMonth()))}</td><td>{row.status === "trial" ? row.trialDate : row.status === "departed" ? row.departedAt : row.hiredAt}</td><td>{data.introducers.find((item) => item.id === row.introducerId)?.name || "—"}</td><td className="wrap-cell">{row.note || "—"}</td><td><div className="row-actions">
          <button className="button secondary mini" disabled={busy} onClick={() => begin(row.status, row)}>編集</button>
          {row.status === "active" && <button className="button secondary mini" disabled={busy} onClick={() => { const date = promptDepartureDate(); if (date) void run(() => departCast(row.id, date, row.updatedAt, user), "退店キャストへ移管しました。"); }}>退店</button>}
          {row.status === "trial" && (row.convertedToCastId ? <StatusPill tone="good">入店済み</StatusPill> : <button className="button secondary mini" disabled={busy} onClick={() => { begin("active"); setSourceTrialId(row.id); setEditing({ ...row, status: "active", hiredAt: today(), hourlyRates: {} }); }}>入店</button>)}
          {row.status === "trial" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`体入キャスト「${row.name}」を完全削除しますか？\n過去の送信済み日次データは削除されません。`)) void run(() => deleteCast(row.id, row.updatedAt, user), "体入キャストを完全削除しました。"); }}>完全削除</button>}
          {row.status === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => restoreCast(row.id, row.updatedAt, user), "退店登録を取り消しました。")}>退店取消</button>}
          {row.status === "departed" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？`)) void run(() => deleteCast(row.id, row.updatedAt, user), "キャストデータを完全削除しました。"); }}>完全削除</button>}
        </div></td></tr>)}
      </Table>
    </Card>
    {editing && <Modal title={sourceTrialId ? "体入キャストを入店登録" : editing.id ? "キャストデータ編集" : editing.status === "trial" ? "体入キャスト登録" : "新規キャスト入店"} disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (event) => {
      event.preventDefault();
      const value = editing as CastRecord;
      let saved: boolean;
      if (sourceTrialId) saved = await run(() => convertTrialCast(sourceTrialId, { ...value, hiredAt: value.hiredAt || today(), hourlyRates: { [month]: rate } }, user), "体入キャストを在籍登録しました。");
      else saved = await run(() => saveCast({ ...value, hourlyRates: value.status !== "trial" ? { ...(value.hourlyRates || {}), [month]: rate } : {}, trialHourlyRate: value.status === "trial" ? value.trialHourlyRate : undefined }, user), value.id ? "キャストデータを更新しました。" : "キャストデータを登録しました。");
      if (saved) setEditing(null);
    }}>
      <div className="grid two"><Field label="キャスト名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="本名"><input className="input" required value={editing.legalName || ""} onChange={(e) => setEditing({ ...editing, legalName: e.target.value })} /></Field></div>
      {editing.status === "trial" ? <div className="grid two"><Field label="体入時給"><MoneyInput value={editing.trialHourlyRate || 0} onChange={(value) => setEditing({ ...editing, trialHourlyRate: value })} /></Field><Field label="体入日"><input className="input" type="date" required value={editing.trialDate || ""} onChange={(e) => setEditing({ ...editing, trialDate: e.target.value })} /></Field></div> : <div className="grid three"><Field label="採用日"><input className="input" type="date" required value={editing.hiredAt || ""} onChange={(e) => setEditing({ ...editing, hiredAt: e.target.value })} /></Field><Field label="時給の対象月"><input className="input" type="month" required value={month} onChange={(e) => { setMonth(e.target.value); setRate(rateForMonth(editing.hourlyRates || {}, e.target.value)); }} /></Field><Field label={`${month} 月度時給`}><MoneyInput value={rate} onChange={setRate} /></Field></div>}
      <Field label="紹介者"><select className="input" value={editing.introducerId || ""} onChange={(e) => {
        const introducerId = e.target.value || undefined;
        const selectedIntroducer = data.introducers.find((row) => row.id === introducerId);
        setEditing({
          ...editing,
          introducerId,
          attendanceAdvisoryFee: selectedIntroducer?.attendanceAdvisoryEnabled ? editing.attendanceAdvisoryFee : undefined,
          entryAdvisoryFee: selectedIntroducer?.entryAdvisoryEnabled ? editing.entryAdvisoryFee : undefined,
        });
      }}><option value="">紹介者なし</option>{data.introducers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
      {editing.status !== "trial" && introducer && <div className="grid two">{introducer.attendanceAdvisoryEnabled && <Field label="1出勤あたり顧問料"><MoneyInput value={editing.attendanceAdvisoryFee || 0} onChange={(value) => setEditing({ ...editing, attendanceAdvisoryFee: value })} /></Field>}{introducer.entryAdvisoryEnabled && <Field label="入店顧問料"><MoneyInput value={editing.entryAdvisoryFee || 0} onChange={(value) => setEditing({ ...editing, entryAdvisoryFee: value })} /></Field>}</div>}
      <Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field>
      <div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div>
    </form></Modal>}
  </div>;
}

function StaffManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useState<StaffRecord["status"]>("active");
  const [editing, setEditing] = useState<Partial<StaffRecord> | null>(null);
  const [sourceTrialId, setSourceTrialId] = useState("");
  useCommonDirty(onDirtyChange, Boolean(editing));
  const rows = data.staff.filter((row) => row.status === tab);
  const begin = (status: StaffRecord["status"], row?: StaffRecord) => { setSourceTrialId(""); setEditing(row ? { ...row } : { status, name: "", hourlyRate: 0, trialHourlyRate: 0, hiredAt: today(), trialDate: today(), note: "" }); };
  return <div className="grid"><div className="tabs">{(["active", "trial", "departed"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "active" ? "在籍スタッフ" : value === "trial" ? "体入スタッフ" : "退店スタッフ"}<b>{data.staff.filter((row) => row.status === value).length}</b></button>)}</div>
    <Card title="スタッフデータ" action={tab !== "departed" ? <button className="button" disabled={busy} onClick={() => begin(tab)}>新規登録</button> : null}><Table headers={["名前", "時給", "日付", "備考", "操作"]}>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{yen.format(row.status === "trial" ? row.trialHourlyRate || 0 : row.hourlyRate || 0)}</td><td>{row.status === "trial" ? row.trialDate : row.status === "departed" ? row.departedAt : row.hiredAt}</td><td>{row.note || "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => begin(row.status, row)}>編集</button>{row.status === "trial" && (row.convertedToStaffId ? <StatusPill tone="good">入店済み</StatusPill> : <button className="button secondary mini" disabled={busy} onClick={() => { begin("active"); setSourceTrialId(row.id); setEditing({ ...row, status: "active", hiredAt: today(), hourlyRate: 0 }); }}>入店</button>)}{row.status === "trial" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`体入スタッフ「${row.name}」を完全削除しますか？\n過去の送信済み日次データは削除されません。`)) void run(() => deleteStaff(row.id, row.updatedAt, user), "体入スタッフを完全削除しました。"); }}>完全削除</button>}{row.status === "active" && <button className="button secondary mini" disabled={busy} onClick={() => { const date = promptDepartureDate(); if (date) void run(() => departStaff(row.id, date, row.updatedAt, user), "退店スタッフへ移管しました。"); }}>退店</button>}{row.status === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => restoreStaff(row.id, row.updatedAt, user), "退店登録を取り消しました。")}>退店取消</button>}{row.status === "departed" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？`)) void run(() => deleteStaff(row.id, row.updatedAt, user), "スタッフを完全削除しました。"); }}>完全削除</button>}</div></td></tr>)}</Table></Card>
    {editing && <Modal title={sourceTrialId ? "体入スタッフを入店登録" : "スタッフ登録・編集"} disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (event) => { event.preventDefault(); const row = editing as StaffRecord; const saved = sourceTrialId ? await run(() => convertTrialStaff(sourceTrialId, { ...row, hiredAt: row.hiredAt || today(), hourlyRate: row.hourlyRate || 0 }, user), "体入スタッフを在籍登録しました。") : await run(() => saveStaff(row, user), row.id ? "スタッフを更新しました。" : "スタッフを登録しました。"); if (saved) setEditing(null); }}><Field label="名前"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid two"><Field label={editing.status === "trial" ? "体入時給" : "時給"}><MoneyInput value={editing.status === "trial" ? editing.trialHourlyRate || 0 : editing.hourlyRate || 0} onChange={(value) => setEditing(editing.status === "trial" ? { ...editing, trialHourlyRate: value } : { ...editing, hourlyRate: value })} /></Field><Field label={editing.status === "trial" ? "体入日" : "採用日"}><input className="input" type="date" required value={(editing.status === "trial" ? editing.trialDate : editing.hiredAt) || ""} onChange={(e) => setEditing(editing.status === "trial" ? { ...editing, trialDate: e.target.value } : { ...editing, hiredAt: e.target.value })} /></Field></div><Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}
  </div>;
}

function DriverManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useState<"active" | "departed">("active");
  const [editing, setEditing] = useState<Partial<DriverRecord> | null>(null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <div className="grid"><div className="tabs"><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>在籍ドライバー<b>{data.drivers.filter((r) => r.status === "active").length}</b></button><button className={tab === "departed" ? "active" : ""} onClick={() => setTab("departed")}>退店ドライバー<b>{data.drivers.filter((r) => r.status === "departed").length}</b></button></div><Card title="送迎ドライバーデータ" action={tab === "active" ? <button className="button" disabled={busy} onClick={() => setEditing({ name: "", hiredAt: today(), dailyRate: 0, status: "active", note: "" })}>新規登録</button> : null}><Table headers={tab === "departed" ? ["名前", "採用日", "退店日", "日給", "備考", "操作"] : ["名前", "採用日", "日給", "備考", "操作"]}>{data.drivers.filter((r) => r.status === tab).map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hiredAt}</td>{tab === "departed" && <td>{row.departedAt || "—"}</td>}<td>{yen.format(row.dailyRate)}</td><td>{row.note || "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button>{row.status === "active" && <button className="button secondary mini" disabled={busy} onClick={() => { const date = promptDepartureDate(); if (date) void run(() => saveDriver({ ...row, status: "departed", departedAt: date }, user), "退店ドライバーへ移管しました。"); }}>退店</button>}{row.status === "departed" && <button className="button secondary mini" disabled={busy} onClick={() => void run(() => saveDriver({ ...row, status: "active", departedAt: undefined }, user), "退店登録を取り消しました。")}>退店取消</button>}{row.status === "departed" && <button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を完全削除しますか？`)) void run(() => deleteDriver(row.id, row.updatedAt, user), "ドライバーを完全削除しました。"); }}>完全削除</button>}</div></td></tr>)}</Table></Card>{editing && <Modal title="ドライバー登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveDriver(editing as DriverRecord, user), editing.id ? "ドライバーを更新しました。" : "ドライバーを登録しました。"); if (saved) setEditing(null); }}><Field label="名前"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid two"><Field label="採用日"><input className="input" required type="date" value={editing.hiredAt || ""} onChange={(e) => setEditing({ ...editing, hiredAt: e.target.value })} /></Field><Field label="日給"><MoneyInput value={editing.dailyRate || 0} onChange={(value) => setEditing({ ...editing, dailyRate: value })} /></Field></div><Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</div>;
}

const feeLabels: Record<IntroducerFeeType, string> = { sales10: "本指名売上10%", netSales10: "酒代原価引き売上10%", gross10: "総支給額10%", higherSalesGross10: "売上10%・総支給額10%の高い方", higherNetSalesGross10: "原価引き売上10%・総支給額10%の高い方" };

function IntroducerManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [editing, setEditing] = useState<Partial<IntroducerRecord> | null>(null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <Card title="紹介者データ" description="報酬形態と顧問料の有無を管理します。" action={<button className="button" disabled={busy} onClick={() => setEditing({ name: "", feeType: "sales10", attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false, note: "" })}>新規登録</button>}><Table headers={["紹介者", "報酬形態", "出勤顧問料", "入店顧問料", "備考", "操作"]}>{data.introducers.map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td className="wrap-cell">{feeLabels[row.feeType]}</td><td>{row.attendanceAdvisoryEnabled ? "あり" : "なし"}</td><td>{row.entryAdvisoryEnabled ? "あり" : "なし"}</td><td>{row.note || "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button><button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を削除しますか？`)) void run(() => deleteIntroducer(row.id, row.updatedAt, user), "紹介者を削除しました。"); }}>削除</button></div></td></tr>)}</Table>{editing && <Modal title="紹介者登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveIntroducer(editing as IntroducerRecord, user), editing.id ? "紹介者を更新しました。" : "紹介者を登録しました。"); if (saved) setEditing(null); }}><Field label="紹介者名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="紹介者報酬形態"><select className="input" value={editing.feeType} onChange={(e) => setEditing({ ...editing, feeType: e.target.value as IntroducerFeeType })}>{Object.entries(feeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><div className="grid two"><label className="check-row"><input type="checkbox" checked={editing.attendanceAdvisoryEnabled || false} onChange={(e) => setEditing({ ...editing, attendanceAdvisoryEnabled: e.target.checked })} />出勤顧問料あり</label><label className="check-row"><input type="checkbox" checked={editing.entryAdvisoryEnabled || false} onChange={(e) => setEditing({ ...editing, entryAdvisoryEnabled: e.target.checked })} />入店顧問料あり</label></div><Field label="備考"><textarea className="input" rows={3} value={editing.note || ""} onChange={(e) => setEditing({ ...editing, note: e.target.value })} /></Field><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</Card>;
}

function LiquorManager({ data, user, busy, run, onDirtyChange }: Props) {
  const [tab, setTab] = useState<LiquorRecord["kind"]>("champagneWine");
  const [editing, setEditing] = useState<Partial<LiquorRecord> | null>(null);
  useCommonDirty(onDirtyChange, Boolean(editing));
  return <div className="grid"><div className="tabs"><button className={tab === "champagneWine" ? "active" : ""} onClick={() => setTab("champagneWine")}>シャンパン・ワイン</button><button className={tab === "keepBottle" ? "active" : ""} onClick={() => setTab("keepBottle")}>キープボトル</button></div><Card title="酒代原価データ" action={<button className="button" disabled={busy} onClick={() => setEditing({ kind: tab, name: "", salePrice: 0, costPrice: 0 })}>新規登録</button>}><Table headers={["ボトル名", "販売金額", "酒代原価", "原価率", "操作"]}>{data.liquor.filter((row) => row.kind === tab).map((row) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{yen.format(row.salePrice)}</td><td>{yen.format(row.costPrice)}</td><td>{row.salePrice ? `${Math.round(row.costPrice / row.salePrice * 1000) / 10}%` : "—"}</td><td><div className="row-actions"><button className="button secondary mini" disabled={busy} onClick={() => setEditing(row)}>編集</button><button className="button danger mini" disabled={busy} onClick={() => { if (window.confirm(`「${row.name}」を削除しますか？`)) void run(() => deleteLiquor(row.id, row.updatedAt, user), "酒代原価を削除しました。"); }}>削除</button></div></td></tr>)}</Table>{editing && <Modal title="酒代原価登録・編集" disabled={busy} onClose={() => setEditing(null)}><form className="stack" onSubmit={async (e) => { e.preventDefault(); const saved = await run(() => saveLiquor(editing as LiquorRecord, user), editing.id ? "酒代原価を更新しました。" : "酒代原価を登録しました。"); if (saved) setEditing(null); }}><Field label="区分"><select className="input" value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as LiquorRecord["kind"] })}><option value="champagneWine">シャンパン・ワイン</option><option value="keepBottle">キープボトル</option></select></Field><Field label="ボトル名"><input className="input" required value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid two"><Field label="販売金額"><MoneyInput value={editing.salePrice || 0} onChange={(value) => setEditing({ ...editing, salePrice: value })} /></Field><Field label="酒代原価"><MoneyInput value={editing.costPrice || 0} onChange={(value) => setEditing({ ...editing, costPrice: value })} /></Field></div><div className="actions"><button className="button" disabled={busy}>保存</button><button type="button" className="button secondary" onClick={() => setEditing(null)}>取消</button></div></form></Modal>}</Card></div>;
}

function CashSetting({ data, user, busy, run, onDirtyChange }: Props) {
  const [amount, setAmount] = useState(data.cashFloat);
  useEffect(() => setAmount(data.cashFloat), [data.cashFloat]);
  useCommonDirty(onDirtyChange, amount !== data.cashFloat);
  return <Card title="現金照合設定" description="営業開始時につり銭として用意する金額です。"><div className="setting-row"><Field label="つり銭設定額"><MoneyInput value={amount} onChange={setAmount} /></Field><button className="button" disabled={busy || amount < 0} onClick={() => void run(() => saveCashFloat(amount, user), "つり銭金額を保存しました。")}>保存</button></div></Card>;
}
