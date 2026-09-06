"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { CastReward, CastSalesBackBreakdown, CastSalesBottleSummary, CastSalesReport, DailyClosing, LegacyBottleClassification, MonthlyAdjustments } from "@/domain/gms";
import { findUnclassifiedLegacyBottles, normalizeMonthlyAdjustments } from "@/domain/gms";
import { validateExpenseExport, type ExpenseExportInput } from "@/domain/expense-export";
import { buildBalanceExportReport, type BalanceExportInput } from "@/domain/balance-export";
import {
  buildMonthlySnapshot, calculateMonthlyAccounting, canFinalizeMonthlyAccounting, monthlySourceFingerprint,
  type AccountingWorkspaceData, type IntroducerPaymentRow, type MonthlyAccountingResults, type StaffPayrollRow,
} from "@/domain/month-accounting";
import { approveClosing, cancelAccountingMonthClosing, finalizeAccountingMonth, reopenAccountingMonth, returnClosing, saveMonthlyAdjustments } from "@/lib/firebase/repository";
import { Card, Field, MoneyInput, StatusPill, Table, currentMonth, yen } from "./ui";
import { summarizeCastDrinksByPrice } from "./store-work";

type Props = { data: AccountingWorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
type Section = "approval" | "castSales" | "castRewards" | "introducers" | "staffPayroll" | "driverPayroll" | "expenses" | "balance";

const statusLabel = { submitted: "確認待ち", returned: "差戻し中", approved: "承認済み", withdrawn: "店舗編集中（取下げ）" } as const;
const expenseLabels: Record<string, string> = { beautyTrial: "美容室手当", introduction: "紹介料", advertising: "広告等", supplies: "備品・消耗品他", entertainment: "交際費・プレゼント等", liquor: "酒代", transportOther: "交通費・その他" };
const classificationLabels: Record<LegacyBottleClassification, string> = { honShimei: "本指名", jonaiExtension: "場内延長", excluded: "対象外" };

export function AccountingForms({ section, ...props }: Props & { section: Section }) {
  if (section === "approval") return <ApprovalView {...props} />;
  return <MonthlyAccounting section={section} {...props} />;
}

function closingRevisionKey(closing: DailyClosing) {
  return [closing.id, closing.status, closing.updatedAt, closing.checksum].join(":");
}

function accountingMonthLockMessage(data: AccountingWorkspaceData, businessDate: string) {
  const state = data.monthStates.find((row) => row.month === businessDate.slice(0, 7));
  if (state?.status === "closed") return "月次確定済みです。承認・差戻しを行うには先に月次確定を解除してください。";
  if (state?.status === "closing") return "月次確定処理中です。処理完了後に最新データを読み込んでください。";
  return "";
}

function ApprovalView({ data, user, busy, run }: Props) {
  const [expanded, setExpanded] = useState("");
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const expandedClosing = data.closings.find((row) => row.id === expanded);
  return <div className="grid">
    <div className="grid metrics">
      <Metric label="経理確認待ち" value={`${data.closings.filter((row) => row.status === "submitted").length}件`} />
      <Metric label="承認済み" value={`${data.closings.filter((row) => row.status === "approved").length}件`} />
      <Metric label="差戻し" value={`${data.closings.filter((row) => row.status === "returned").length}件`} />
      <Metric label="当月承認売上" value={yen.format(data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(currentMonth())).reduce((sum, row) => sum + row.sales.totalSales, 0))} />
    </div>
    <Card title="店舗送信データの確認・承認" description="店舗データと現金照合の全項目を詳細で確認してから承認します。">
      <Table headers={["営業日", "状態", "総売上", "経費・支払", "現金実在高", "差額", "操作"]}>
        {data.closings.filter((row) => row.status !== "withdrawn").map((row) => {
          const revisionKey = closingRevisionKey(row);
          const isReviewed = Boolean(reviewed[revisionKey]);
          const monthLock = accountingMonthLockMessage(data, row.businessDate);
          return <tr key={row.id}><td>{row.businessDate}</td><td><StatusPill tone={row.status === "approved" ? "good" : row.status === "returned" ? "danger" : "warn"}>{statusLabel[row.status]}</StatusPill></td><td>{yen.format(row.sales.totalSales)}</td><td>{yen.format(row.cash.expenseAndPaymentTotal)}</td><td>{yen.format(row.cash.actualClosingCash)}</td><td className={row.cash.difference ? "text-danger" : "text-good"}>{yen.format(row.cash.difference)}</td><td><div className="row-actions">
            <button className="button secondary mini" disabled={busy} onClick={() => setExpanded(expanded === row.id ? "" : row.id)}>{expanded === row.id ? "閉じる" : "詳細"}</button>
            {row.status === "submitted" && <button className="button mini" title={monthLock || (!isReviewed ? "詳細下部の確認ボタンを押してください。" : undefined)} disabled={busy || Boolean(monthLock) || !isReviewed || (row.integrityIssues?.length || 0) > 0} onClick={() => { if (window.confirm(`${row.businessDate}の店舗データと現金照合を承認しますか？`)) void run(() => approveClosing(row.id, { businessDate: row.businessDate, updatedAt: row.updatedAt, checksum: row.checksum, submissionId: row.submissionId }, user), "店舗データを承認しました。"); }}>承認</button>}
            {(row.status === "submitted" || row.status === "approved") && <button className="button danger mini" title={monthLock || undefined} disabled={busy || Boolean(monthLock)} onClick={() => {
              if (row.status === "approved" && !window.confirm(`${row.businessDate}の承認を取り消して店舗へ差し戻しますか？\n再送・再承認されるまで月次集計から除外されます。`)) return;
              const reason = window.prompt(row.status === "approved" ? "承認後の差戻し理由を入力してください（500文字以内）。" : "差戻し理由を入力してください（500文字以内）。");
              if (reason?.trim()) void run(() => returnClosing(row.id, { businessDate: row.businessDate, updatedAt: row.updatedAt, checksum: row.checksum, submissionId: row.submissionId }, reason, user), "店舗へ差し戻しました。");
            }}>差戻し</button>}
            {monthLock && <small className="text-danger">{monthLock}</small>}
          </div></td></tr>;
        })}
      </Table>
      {expandedClosing && <ClosingDetail closing={expandedClosing} reviewed={Boolean(reviewed[closingRevisionKey(expandedClosing)])} disabled={busy || Boolean(accountingMonthLockMessage(data, expandedClosing.businessDate))} onReviewed={() => setReviewed((rows) => ({ ...rows, [closingRevisionKey(expandedClosing)]: true }))} />}
      {expanded && !expandedClosing && <div className="notice error">対象データが更新されたため、最新データを読み込んでください。</div>}
    </Card>
  </div>;
}

