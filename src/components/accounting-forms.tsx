"use client";

import { useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import type { CastReward, CastSalesBackBreakdown, CastSalesBottleSummary, CastSalesReport, DailyClosing, MonthlyAdjustments, WorkspaceData } from "@/domain/gms";
import { calculateCastRewards, calculateCastSalesReports, calculateDriverPayroll, floorHundred, introducerSalesBase } from "@/domain/gms";
import { approveClosing, returnClosing, saveMonthlyAdjustments } from "@/lib/firebase/repository";
import { Card, Field, MoneyInput, StatusPill, Table, currentMonth, yen } from "./ui";

type Props = { data: WorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean> };
type Section = "approval" | "castSales" | "castRewards" | "introducers" | "staffPayroll" | "driverPayroll" | "expenses" | "balance";

const statusLabel = { submitted: "確認待ち", returned: "差戻し", approved: "承認済み", withdrawn: "取下げ" } as const;
const expenseLabels: Record<string, string> = { beautyTrial: "美容室手当", introduction: "紹介料", advertising: "広告等", supplies: "備品・消耗品他", entertainment: "交際費・プレゼント等", liquor: "酒代", transportOther: "交通費・その他" };
const introducerFeeTypes = new Set(["sales10", "netSales10", "gross10", "higherSalesGross10", "higherNetSalesGross10"]);

export function AccountingForms({ section, ...props }: Props & { section: Section }) {
  if (section === "approval") return <ApprovalView {...props} />;
  return <MonthlyAccounting section={section} {...props} />;
}

function ApprovalView({ data, user, busy, run }: Props) {
  const [expanded, setExpanded] = useState("");
  const expandedClosing = data.closings.find((row) => row.id === expanded);
  return <div className="grid">
    <div className="grid metrics">
      <Metric label="経理確認待ち" value={`${data.closings.filter((row) => row.status === "submitted").length}件`} />
      <Metric label="承認済み" value={`${data.closings.filter((row) => row.status === "approved").length}件`} />
      <Metric label="差戻し" value={`${data.closings.filter((row) => row.status === "returned").length}件`} />
      <Metric label="当月承認売上" value={yen.format(data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(currentMonth())).reduce((sum, row) => sum + row.sales.totalSales, 0))} />
    </div>
    <Card title="店舗送信データの確認・承認" description="店舗データと現金照合を確認して承認または差戻しします。">
      <Table headers={["営業日", "状態", "総売上", "経費・支払", "現金実在高", "差額", "操作"]}>
        {data.closings.filter((row) => row.status !== "withdrawn").map((row) => <tr key={row.id}>
          <td>{row.businessDate}</td>
          <td><StatusPill tone={row.status === "approved" ? "good" : row.status === "returned" ? "danger" : "warn"}>{statusLabel[row.status]}</StatusPill></td>
          <td>{yen.format(row.sales.totalSales)}</td>
          <td>{yen.format(row.cash.expenseAndPaymentTotal)}</td>
          <td>{yen.format(row.cash.actualClosingCash)}</td>
          <td className={row.cash.difference ? "text-danger" : "text-good"}>{yen.format(row.cash.difference)}</td>
          <td><div className="row-actions">
            <button className="button secondary mini" disabled={busy} onClick={() => setExpanded(expanded === row.id ? "" : row.id)}>{expanded === row.id ? "閉じる" : "詳細"}</button>
            {row.status === "submitted" && <button className="button mini" disabled={busy} onClick={() => { if (window.confirm(`${row.businessDate}を経理承認しますか？`)) void run(() => approveClosing(row.id, user), "店舗データを承認しました。"); }}>承認</button>}
            {(row.status === "submitted" || row.status === "approved") && <button className="button danger mini" disabled={busy} onClick={() => {
              if (row.status === "approved" && !window.confirm(`${row.businessDate}の承認を取り消して店舗へ差し戻しますか？\n再送・再承認されるまで、給与・経費・収支の月次集計から除外されます。`)) return;
              const message = row.status === "approved" ? "承認後の差戻し理由を入力してください（500文字以内）。" : "差戻し理由を入力してください（500文字以内）。";
              const reason = window.prompt(message);
              if (reason) void run(() => returnClosing(row.id, reason, user), "店舗へ差し戻しました。");
            }}>差戻し</button>}
          </div></td>
        </tr>)}
      </Table>
      {expandedClosing && <ClosingDetail closing={expandedClosing} />}
      {expanded && !expandedClosing && <div className="notice error">対象データが更新されたため、最新データを読み込んでください。</div>}
    </Card>
  </div>;
}

