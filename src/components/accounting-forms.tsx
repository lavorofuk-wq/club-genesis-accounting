"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import type { CastReward, DailyClosing, MonthlyAdjustments, WorkspaceData } from "@/domain/gms";
import { calculateCastRewards, floorHundred } from "@/domain/gms";
import { approveClosing, returnClosing, saveMonthlyAdjustments } from "@/lib/firebase/repository";
import { Card, Field, MoneyInput, StatusPill, Table, currentMonth, yen } from "./ui";

type Props = { data: WorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean> };
type Section = "approval" | "castRewards" | "introducers" | "staffPayroll" | "driverPayroll" | "expenses" | "balance";

const statusLabel = { submitted: "確認待ち", returned: "差戻し", approved: "承認済み", withdrawn: "取下げ" } as const;
const expenseLabels: Record<string, string> = { beautyTrial: "美容室手当", introduction: "紹介料", advertising: "広告等", supplies: "備品・消耗品他", entertainment: "交際費・プレゼント等", liquor: "酒代", transportOther: "交通費・その他" };

export function AccountingForms({ section, ...props }: Props & { section: Section }) {
  if (section === "approval") return <ApprovalView {...props} />;
  return <MonthlyAccounting section={section} {...props} />;
}

function ApprovalView({ data, user, run }: Props) {
  const [expanded, setExpanded] = useState("");
  return <div className="grid"><div className="grid metrics"><Metric label="経理確認待ち" value={`${data.closings.filter((row) => row.status === "submitted").length}件`} /><Metric label="承認済み" value={`${data.closings.filter((row) => row.status === "approved").length}件`} /><Metric label="差戻し" value={`${data.closings.filter((row) => row.status === "returned").length}件`} /><Metric label="当月承認売上" value={yen.format(data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(currentMonth())).reduce((sum, row) => sum + row.sales.totalSales, 0))} /></div>
    <Card title="店舗送信データの確認・承認" description="店舗データと現金照合を確認して承認または差戻しします。"><Table headers={["営業日", "状態", "総売上", "経費・支払", "現金実在高", "差額", "操作"]}>{data.closings.filter((row) => row.status !== "withdrawn").map((row) => <tr key={row.id}><td>{row.businessDate}</td><td><StatusPill tone={row.status === "approved" ? "good" : row.status === "returned" ? "danger" : "warn"}>{statusLabel[row.status]}</StatusPill></td><td>{yen.format(row.sales.totalSales)}</td><td>{yen.format(row.cash.expenseAndPaymentTotal)}</td><td>{yen.format(row.cash.actualClosingCash)}</td><td className={row.cash.difference ? "text-danger" : "text-good"}>{yen.format(row.cash.difference)}</td><td><div className="row-actions"><button className="button secondary mini" onClick={() => setExpanded(expanded === row.id ? "" : row.id)}>{expanded === row.id ? "閉じる" : "詳細"}</button>{row.status === "submitted" && <><button className="button mini" onClick={() => { if (window.confirm(`${row.businessDate}を経理承認しますか？`)) void run(() => approveClosing(row.id, user), "店舗データを承認しました。"); }}>承認</button><button className="button danger mini" onClick={() => { const reason = window.prompt("差戻し理由を入力してください。"); if (reason) void run(() => returnClosing(row.id, reason, user), "店舗へ差し戻しました。"); }}>差戻し</button></>}</div></td></tr>).flatMap((row) => row)}</Table>
      {expanded && <ClosingDetail closing={data.closings.find((row) => row.id === expanded)!} />}
    </Card></div>;
}

