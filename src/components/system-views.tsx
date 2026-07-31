"use client";

import { useMemo, useState } from "react";
import { calculateCastRewards } from "@/domain/monthly";
import type { FixedExpense, Introducer, LiquorCost, PartTimeWorker } from "@/domain/types";
import type { WorkspaceData } from "@/lib/firebase/repository";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const currentMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const number = (value: unknown) => Number(value || 0);

export function CastsView({ rows }: { rows: WorkspaceData["casts"] }) {
  const [status, setStatus] = useState<"all" | "active" | "trial" | "departed">("all");
  const sorted = useMemo(() => [...rows]
    .filter((row) => !row.deleted && (status === "all" || row.status === status))
    .sort((a, b) => a.internalNo - b.internalNo || a.name.localeCompare(b.name, "ja")), [rows, status]);
  const counts = {
    active: rows.filter((row) => !row.deleted && row.status === "active").length,
    trial: rows.filter((row) => !row.deleted && row.status === "trial").length,
    departed: rows.filter((row) => !row.deleted && row.status === "departed").length
  };
  return <div className="grid">
    <section className="grid metrics">
      <SmallMetric label="在籍キャスト" value={`${counts.active}名`} />
      <SmallMetric label="体入キャスト" value={`${counts.trial}名`} />
      <SmallMetric label="退店キャスト" value={`${counts.departed}名`} />
      <SmallMetric label="人物台帳合計" value={`${counts.active + counts.trial + counts.departed}名`} />
    </section>
    <section className="card">
      <div className="section-head"><h2>キャスト情報</h2><select className="input filter-select" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
        <option value="all">すべて</option><option value="active">在籍</option><option value="trial">体入</option><option value="departed">退店</option>
      </select></div>
      <div className="table-wrap"><table><thead><tr><th>No.</th><th>名前</th><th>状態</th><th>時給・保証</th><th>入店日</th><th>退店日</th><th>紹介者</th></tr></thead>
        <tbody>{sorted.map((row) => <tr key={row.id}><td>{row.internalNo || "—"}</td><td>{row.name}</td>
          <td><span className={`pill ${row.status === "active" ? "good" : "warn"}`}>{castStatus(row.status)}</span></td>
          <td>{row.hourlyRate || row.guaranteedHourlyRate ? yen.format(row.hourlyRate || row.guaranteedHourlyRate || 0) : "—"}</td>
          <td>{row.entryDate || "—"}</td><td>{row.exitedDate || "—"}</td><td>{row.introducerName || "—"}</td></tr>)}
          {!sorted.length && <tr><td colSpan={7}>対象のキャストはいません。</td></tr>}</tbody></table></div>
    </section>
  </div>;
}