function ClosingDetail({ closing }: { closing: DailyClosing }) {
  return <div className="detail-panel">{(closing.integrityIssues?.length || 0) > 0 && <div className="notice error"><strong>この営業日のデータが不完全です。</strong><ul>{closing.integrityIssues?.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}<div className="summaryetho"><div className="summary-strip"><span><small>現金売上</small><strong>{yen.format(closing.sales.cashSales)}</strong></span><span><small>カード売上</small><strong>{yen.format(closing.sales.cardSales)}</strong></span><span><small>計算上現金残額</small><strong>{yen.format(closing.cash.expectedClosingCash)}</strong></span><span><small>実在高</small><strong>{yen.format(closing.cash.actualClosingCash)}</strong></span></div></div><h3>キャスト日次データ</h3><Table headers={["名前", "勤務", "本指名/場内/同伴", "本指名売上", "場内延長売上", "酒代原価", "手当・控除"]}>{(closing.casts ?? []).map((row) => <tr key={row.posCastId}><td>{row.name}</td><td>{row.startTime}–{row.endTime}（{row.hours}h）</td><td>{row.honShimeiCount}/{row.banaiShimeiCount}/{row.dohanCount}</td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td><td>{yen.format(row.liquorCost)}</td><td>{yen.format(row.beautyAllowance - row.dailyPayment - row.advancePayment - row.transportFee)}</td></tr>)}</Table><h3>スタッフ・ドライバー</h3><Table headers={["区分", "名前", "勤務・給与基準", "日払い"]}>{[...(closing.staffWork ?? []).map((row) => <tr key={`staff-${row.staffId}`}><td>{row.kind === "trial" ? "体入スタッフ" : "スタッフ"}</td><td>{row.name}</td><td>{row.startTime}–{row.endTime}（{row.hours}h）</td><td>{yen.format(row.dailyPayment)}</td></tr>), ...(closing.drivers ?? []).map((row) => <tr key={`driver-${row.driverId}`}><td>送迎ドライバー</td><td>{row.name}</td><td>日給 {yen.format(row.dailyRate)}</td><td>{yen.format(row.dailyPayment)}</td></tr>)]}</Table><h3>当日経費</h3><Table headers={["勘定科目", "支払先", "金額"]}>{(closing.expenses ?? []).map((row) => <tr key={row.id}><td>{expenseLabels[row.category] || row.category || "科目未設定"}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td></tr>)}</Table></div>;
}

function MonthlyAccounting({ section, data, user, busy, run }: Props & { section: Exclude<Section, "approval"> }) {
  const [month, setMonth] = useState(currentMonth());
  const stored = data.adjustments.find((row) => row.month === month);
  const [adjustments, setAdjustments] = useState<MonthlyAdjustments>(() => blankAdjustments(month, stored));
  useEffect(() => setAdjustments(blankAdjustments(month, data.adjustments.find((row) => row.month === month))), [data.adjustments, month]);
  const approved = useMemo(() => data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month)), [data.closings, month]);
  const castSalesReports = useMemo(() => calculateCastSalesReports(data.closings, data.casts, month), [data.casts, data.closings, month]);
  const rewards = useMemo(() => calculateCastRewards(data.closings, data.casts, month, adjustments), [adjustments, data.casts, data.closings, month]);
  const staffRows = staffPayroll(approved, adjustments);
  const driverRows = calculateDriverPayroll(approved, adjustments.driverRemoteAllowance);
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

  return <div className="grid"><Card><div className="month-toolbar"><Field label="対象月"><input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field><span>承認済み営業日 <strong>{approved.length}日</strong></span>{section !== "castSales" && <button className="button" disabled={busy} onClick={() => void save()}>経理入力を保存</button>}</div></Card>
    {warnings.length > 0 && <div className="notice error"><strong>正しく算出できない項目があります。</strong><ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
    {section === "castSales" && <CastSalesReports rows={castSalesReports} month={month} />}
    {section === "castRewards" && <CastRewards rows={rewards} onWithholding={(id, value) => setMap("withholdingByCast", id, value)} />}
    {section === "introducers" && <IntroducerPayments rows={introducerRows} />}
    {section === "staffPayroll" && <StaffPayroll rows={staffRows} onSales={(id, value) => setMap("staffSalesAllowance", id, value)} onBottle={(id, value) => setMap("staffBottleAllowance", id, value)} />}
    {section === "driverPayroll" && <DriverPayroll rows={driverRows} onRemote={(id, value) => setMap("driverRemoteAllowance", id, value)} />}
    {section === "expenses" && <Expenses approved={approved} totals={expenseRows} adjustments={adjustments} setAdjustments={setAdjustments} deliveryAmount={deliveryAmount} total={totalExpenses} />}
    {section === "balance" && <Balance sales={sales} cast={castTotal} introducer={introducerTotal} staff={staffTotal} driver={driverTotal} expenses={totalExpenses} totalCosts={totalCosts} days={approved.length} warnings={warnings} />}
  </div>;
}