function ClosingDetail({ closing }: { closing: DailyClosing }) {
  return <div className="detail-panel"><div className="summaryetho"><div className="summary-strip"><span><small>現金売上</small><strong>{yen.format(closing.sales.cashSales)}</strong></span><span><small>カード売上</small><strong>{yen.format(closing.sales.cardSales)}</strong></span><span><small>計算上現金残額</small><strong>{yen.format(closing.cash.expectedClosingCash)}</strong></span><span><small>実在高</small><strong>{yen.format(closing.cash.actualClosingCash)}</strong></span></div></div><h3>キャスト日次データ</h3><Table headers={["名前", "勤務", "本指名/場内/同伴", "本指名売上", "場内延長売上", "酒代原価", "手当・控除"]}>{closing.casts.map((row) => <tr key={row.posCastId}><td>{row.name}</td><td>{row.startTime}–{row.endTime}（{row.hours}h）</td><td>{row.honShimeiCount}/{row.banaiShimeiCount}/{row.dohanCount}</td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td><td>{yen.format(row.liquorCost)}</td><td>{yen.format(row.beautyAllowance - row.dailyPayment - row.advancePayment - row.transportFee)}</td></tr>)}</Table><h3>スタッフ・ドライバー</h3><Table headers={["区分", "名前", "勤務・給与基準", "日払い"]}>{[...closing.staffWork.map((row) => <tr key={`staff-${row.staffId}`}><td>{row.kind === "trial" ? "体入スタッフ" : "スタッフ"}</td><td>{row.name}</td><td>{row.startTime}–{row.endTime}（{row.hours}h）</td><td>{yen.format(row.dailyPayment)}</td></tr>), ...closing.drivers.map((row) => <tr key={`driver-${row.driverId}`}><td>送迎ドライバー</td><td>{row.name}</td><td>日給 {yen.format(row.dailyRate)}</td><td>—</td></tr>)]}</Table><h3>当日経費</h3><Table headers={["勘定科目", "支払先", "金額"]}>{closing.expenses.map((row) => <tr key={row.id}><td>{expenseLabels[row.category]}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td></tr>)}</Table></div>;
}

function MonthlyAccounting({ section, data, user, busy, run }: Props & { section: Exclude<Section, "approval"> }) {
  const [month, setMonth] = useState(currentMonth());
  const stored = data.adjustments.find((row) => row.month === month);
  const [adjustments, setAdjustments] = useState<MonthlyAdjustments>(() => blankAdjustments(month, stored));
  useEffect(() => setAdjustments(blankAdjustments(month, data.adjustments.find((row) => row.month === month))), [data.adjustments, month]);
  const approved = useMemo(() => data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month)), [data.closings, month]);
  const rewards = useMemo(() => calculateCastRewards(data.closings, data.casts, month, adjustments), [adjustments, data.casts, data.closings, month]);
  const staffRows = staffPayroll(approved, adjustments);
  const driverRows = driverPayroll(approved, adjustments);
  const introducerRows = introducerPayments(rewards, data, month);
  const expenseRows = expenseTotals(approved);
  const deliveryAmount = adjustments.liquorDeliveryAmount ?? approved.reduce((sum, row) => sum + row.liquorDeliveryAmount, 0);
  const fixedTotal = adjustments.fixedExpenses.reduce((sum, row) => sum + row.amount, 0);
  const castTotal = rewards.reduce((sum, row) => sum + row.grossPay, 0);
  const introducerTotal = introducerRows.reduce((sum, row) => sum + row.total, 0);
  const staffTotal = staffRows.reduce((sum, row) => sum + row.gross, 0);
  const driverTotal = driverRows.reduce((sum, row) => sum + row.gross, 0);
  const dailyExpenseTotal = Object.values(expenseRows).reduce((sum, value) => sum + value, 0);
  const totalExpenses = dailyExpenseTotal + deliveryAmount + fixedTotal + adjustments.cardFee;
  const sales = approved.reduce((sum, row) => sum + row.sales.totalSales, 0);
  const totalCosts = castTotal + introducerTotal + staffTotal + driverTotal + totalExpenses;
  const warnings = accountingWarnings(approved);
  const setMap = (key: "withholdingByCast" | "staffSalesAllowance" | "staffBottleAllowance" | "driverRemoteAllowance", id: string, value: number) => setAdjustments((row) => ({ ...row, [key]: { ...row[key], [id]: value } }));
  const save = () => run(() => saveMonthlyAdjustments(adjustments, user), `${month}の経理入力を保存しました。`);

  return <div className="grid"><Card><div className="month-toolbar"><Field label="対象月"><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field><span>承認済み営業日 <strong>{approved.length}日</strong></span><button className="button" disabled={busy} onClick={() => void save()}>経理入力を保存</button></div></Card>
    {warnings.length > 0 && <div className="notice error"><strong>正しく算出できない項目があります。</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    {section === "castRewards" && <CastRewards rows={rewards} onWithholding={(id, value) => setMap("withholdingByCast", id, value)} />}
    {section === "introducers" && <IntroducerPayments rows={introducerRows} />}
    {section === "staffPayroll" && <StaffPayroll rows={staffRows} onSales={(id, value) => setMap("staffSalesAllowance", id, value)} onBottle={(id, value) => setMap("staffBottleAllowance", id, value)} />}
    {section === "driverPayroll" && <DriverPayroll rows={driverRows} onRemote={(id, value) => setMap("driverRemoteAllowance", id, value)} />}
    {section === "expenses" && <Expenses approved={approved} totals={expenseRows} adjustments={adjustments} setAdjustments={setAdjustments} deliveryAmount={deliveryAmount} total={totalExpenses} />}
    {section === "balance" && <Balance sales={sales} cast={castTotal} introducer={introducerTotal} staff={staffTotal} driver={driverTotal} expenses={totalExpenses} totalCosts={totalCosts} days={approved.length} warnings={warnings} />}
  </div>;
}