export function SalesWorkView({ data }: { data: WorkspaceData }) {
  const [month, setMonth] = useState(currentMonth());
  const closings = data.closings.filter((row) =>
    row.businessDate.startsWith(month) && row.status !== "superseded");
  const rewardRows = calculateCastRewards(closings as Parameters<typeof calculateCastRewards>[0], data.casts);
  const staffRows = new Map<string, { name: string; hours: number; days: number; pay: number }>();
  closings.forEach((closing) => closing.staffWork.forEach((work) => {
    const id = String(work.staffId || work.id || work.staffName || work.name);
    const current = staffRows.get(id) || { name: String(work.staffName || work.name || ""), hours: 0, days: 0, pay: 0 };
    current.hours += number(work.hours);
    current.days += 1;
    current.pay += work.payType === "daily" ? number(work.payAmount) : number(work.payAmount) * number(work.hours);
    staffRows.set(id, current);
  }));
  return <div className="grid">
    <section className="card"><div className="field short-field"><label>対象月</label><input className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div></section>
    <section className="card">
      <div className="section-head"><h2>キャスト売上・報酬・勤務時間</h2><span className="pill">{rewardRows.length}名</span></div>
      <div className="table-wrap"><table><thead><tr><th>キャスト</th><th>本指名売上</th><th>場内延長売上</th><th>売上合計</th><th>勤務日数</th><th>勤務時間</th><th>報酬総額</th><th>日払・立替</th><th>差引支給</th></tr></thead>
        <tbody>{rewardRows.map((row) => <tr key={row.key}><td>{row.name}</td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td>
          <td>{yen.format(row.attributedSales)}</td><td>{row.days}日</td><td>{row.hours.toFixed(2)}時間</td><td>{yen.format(row.grossPayable)}</td><td>{yen.format(row.deductions)}</td><td>{yen.format(row.payable)}</td></tr>)}
          {!rewardRows.length && <tr><td colSpan={9}>対象月のデータはありません。</td></tr>}</tbody></table></div>
    </section>
    <section className="card">
      <div className="section-head"><h2>アルバイト勤務時間</h2></div>
      <div className="table-wrap"><table><thead><tr><th>名前</th><th>勤務日数</th><th>勤務時間</th><th>算定給与</th></tr></thead>
        <tbody>{[...staffRows.entries()].map(([id, row]) => <tr key={id}><td>{row.name}</td><td>{row.days}日</td><td>{row.hours.toFixed(2)}時間</td><td>{yen.format(Math.round(row.pay))}</td></tr>)}
          {!staffRows.size && <tr><td colSpan={4}>対象月の勤務データはありません。</td></tr>}</tbody></table></div>
    </section>
  </div>;
}

export function SharedMastersView({ data, busy, onSaveIntroducer, onSaveStaff, onSaveLiquor }: {
  data: WorkspaceData;
  busy: boolean;
  onSaveIntroducer: (value: Omit<Introducer, "id">) => Promise<void>;
  onSaveStaff: (value: Pick<PartTimeWorker, "name" | "payType" | "payAmount">) => Promise<void>;
  onSaveLiquor: (value: Omit<LiquorCost, "id">) => Promise<void>;
}) {
  const [introName, setIntroName] = useState("");
  const [introFee, setIntroFee] = useState(0);
  const [advisory, setAdvisory] = useState(false);
  const [advisoryAmount, setAdvisoryAmount] = useState(0);
  const [introNote, setIntroNote] = useState("");
  const [staffName, setStaffName] = useState("");
  const [payType, setPayType] = useState<"hourly" | "daily">("hourly");
  const [payAmount, setPayAmount] = useState(0);
  const [brand, setBrand] = useState("");
  const [cost, setCost] = useState(0);
  return <div className="grid master-grid">
    <MasterCard title="紹介者設定" description="紹介料と顧問料を共有します。">
      <div className="grid two">
        <Field label="紹介者"><input className="input" value={introName} onChange={(event) => setIntroName(event.target.value)} /></Field>
        <Field label="紹介料"><input className="input" type="number" min="0" value={introFee || ""} onChange={(event) => setIntroFee(Number(event.target.value))} /></Field>
        <Field label="顧問料"><label className="check-row"><input type="checkbox" checked={advisory} onChange={(event) => setAdvisory(event.target.checked)} />顧問料あり</label></Field>
        <Field label="顧問料金額"><input className="input" type="number" min="0" disabled={!advisory} value={advisoryAmount || ""} onChange={(event) => setAdvisoryAmount(Number(event.target.value))} /></Field>
      </div>
      <Field label="備考"><input className="input" value={introNote} onChange={(event) => setIntroNote(event.target.value)} /></Field>
      <button className="button" disabled={busy || !introName.trim() || (advisory && advisoryAmount <= 0)} onClick={async () => {
        await onSaveIntroducer({ name: introName, introductionFeeAmount: introFee, advisoryFeeEnabled: advisory, advisoryFeeAmount: advisory ? advisoryAmount : 0, note: introNote, feeSystem: "higher10" });
        setIntroName(""); setIntroFee(0); setAdvisory(false); setAdvisoryAmount(0); setIntroNote("");
      }}>紹介者を登録</button>
      <SimpleTable headers={["紹介者", "紹介料", "顧問料", "備考"]} rows={data.introducers.map((row) => [
        row.name, yen.format(row.introductionFeeAmount), row.advisoryFeeEnabled ? yen.format(row.advisoryFeeAmount) : "なし", row.note || "—"
      ])} />
    </MasterCard>

    <MasterCard title="アルバイト設定" description="時給または日給を登録します。">
      <Field label="名前"><input className="input" value={staffName} onChange={(event) => setStaffName(event.target.value)} /></Field>
      <div className="grid two">
        <Field label="給与区分"><select className="input" value={payType} onChange={(event) => setPayType(event.target.value as typeof payType)}><option value="hourly">時給</option><option value="daily">日給</option></select></Field>
        <Field label="金額"><input className="input" type="number" min="1" value={payAmount || ""} onChange={(event) => setPayAmount(Number(event.target.value))} /></Field>
      </div>
      <button className="button" disabled={busy || !staffName.trim() || payAmount <= 0} onClick={async () => {
        await onSaveStaff({ name: staffName, payType, payAmount }); setStaffName(""); setPayAmount(0);
      }}>アルバイトを登録</button>
      <SimpleTable headers={["名前", "区分", "金額", "状態"]} rows={data.staff.map((row) => [
        row.name, row.payType === "hourly" ? "時給" : "日給", yen.format(row.payAmount), row.status === "active" ? "在籍" : "退職"
      ])} />
    </MasterCard>

    <MasterCard title="酒代原価設定" description="シャンパン・ワインの銘柄と原価です。">
      <div className="grid two">
        <Field label="銘柄"><input className="input" value={brand} onChange={(event) => setBrand(event.target.value)} /></Field>
        <Field label="原価金額"><input className="input" type="number" min="0" value={cost || ""} onChange={(event) => setCost(Number(event.target.value))} /></Field>
      </div>
      <button className="button" disabled={busy || !brand.trim()} onClick={async () => {
        await onSaveLiquor({ brandName: brand, costAmount: cost }); setBrand(""); setCost(0);
      }}>酒代原価を登録</button>
      <SimpleTable headers={["銘柄", "原価"]} rows={data.liquorCosts.map((row) => [row.brandName, yen.format(row.costAmount)])} />
    </MasterCard>
  </div>;
}