const businessDateLabel = (value: string) => {
  const [, month, day] = value.split("-").map(Number);
  return Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : value;
};

function BackBreakdown({ rows }: { rows: CastSalesBackBreakdown[] }) {
  return <div className="back-breakdown">{rows.map((row) => <span key={row.key}><small>{row.label}</small><strong>{yen.format(row.amount)}</strong></span>)}</div>;
}

function BottleSummary({ rows }: { rows: CastSalesBottleSummary[] }) {
  return rows.length ? <div className="bottle-summary">{rows.map((row) => <span key={row.name}>{row.name}<small>×{row.quantity}</small></span>)}</div> : <>—</>;
}

function CastSalesReports({ rows, month }: { rows: CastSalesReport[]; month: string }) {
  const totals = rows.reduce((result, row) => ({
    attendanceDays: result.attendanceDays + row.attendanceDays,
    sales: result.sales + row.totals.totalSales,
    liquorCost: result.liquorCost + row.totals.totalLiquorCost,
    backs: result.backs + row.totals.backTotal,
  }), { attendanceDays: 0, sales: 0, liquorCost: 0, backs: 0 });
  if (!rows.length) return <Card title="キャスト売上" description={`${month}の承認済みキャスト売上はありません。`}><div className="notice">店舗送信データを承認すると、この画面へ反映されます。</div></Card>;
  return <div className="grid cast-sales-report">
    <div className="grid metrics"><Metric label="対象キャスト" value={`${rows.length}名`} /><Metric label="延べ出勤" value={`${totals.attendanceDays}日`} /><Metric label="キャスト合計売上" value={yen.format(totals.sales)} /><Metric label="バック合計" value={yen.format(totals.backs)} /></div>
    {rows.map((report, index) => <details className="card cast-sales-card" key={report.id} open={index === 0}>
      <summary className="cast-sales-summary"><strong>{report.name}</strong><span>{report.totals.attendanceDays}日 / {report.totals.hours}時間</span><span>合計売上 <b>{yen.format(report.totals.totalSales)}</b></span><span>バック <b>{yen.format(report.totals.backTotal)}</b></span></summary>
      <div className="cast-sales-content"><Table headers={["出勤日", "出勤時刻", "退勤時刻", "勤務時間", "本指名売上", "場内延長売上", "合計売上", "本指名酒代原価", "場内延長酒代原価", "合計酒代原価", "本指名/場内指名", "同伴", "各種バック", "ボトル銘柄", "美容室手当"]}>
        {report.days.map((day) => <tr key={`${report.id}-${day.businessDate}`}><td>{businessDateLabel(day.businessDate)}</td><td>{day.startTime || "—"}</td><td>{day.endTime || "—"}</td><td>{day.hours}時間</td><td>{yen.format(day.honShimeiSales)}</td><td>{yen.format(day.jonaiExtensionSales)}</td><td><strong>{yen.format(day.totalSales)}</strong></td><td>{yen.format(day.honShimeiLiquorCost)}</td><td>{yen.format(day.jonaiExtensionLiquorCost)}</td><td>{yen.format(day.totalLiquorCost)}</td><td>{day.honShimeiCount}本 / {day.banaiShimeiCount}本<br /><small>計 {day.nominationCount}本</small></td><td>{day.dohanCount}本</td><td className="wrap-cell"><BackBreakdown rows={day.backs} /><div className="cell-total">計 {yen.format(day.backTotal)}</div></td><td className="wrap-cell"><BottleSummary rows={day.bottles} /></td><td>{day.beautyAllowance > 0 ? <><StatusPill tone="good">あり</StatusPill><br />{yen.format(day.beautyAllowance)}</> : "なし"}</td></tr>)}
        <tr className="total-row"><td>{month} 合計<br /><strong>{report.totals.attendanceDays}日</strong></td><td>—</td><td>—</td><td>{report.totals.hours}時間</td><td>{yen.format(report.totals.honShimeiSales)}</td><td>{yen.format(report.totals.jonaiExtensionSales)}</td><td><strong>{yen.format(report.totals.totalSales)}</strong></td><td>{yen.format(report.totals.honShimeiLiquorCost)}</td><td>{yen.format(report.totals.jonaiExtensionLiquorCost)}</td><td>{yen.format(report.totals.totalLiquorCost)}</td><td>{report.totals.honShimeiCount}本 / {report.totals.banaiShimeiCount}本<br /><small>計 {report.totals.nominationCount}本</small></td><td>{report.totals.dohanCount}本</td><td className="wrap-cell"><BackBreakdown rows={report.totals.backs} /><div className="cell-total">計 {yen.format(report.totals.backTotal)}</div></td><td className="wrap-cell"><BottleSummary rows={report.totals.bottles} /></td><td>{report.days.filter((day) => day.beautyAllowance > 0).length}日<br />{yen.format(report.totals.beautyAllowance)}</td></tr>
      </Table></div>
    </details>)}
  </div>;
}