function CastRewards({ rows, onWithholding }: { rows: CastReward[]; onWithholding: (id: string, value: number) => void }) {
  return <Card title="キャスト報酬データ" description="時給＋バックと売上報酬を比較し、高い方を採用します。"><Table headers={["キャスト", "勤務", "基本報酬", "指名・同伴", "ボトル", "ドリンク", "原価", "売上報酬", "採用", "美容室", "総支給", "日払・立替・送迎", "源泉所得税", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong>{row.trialOnly && <><br /><StatusPill>体入時給のみ</StatusPill></>}</td><td>{row.days}日 / {row.hours}h</td><td>{yen.format(row.hourlyPay)}</td><td>{yen.format(row.honShimeiBack + row.banaiShimeiBack + row.dohanBack)}</td><td>{yen.format(row.bottleBack)}</td><td>{yen.format(row.drinkBack)}</td><td>{yen.format(row.liquorCost)}</td><td>{row.rewardRate ? `${Math.round(row.rewardRate * 100)}% / ${yen.format(row.salesReward)}` : "対象外"}</td><td><StatusPill tone="good">{row.trialOnly ? "体入時給" : row.adoptedSystem === "salesReward" ? "売上報酬" : "時給＋バック"} {yen.format(row.adoptedReward)}</StatusPill></td><td>{yen.format(row.beautyAllowance)}</td><td><strong>{yen.format(row.grossPay)}</strong></td><td>{yen.format(row.dailyPayment + row.advancePayment + row.transportFee)}</td><td><MoneyInput value={row.withholding} step={1} onChange={(value) => onWithholding(row.id, value)} /></td><td><strong>{yen.format(row.netPay)}</strong></td></tr>)}</Table></Card>;
}

type IntroRow = { id: string; introducer: string; cast: string; feeType: string; salesBase: number; salesFee: number; grossBase: number; grossFee: number; adopted: string; advisory: number; total: number };
function introducerPayments(rewards: CastReward[], data: WorkspaceData, month: string): IntroRow[] {
  return rewards.filter((row) => row.introducer).map((row) => {
    const intro = row.introducer!;
    const salesBase = intro.feeType.includes("netSales") || intro.feeType.includes("NetSales") ? Math.max(0, row.honShimeiSales - row.liquorCost) : row.honShimeiSales;
    const salesFee = Math.floor(salesBase * 0.1);
    const grossFee = Math.floor(row.grossPay * 0.1);
    let adopted = "売上10%"; let fee = salesFee;
    if (intro.feeType === "gross10") { adopted = "総支給額10%"; fee = grossFee; }
    if (["higherSalesGross10", "higherNetSalesGross10"].includes(intro.feeType)) { const grossWins = grossFee > salesFee; adopted = grossWins ? "総支給額10%" : "売上10%"; fee = Math.max(salesFee, grossFee); }
    const member = data.casts.find((cast) => cast.id === row.id);
    const advisory = row.advisoryDays * intro.attendanceAdvisoryFee + (member?.hiredAt?.startsWith(month) ? intro.entryAdvisoryFee : 0);
    return { id: `${intro.id}_${row.id}`, introducer: intro.name, cast: row.name, feeType: intro.feeType, salesBase, salesFee, grossBase: row.grossPay, grossFee, adopted, advisory, total: fee + advisory };
  });
}
function IntroducerPayments({ rows }: { rows: IntroRow[] }) { return <Card title="紹介者支払データ"><Table headers={["紹介者", "対象キャスト", "売上算定額", "売上10%", "総支給額", "総支給10%", "採用タイプ", "顧問料", "支払合計"]}>{rows.map((row) => <tr key={row.id}><td>{row.introducer}</td><td>{row.cast}</td><td>{yen.format(row.salesBase)}</td><td>{yen.format(row.salesFee)}</td><td>{yen.format(row.grossBase)}</td><td>{yen.format(row.grossFee)}</td><td>{row.adopted}</td><td>{yen.format(row.advisory)}</td><td><strong>{yen.format(row.total)}</strong></td></tr>)}</Table></Card>; }