export function AccountingSummaryView({ data }: { data: WorkspaceData }) {
  const [month, setMonth] = useState(currentMonth());
  const rows = data.closings.filter((row) => row.status === "finalized" && row.businessDate.startsWith(month));
  const fixed = data.fixedExpenses.find((row) => row.month === month);
  const sales = rows.reduce((sum, row) => sum + number(row.sales.totalSales), 0);
  const variableExpenses = rows.reduce((sum, row) => sum + row.expenses.reduce((total, item) => total + number(item.amount), 0), 0);
  const auric = rows.reduce((sum, row) => sum + number(row.auricLiquorAmount), 0);
  const rewards = calculateCastRewards(rows as Parameters<typeof calculateCastRewards>[0], data.casts)
    .reduce((sum, row) => sum + row.grossPayable, 0);
  const staffPayroll = rows.reduce((sum, closing) => sum + closing.staffWork.reduce((subtotal, work) =>
    subtotal + (work.payType === "daily"
      ? number(work.payAmount)
      : number(work.payAmount) * number(work.hours)), 0), 0);
  const fixedTotal = fixed ? fixed.rent + fixed.utilities + fixed.towel + fixed.karaoke + fixed.leasekin + fixed.communications : 0;
  const costs = variableExpenses + auric + rewards + staffPayroll + fixedTotal;
  return <div className="grid">
    <section className="card"><div className="field short-field"><label>対象月</label><input className="input" type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></div></section>
    <section className="grid metrics">
      <SmallMetric label="総売上" value={yen.format(sales)} />
      <SmallMetric label="総支出" value={yen.format(costs)} />
      <SmallMetric label="総収支" value={yen.format(sales - costs)} tone={sales - costs < 0 ? "danger" : "good"} />
      <SmallMetric label="経理確定日数" value={`${rows.length}日`} />
    </section>
    <section className="card">
      <div className="section-head"><h2>総収支内訳</h2><span className="pill">経理確定データのみ</span></div>
      <SimpleTable headers={["区分", "金額", "算定"]} rows={[
        ["総売上", yen.format(sales), "日次確定売上の合計"],
        ["店舗入力経費", yen.format(variableExpenses), "6勘定科目の合計"],
        ["オーリック酒代", yen.format(auric), "店舗締め⑦の月合計"],
        ["キャスト算定報酬", yen.format(rewards), "勤務時間・手当から算定"],
        ["アルバイト給与", yen.format(staffPayroll), "時給・日給と勤務実績から算定"],
        ["固定費", yen.format(fixedTotal), fixed ? "設定済み" : "未設定"],
        ["総収支", yen.format(sales - costs), "総売上－総支出"]
      ]} />
    </section>
  </div>;
}