function CastRewards({ rows, onWithholding }: { rows: CastReward[]; onWithholding: (id: string, value: number) => void }) {
  return <Card title="キャスト報酬データ" description="時給＋バックと売上報酬を比較し、高い方を採用します。"><Table headers={["キャスト", "勤務", "基本報酬", "指名・同伴", "ボトル", "ドリンク", "原価", "売上報酬", "採用", "美容室", "総支給", "日払・立替・送迎", "源泉所得税", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td><strong>{row.name}</strong>{row.trialOnly && <><br /><StatusPill>体入時給のみ</StatusPill></>}</td><td>{row.days}日 / {row.hours}h</td><td>{yen.format(row.hourlyPay)}</td><td>{yen.format(row.honShimeiBack + row.banaiShimeiBack + row.dohanBack)}</td><td>{yen.format(row.bottleBack)}</td><td>{yen.format(row.drinkBack)}</td><td>{yen.format(row.liquorCost)}</td><td>{row.rewardRate ? `${Math.round(row.rewardRate * 100)}% / ${yen.format(row.salesReward)}` : "対象外"}</td><td><StatusPill tone="good">{row.trialOnly ? "体入時給" : row.adoptedSystem === "salesReward" ? "売上報酬" : "時給＋バック"} {yen.format(row.adoptedReward)}</StatusPill></td><td>{yen.format(row.beautyAllowance)}</td><td><strong>{yen.format(row.grossPay)}</strong></td><td>{yen.format(row.dailyPayment + row.advancePayment + row.transportFee)}</td><td><MoneyInput value={row.withholding} step={1} onChange={(value) => onWithholding(row.id, value)} /></td><td><strong>{yen.format(row.netPay)}</strong></td></tr>)}</Table></Card>;
}