type StaffRow = { id: string; name: string; hours: number; hourly: number; sales: number; bottle: number; gross: number; daily: number; net: number };
function staffPayroll(closings: DailyClosing[], adjustments: MonthlyAdjustments): StaffRow[] { const map = new Map<string, StaffRow>(); closings.forEach((closing) => closing.staffWork.forEach((work) => { const row = map.get(work.staffId) || { id: work.staffId, name: work.name, hours: 0, hourly: 0, sales: adjustments.staffSalesAllowance[work.staffId] || 0, bottle: adjustments.staffBottleAllowance[work.staffId] || 0, gross: 0, daily: 0, net: 0 }; row.hours += work.hours; row.hourly += work.hourlyRate * work.hours; row.daily += work.dailyPayment; map.set(work.staffId, row); })); return [...map.values()].map((row) => { const hourly = floorHundred(row.hourly); return { ...row, hourly, gross: hourly + row.sales + row.bottle, net: hourly + row.sales + row.bottle - row.daily }; }); }
function StaffPayroll({ rows, onSales, onBottle }: { rows: StaffRow[]; onSales: (id: string, value: number) => void; onBottle: (id: string, value: number) => void }) { return <Card title="スタッフ給与データ"><Table headers={["スタッフ", "勤務時間", "基本給与", "売上手当", "ボトル手当", "総支給", "日払い", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hours}時間</td><td>{yen.format(row.hourly)}</td><td><MoneyInput value={row.sales} onChange={(value) => onSales(row.id, value)} /></td><td><MoneyInput value={row.bottle} onChange={(value) => onBottle(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.daily)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>)}</Table></Card>; }