export function FixedExpenseView({ data, busy, onSave }: {
  data: WorkspaceData;
  busy: boolean;
  onSave: (value: FixedExpense) => Promise<void>;
}) {
  const [month, setMonth] = useState(currentMonth());
  const stored = data.fixedExpenses.find((row) => row.month === month);
  const [form, setForm] = useState<Omit<FixedExpense, "month">>({
    rent: 0, utilities: 0, towel: 0, karaoke: 0, leasekin: 0, communications: 0
  });
  const [dirty, setDirty] = useState(false);
  const auric = data.closings.filter((row) => row.status === "finalized" && row.businessDate.startsWith(month))
    .reduce((sum, row) => sum + number(row.auricLiquorAmount), 0);
  const update = (key: keyof typeof form, value: number) => {
    setForm((row) => {
      const base = stored && !dirty ? {
        rent: stored.rent, utilities: stored.utilities, towel: stored.towel, karaoke: stored.karaoke,
        leasekin: stored.leasekin, communications: stored.communications
      } : row;
      return { ...base, [key]: value };
    });
    setDirty(true);
  };
  const displayed = dirty ? { month, ...form } : stored || { month, ...form };
  return <div className="grid">
    <section className="card stack">
      <div className="section-head"><h2>固定費設定</h2><input className="input filter-select" type="month" value={month} onChange={(event) => {
        setMonth(event.target.value); setDirty(false);
        setForm({ rent: 0, utilities: 0, towel: 0, karaoke: 0, leasekin: 0, communications: 0 });
      }} /></div>
      <div className="grid three">
        {([
          ["rent", "家賃"], ["utilities", "光熱費"], ["towel", "おしぼり"],
          ["karaoke", "カラオケ"], ["leasekin", "リースキン"], ["communications", "通信費"]
        ] as const).map(([key, label]) => <Field key={key} label={label}><input className="input" type="number" min="0" value={displayed[key] || ""} onChange={(event) => update(key, Number(event.target.value))} /></Field>)}
      </div>
      <div className="derived-cost"><span>オーリック酒代（月合計・自動算出）</span><strong>{yen.format(auric)}</strong></div>
      <button className="button" disabled={busy || !month} onClick={() => onSave({ ...displayed, month })}>固定費を保存</button>
    </section>
  </div>;
}

function MasterCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="card stack"><div><h2>{title}</h2><p className="muted">{description}</p></div>{children}</section>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}</div>;
}
function SmallMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return <div className={`card metric-card ${tone || ""}`}><div className="metric-label">{label}</div><div className="metric-value">{value}</div></div>;
}
function SimpleTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}
      {!rows.length && <tr><td colSpan={headers.length}>データがありません。</td></tr>}</tbody></table></div>;
}
function castStatus(status: string) {
  return { active: "在籍", trial: "体入", departed: "退店" }[status] || status;
}