type IntroRow = { id: string; introducer: string; cast: string; feeType: string; honShimeiLiquorCost: number; salesBase: number; salesFee: number; grossBase: number; grossFee: number; adopted: string; advisory: number; total: number };
function introducerPayments(rewards: CastReward[], data: WorkspaceData, month: string): IntroRow[] {
  return rewards.filter((row) => row.introducer).map((row) => {
    const intro = row.introducer!;
    const feeType = typeof intro.feeType === "string" ? intro.feeType : "";
    const validFeeType = introducerFeeTypes.has(feeType);
    const salesBase = validFeeType ? introducerSalesBase(row, intro.feeType) : 0;
    const salesFee = validFeeType ? Math.floor(salesBase * 0.1) : 0;
    const grossFee = Math.floor(row.grossPay * 0.1);
    const salesLabel = feeType === "netSales10" || feeType === "higherNetSalesGross10" ? "酒代原価引き売上10%" : "売上10%";
    let adopted = validFeeType ? salesLabel : "報酬形態未設定"; let fee = salesFee;
    if (feeType === "gross10") { adopted = "総支給額10%"; fee = grossFee; }
    if (["higherSalesGross10", "higherNetSalesGross10"].includes(feeType)) { const grossWins = grossFee > salesFee; adopted = grossWins ? "総支給額10%" : salesLabel; fee = Math.max(salesFee, grossFee); }
    const member = data.casts.find((cast) => cast.id === row.id);
    const advisory = row.advisoryDays * intro.attendanceAdvisoryFee + (member?.hiredAt?.startsWith(month) ? intro.entryAdvisoryFee : 0);
    return { id: `${intro.id}_${row.id}`, introducer: intro.name, cast: row.name, feeType, honShimeiLiquorCost: row.honShimeiLiquorCost, salesBase, salesFee, grossBase: row.grossPay, grossFee, adopted, advisory, total: fee + advisory };
  });
}
function IntroducerPayments({ rows }: { rows: IntroRow[] }) { return <Card title="紹介者支払データ" description="売上基準は本指名売上のみです。場内延長売上は含みません。"><Table headers={["紹介者", "対象キャスト", "本指名酒代原価", "売上算定額", "売上10%", "総支給額", "総支給10%", "採用タイプ", "顧問料", "支払合計"]}>{rows.map((row) => <tr key={row.id}><td>{row.introducer}</td><td>{row.cast}</td><td>{yen.format(row.honShimeiLiquorCost)}</td><td>{yen.format(row.salesBase)}</td><td>{yen.format(row.salesFee)}</td><td>{yen.format(row.grossBase)}</td><td>{yen.format(row.grossFee)}</td><td>{row.adopted}</td><td>{yen.format(row.advisory)}</td><td><strong>{yen.format(row.total)}</strong></td></tr>)}</Table></Card>; }

type StaffRow = { id: string; name: string; hours: number; hourly: number; sales: number; bottle: number; gross: number; daily: number; net: number };
function staffPayroll(closings: DailyClosing[], adjustments: MonthlyAdjustments): StaffRow[] { const map = new Map<string, StaffRow>(); closings.forEach((closing) => (closing.staffWork ?? []).forEach((work) => { const row = map.get(work.staffId) || { id: work.staffId, name: work.name, hours: 0, hourly: 0, sales: adjustments.staffSalesAllowance[work.staffId] || 0, bottle: adjustments.staffBottleAllowance[work.staffId] || 0, gross: 0, daily: 0, net: 0 }; row.hours += work.hours; row.hourly += work.hourlyRate * work.hours; row.daily += work.dailyPayment; map.set(work.staffId, row); })); return [...map.values()].map((row) => { const hourly = floorHundred(row.hourly); return { ...row, hourly, gross: hourly + row.sales + row.bottle, net: hourly + row.sales + row.bottle - row.daily }; }); }
function StaffPayroll({ rows, onSales, onBottle }: { rows: StaffRow[]; onSales: (id: string, value: number) => void; onBottle: (id: string, value: number) => void }) { return <Card title="スタッフ給与データ"><Table headers={["スタッフ", "勤務時間", "基本給与", "売上手当", "ボトル手当", "総支給", "日払い", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hours}時間</td><td>{yen.format(row.hourly)}</td><td><MoneyInput value={row.sales} onChange={(value) => onSales(row.id, value)} /></td><td><MoneyInput value={row.bottle} onChange={(value) => onBottle(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.daily)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>)}</Table></Card>; }

function DriverPayroll({ rows, onRemote }: { rows: ReturnType<typeof calculateDriverPayroll>; onRemote: (id: string, value: number) => void }) { return <Card title="送迎ドライバー給与データ"><Table headers={["ドライバー", "出勤日数", "基本給与", "遠方手当", "総支給", "日払い", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.days}日</td><td>{yen.format(row.basic)}</td><td><MoneyInput value={row.remote} onChange={(value) => onRemote(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.dailyPayment)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>)}</Table></Card>; }