type DriverRow = { id: string; name: string; days: number; basic: number; remote: number; gross: number };
function driverPayroll(closings: DailyClosing[], adjustments: MonthlyAdjustments): DriverRow[] { const map = new Map<string, DriverRow>(); closings.forEach((closing) => closing.drivers.forEach((driver) => { const row = map.get(driver.driverId) || { id: driver.driverId, name: driver.name, days: 0, basic: 0, remote: adjustments.driverRemoteAllowance[driver.driverId] || 0, gross: 0 }; row.days += 1; row.basic += driver.dailyRate; map.set(driver.driverId, row); })); return [...map.values()].map((row) => ({ ...row, gross: row.basic + row.remote })); }
function DriverPayroll({ rows, onRemote }: { rows: DriverRow[]; onRemote: (id: string, value: number) => void }) { return <Card title="送迎ドライバー給与データ"><Table headers={["ドライバー", "出勤日数", "基本給与", "遠方手当", "総支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.days}日</td><td>{yen.format(row.basic)}</td><td><MoneyInput value={row.remote} onChange={(value) => onRemote(row.id, value)} /></td><td><strong>{yen.format(row.gross)}</strong></td></tr>)}</Table></Card>; }

function expenseTotals(closings: DailyClosing[]) { const result: Record<string, number> = {}; closings.forEach((closing) => closing.expenses.forEach((row) => { result[row.category] = (result[row.category] || 0) + row.amount; })); return result; }
function Expenses({ totals, adjustments, setAdjustments, deliveryAmount, total }: { approved: DailyClosing[]; totals: Record<string, number>; adjustments: MonthlyAdjustments; setAdjustments: (value: MonthlyAdjustments | ((row: MonthlyAdjustments) => MonthlyAdjustments)) => void; deliveryAmount: number; total: number }) {
  const addFixed = () => setAdjustments((row) => ({ ...row, fixedExpenses: [...row.fixedExpenses, { id: crypto.randomUUID(), account: "", amount: 0 }] }));
  return <div className="grid"><Card title="当月経費データ"><Table headers={["勘定科目", "金額"]}>{Object.entries(expenseLabels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{yen.format(totals[key] || 0)}</td></tr>)}</Table></Card><Card title="固定経費・月締め調整" action={<button className="button secondary" onClick={addFixed}>固定経費を追加</button>}><div className="stack">{adjustments.fixedExpenses.map((row) => <div className="grid form-row" key={row.id}><Field label="科目"><input className="input" value={row.account} onChange={(e) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, account: e.target.value } : item) }))} /></Field><Field label="金額"><MoneyInput value={row.amount} onChange={(amount) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, amount } : item) }))} /></Field><button className="button danger compact" onClick={() => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.filter((item) => item.id !== row.id) }))}>削除</button></div>)}</div><div className="grid two top-gap"><Field label="酒代納品書分（月締め後の修正可）"><MoneyInput value={deliveryAmount} onChange={(value) => setAdjustments((row) => ({ ...row, liquorDeliveryAmount: value }))} /></Field><Field label="カード決済手数料"><MoneyInput value={adjustments.cardFee} step={1} onChange={(value) => setAdjustments((row) => ({ ...row, cardFee: value }))} /></Field></div><div className="right-total">経費総合計 <strong>{yen.format(total)}</strong></div></Card></div>;
}

function Balance({ sales, cast, introducer, staff, driver, expenses, totalCosts, days, warnings }: { sales: number; cast: number; introducer: number; staff: number; driver: number; expenses: number; totalCosts: number; days: number; warnings: string[] }) { return <div className="grid"><div className="grid metrics"><Metric label="合計売上" value={yen.format(sales)} /><Metric label="総支出" value={yen.format(totalCosts)} /><Metric label="収支" value={yen.format(sales - totalCosts)} /><Metric label="承認営業日" value={`${days}日`} /></div><Card title="収支データ"><Table headers={["区分", "金額"]}><tr><td>合計売上</td><td>{yen.format(sales)}</td></tr><tr><td>キャスト報酬</td><td>− {yen.format(cast)}</td></tr><tr><td>紹介者支払</td><td>− {yen.format(introducer)}</td></tr><tr><td>スタッフ給与</td><td>− {yen.format(staff)}</td></tr><tr><td>送迎ドライバー給与</td><td>− {yen.format(driver)}</td></tr><tr><td>経費</td><td>− {yen.format(expenses)}</td></tr><tr className="total-row"><td><strong>収支</strong></td><td><strong>{yen.format(sales - totalCosts)}</strong></td></tr></Table>{warnings.length === 0 && <div className="notice success top-gap">すべての承認済みデータから収支を算出しました。</div>}</Card></div>; }

function accountingWarnings(rows: DailyClosing[]) { const warnings: string[] = []; rows.forEach((closing) => { if (closing.cash.difference !== 0) warnings.push(`${closing.businessDate}の現金照合に${yen.format(closing.cash.difference)}の差額があります。`); closing.casts.filter((row) => row.kind === "regular" && row.hourlyRate <= 0).forEach((row) => warnings.push(`${closing.businessDate}・${row.name}の時給が未設定です。`)); }); return [...new Set(warnings)]; }
function blankAdjustments(month: string, stored?: MonthlyAdjustments): MonthlyAdjustments { return stored ? { ...stored, withholdingByCast: stored.withholdingByCast || {}, staffSalesAllowance: stored.staffSalesAllowance || {}, staffBottleAllowance: stored.staffBottleAllowance || {}, driverRemoteAllowance: stored.driverRemoteAllowance || {}, fixedExpenses: stored.fixedExpenses || [], cardFee: stored.cardFee || 0 } : { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 }; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="card metric-card"><small>{label}</small><strong>{value}</strong></div>; }