function ClosingDetail({ closing, reviewed, disabled, onReviewed }: { closing: DailyClosing; reviewed: boolean; disabled: boolean; onReviewed: () => void }) {
  const expenseTotal = closing.expenses.reduce((sum, row) => sum + row.amount, 0);
  const regularDaily = closing.casts.filter((row) => row.kind === "regular").reduce((sum, row) => sum + row.dailyPayment, 0);
  const trialDaily = closing.casts.filter((row) => row.kind === "trial").reduce((sum, row) => sum + row.dailyPayment, 0);
  const staffDaily = closing.staffWork.reduce((sum, row) => sum + row.dailyPayment, 0);
  const driverDaily = closing.drivers.reduce((sum, row) => sum + row.dailyPayment, 0);
  return <div className="detail-panel">
    {(closing.integrityIssues?.length || 0) > 0 && <div className="notice error"><strong>この営業日のデータが不完全です。</strong><ul>{closing.integrityIssues?.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>}
    {closing.returnReason && <div className="notice error"><strong>差戻し理由</strong><br />{closing.returnReason}</div>}
    <div className="summary-strip"><span><small>総売上</small><strong>{yen.format(closing.sales.totalSales)}</strong></span><span><small>現金売上</small><strong>{yen.format(closing.sales.cashSales)}</strong></span><span><small>カード売上</small><strong>{yen.format(closing.sales.cardSales)}</strong></span><span><small>現金差額</small><strong className={closing.cash.difference ? "text-danger" : "text-good"}>{yen.format(closing.cash.difference)}</strong></span></div>
    <h3>店舗データプレビュー</h3>
    <Table headers={["キャスト", "出退勤・時間", "本指名/場内/同伴", "本指名売上", "場内延長売上", "ボトル・ドリンク明細", "手当・控除"]}>
      {closing.casts.map((row) => <tr key={row.posCastId}><td><strong>{row.name}</strong><br /><small>{row.kind === "trial" ? "体入" : "在籍"}</small></td><td>{row.startTime}–{row.endTime}<br />{row.hours}時間</td><td>{row.honShimeiCount} / {row.banaiShimeiCount} / {row.dohanCount}</td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td><td className="wrap-cell"><ClosingCastProductDetails row={row} pos={closing.posSnapshot} /></td><td className="wrap-cell">美容室 {yen.format(row.beautyAllowance)}<br />日払い {yen.format(row.dailyPayment)}<br />立替 {yen.format(row.advancePayment)}<br />送迎 {yen.format(row.transportFee)}</td></tr>)}
    </Table>
    <h3>スタッフ・送迎ドライバー</h3>
    <Table headers={["区分", "名前", "勤務・給与基準", "日払い"]}>{[
      ...closing.staffWork.map((row) => <tr key={`staff-${row.staffId}`}><td>{row.kind === "trial" ? "体入スタッフ" : "スタッフ"}</td><td>{row.name}</td><td>{row.startTime}–{row.endTime}（{row.hours}時間）<br /><small>時給 {yen.format(row.hourlyRate)}</small></td><td>{yen.format(row.dailyPayment)}</td></tr>),
      ...closing.drivers.map((row) => <tr key={`driver-${row.driverId}`}><td>送迎ドライバー</td><td>{row.name}</td><td>日給 {yen.format(row.dailyRate)}</td><td>{yen.format(row.dailyPayment)}</td></tr>),
    ]}</Table>
    <h3>現金照合データプレビュー</h3>
    <div className="grid two"><Table headers={["当日経費", "支払先", "金額"]}>{closing.expenses.map((row) => <tr key={row.id}><td>{expenseLabels[row.category] || row.category || "科目未設定"}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td></tr>)}</Table><Table headers={["現金支払内訳", "金額"]}>
      <tr><td>経費総計</td><td>{yen.format(expenseTotal)}</td></tr><tr><td>在籍キャスト日払い</td><td>{yen.format(regularDaily)}</td></tr><tr><td>体入キャスト即日払い</td><td>{yen.format(trialDaily)}</td></tr><tr><td>スタッフ日払い</td><td>{yen.format(staffDaily)}</td></tr><tr><td>ドライバー日払い</td><td>{yen.format(driverDaily)}</td></tr><tr><td>派遣キャスト支払</td><td>{yen.format(closing.dispatchCastPayment)}</td></tr><tr><td>派遣スタッフ支払</td><td>{yen.format(closing.dispatchStaffPayment)}</td></tr><tr><td>派遣手数料</td><td>{yen.format(closing.dispatchFee)}</td></tr><tr className="total-row"><td>経費・支払合計</td><td><strong>{yen.format(closing.cash.expenseAndPaymentTotal)}</strong></td></tr>
    </Table></div>
    <Table headers={["現金照合計算", "金額"]}><tr><td>現金売上 ＋ つり銭</td><td>{yen.format(closing.cash.cashSales + closing.cash.cashFloat)}</td></tr><tr><td>経費・支払控除後（営業終了時の計算上現金残額）</td><td>{yen.format(closing.cash.expectedClosingCash)}</td></tr><tr><td>つり銭控除後の現金利益</td><td>{yen.format(closing.cash.cashProfit)}</td></tr><tr><td>営業終了時の現金実在高</td><td>{yen.format(closing.cash.actualClosingCash)}</td></tr><tr className="total-row"><td>現金差額</td><td className={closing.cash.difference ? "text-danger" : "text-good"}><strong>{yen.format(closing.cash.difference)}</strong></td></tr><tr><td>酒代納品書分（当日現金控除外）</td><td>{yen.format(closing.liquorDeliveryAmount)}</td></tr></Table>
    {closing.status === "submitted" && <div className="actions top-gap"><button className="button" disabled={disabled || reviewed || (closing.integrityIssues?.length || 0) > 0} onClick={onReviewed}>{reviewed ? "全項目を確認済み" : "店舗・現金プレビューの全項目を確認済みにする"}</button></div>}
  </div>;
}

export function ClosingCastProductDetails({
  row,
  pos,
}: {
  row: DailyClosing["casts"][number];
  pos: DailyClosing["posSnapshot"];
}) {
  const drinks = summarizeCastDrinksByPrice(row, pos);
  return <>
    {row.bottles.map((bottle, index) => <div key={`${bottle.sourceKey || bottle.itemId}-${index}`}><strong>{bottle.name} ×{bottle.quantity}</strong><br /><small>売上 {yen.format(bottle.salesAmount)} / 原価 {yen.format(bottle.costAmount)}{bottle.specialCost ? "（特別原価）" : ""}</small></div>)}
    {drinks.map((drink) => <div key={`drink-price-${drink.unitPrice}`}><strong>{yen.format(drink.unitPrice)}　{drink.quantity}杯</strong><br /><small>配賦売上 {yen.format(drink.salesAmount)}</small></div>)}
    {!row.bottles.length && drinks.length === 0 && (row.drinkSales ? <>キャストドリンク {yen.format(row.drinkSales)}</> : "—")}
  </>;
}

function MonthlyAccounting({ section, data, user, busy, run, onDirtyChange }: Props & { section: Exclude<Section, "approval"> }) {
  const [month, setMonth] = useState(currentMonth());
  const stored = data.adjustments.find((row) => row.month === month);
  const [adjustments, setAdjustments] = useState<MonthlyAdjustments>(() => blankAdjustments(month, stored));
  useEffect(() => setAdjustments(blankAdjustments(month, data.adjustments.find((row) => row.month === month))), [data.adjustments, month]);
  const state = data.monthStates.find((row) => row.month === month);
  const closed = state?.status === "closed";
  const currentSnapshot = closed ? data.monthSnapshots.find((row) => row.month === month && row.revision === state.currentSnapshotRevision) : undefined;
  const storedAdjustments = blankAdjustments(month, stored);
  const adjustmentsDirty = adjustmentSignature(adjustments) !== adjustmentSignature(storedAdjustments);
  useEffect(() => {
    onDirtyChange?.(adjustmentsDirty);
    return () => onDirtyChange?.(false);
  }, [adjustmentsDirty, onDirtyChange]);
  const allLegacyBottles = useMemo(() => findUnclassifiedLegacyBottles(data.closings, month, { ...adjustments, legacyBottleClassifications: {} }), [adjustments, data.closings, month]);
  const pendingLegacy = allLegacyBottles.filter((row) => !adjustments.legacyBottleClassifications?.[row.sourceKey]);
  const legacyDirty = classificationSignature(adjustments) !== classificationSignature(storedAdjustments);
  const calculationsBlocked = !closed && (pendingLegacy.length > 0 || legacyDirty);
  const liveResults = useMemo(() => calculateMonthlyAccounting(data, month, adjustments, data.introducerEntryEvents), [adjustments, data, month]);
  const results = closed ? currentSnapshot : calculationsBlocked ? undefined : liveResults;
  const approved = data.closings.filter((row) => row.status === "approved" && row.businessDate.startsWith(month));
  const finalizeCheck = canFinalizeMonthlyAccounting(data, month, adjustments, true);
  const setMap = (key: "withholdingByCast" | "staffSalesAllowance" | "staffBottleAllowance" | "driverRemoteAllowance", id: string, value: number) => setAdjustments((row) => ({ ...row, [key]: { ...row[key], [id]: value } }));
  const save = () => run(() => saveMonthlyAdjustments(adjustments, user), `${month}の経理入力を保存しました。`);
  const finalize = () => {
    if (adjustmentsDirty || calculationsBlocked || !finalizeCheck.allowed) return;
    if (!window.confirm(`${month}を月次確定しますか？\n確定後は日次承認・差戻し・経理入力を変更できません。`)) return;
    void run(async () => {
      const fingerprint = await monthlySourceFingerprint(data, month, adjustments, data.introducerEntryEvents);
      const snapshot = buildMonthlySnapshot(month, 0, fingerprint, adjustments, liveResults, data.closings, user.uid, new Date().toISOString());
      await finalizeAccountingMonth(month, snapshot, state?.revision || 0, user);
    }, `${month}を月次確定しました。`);
  };
  const reopen = () => {
    if (!state || state.status !== "closed" || !window.confirm(`${month}の月次確定を解除しますか？\n解除後は最新の承認済みデータから再計算されます。`)) return;
    void run(() => reopenAccountingMonth(month, state.revision, user), `${month}の月次確定を解除しました。`);
  };
  const cancelClosing = () => {
    if (!state || state.status !== "closing" || !window.confirm(`${month}の月次確定処理を中止しますか？\n別の端末で処理中でないことを確認してください。`)) return;
    void run(() => cancelAccountingMonthClosing(month, state.revision, user), `${month}の月次確定処理を中止しました。`);
  };
  const locked = closed || state?.status === "closing";
  const changeMonth = (nextMonth: string) => {
    if (nextMonth === month) return;
    if (adjustmentsDirty && !window.confirm(`${month}の未保存の経理入力を破棄して、${nextMonth}へ移動しますか？`)) return;
    setMonth(nextMonth);
  };
  return <div className="grid">
    <Card><div className="month-toolbar"><Field label="対象月"><input className="input" type="month" value={month} onChange={(event) => changeMonth(event.target.value)} /></Field><span>承認済み営業日 <strong>{results?.approvedDays ?? approved.length}日</strong></span>{state?.status === "closed" ? <StatusPill tone="good">月次確定済み 第{state.currentSnapshotRevision}版</StatusPill> : state?.status === "closing" ? <StatusPill tone="warn">月次確定処理中</StatusPill> : <StatusPill>未確定</StatusPill>}{!closed && state?.status !== "closing" && (section !== "castSales" || adjustmentsDirty) && <button className="button" disabled={busy || !adjustmentsDirty} onClick={() => void save()}>経理入力を保存</button>}{!closed && state?.status !== "closing" && <button className="button secondary" disabled={busy || adjustmentsDirty || calculationsBlocked || !finalizeCheck.allowed} onClick={finalize}>月次確定</button>}{state?.status === "closing" && <button className="button danger" disabled={busy} onClick={cancelClosing}>確定処理を中止</button>}{closed && <button className="button danger" disabled={busy} onClick={reopen}>確定解除</button>}</div></Card>
    {state?.status === "closing" && <div className="notice error">月次確定処理中です。画面を更新しても解消しない場合は、処理を行った担当者と通信状態を確認してください。</div>}
    {!closed && finalizeCheck.unresolvedDaily.length > 0 && <div className="notice error"><strong>未承認・差戻し中・店舗編集中の日次データがあるため月次確定できません。</strong><ul>{finalizeCheck.unresolvedDaily.map((row) => <li key={row.id}>{row.businessDate}：{statusLabel[row.status]}</li>)}</ul></div>}
    {!closed && adjustmentsDirty && !calculationsBlocked && <div className="notice">未保存の経理入力があります。保存すると月次確定できます。</div>}
    {closed && !currentSnapshot && <div className="notice error">確定時の月次データを読み込めません。確定解除は可能ですが、先にFirebaseデータと通信状態を確認してください。</div>}
    {!closed && allLegacyBottles.length > 0 && <LegacyBottleClassifications rows={allLegacyBottles} adjustments={adjustments} setAdjustments={setAdjustments} disabled={busy || locked} onSave={save} />}
    {!closed && calculationsBlocked && <div className="notice error"><strong>旧データのボトル区分が未確定または未保存のため、自動計算を停止しています。</strong><br />すべての商品を「本指名・場内延長・対象外」から手動指定し、保存してください。</div>}
    {results?.warnings.length ? <div className="notice error"><strong>正しく算出できない項目があります。</strong><ul>{results.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div> : null}
    {section === "castSales" && <CastSalesExport
      results={results} month={month}
      sourceLabel={closed ? `月次確定済み 第${state.currentSnapshotRevision}版` : "承認済みデータ（未確定）"}
      disabledReason={busy ? "処理中です。" : state?.status === "closing" ? "月次確定処理中です。"
        : adjustmentsDirty ? "未保存の経理入力を保存してください。"
        : calculationsBlocked ? "ボトル区分を確認して保存してください。"
        : !results ? "出力する月次データを読み込めません。"
        : results.warnings.length || (!closed && finalizeCheck.integrityIssues.length) ? "データの警告を解消してから出力してください。"
        : !results.castSalesReports.length ? "対象月の承認済みキャスト売上がありません。" : ""}
    />}
    {section === "expenses" && <ExpenseExport
      input={results ? { results, closings: data.closings, adjustments, month, snapshot: currentSnapshot } : undefined}
      month={month}
      sourceLabel={closed ? `月次確定済み 第${state.currentSnapshotRevision}版` : "承認済みデータ（未確定）"}
      disabledReason={busy ? "処理中です。" : state?.status === "closing" ? "月次確定処理中です。"
        : adjustmentsDirty ? "未保存の経理入力を保存してください。"
        : calculationsBlocked ? "ボトル区分を確認して保存してください。"
        : !results ? "出力する月次データを読み込めません。"
        : results.warnings.length || (!closed && finalizeCheck.integrityIssues.length) ? "データの警告を解消してから出力してください。" : ""}
    />}
    {section === "balance" && <BalanceExport
      input={results ? { results, closings: data.closings, adjustments, month, snapshot: currentSnapshot, staff: data.staff, archivedStaff: data.archivedStaff } : undefined}
      month={month}
      sourceLabel={closed ? `月次確定済み 第${state.currentSnapshotRevision}版` : "承認済みデータ（未確定）"}
      disabledReason={busy ? "処理中です。" : state?.status === "closing" ? "月次確定処理中です。"
        : adjustmentsDirty ? "未保存の経理入力を保存してください。"
        : calculationsBlocked ? "ボトル区分を確認して保存してください。"
        : !results ? "出力する月次データを読み込めません。"
        : results.warnings.length || (!closed && finalizeCheck.integrityIssues.length) ? "データの警告を解消してから出力してください。" : ""}
    />}
    {results && section === "castSales" && <CastSalesReports rows={results.castSalesReports} month={month} />}
    {results && section === "castRewards" && <CastRewards rows={results.castRewards} disabled={busy || locked} onWithholding={(id, value) => setMap("withholdingByCast", id, value)} />}
    {results && section === "introducers" && <IntroducerPayments rows={results.introducerPayments} />}
    {results && section === "staffPayroll" && <StaffPayroll rows={results.staffPayroll} disabled={busy || locked} onSales={(id, value) => setMap("staffSalesAllowance", id, value)} onBottle={(id, value) => setMap("staffBottleAllowance", id, value)} />}
    {results && section === "driverPayroll" && <DriverPayroll rows={results.driverPayroll} disabled={busy || locked} onRemote={(id, value) => setMap("driverRemoteAllowance", id, value)} />}
    {results && section === "expenses" && <Expenses results={results} adjustments={adjustments} setAdjustments={setAdjustments} disabled={busy || locked} />}
    {results && section === "balance" && <Balance results={results} />}
  </div>;
}

export function CastSalesExport({ results, month, sourceLabel, disabledReason }: {
  results?: Pick<MonthlyAccountingResults, "castSalesReports" | "castRewards">;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  const exportAll = async () => {
    if (disabledReason || !results || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    try {
      const { createCastSalesWorkbook } = await import("@/lib/xlsx/cast-sales");
      const { downloadWorkbook } = await import("@/lib/xlsx/workbooks");
      const book = createCastSalesWorkbook(results, month, sourceLabel);
      await downloadWorkbook(book, `GENESISキャスト売上_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}のキャスト売上XLSXを出力しました。` });
    } catch (error) {
      setNotice({ month, error: true, text: `XLSXを出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  return <Card title="キャスト売上XLSX" description={`${month}・${sourceLabel}。全員をキャスト別シートにまとめ、左右両方の給与欄を出力します。`}
    action={<button className="button" disabled={Boolean(disabledReason) || exporting || !results} title={disabledReason || undefined} onClick={() => void exportAll()}>{exporting ? "XLSX出力中…" : "全員分をXLSX出力"}</button>}>
    {disabledReason && <p className="muted compact-text">{disabledReason}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}

export function ExpenseExport({ input, month, sourceLabel, disabledReason }: {
  input?: ExpenseExportInput;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  const validationError = useMemo(() => {
    if (disabledReason || !input) return "";
    try {
      validateExpenseExport(input);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "出力元データを確認してください。";
    }
  }, [disabledReason, input]);
  const blockedReason = disabledReason || validationError;
  const exportExpenses = async () => {
    if (blockedReason || !input || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    try {
      const { createMonthlyExpenseWorkbook } = await import("@/lib/xlsx/expenses");
      const { downloadWorkbook } = await import("@/lib/xlsx/workbooks");
      const book = createMonthlyExpenseWorkbook(input, sourceLabel);
      await downloadWorkbook(book, `GENESIS経費表_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}の経費表XLSXを出力しました。` });
    } catch (error) {
      setNotice({ month, error: true, text: `XLSXを出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  return <Card title="経費表XLSX" description={`${month}・${sourceLabel}。見本の経費表形式で、日次経費・固定費・給与・紹介者支払を出力します。未承認・差戻し中・店舗編集中の日次は含みません。`}
    action={<button className="button" disabled={Boolean(blockedReason) || exporting || !input} title={blockedReason || undefined} onClick={() => void exportExpenses()}>{exporting ? "XLSX出力中…" : "経費表をXLSX出力"}</button>}>
    {blockedReason && <p className="muted compact-text">{blockedReason}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}

export function BalanceExport({ input, month, sourceLabel, disabledReason }: {
  input?: BalanceExportInput;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ month: string; error: boolean; text: string }>();
  const validationError = useMemo(() => {
    if (disabledReason || !input) return "";
    if (input.month !== month) return "表示中の対象月と出力データが一致しません。最新データを読み込んでください。";
    try {
      buildBalanceExportReport(input);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "出力元データを確認してください。";
    }
  }, [disabledReason, input, month]);
  const blockedReason = disabledReason || validationError;
  const exportBalance = async () => {
    if (blockedReason || !input || input.month !== month || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    try {
      const { createMonthlyBalanceWorkbook } = await import("@/lib/xlsx/balance");
      const { downloadWorkbook } = await import("@/lib/xlsx/workbooks");
      const book = createMonthlyBalanceWorkbook(input, sourceLabel);
      await downloadWorkbook(book, `GENESIS収支表_${month}.xlsx`);
      setNotice({ month, error: false, text: `${month}の収支表XLSXを出力しました。` });
    } catch (error) {
      setNotice({ month, error: true, text: `XLSXを出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  };
  return <Card title="収支表XLSX" description={`${month}・${sourceLabel}。月間の採用報酬方式を日別に配分し、紹介料を独立列で出力します。月額の紹介料・固定費・納品酒代・カード手数料は最後の承認済み営業日に計上します。カード入金額はExcel内で入力してください。未承認・差戻し中・店舗編集中の日次は含みません。`}
    action={<button className="button" disabled={Boolean(blockedReason) || exporting || !input} title={blockedReason || undefined} onClick={() => void exportBalance()}>{exporting ? "XLSX出力中…" : "収支表をXLSX出力"}</button>}>
    {blockedReason && <p className="muted compact-text">{blockedReason}</p>}
    {notice?.month === month && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}

function LegacyBottleClassifications({ rows, adjustments, setAdjustments, disabled, onSave }: { rows: ReturnType<typeof findUnclassifiedLegacyBottles>; adjustments: MonthlyAdjustments; setAdjustments: (value: MonthlyAdjustments | ((row: MonthlyAdjustments) => MonthlyAdjustments)) => void; disabled: boolean; onSave: () => Promise<boolean> }) {
  const pending = rows.filter((row) => !adjustments.legacyBottleClassifications?.[row.sourceKey]).length;
  return <Card title="旧日次データのボトルバック区分" description="POS原本がない旧データは自動判定しません。商品ごとに必ず手動指定してください。" action={<button className="button" disabled={disabled || pending > 0} onClick={() => void onSave()}>区分を保存</button>}><Table headers={["営業日", "キャスト", "ボトル", "数量", "売上", "原価", "手動区分"]}>{rows.map((row) => <tr key={row.sourceKey}><td>{row.businessDate}</td><td>{row.castName}</td><td>{row.bottle.name}</td><td>{row.bottle.quantity}</td><td>{yen.format(row.bottle.salesAmount)}</td><td>{yen.format(row.bottle.costAmount)}</td><td><select className="input" disabled={disabled} value={adjustments.legacyBottleClassifications?.[row.sourceKey] || ""} onChange={(event) => setAdjustments((current) => ({ ...current, legacyBottleClassifications: { ...(current.legacyBottleClassifications || {}), [row.sourceKey]: event.target.value as LegacyBottleClassification } }))}><option value="">選択してください</option>{Object.entries(classificationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td></tr>)}</Table>{pending > 0 && <div className="notice error top-gap">未指定の商品が{pending}件あります。</div>}</Card>;
}

const businessDateLabel = (value: string) => { const [, month, day] = value.split("-").map(Number); return Number.isFinite(month) && Number.isFinite(day) ? `${month}月${day}日` : value; };
function BackBreakdown({ rows }: { rows: CastSalesBackBreakdown[] }) { return <div className="back-breakdown">{rows.map((row) => <span key={row.key}><small>{row.label}</small><strong>{yen.format(row.amount)}</strong></span>)}</div>; }
function BottleSummary({ rows }: { rows: CastSalesBottleSummary[] }) { return rows.length ? <div className="bottle-summary">{rows.map((row) => <span key={row.name}>{row.name}<small>×{row.quantity}</small></span>)}</div> : <>—</>; }

function CastSalesReports({ rows, month }: { rows: CastSalesReport[]; month: string }) {
  const totals = rows.reduce((result, row) => ({ attendanceDays: result.attendanceDays + row.attendanceDays, sales: result.sales + row.totals.totalSales, liquorCost: result.liquorCost + row.totals.totalLiquorCost, backs: result.backs + row.totals.backTotal }), { attendanceDays: 0, sales: 0, liquorCost: 0, backs: 0 });
  if (!rows.length) return <Card title="キャスト売上" description={`${month}の承認済みキャスト売上はありません。`}><div className="notice">店舗送信データを承認すると、この画面へ反映されます。</div></Card>;
  return <div className="grid cast-sales-report"><div className="grid metrics"><Metric label="対象キャスト" value={`${rows.length}名`} /><Metric label="延べ出勤" value={`${totals.attendanceDays}日`} /><Metric label="キャスト合計売上" value={yen.format(totals.sales)} /><Metric label="バック合計" value={yen.format(totals.backs)} /></div>{rows.map((report, index) => <details className="card cast-sales-card" key={report.id} open={index === 0}><summary className="cast-sales-summary"><strong>{report.name}</strong><span>{report.totals.attendanceDays}日 / {report.totals.hours}時間</span><span>合計売上 <b>{yen.format(report.totals.totalSales)}</b></span><span>バック <b>{yen.format(report.totals.backTotal)}</b></span></summary><div className="cast-sales-content"><Table headers={["出勤日", "出勤時刻", "退勤時刻", "勤務時間", "本指名売上", "場内延長売上", "合計売上", "本指名酒代原価", "場内延長酒代原価", "合計酒代原価", "本指名/場内指名", "同伴", "各種バック", "ボトル銘柄", "美容室手当"]}>{report.days.map((day) => <tr key={`${report.id}-${day.businessDate}`}><td>{businessDateLabel(day.businessDate)}</td><td>{day.startTime || "—"}</td><td>{day.endTime || "—"}</td><td>{day.hours}時間</td><td>{yen.format(day.honShimeiSales)}</td><td>{yen.format(day.jonaiExtensionSales)}</td><td><strong>{yen.format(day.totalSales)}</strong></td><td>{yen.format(day.honShimeiLiquorCost)}</td><td>{yen.format(day.jonaiExtensionLiquorCost)}</td><td>{yen.format(day.totalLiquorCost)}</td><td>{day.honShimeiCount}本 / {day.banaiShimeiCount}本<br /><small>計 {day.nominationCount}本</small></td><td>{day.dohanCount}本</td><td className="wrap-cell"><BackBreakdown rows={day.backs} /><div className="cell-total">計 {yen.format(day.backTotal)}</div></td><td className="wrap-cell"><BottleSummary rows={day.bottles} /></td><td>{day.beautyAllowance > 0 ? <><StatusPill tone="good">あり</StatusPill><br />{yen.format(day.beautyAllowance)}</> : "なし"}</td></tr>)}<tr className="total-row"><td>{month} 合計<br /><strong>{report.totals.attendanceDays}日</strong></td><td>—</td><td>—</td><td>{report.totals.hours}時間</td><td>{yen.format(report.totals.honShimeiSales)}</td><td>{yen.format(report.totals.jonaiExtensionSales)}</td><td><strong>{yen.format(report.totals.totalSales)}</strong></td><td>{yen.format(report.totals.honShimeiLiquorCost)}</td><td>{yen.format(report.totals.jonaiExtensionLiquorCost)}</td><td>{yen.format(report.totals.totalLiquorCost)}</td><td>{report.totals.honShimeiCount}本 / {report.totals.banaiShimeiCount}本<br /><small>計 {report.totals.nominationCount}本</small></td><td>{report.totals.dohanCount}本</td><td className="wrap-cell"><BackBreakdown rows={report.totals.backs} /><div className="cell-total">計 {yen.format(report.totals.backTotal)}</div></td><td className="wrap-cell"><BottleSummary rows={report.totals.bottles} /></td><td>{report.days.filter((day) => day.beautyAllowance > 0).length}日<br />{yen.format(report.totals.beautyAllowance)}</td></tr></Table></div></details>)}</div>;
}

function CastRewards({ rows, disabled, onWithholding }: { rows: CastReward[]; disabled: boolean; onWithholding: (id: string, value: number) => void }) {
  return <Card title="キャスト報酬データ" description="時給＋各種バックと売上報酬を比較し、高い方へ美容室手当を加算します。"><Table headers={["キャスト", "勤務", "基本報酬", "指名・同伴内訳", "ボトル", "ドリンク", "酒代原価", "売上報酬", "採用", "美容室", "総支給", "日払・立替・送迎内訳", "源泉所得税", "差引支給"]}>{rows.map((row) => <tr key={row.id}>
    <td><strong>{row.name}</strong>{row.trialOnly && <><br /><StatusPill>体入時給のみ</StatusPill></>}</td>
    <td>{row.days}日 / {row.hours}時間</td>
    <td>{yen.format(row.hourlyPay)}</td>
    <td className="wrap-cell"><div className="back-breakdown"><span><small>本指名</small><strong>{yen.format(row.honShimeiBack)}</strong></span><span><small>場内指名</small><strong>{yen.format(row.banaiShimeiBack)}</strong></span><span><small>同伴</small><strong>{yen.format(row.dohanBack)}</strong></span></div></td>
    <td>{yen.format(row.bottleBack)}</td>
    <td>{yen.format(row.drinkBack)}</td>
    <td>{yen.format(row.liquorCost)}</td>
    <td>{row.rewardRate ? `${Math.round(row.rewardRate * 100)}% / ${yen.format(row.salesReward)}` : "対象外"}</td>
    <td><StatusPill tone="good">{row.trialOnly ? "体入時給" : row.adoptedSystem === "salesReward" ? "売上報酬" : "時給＋バック"} {yen.format(row.adoptedReward)}</StatusPill></td>
    <td>{yen.format(row.beautyAllowance)}</td>
    <td><strong>{yen.format(row.grossPay)}</strong></td>
    <td className="wrap-cell"><div className="back-breakdown"><span><small>日払い</small><strong>{yen.format(row.dailyPayment)}</strong></span><span><small>立替</small><strong>{yen.format(row.advancePayment)}</strong></span><span><small>送迎</small><strong>{yen.format(row.transportFee)}</strong></span></div></td>
    <td><MoneyInput value={row.withholding} disabled={disabled} onChange={(value) => onWithholding(row.id, value)} /></td>
    <td><strong>{yen.format(row.netPay)}</strong></td>
  </tr>)}</Table></Card>;
}
function IntroducerPayments({ rows }: { rows: IntroducerPaymentRow[] }) { return <Card title="紹介者支払データ" description="売上基準は本指名売上のみです。場内延長売上は含みません。"><Table headers={["紹介者", "対象キャスト", "本指名酒代原価", "売上算定額", "売上10%", "総支給額", "総支給10%", "採用タイプ", "出勤顧問料", "入店顧問料", "支払合計"]}>{rows.map((row) => <tr key={row.id}><td>{row.introducer}</td><td>{row.cast}</td><td>{yen.format(row.honShimeiLiquorCost)}</td><td>{yen.format(row.salesBase)}</td><td>{yen.format(row.salesFee)}</td><td>{yen.format(row.grossBase)}</td><td>{yen.format(row.grossFee)}</td><td>{row.adopted}</td><td>{yen.format(row.attendanceAdvisory)}</td><td>{yen.format(row.entryAdvisory)}</td><td><strong>{yen.format(row.total)}</strong></td></tr>)}</Table></Card>; }
function StaffPayroll({ rows, disabled, onSales, onBottle }: { rows: StaffPayrollRow[]; disabled: boolean; onSales: (id: string, value: number) => void; onBottle: (id: string, value: number) => void }) { return <Card title="スタッフ給与データ"><Table headers={["スタッフ", "勤務時間", "基本給与", "売上手当", "ボトル手当", "総支給", "日払い", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.hours}時間</td><td>{yen.format(row.hourly)}</td><td><MoneyInput value={row.sales} disabled={disabled} onChange={(value) => onSales(row.id, value)} /></td><td><MoneyInput value={row.bottle} disabled={disabled} onChange={(value) => onBottle(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.daily)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>)}</Table></Card>; }
function DriverPayroll({ rows, disabled, onRemote }: { rows: MonthlyAccountingResults["driverPayroll"]; disabled: boolean; onRemote: (id: string, value: number) => void }) { return <Card title="送迎ドライバー給与データ"><Table headers={["ドライバー", "出勤日数", "基本給与", "遠方手当", "総支給", "日払い", "差引支給"]}>{rows.map((row) => <tr key={row.id}><td>{row.name}</td><td>{row.days}日</td><td>{yen.format(row.basic)}</td><td><MoneyInput value={row.remote} disabled={disabled} onChange={(value) => onRemote(row.id, value)} /></td><td>{yen.format(row.gross)}</td><td>{yen.format(row.dailyPayment)}</td><td><strong>{yen.format(row.net)}</strong></td></tr>)}</Table></Card>; }

function Expenses({ results, adjustments, setAdjustments, disabled }: { results: MonthlyAccountingResults; adjustments: MonthlyAdjustments; setAdjustments: (value: MonthlyAdjustments | ((row: MonthlyAdjustments) => MonthlyAdjustments)) => void; disabled: boolean }) {
  const addFixed = () => setAdjustments((row) => ({ ...row, fixedExpenses: [...row.fixedExpenses, { id: crypto.randomUUID(), account: "", amount: 0 }] }));
  return <div className="grid"><Card title="当月経費データ"><Table headers={["勘定科目", "金額"]}>{Object.entries(expenseLabels).map(([key, label]) => <tr key={key}><td>{label}</td><td>{yen.format(results.expenses.byCategory[key] || 0)}</td></tr>)}</Table><div className="right-total">日次経費計 <strong>{yen.format(results.expenses.dailyExpenseTotal)}</strong></div></Card><Card title="派遣支払"><Table headers={["区分", "金額"]}><tr><td>派遣キャスト支払</td><td>{yen.format(results.expenses.dispatchCast)}</td></tr><tr><td>派遣スタッフ支払</td><td>{yen.format(results.expenses.dispatchStaff)}</td></tr><tr><td>派遣手数料</td><td>{yen.format(results.expenses.dispatchFee)}</td></tr><tr className="total-row"><td>派遣支払計</td><td><strong>{yen.format(results.expenses.dispatchTotal)}</strong></td></tr></Table></Card><Card title="固定経費・月締め調整" action={!disabled ? <button className="button secondary" onClick={addFixed}>固定経費を追加</button> : null}><div className="stack">{adjustments.fixedExpenses.map((row) => <div className="grid form-row" key={row.id}><Field label="科目"><input className="input" disabled={disabled} value={row.account} onChange={(event) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, account: event.target.value } : item) }))} /></Field><Field label="金額"><MoneyInput value={row.amount} disabled={disabled} onChange={(amount) => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.map((item) => item.id === row.id ? { ...item, amount } : item) }))} /></Field>{!disabled && <button className="button danger compact" onClick={() => setAdjustments((value) => ({ ...value, fixedExpenses: value.fixedExpenses.filter((item) => item.id !== row.id) }))}>削除</button>}</div>)}</div><div className="grid two top-gap"><Field label="酒代納品書分（月締め後は確定解除して修正）"><MoneyInput value={results.expenses.liquorDelivery} disabled={disabled} onChange={(value) => setAdjustments((row) => ({ ...row, liquorDeliveryAmount: value }))} /></Field><Field label="カード決済手数料"><MoneyInput value={adjustments.cardFee} disabled={disabled} onChange={(value) => setAdjustments((row) => ({ ...row, cardFee: value }))} /></Field></div><div className="right-total">経費総合計 <strong>{yen.format(results.expenses.total)}</strong></div></Card></div>;
}
function Balance({ results }: { results: MonthlyAccountingResults }) { return <div className="grid"><div className="grid metrics"><Metric label="現金売上" value={yen.format(results.sales.cash)} /><Metric label="カード売上" value={yen.format(results.sales.card)} /><Metric label="合計売上" value={yen.format(results.sales.total)} /><Metric label="収支" value={yen.format(results.balance.profit)} /></div><Card title="収支データ"><Table headers={["区分", "金額"]}><tr><td>現金売上</td><td>{yen.format(results.sales.cash)}</td></tr><tr><td>カード売上</td><td>{yen.format(results.sales.card)}</td></tr><tr className="total-row"><td>合計売上</td><td><strong>{yen.format(results.sales.total)}</strong></td></tr><tr><td>キャスト報酬</td><td>− {yen.format(results.balance.cast)}</td></tr><tr><td>紹介者支払</td><td>− {yen.format(results.balance.introducer)}</td></tr><tr><td>スタッフ給与</td><td>− {yen.format(results.balance.staff)}</td></tr><tr><td>送迎ドライバー給与</td><td>− {yen.format(results.balance.driver)}</td></tr><tr><td>経費・派遣支払</td><td>− {yen.format(results.balance.expenses)}</td></tr><tr className="total-row"><td>総支出</td><td><strong>− {yen.format(results.balance.totalCosts)}</strong></td></tr><tr className="total-row"><td><strong>収支</strong></td><td><strong>{yen.format(results.balance.profit)}</strong></td></tr></Table>{results.warnings.length === 0 && <div className="notice success top-gap">すべての承認済みデータから収支を算出しました。</div>}</Card></div>; }

function mapSignature(value: Record<string, unknown> | undefined) { return JSON.stringify(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right))); }
function classificationSignature(value: MonthlyAdjustments) { return mapSignature(value.legacyBottleClassifications); }
function adjustmentSignature(value: MonthlyAdjustments) { return JSON.stringify({ withholdingByCast: mapSignature(value.withholdingByCast), staffSalesAllowance: mapSignature(value.staffSalesAllowance), staffBottleAllowance: mapSignature(value.staffBottleAllowance), driverRemoteAllowance: mapSignature(value.driverRemoteAllowance), fixedExpenses: value.fixedExpenses, liquorDeliveryAmount: value.liquorDeliveryAmount, cardFee: value.cardFee, legacyBottleClassifications: classificationSignature(value) }); }
function blankAdjustments(month: string, stored?: MonthlyAdjustments): MonthlyAdjustments { return normalizeMonthlyAdjustments(stored || { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, legacyBottleClassifications: {}, revision: 0 }); }
function Metric({ label, value }: { label: string; value: string }) { return <div className="card metric-card"><small>{label}</small><strong>{value}</strong></div>; }