function expenseTotals(closings: DailyClosing[]) { const result: Record<string, number> = {}; closings.forEach((closing) => (closing.expenses ?? []).forEach((row) => { result[row.category] = (result[row.category] || 0) + row.amount; })); return result; }
function Expenses({ totals, adjustments, setAdjustments, deliveryAmount, total }: { approved: DailyClosing[]; totals: Record<string, number>; adjustments: MonthlyAdjustments; setAdjustments: (value: MonthlyAdjustments | ((row: MonthlyAdjustments) => MonthlyAdjustments)) => void; deliveryAmount: number; total: number }) {
  const addFixed = () => setAdjustments((row) => ({ ...row, fixedExpenses: [...row.fixedExpenses, { id: crypto.randomUUID(), account: "", amount: 0 }] }));
  return <div className="grid"><Card title="当月経費データ"><Table headers={["勘定科目", "金額"]}>{Object.entries(expenseLabels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{yen.format(totals[key] || 0)}</td></tr>)}</Table></Card><Card title="固定経費・月締め調整" action={<button className="button secondary" onClick={addFixed}>固定経費を追加</button>}><div className="stack">{adjustments.fixedExpenses.map((row) => <div className="grid form-row" key={row.id}><Field label="科目"><input className="input" value={row.account} onChange={(e) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, account: e.target.value } : item) }))} /></Field><Field label="金額"><MoneyInput value={row.amount} onChange={(amount) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, amount } : item) }))} /></Field><button className="button danger compact" onClick={() => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.filter((item) => item.id !== row.id) }))}>削除</button></div>)}</div><div className="grid two top-gap"><Field label="酒代納品書分（月締め後の修正可）"><MoneyInput value={deliveryAmount} onChange={(value) => setAdjustments((row) => ({ ...row, liquorDeliveryAmount: value }))} /></Field><Field label="カード決済手数料"><MoneyInput value={adjustments.cardFee} step={1} onChange={(value) => setAdjustments((row) => ({ ...row, cardFee: value }))} /></Field></div><div className="right-total">経費総合計 <strong>{yen.format(total)}</strong></div></Card></div>;
}

function Balance({ sales, cast, introducer, staff, driver, expenses, totalCosts, days, warnings }: { sales: number; cast: number; introducer: number; staff: number; driver: number; expenses: number; totalCosts: number; days: number; warnings: string[] }) { return <div className="grid"><div className="grid metrics"><Metric label="合計売上" value={yen.format(sales)} /><Metric label="総支出" value={yen.format(totalCosts)} /><Metric label="収支" value={yen.format(sales - totalCosts)} /><Metric label="承認営業日" value={`${days}日`} /></div><Card title="収支データ"><Table headers={["区分", "金額"]}><tr><td>合計売上</td><td>{yen.format(sales)}</td></tr><tr><td>キャスト報酬</td><td>− {yen.format(cast)}</td></tr><tr><td>紹介者支払</td><td>− {yen.format(introducer)}</td></tr><tr><td>スタッフ給与</td><td>− {yen.format(staff)}</td></tr><tr><td>送迎ドライバー給与</td><td>− {yen.format(driver)}</td></tr><tr><td>経費</td><td>− {yen.format(expenses)}</td></tr><tr className="total-row"><td><strong>収支</strong></td><td><strong>{yen.format(sales - totalCosts)}</strong></td></tr></Table>{warnings.length === 0 && <div className="notice success top-gap">すべての承認済みデータから収支を算出しました。</div>}</Card></div>; }

function accountingWarnings(rows: DailyClosing[]) { const warnings: string[] = []; rows.forEach((closing) => { (closing.integrityIssues ?? []).forEach((issue) => warnings.push(`${closing.businessDate || closing.id}: ${issue}`)); if (closing.cash.difference !== 0) warnings.push(`${closing.businessDate}の現金照合に${yen.format(closing.cash.difference)}の差額があります。`); (closing.casts ?? []).filter((row) => row.kind === "regular" && row.hourlyRate <= 0).forEach((row) => warnings.push(`${closing.businessDate}・${row.name}の時給が未設定です。`)); (closing.casts ?? []).filter((row) => row.introducer && !introducerFeeTypes.has(String(row.introducer.feeType || ""))).forEach((row) => warnings.push(`${closing.businessDate}・${row.name}の紹介者報酬形態が未設定です。`)); }); return [...new Set(warnings)]; }
function blankAdjustments(month: string, stored?: MonthlyAdjustments): MonthlyAdjustments { return stored ? { ...stored, withholdingByCast: stored.withholdingByCast || {}, staffSalesAllowance: stored.staffSalesAllowance || {}, staffBottleAllowance: stored.staffBottleAllowance || {}, driverRemoteAllowance: stored.driverRemoteAllowance || {}, fixedExpenses: Array.isArray(stored.fixedExpenses) ? stored.fixedExpenses : Object.values(stored.fixedExpenses || {}), cardFee: stored.cardFee || 0 } : { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 }; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="card metric-card"><small>{label}</small><strong>{value}</strong></div>; }
