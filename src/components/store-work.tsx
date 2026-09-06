"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type {
  BottleAllocation, CastKind, DailyCast, DailyClosing, DailyDriverWork, DailyExpense, DailyStaffWork, ExpenseCategory,
  PosClosingV3, PosItem, PosTransaction, ReconciledDailyCastInputs
} from "@/domain/gms";
import { buildDailyCasts, calculateCash, canMapAsDispatch, deriveReeditCastMapping, floorHundred, floorTen, hoursBetweenQuarter, invalidTrialBeautyExpensesForRows, isCastMappingComplete, isUnapprovedClosingStatus, mergeReconciledDailyCastInputs, parsePosClosingV3, posCastReferences, posItemOccurrenceKey, rateForMonth, requiresBottleCost, restoreDailyCastBackMetadata, staffCandidatesForBusinessDate } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { deleteUnapprovedClosing, submitClosing, withdrawClosing } from "@/lib/firebase/repository";
import { Card, Field, MoneyInput, StatusPill, Table, yen } from "./ui";

type Props = { data: AccountingWorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean>; onDirtyChange?: (dirty: boolean) => void };
type Stage = "json" | "details" | "cash" | "preview";
type MissingBottleCost = { transaction: PosTransaction; item: PosItem; sourceKey: string };

const expenseLabels: Record<ExpenseCategory, string> = {
  beautyTrial: "1. 体入キャスト美容室手当",
  introduction: "2. 紹介料",
  advertising: "2. 広告等",
  supplies: "3. 備品・消耗品他",
  entertainment: "4. 交際費・プレゼント等",
  liquor: "5. 酒代",
  transportOther: "6. 交通費・その他"
};

const closingLabels: Record<DailyClosing["status"], string> = {
  submitted: "経理確認待ち", returned: "差戻し", approved: "承認済み", withdrawn: "取下げ"
};

function lockedMonthMessage(data: AccountingWorkspaceData, businessDate: string) {
  const state = data.monthStates.find((row) => row.month === businessDate.slice(0, 7));
  if (state?.status === "closed") return "月次確定済みのため、再編集・取下げ・完全削除はできません。経理またはOPが月次確定を解除してください。";
  if (state?.status === "closing") return "月次確定処理中のため、再編集・取下げ・完全削除はできません。処理完了後に最新データを読み込んでください。";
  return "";
}

export function closingDeletionConfirmation(row: Pick<DailyClosing, "businessDate" | "status">) {
  return `${row.businessDate}の送信済みデータ（${closingLabels[row.status]}）を完全削除しますか？\n\nPOS原本・店舗入力・現金照合・差戻し履歴を含む、この営業日の日次データがすべて削除されます。\n削除後は復元できません。`;
}

export function jsonReimportConfirmation(previousDate: string, nextDate: string) {
  if (previousDate === nextDate) {
    return `${nextDate}のJSONを再取込します。\n\n入力済みの店舗データと現金実在高は保持し、勤務・指名本数・商品配賦などPOS由来の項目だけを新しいJSONから再計算します。続けますか？`;
  }
  return `${previousDate}から${nextDate}へ営業日を変更します。\n\n別営業日のデータが混ざらないよう、入力済みの店舗データ・現金照合・今回のみの特別原価はすべて初期化されます。続けますか？`;
}

export function shouldResetDailyInputsForJson(previousDate: string, nextDate: string) {
  return Boolean(previousDate && previousDate !== nextDate);
}

export function retainCurrentCastMappingForJson(
  previousPos: PosClosingV3 | null,
  nextPos: PosClosingV3,
  currentMapping: Record<string, string>,
) {
  if (!previousPos || previousPos.businessDate !== nextPos.businessDate) return {};
  const previousSources = new Map(posCastReferences(previousPos).map((source) => [source.id, source] as const));
  const result: Record<string, string> = {};
  posCastReferences(nextPos).forEach((source) => {
    const previous = previousSources.get(source.id);
    if (!previous || previous.name !== source.name || previous.kind !== source.kind) return;
    const selected = currentMapping[source.id];
    if (!selected) return;
    if (selected === "dispatch") {
      if (canMapAsDispatch(source.kind)) result[source.id] = selected;
      return;
    }
    if (source.kind !== "dispatch") result[source.id] = selected;
  });
  return result;
}

export function reconcileTrialBeautyExpenses(
  expenses: DailyExpense[],
  reconciled: Pick<ReconciledDailyCastInputs, "rows" | "matches">,
) {
  return expenses.map((expense) => {
    if (expense.category !== "beautyTrial" || !expense.personId) return expense;
    const matches = reconciled.matches.filter(({ previous, next }) => previous.kind === "trial"
      && next.kind === "trial"
      && previous.masterId === expense.personId
      && (!expense.personName || previous.name === expense.personName));
    if (matches.length === 1) {
      const next = matches[0].next;
      return { ...expense, personId: next.masterId, personName: next.name, payee: next.name };
    }
    // POS人物行との対応がない名称訂正だけは、一意な同一masterIdへ追従する。
    const sameMaster = reconciled.rows.filter((row) => row.kind === "trial" && row.masterId === expense.personId);
    if (sameMaster.length === 1) {
      return { ...expense, personName: sameMaster[0].name, payee: sameMaster[0].name };
    }
    return expense;
  });
}

export function StoreWork(props: Props) {
  const [editing, setEditing] = useState<DailyClosing | null>(null);
  const [workflowDirty, setWorkflowDirty] = useState(false);
  const beginEditing = (row: DailyClosing) => {
    if (lockedMonthMessage(props.data, row.businessDate)) return;
    if (workflowDirty && !window.confirm("現在入力中の営業日データは保存されていません。破棄して別の送信済みデータを再編集しますか？")) return;
    setEditing(row);
  };
  const deleteClosing = async (row: DailyClosing) => {
    if (!window.confirm(closingDeletionConfirmation(row))) return;
    let deletionCommitted = false;
    await props.run(
      async () => {
        await deleteUnapprovedClosing(row.id, {
          businessDate: row.businessDate,
          updatedAt: row.updatedAt,
          checksum: row.checksum,
          submissionId: row.submissionId,
        }, props.user);
        deletionCommitted = true;
      },
      `${row.businessDate}の送信済みデータを完全削除しました。`,
    );
    if (deletionCommitted && editing?.id === row.id) {
      setEditing(null);
      setWorkflowDirty(false);
    }
  };
  useEffect(() => {
    props.onDirtyChange?.(workflowDirty);
    return () => props.onDirtyChange?.(false);
  }, [props.onDirtyChange, workflowDirty]);
  return <div className="grid">
    <DailyWorkflow key={editing?.id || "new"} {...props} initial={editing} onFinished={() => setEditing(null)} onDirtyChange={setWorkflowDirty} />
    <Card title="送信済みデータ" description="店舗データと現金照合プレビューを営業日ごとに保管します。経理未承認のデータは完全削除できます。">
      <Table headers={["営業日", "状態", "売上", "現金残額", "差額", "差戻し理由", "操作"]}>
        {props.data.closings.map((row) => {
          const monthLock = lockedMonthMessage(props.data, row.businessDate);
          const updateDisabled = props.busy || Boolean(monthLock);
          return <tr key={row.id}>
            <td>{row.businessDate}</td>
            <td><StatusPill tone={row.status === "approved" ? "good" : row.status === "returned" ? "danger" : row.status === "submitted" ? "warn" : "neutral"}>{closingLabels[row.status]}</StatusPill></td>
            <td>{yen.format(row.sales.totalSales)}</td>
            <td>{yen.format(row.cash.actualClosingCash)}</td>
            <td className={row.cash.difference ? "text-danger" : "text-good"}>{yen.format(row.cash.difference)}</td>
            <td className="wrap-cell">{row.returnReason || "—"}</td>
            <td><div className="row-actions">
              {["returned", "withdrawn"].includes(row.status) && <button className="button secondary mini" disabled={updateDisabled} title={monthLock || undefined} onClick={() => beginEditing(row)}>再編集</button>}
              {["submitted", "returned"].includes(row.status) && <button className="button secondary mini" disabled={updateDisabled} title={monthLock || undefined} onClick={() => { if (window.confirm(`${row.businessDate}の送信を取り下げますか？`)) void props.run(() => withdrawClosing(row.id, { businessDate: row.businessDate, updatedAt: row.updatedAt, checksum: row.checksum, submissionId: row.submissionId }, props.user), "送信を取り下げました。再編集できます。"); }}>取下げ</button>}
              {isUnapprovedClosingStatus(row.status) && <button className="button danger mini" disabled={updateDisabled} title={monthLock || undefined} onClick={() => void deleteClosing(row)}>完全削除</button>}
              <details><summary className="text-button">プレビュー</summary><div className="popover-preview"><DailyPreview closing={row} /></div></details>
              {monthLock && <small className="text-danger">{monthLock}</small>}
            </div></td>
          </tr>;
        })}
      </Table>
    </Card>
  </div>;
}

function DailyWorkflow({ data, user, busy, run, initial, onFinished, onDirtyChange }: Props & { initial: DailyClosing | null; onFinished: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [stage, setStage] = useState<Stage>(initial?.posSnapshot ? "details" : "json");
  const [pos, setPos] = useState<PosClosingV3 | null>(initial?.posSnapshot || null);
  const [mapping, setMapping] = useState<Record<string, string>>(() => deriveReeditCastMapping(initial));
  const [allowInitialSnapshotMapping, setAllowInitialSnapshotMapping] = useState(Boolean(initial?.posSnapshot));
  const [specialCosts, setSpecialCosts] = useState<Record<string, number>>(() => initialStoredBottleCosts(initial));
  const [castRows, setCastRows] = useState<DailyCast[]>(() => initial?.posSnapshot
    ? restoreDailyCastBackMetadata(initial.posSnapshot, initial.casts || [])
    : initial?.casts || []);
  const [castRowsSourcePos, setCastRowsSourcePos] = useState<PosClosingV3 | null>(initial?.posSnapshot || null);
  const [unmatchedCastDrafts, setUnmatchedCastDrafts] = useState<DailyCast[]>([]);
  const [staffWork, setStaffWork] = useState<DailyStaffWork[]>(() => (initial?.staffWork || []).map((row) => row.kind === "trial"
    ? { ...row, dailyPayment: floorHundred(row.hourlyRate * row.hours) }
    : row));
  const [staffId, setStaffId] = useState("");
  const [staffStart, setStaffStart] = useState("20:00");
  const [staffEnd, setStaffEnd] = useState("02:00");
  const [driverWork, setDriverWork] = useState<DailyDriverWork[]>(initial?.drivers || []);
  const [expenses, setExpenses] = useState<DailyExpense[]>(initial?.expenses || []);
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("supplies");
  const [expensePayee, setExpensePayee] = useState("");
  const [expensePersonId, setExpensePersonId] = useState("");
  const [expenseAmount, setExpenseAmount] = useState(0);
  const [dispatchStaffPayment, setDispatchStaffPayment] = useState(initial?.dispatchStaffPayment || 0);
  const [dispatchCastPayment, setDispatchCastPayment] = useState(initial?.dispatchCastPayment || 0);
  const [dispatchFee, setDispatchFee] = useState(initial?.dispatchFee || 0);
  const [liquorDeliveryAmount, setLiquorDeliveryAmount] = useState(initial?.liquorDeliveryAmount || 0);
  const [cashFloat] = useState(initial?.cash.cashFloat ?? data.cashFloat);
  const [actualCash, setActualCash] = useState(initial?.cash.actualClosingCash || 0);
  const [error, setError] = useState("");
  const [jsonReading, setJsonReading] = useState(false);
  const jsonImportSequence = useRef(0);
  const hasUnsavedDailyData = Boolean(initial || pos);
  useEffect(() => {
    onDirtyChange(hasUnsavedDailyData);
    return () => onDirtyChange(false);
  }, [hasUnsavedDailyData, onDirtyChange]);
  const references = useMemo(() => pos ? posCastReferences(pos) : [], [pos]);
  const missingBottles = useMemo<MissingBottleCost[]>(() => pos ? pos.transactions.flatMap((transaction) => transaction.items.flatMap((item, itemIndex) => {
    if (!requiresBottleCost(transaction, item, mapping)) return [];
    if (data.liquor.some((row) => row.kind === item.category && row.name === item.label && row.salePrice === item.price)) return [];
    return [{ transaction, item, sourceKey: posItemOccurrenceKey(transaction, itemIndex) }];
  })) : [], [data.liquor, mapping, pos]);
  const month = pos?.businessDate.slice(0, 7) || "";

  const activeOnBusinessDate = (hiredAt?: string, departedAt?: string) => Boolean(pos && hiredAt && hiredAt <= pos.businessDate && (!departedAt || departedAt >= pos.businessDate));
  const staffCandidates = staffCandidatesForBusinessDate(data.staff, data.archivedStaff, pos?.businessDate || "");
  const candidates = (kind: CastKind, name: string) => kind === "dispatch" ? [] : data.casts.filter((row) => row.name === name && (kind === "trial"
    ? row.status === "trial" && row.trialDate === pos?.businessDate
    : row.status !== "trial" && activeOnBusinessDate(row.hiredAt, row.departedAt)));
  const initialSnapshotFor = (source: (typeof references)[number]) => {
    if (!allowInitialSnapshotMapping || !initial || !pos || initial.businessDate !== pos.businessDate) return undefined;
    const snapshot = initial.casts.find((row) => row.posCastId === source.id);
    if (!snapshot?.masterId || mapping[source.id] !== snapshot.masterId) return undefined;
    return snapshot.name === source.name && snapshot.kind === source.kind ? snapshot : undefined;
  };
  const mappingIssue = (source: (typeof references)[number]) => {
    const selected = mapping[source.id];
    if (!selected) return "未照合";
    if (selected === "dispatch") return canMapAsDispatch(source.kind) ? "" : "在籍キャストは派遣として処理できません";
    if (source.kind === "dispatch") return "派遣キャストとして再照合してください";
    return candidates(source.kind, source.name).some((row) => row.id === selected) || Boolean(initialSnapshotFor(source))
      ? ""
      : "選択済みデータが現在の営業日・名前・区分と一致しません";
  };
  const mappingComplete = isCastMappingComplete(references, mapping) && references.every((source) => !mappingIssue(source));
  const costsComplete = missingBottles.every((bottle) => {
    const value = specialCostValue(specialCosts, bottle);
    return value !== undefined && Number.isFinite(value) && value >= 0;
  });
  const invalidTrialBeautyExpenses = invalidTrialBeautyExpensesForRows(expenses, castRows);
  const workflowLock = lockedMonthMessage(data, pos?.businessDate || initial?.businessDate || "");
  useEffect(() => {
    if (workflowLock && stage !== "json") setStage("json");
  }, [stage, workflowLock]);

  const hydrateMapping = (closing: PosClosingV3) => {
    const auto: Record<string, string> = {};
    const retainedMapping = retainCurrentCastMappingForJson(pos, closing, mapping);
    const reeditSourcePos = initial?.businessDate === closing.businessDate
      ? initial.posSnapshot || closing
      : undefined;
    const savedMapping = initial && reeditSourcePos
      ? deriveReeditCastMapping({ businessDate: initial.businessDate, casts: initial.casts, posSnapshot: reeditSourcePos })
      : {};
    const savedReferences = new Map(reeditSourcePos
      ? posCastReferences(reeditSourcePos).map((source) => [source.id, source] as const)
      : []);
    posCastReferences(closing).forEach((source) => {
      if (retainedMapping[source.id]) {
        auto[source.id] = retainedMapping[source.id];
        return;
      }
      if (source.kind === "dispatch") auto[source.id] = "dispatch";
      else {
        const savedSource = savedReferences.get(source.id);
        if (savedSource?.name === source.name
          && savedSource.kind === source.kind
          && savedMapping[source.id]) {
          auto[source.id] = savedMapping[source.id];
          return;
        }
        const matches = data.casts.filter((row) => row.name === source.name && (source.kind === "trial"
          ? row.status === "trial" && row.trialDate === closing.businessDate
          : row.status !== "trial" && Boolean(row.hiredAt && row.hiredAt <= closing.businessDate && (!row.departedAt || row.departedAt >= closing.businessDate))));
        if (matches.length === 1) auto[source.id] = matches[0].id;
      }
    });
    setMapping(auto);
  };

  const resetDailyInputsForDifferentDate = () => {
    setSpecialCosts({});
    setCastRows([]);
    setCastRowsSourcePos(null);
    setUnmatchedCastDrafts([]);
    setStaffWork([]);
    setStaffId("");
    setStaffStart("20:00");
    setStaffEnd("02:00");
    setDriverWork([]);
    setExpenses([]);
    setExpenseCategory("supplies");
    setExpensePayee("");
    setExpensePersonId("");
    setExpenseAmount(0);
    setDispatchStaffPayment(0);
    setDispatchCastPayment(0);
    setDispatchFee(0);
    setLiquorDeliveryAmount(0);
    setActualCash(0);
  };

  const ensureCurrentReferences = () => {
    if (!mappingComplete) {
      setError("照合済みのキャストデータが現在の営業日・名前・区分と一致しません。この画面で再照合してください。入力済みの店舗データは保持されています。");
      setStage("json");
      return false;
    }
    if (!costsComplete) {
      setError("今回のみの酒代原価が未入力、または正しくありません。JSON取込画面で確認してください。");
      setStage("json");
      return false;
    }
    if (unmatchedCastDrafts.length > 0) {
      setError("自動で引き継げなかったキャスト入力があります。店舗データ画面の「引継ぎ保留」を確認してください。");
      setStage("details");
      return false;
    }
    if (invalidTrialBeautyExpenses.length > 0) {
      setError("体入キャストとの紐付けを確認できない美容室手当経費があります。対象行を削除し、現在の体入キャストを選び直してください。");
      setStage("details");
      return false;
    }
    return true;
  };

  const createRows = () => {
    if (!pos) return;
    if (workflowLock) return setError(workflowLock);
    if (!mappingComplete) return setError("未照合、または現在の営業日・名前・区分と一致しないキャストがあります。再照合してください。");
    if (!costsComplete) return setError("今回のみの酒代原価をすべて入力してください。");
    const details = Object.fromEntries(references.map((source) => {
      if (mapping[source.id] === "dispatch") return [source.id, { masterId: "", name: source.name, kind: "dispatch" as const, hourlyRate: 0 }];
      const cast = candidates(source.kind, source.name).find((row) => row.id === mapping[source.id]);
      const savedSnapshot = initialSnapshotFor(source);
      if (!cast && savedSnapshot) return [source.id, {
        masterId: savedSnapshot.masterId,
        name: savedSnapshot.name,
        kind: savedSnapshot.kind,
        hourlyRate: savedSnapshot.hourlyRate,
        introducer: savedSnapshot.introducer
      }];
      const introducer = data.introducers.find((row) => row.id === cast?.introducerId);
      return [source.id, {
        masterId: cast?.id || "", name: cast?.name || source.name, kind: source.kind,
        hourlyRate: source.kind === "trial" ? cast?.trialHourlyRate || 0 : rateForMonth(cast?.hourlyRates || {}, month),
        introducer: introducer ? {
          id: introducer.id,
          name: introducer.name,
          feeType: introducer.feeType,
          attendanceAdvisoryEnabled: introducer.attendanceAdvisoryEnabled,
          entryAdvisoryEnabled: introducer.entryAdvisoryEnabled,
          attendanceAdvisoryFee: introducer.attendanceAdvisoryEnabled ? cast?.attendanceAdvisoryFee || 0 : 0,
          entryAdvisoryFee: introducer.entryAdvisoryEnabled ? cast?.entryAdvisoryFee || 0 : 0
        } : undefined
      }];
    }));
    const generatedRows = buildDailyCasts(pos, details, data.liquor, occurrenceSpecialCosts(pos, specialCosts));
    const draftRows = [...unmatchedCastDrafts, ...castRows].filter((row, index, rows) => rows.findIndex((candidate) =>
      candidate.posCastId === row.posCastId
      && candidate.name === row.name
      && candidate.kind === row.kind) === index);
    const reconciled = mergeReconciledDailyCastInputs(draftRows, generatedRows, castRowsSourcePos);
    setCastRows(reconciled.rows);
    setCastRowsSourcePos(pos);
    setUnmatchedCastDrafts(reconciled.unmatchedPrevious);
    setExpenses((current) => reconcileTrialBeautyExpenses(current, reconciled));
    setStage("details");
    setError(reconciled.unmatchedPrevious.length > 0
      ? "新しいPOSデータへ自動で引き継げなかったキャスト入力があります。内容を確認するまで送信できません。"
      : "");
  };

  const updateCast = (posId: string, patch: Partial<DailyCast>) => setCastRows((rows) => rows.map((row) => row.posCastId === posId ? { ...row, ...patch } : row));
  const addStaff = () => {
    const staff = data.staff.find((row) => row.id === staffId);
    if (!staff) return setError("スタッフを選択してください。");
    const hours = hoursBetweenQuarter(staffStart, staffEnd);
    if (hours <= 0) return setError("スタッフの出勤時刻と退勤時刻を正しく入力してください。");
    const rate = staff.status === "trial" ? staff.trialHourlyRate || 0 : staff.hourlyRate || 0;
    const dailyPayment = staff.status === "trial" ? floorHundred(rate * hours) : 0;
    setStaffWork((rows) => [...rows.filter((row) => row.staffId !== staff.id), { staffId: staff.id, name: staff.name, kind: staff.status === "trial" ? "trial" : "regular", startTime: staffStart, endTime: staffEnd, hours, hourlyRate: rate, dailyPayment }]);
    setStaffId(""); setError("");
  };
  const addExpense = () => {
    const trial = castRows.find((row) => row.posCastId === expensePersonId && row.kind === "trial");
    const payee = expenseCategory === "beautyTrial" ? trial?.name || "" : expensePayee.trim();
    if (!payee || expenseAmount <= 0) return setError("経費の支払先と金額を入力してください。");
    setExpenses((rows) => [...rows, { id: crypto.randomUUID(), category: expenseCategory, payee, amount: expenseAmount, personId: trial?.masterId, personName: trial?.name }]);
    setExpensePayee(""); setExpensePersonId(""); setExpenseAmount(0); setError("");
  };
  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount, 0);
  const regularDailyPayments = castRows.filter((row) => row.kind === "regular").reduce((sum, row) => sum + row.dailyPayment, 0);
  const trialDailyPayments = castRows.filter((row) => row.kind === "trial").reduce((sum, row) => sum + row.dailyPayment, 0);
  const staffDailyPayments = staffWork.reduce((sum, row) => sum + row.dailyPayment, 0);
  const driverDailyPayments = driverWork.reduce((sum, row) => sum + row.dailyPayment, 0);
  const cash = pos ? calculateCash({ sales: pos.sales, cashFloat, expenses: expenseTotal, regularDailyPayments, trialDailyPayments, staffDailyPayments, driverDailyPayments, dispatchCastPayment, dispatchStaffPayment, dispatchFee, actualClosingCash: actualCash }) : null;
  const driverRows = driverWork;

  const submit = async () => {
    if (!pos || !cash) return;
    if (workflowLock) return setError(workflowLock);
    if (!ensureCurrentReferences()) return;
    // 旧版で保存された再編集データも、手当・控除等を保持したまま商品バック明細だけ最新形式へ揃える。
    const submissionCastRows = restoreDailyCastBackMetadata(pos, castRows);
    const value: DailyClosing = {
      id: initial?.id || `daily_${pos.businessDate.replaceAll("-", "")}`,
      businessDate: pos.businessDate, status: "submitted", submissionId: pos.submissionId, checksum: pos.checksum,
      sales: pos.sales, customers: pos.customers, nominations: pos.nominations, casts: submissionCastRows, staffWork, drivers: driverRows, expenses,
      staffDailyPaymentTotal: staffWork.reduce((sum, row) => sum + row.dailyPayment, 0), dispatchStaffPayment, dispatchCastPayment, dispatchFee,
      liquorDeliveryAmount, cash, posSnapshot: pos, updatedAt: new Date().toISOString()
    };
    const saved = await run(() => submitClosing(value, user, initial?.updatedAt), `${pos.businessDate}のデータを経理へ送信しました。`);
    if (saved) {
      // 新規作成は親のkeyが"new"のままで再マウントされないため、翌営業日へ入力を残さない。
      resetDailyInputsForDifferentDate();
      setMapping({});
      setAllowInitialSnapshotMapping(false);
      setPos(null);
      setError("");
      setStage("json");
      onFinished();
    }
  };

  return <Card title={initial ? `${initial.businessDate} 再編集` : "当日営業データ作成"} description="POS JSONの照合から現金実在高まで順番に確認します。" action={initial ? <button className="button secondary" disabled={busy} onClick={() => { if (window.confirm("保存していない再編集内容を破棄して終了しますか？")) onFinished(); }}>再編集を終了</button> : null}>
    <div className="stepper">{(["json", "details", "cash", "preview"] as Stage[]).map((value, index) => <span key={value} className={stage === value ? "active" : ""}><b>{index + 1}</b>{["JSON取込", "店舗データ", "現金照合", "送信確認"][index]}</span>)}</div>
    {error && <div className="notice error">{error}</div>}
    {workflowLock && <div className="notice warn"><strong>この営業日は編集できません。</strong><br />{workflowLock}</div>}
    {stage === "json" && <div className="stack section-pad">
      {initial && !initial.posSnapshot && <div className="notice warn">この旧データにはPOS原本が保存されていません。再編集するには、同じ営業日のPOS JSONをもう一度取り込んでください。既存データは送信を完了するまで変更されません。商品との一致を検証できない今回のみの特別原価は、安全のため再入力が必要です。</div>}
      {(initial || pos) && <div className="notice warn">同じ営業日のJSONを再取込しても、入力済みの店舗データと現金実在高は保持されます。勤務・指名本数・商品配賦などPOS由来の項目だけを再計算します。</div>}
      <Field label="POS営業終了JSON（schemaVersion 3）"><input className="input" type="file" accept=".json,application/json" disabled={busy || jsonReading || Boolean(workflowLock)} onChange={async (event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        if (!file) return;
        const sequence = ++jsonImportSequence.current;
        setJsonReading(true);
        try {
          const parsed = await parsePosClosingV3(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
          if (sequence !== jsonImportSequence.current) return;
          if (initial && parsed.businessDate !== initial.businessDate) throw new Error(`再編集対象は${initial.businessDate}です。同じ営業日のPOS JSONを選択してください。`);
          const previousDate = pos?.businessDate || initial?.businessDate || "";
          if (initial || pos) {
            if (!window.confirm(jsonReimportConfirmation(previousDate, parsed.businessDate))) return;
          }
          const changedDate = shouldResetDailyInputsForJson(previousDate, parsed.businessDate);
          if (changedDate) resetDailyInputsForDifferentDate();
          else setSpecialCosts((current) => retainMatchingSpecialCosts(pos, parsed, current));
          const isSameEditedDay = Boolean(initial && parsed.businessDate === initial.businessDate);
          setAllowInitialSnapshotMapping(isSameEditedDay);
          setPos(parsed);
          hydrateMapping(parsed);
          setError("");
        } catch (caught) {
          // 読込失敗時は、編集中の営業日データや手入力を破棄しない。
          if (sequence === jsonImportSequence.current) setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
          if (sequence === jsonImportSequence.current) setJsonReading(false);
          input.value = "";
        }
      }} />{jsonReading && <small>JSONを検証しています…</small>}</Field>
      {pos && <><div className="summary-strip"><span><small>営業日</small><strong>{pos.businessDate}</strong></span><span><small>総売上</small><strong>{yen.format(pos.sales.totalSales)}</strong></span><span><small>会計</small><strong>{pos.transactions.length}件</strong></span><span><small>勤務</small><strong>{pos.castWork.length}名</strong></span></div>
        <h3>キャストデータ照合</h3><Table headers={["POS名", "区分", "GMSデータ", "状態"]}>{references.map((source) => {
          const options = candidates(source.kind, source.name);
          const selected = mapping[source.id] || "";
          const issue = mappingIssue(source);
          const savedSnapshot = initialSnapshotFor(source);
          const currentOptionExists = options.some((row) => row.id === selected);
          const unavailable = selected !== "dispatch" && selected !== "" && !currentOptionExists && !savedSnapshot;
          const updateMapping = (value: string) => { setMapping((current) => ({ ...current, [source.id]: value })); setError(""); };
          return <tr key={source.id}><td>{source.name}</td><td>{source.kind === "regular" ? "在籍" : source.kind === "trial" ? "体入" : "派遣"}</td><td>{source.kind === "dispatch"
            ? <select className="input table-input" value={selected} onChange={(e) => updateMapping(e.target.value)}><option value="">選択</option><option value="dispatch">派遣キャストとして処理</option>{unavailable && <option value={selected}>選択済みデータは利用不可</option>}</select>
            : <select className="input table-input" value={selected} onChange={(e) => updateMapping(e.target.value)}><option value="">一致するデータを選択</option>{savedSnapshot && !currentOptionExists && <option value={savedSnapshot.masterId}>{savedSnapshot.name}（この日次に保存済み・マスタ削除済み）</option>}{unavailable && <option value={selected}>選択済みデータは利用不可（再照合が必要）</option>}{options.map((row) => <option key={row.id} value={row.id}>{row.name}（{row.trialDate || row.hiredAt}）</option>)}{canMapAsDispatch(source.kind) && <option value="dispatch">派遣キャストとして処理（マスタ登録不要）</option>}</select>}</td><td>{issue ? <><StatusPill tone="danger">{selected ? "再照合が必要" : "未照合"}</StatusPill><br /><small>{issue}</small></> : <><StatusPill tone="good">照合済み</StatusPill>{savedSnapshot && !currentOptionExists && <><br /><small>保存済み照合を使用</small></>}</>}</td></tr>;
        })}</Table>
        {missingBottles.length > 0 && <><h3>酒代原価未登録</h3><div className="notice error">マスタ未登録のボトルがあります。共通フォームへ登録するか、今回のみの特別原価を入力してください。同じ商品IDでも会計内の注文1件ごとに個別保存します。</div><Table headers={["会計", "区分", "ボトル", "数量", "販売額", "今回のみの単価原価"]}>{missingBottles.map((bottle) => {
          const current = specialCostValue(specialCosts, bottle);
          return <tr key={bottle.sourceKey}><td>{bottle.transaction.tableLabel || bottle.transaction.transactionId}</td><td>{bottle.item.category === "champagneWine" ? "シャンパン・ワイン" : "キープボトル"}</td><td>{bottle.item.label}</td><td>{bottle.item.quantity}</td><td>{yen.format(bottle.item.price * bottle.item.quantity)}</td><td><MoneyInput value={current ?? 0} onChange={(value) => setSpecialCosts((costs) => ({ ...costs, [bottle.sourceKey]: value }))} /></td></tr>;
        })}</Table></>}
        <button className="button wide-button" disabled={busy || Boolean(workflowLock) || !mappingComplete || !costsComplete} title={workflowLock || undefined} onClick={createRows}>照合を確定して店舗データ作成へ</button></>}
    </div>}
    {stage === "details" && pos && !workflowLock && <div className="stack section-pad">
      {unmatchedCastDrafts.length > 0 && <div className="notice error"><strong>引継ぎ保留のキャスト入力があります</strong><p>POSキャストID・名前・区分の一致を確認できなかったため、別人への誤転記を防いで元の入力を保留しています。正しいJSONまたは照合内容を確認してください。</p><Table headers={["キャスト", "本指名売上", "場内延長売上", "美容室", "日払い", "立替", "送迎"]}>{unmatchedCastDrafts.map((row) => <tr key={`${row.posCastId}-${row.name}-${row.kind}`}><td>{row.name}<br /><small>{row.kind === "trial" ? "体入" : "在籍"}</small></td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td><td>{yen.format(row.beautyAllowance)}</td><td>{yen.format(row.dailyPayment)}</td><td>{yen.format(row.advancePayment)}</td><td>{yen.format(row.transportFee)}</td></tr>)}</Table><button className="button danger mini" onClick={() => { if (window.confirm("引継ぎ保留のキャスト入力を破棄しますか？破棄した値は現在の再編集画面へ戻せません。")) { setUnmatchedCastDrafts([]); setError(""); } }}>保留入力を確認済みとして破棄</button></div>}
      {invalidTrialBeautyExpenses.length > 0 && <div className="notice error">体入キャストとの紐付けを確認できない美容室手当経費があります。経費一覧から対象行を削除し、現在の体入キャストを選び直してください。</div>}
      <h3>キャスト出勤・売上・手当控除</h3><Table headers={["キャスト", "勤務", "本指名", "場内", "同伴", "本指名売上", "場内延長売上", "ボトル/ドリンク", "美容室", "日払い", "立替", "送迎"]}>{castRows.map((row) => <tr key={row.posCastId}><td><strong>{row.name}</strong><br /><small>{row.kind === "trial" ? "体入" : "在籍"}</small></td><td>{row.startTime}–{row.endTime}<br />{row.hours}時間</td><td>{row.honShimeiCount}本</td><td>{row.banaiShimeiCount}本</td><td>{row.dohanCount}本</td><td><MoneyInput value={row.honShimeiSales} step={10} onChange={(value) => updateCast(row.posCastId, { honShimeiSales: value })} /></td><td><MoneyInput value={row.jonaiExtensionSales} step={10} onChange={(value) => updateCast(row.posCastId, { jonaiExtensionSales: value })} /></td><td><CastProductSummary row={row} pos={pos} /></td><td><label className="check-row"><input type="checkbox" checked={row.beautyAllowance === 500} disabled={row.kind === "trial"} onChange={(e) => updateCast(row.posCastId, { beautyAllowance: e.target.checked ? 500 : 0 })} />500円</label></td><td><MoneyInput value={row.dailyPayment} step={row.kind === "trial" ? 10 : 1} onChange={(value) => updateCast(row.posCastId, { dailyPayment: value })} /></td><td><MoneyInput value={row.advancePayment} onChange={(value) => updateCast(row.posCastId, { advancePayment: value })} /></td><td><MoneyInput value={row.transportFee} step={500} onChange={(value) => updateCast(row.posCastId, { transportFee: value })} /></td></tr>)}</Table>
      <h3>スタッフ勤務・日払い</h3><div className="grid form-row"><Field label="スタッフ"><select className="input" value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="">選択</option>{staffCandidates.map((row) => <option key={row.id} value={row.id}>{row.name}（{row.status === "trial" ? "体入" : "在籍"}）</option>)}</select></Field><Field label="出勤"><input className="input" type="time" value={staffStart} onChange={(e) => setStaffStart(e.target.value)} /></Field><Field label="退勤"><input className="input" type="time" value={staffEnd} onChange={(e) => setStaffEnd(e.target.value)} /></Field><button className="button compact" onClick={addStaff}>追加</button></div><Table headers={["スタッフ", "区分", "出勤", "退勤", "勤務", "時給", "日払い", "操作"]}>{staffWork.map((row) => <tr key={row.staffId}><td>{row.name}</td><td>{row.kind === "trial" ? "体入" : "在籍"}</td><td>{row.startTime}</td><td>{row.endTime}</td><td>{row.hours}時間</td><td>{yen.format(row.hourlyRate)}</td><td><MoneyInput value={row.dailyPayment} disabled={row.kind === "trial"} onChange={(value) => setStaffWork((rows) => rows.map((item) => item.staffId === row.staffId ? { ...item, dailyPayment: value } : item))} />{row.kind === "trial" && <small>基本給与全額を即日払い</small>}</td><td><button className="button danger mini" onClick={() => setStaffWork((rows) => rows.filter((item) => item.staffId !== row.staffId))}>削除</button></td></tr>)}</Table>
      <h3>送迎ドライバー・日払い</h3><div className="check-grid">{data.drivers.filter((row) => activeOnBusinessDate(row.hiredAt, row.departedAt)).map((row) => { const selected = driverWork.some((item) => item.driverId === row.id); return <label className="select-card" key={row.id}><input type="checkbox" checked={selected} onChange={(e) => setDriverWork(e.target.checked ? [...driverWork.filter((item) => item.driverId !== row.id), { driverId: row.id, name: row.name, dailyRate: row.dailyRate, dailyPayment: 0 }] : driverWork.filter((item) => item.driverId !== row.id))} /><span>{row.name}<small>日給 {yen.format(row.dailyRate)}</small></span></label>; })}</div><Table headers={["ドライバー", "日給", "日払い", "操作"]}>{driverWork.map((row) => <tr key={row.driverId}><td>{row.name}</td><td>{yen.format(row.dailyRate)}</td><td><MoneyInput value={row.dailyPayment} onChange={(value) => setDriverWork((rows) => rows.map((item) => item.driverId === row.driverId ? { ...item, dailyPayment: value } : item))} /></td><td><button className="button danger mini" onClick={() => setDriverWork((rows) => rows.filter((item) => item.driverId !== row.driverId))}>削除</button></td></tr>)}</Table>
      <h3>当日経費</h3><div className="grid form-row expense-row"><Field label="勘定科目"><select className="input" value={expenseCategory} onChange={(e) => { setExpenseCategory(e.target.value as ExpenseCategory); setExpensePayee(""); setExpensePersonId(""); }}>{Object.entries(expenseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>{expenseCategory === "beautyTrial" ? <Field label="対象の体入キャスト"><select className="input" value={expensePersonId} onChange={(e) => setExpensePersonId(e.target.value)}><option value="">選択</option>{castRows.filter((row) => row.kind === "trial").map((row) => <option key={row.posCastId} value={row.posCastId}>{row.name}</option>)}</select></Field> : <Field label="支払先"><input className="input" value={expensePayee} onChange={(e) => setExpensePayee(e.target.value)} /></Field>}<Field label="金額"><MoneyInput value={expenseAmount} onChange={setExpenseAmount} /></Field><button className="button compact" onClick={addExpense}>追加</button></div><Table headers={["勘定科目", "支払先", "金額", "操作"]}>{expenses.map((row) => <tr key={row.id}><td>{expenseLabels[row.category]}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td><td><button className="button danger mini" onClick={() => setExpenses((rows) => rows.filter((item) => item.id !== row.id))}>削除</button></td></tr>)}</Table><div className="right-total">経費総計 <strong>{yen.format(expenseTotal)}</strong></div>
      <h3>派遣・納品書</h3><div className="grid four"><Field label="派遣スタッフ支払"><MoneyInput value={dispatchStaffPayment} onChange={setDispatchStaffPayment} /></Field><Field label="派遣キャスト支払"><MoneyInput value={dispatchCastPayment} onChange={setDispatchCastPayment} /></Field><Field label="派遣手数料"><MoneyInput value={dispatchFee} onChange={setDispatchFee} /></Field><Field label="酒代納品書分"><MoneyInput value={liquorDeliveryAmount} onChange={setLiquorDeliveryAmount} /></Field></div>
      <div className="actions spread"><button className="button secondary" onClick={() => { setError(""); setStage("json"); }}>入力を保持してキャスト照合へ戻る</button><button className="button" onClick={() => { if (!ensureCurrentReferences()) return; setCastRows((rows) => rows.map((row) => ({ ...row, honShimeiSales: floorTen(row.honShimeiSales), jonaiExtensionSales: floorTen(row.jonaiExtensionSales), dailyPayment: row.kind === "trial" ? floorTen(row.dailyPayment) : row.dailyPayment, transportFee: Math.floor(row.transportFee / 500) * 500 }))); setError(""); setStage("cash"); }}>店舗データを確認して現金照合へ</button></div>
    </div>}
    {stage === "cash" && pos && cash && <div className="stack section-pad"><h3>当日現金照合</h3><div className="grid metrics"><Metric label="現金売上" value={cash.cashSales} /><Metric label="カード売上" value={cash.cardSales} /><Metric label="当日合計売上" value={cash.totalSales} /><Metric label="つり銭" value={cash.cashFloat} /></div><Table headers={["計算項目", "金額"]}><tr><td>経費総計</td><td>{yen.format(expenseTotal)}</td></tr><tr><td>在籍キャスト日払い</td><td>{yen.format(regularDailyPayments)}</td></tr><tr><td>体入キャスト即日支払い</td><td>{yen.format(trialDailyPayments)}</td></tr><tr><td>スタッフ日払い</td><td>{yen.format(staffDailyPayments)}</td></tr><tr><td>送迎ドライバー日払い</td><td>{yen.format(driverDailyPayments)}</td></tr><tr><td>派遣キャスト支払い</td><td>{yen.format(dispatchCastPayment)}</td></tr><tr><td>派遣スタッフ支払い</td><td>{yen.format(dispatchStaffPayment)}</td></tr><tr><td>派遣手数料</td><td>{yen.format(dispatchFee)}</td></tr><tr className="total-row"><td>経費・日払い・派遣支払い・手数料 合計</td><td>{yen.format(cash.expenseAndPaymentTotal)}</td></tr><tr><td>現金売上＋つり銭</td><td>{yen.format(cash.cashSales + cash.cashFloat)}</td></tr><tr><td><strong>営業終了時点の計算上現金残額</strong></td><td><strong>{yen.format(cash.expectedClosingCash)}</strong></td></tr><tr><td>つり銭を除いた現金利益額</td><td>{yen.format(cash.cashProfit)}</td></tr></Table><Field label="営業終了時点の現金実在高"><MoneyInput value={actualCash} onChange={setActualCash} step={1} /></Field><div className={`reconciliation-result ${cash.difference === 0 ? "match" : "mismatch"}`}><span>照合差額</span><strong>{yen.format(cash.difference)}</strong><small>{cash.difference === 0 ? "現金が一致しました" : "差額を記録したまま送信できます。入力内容を再確認してください"}</small></div><div className="actions spread"><button className="button secondary" onClick={() => setStage("details")}>店舗データへ戻る</button><button className="button" onClick={() => setStage("preview")}>現金照合内容を確認して送信確認へ</button></div></div>}
    {stage === "preview" && pos && cash && <div className="stack section-pad"><DailyPreview closing={{ id: initial?.id || "preview", businessDate: pos.businessDate, status: "submitted", submissionId: pos.submissionId, checksum: pos.checksum, sales: pos.sales, customers: pos.customers, nominations: pos.nominations, casts: castRows, staffWork, drivers: driverRows, expenses, staffDailyPaymentTotal: staffWork.reduce((sum, row) => sum + row.dailyPayment, 0), dispatchStaffPayment, dispatchCastPayment, dispatchFee, liquorDeliveryAmount, cash, posSnapshot: pos, updatedAt: new Date().toISOString() }} /><div className="actions spread"><button className="button secondary" onClick={() => setStage("cash")}>現金照合へ戻る</button><button className="button submit-button" disabled={busy} onClick={() => void submit()}>{busy ? "送信中…" : "確認済み・経理へ送信"}</button></div></div>}
  </Card>;
}

export function DailyPreview({ closing }: { closing: DailyClosing }) {
  const expenseTotal = closing.expenses.reduce((sum, row) => sum + row.amount, 0);
  const castTotals = closing.casts.reduce((total, row) => ({
    honShimeiCount: total.honShimeiCount + row.honShimeiCount,
    banaiShimeiCount: total.banaiShimeiCount + row.banaiShimeiCount,
    dohanCount: total.dohanCount + row.dohanCount,
    honShimeiSales: total.honShimeiSales + row.honShimeiSales,
    jonaiExtensionSales: total.jonaiExtensionSales + row.jonaiExtensionSales,
    beautyCount: total.beautyCount + (row.beautyAllowance > 0 ? 1 : 0),
  }), { honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, honShimeiSales: 0, jonaiExtensionSales: 0, beautyCount: 0 });
  const drinkTotals = summarizePreviewDrinks(closing.casts, closing.posSnapshot);
  return <div className="preview-sheet">
    <header><div><p className="eyebrow">営業日次データ</p><h2>{closing.businessDate}</h2></div><StatusPill tone={closing.status === "approved" ? "good" : "warn"}>{closingLabels[closing.status]}</StatusPill></header>
    <div className="grid metrics"><Metric label="総売上" value={closing.sales.totalSales} /><Metric label="現金売上" value={closing.sales.cashSales} /><Metric label="カード売上" value={closing.sales.cardSales} /><Metric label="経費総計" value={expenseTotal} /></div>
    <h3>キャスト</h3>
    <Table headers={["名前", "勤務", "本指名", "場内指名", "同伴", "本指名売上", "場内延長売上", "ボトルバック", "ドリンクバック", "美容室", "日払い", "立替", "送迎"]}>{[...closing.casts.map((row) => <tr key={row.posCastId}>
      <td>{row.name}<br /><small>{row.kind === "trial" ? "体入" : "在籍"}</small></td>
      <td>{row.startTime}–{row.endTime}<br />{row.hours}時間</td>
      <td>{row.honShimeiCount}本</td>
      <td>{row.banaiShimeiCount}本</td>
      <td>{row.dohanCount}本</td>
      <td>{yen.format(row.honShimeiSales)}</td>
      <td>{yen.format(row.jonaiExtensionSales)}</td>
      <td className="wrap-cell preview-product-cell"><PreviewBottleBackDetails row={row} /></td>
      <td className="wrap-cell preview-product-cell"><PreviewDrinkBackDetails row={row} pos={closing.posSnapshot} /></td>
      <td>{yen.format(row.beautyAllowance)}</td>
      <td>{yen.format(row.dailyPayment)}</td>
      <td>{yen.format(row.advancePayment)}</td>
      <td>{yen.format(row.transportFee)}</td>
    </tr>), <tr key="cast-totals" className="total-row">
      <td colSpan={2}><strong>合計</strong></td>
      <td>{castTotals.honShimeiCount}本</td>
      <td>{castTotals.banaiShimeiCount}本</td>
      <td>{castTotals.dohanCount}本</td>
      <td>{yen.format(castTotals.honShimeiSales)}</td>
      <td>{yen.format(castTotals.jonaiExtensionSales)}</td>
      <td>—</td>
      <td className="wrap-cell preview-product-cell">
        <div className="preview-product-list">
          {drinkTotals.drinks.map((drink) => <div key={drink.unitPrice}>{yen.format(drink.unitPrice)}　{drink.quantity}杯</div>)}
          {drinkTotals.unpricedQuantity > 0 && <div>単価不明　{drinkTotals.unpricedQuantity}杯</div>}
          <strong>合計杯数 {drinkTotals.hasUnknownQuantity ? "確認不可" : `${drinkTotals.quantity}杯`}</strong>
          <small>キャスト欄の延べ杯数{drinkTotals.hasUnknownQuantity ? "（杯数不明の旧データあり）" : ""}</small>
        </div>
      </td>
      <td>{castTotals.beautyCount}人</td>
      <td>—</td><td>—</td><td>—</td>
    </tr>]}</Table>
    <h3>スタッフ</h3>
    <Table headers={["名前", "区分", "出勤", "退勤", "勤務時間", "時給", "日払い"]}>{closing.staffWork.map((row) => <tr key={row.staffId}><td>{row.name}</td><td>{row.kind === "trial" ? "体入" : "在籍"}</td><td>{row.startTime}</td><td>{row.endTime}</td><td>{row.hours}時間</td><td>{yen.format(row.hourlyRate)}</td><td>{yen.format(row.dailyPayment)}</td></tr>)}</Table>
    <h3>送迎ドライバー</h3>
    <Table headers={["名前", "日給", "日払い"]}>{closing.drivers.map((row) => <tr key={row.driverId}><td>{row.name}</td><td>{yen.format(row.dailyRate)}</td><td>{yen.format(row.dailyPayment)}</td></tr>)}</Table>
    <h3>経費・派遣支払・納品書</h3>
    <Table headers={["区分", "支払先・内容", "金額"]}>{[
      ...closing.expenses.map((row) => <tr key={row.id}><td>{expenseLabels[row.category]}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td></tr>),
      <tr key="dispatch-cast"><td>派遣キャスト支払</td><td>—</td><td>{yen.format(closing.dispatchCastPayment)}</td></tr>,
      <tr key="dispatch-staff"><td>派遣スタッフ支払</td><td>—</td><td>{yen.format(closing.dispatchStaffPayment)}</td></tr>,
      <tr key="dispatch-fee"><td>派遣手数料</td><td>—</td><td>{yen.format(closing.dispatchFee)}</td></tr>,
      <tr key="liquor-delivery"><td>酒代納品書分</td><td>当日現金からの控除対象外</td><td>{yen.format(closing.liquorDeliveryAmount)}</td></tr>,
    ]}</Table>
    <h3>現金照合</h3>
    <div className="summary-strip"><span><small>支払合計</small><strong>{yen.format(closing.cash.expenseAndPaymentTotal)}</strong></span><span><small>計算上残額</small><strong>{yen.format(closing.cash.expectedClosingCash)}</strong></span><span><small>実在高</small><strong>{yen.format(closing.cash.actualClosingCash)}</strong></span><span><small>差額</small><strong>{yen.format(closing.cash.difference)}</strong></span></div>
  </div>;
}

function PreviewBottleBackDetails({ row }: { row: DailyCast }) {
  if (!row.bottles.length) return <>—</>;
  return <div className="preview-product-list">{row.bottles.map((bottle, index) => {
    const rate = bottle.kind === "champagneWine" ? 25 : 15;
    const backAmount = typeof bottle.backAmount === "number" && Number.isFinite(bottle.backAmount)
      ? yen.format(bottle.backAmount)
      : "旧データのため確認不可";
    return <div className="preview-product-item" key={`${bottle.sourceKey || bottle.itemId}-${index}`}>
      <strong>{bottle.name} ×{bottle.quantity}本</strong>
      <small>{bottle.kind === "champagneWine" ? "シャンパン・ワイン" : "キープボトル"}{bottle.specialCost ? "（特別原価）" : ""}</small>
      <small>金額（配賦後） {yen.format(bottle.salesAmount)}</small>
      <small>酒代原価（配賦後） {yen.format(bottle.costAmount)}</small>
      <small>バック率 {rate}% / バック金額 {backAmount}</small>
    </div>;
  })}</div>;
}

/** キャスト欄の表示を合算する。旧配賦額から販売単価や不明な杯数を推測しない。 */
function summarizePreviewDrinks(rows: DailyCast[], pos?: PosClosingV3) {
  const grouped = new Map<number, { unitPrice: number; quantity: number }>();
  let quantity = 0;
  let unpricedQuantity = 0;
  let hasUnknownQuantity = false;
  rows.forEach((row) => {
    const hasPosDetails = Boolean(pos?.transactions.some((transaction) => transaction.items.some((item) =>
      item.category === "castDrink" && item.backTargetCastIds.includes(row.posCastId))));
    if (hasPosDetails) {
      summarizeCastDrinksByPrice(row, pos).forEach((drink) => {
        const current = grouped.get(drink.unitPrice) || { unitPrice: drink.unitPrice, quantity: 0 };
        current.quantity += drink.quantity;
        grouped.set(drink.unitPrice, current);
        quantity += drink.quantity;
      });
    } else {
      const storedQuantity = (row.drinkAllocations || []).reduce((sum, drink) => sum + drink.quantity, 0);
      quantity += storedQuantity;
      unpricedQuantity += storedQuantity;
      if (row.drinkSales > 0 && storedQuantity === 0) hasUnknownQuantity = true;
    }
  });
  return { drinks: [...grouped.values()].sort((a, b) => a.unitPrice - b.unitPrice), quantity, unpricedQuantity, hasUnknownQuantity };
}

function PreviewDrinkBackDetails({ row, pos }: { row: DailyCast; pos?: PosClosingV3 }) {
  const { drinks, quantity } = summarizePreviewDrinks([row], pos);
  if (drinks.length > 0) return <div className="preview-product-list">{drinks.map((drink) => <div className="preview-product-item" key={`drink-price-${drink.unitPrice}`}>
    <strong>{yen.format(drink.unitPrice)}　{drink.quantity}杯</strong>
  </div>)}</div>;
  return row.drinkSales > 0 || quantity > 0
    ? <>合計（配賦後） {yen.format(row.drinkSales)}<br /><small>{quantity > 0 ? `${quantity}杯 / ` : ""}旧データのため単価確認不可</small></>
    : <>—</>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="metric-card"><small>{label}</small><strong>{yen.format(value)}</strong></div>; }

export function CastProductSummary({ row, pos }: { row: DailyCast; pos?: PosClosingV3 }) {
  const bottleQuantity = row.bottles.reduce((sum, bottle) => sum + bottle.quantity, 0);
  const drinkSummaries = summarizeCastDrinksByPrice(row, pos);
  const drinkQuantity = drinkSummaries.length > 0
    ? drinkSummaries.reduce((sum, drink) => sum + drink.quantity, 0)
    : undefined;
  const hasDetails = row.bottles.length > 0 || drinkSummaries.length > 0 || row.drinkSales > 0;
  return <>
    <span>ボトル {bottleQuantity}本 / ドリンク {drinkQuantity === undefined ? "—" : `${drinkQuantity}杯`}</span><br />
    <small>売上 {yen.format(row.bottles.reduce((sum, bottle) => sum + bottle.salesAmount, row.drinkSales))} / 原価 {yen.format(row.liquorCost)}</small>
    {hasDetails && <details><summary className="text-button">商品明細を表示</summary><CastProductDetails row={row} pos={pos} /></details>}
  </>;
}

export type CastDrinkPriceSummary = {
  unitPrice: number;
  quantity: number;
  salesAmount: number;
};

/** キャストドリンクを商品名ではなく、POSの販売単価ごとの杯数へまとめる。 */
export function summarizeCastDrinksByPrice(
  row: Pick<DailyCast, "posCastId" | "drinkAllocations">,
  pos?: PosClosingV3,
): CastDrinkPriceSummary[] {
  const grouped = new Map<number, CastDrinkPriceSummary>();
  const append = (unitPriceValue: number, quantity: number, salesAmount: number) => {
    // 画面上で同じ円額になる注文は、商品名が異なっても同じ行へまとめる。
    const unitPrice = Math.round(unitPriceValue);
    const current = grouped.get(unitPrice) || { unitPrice, quantity: 0, salesAmount: 0 };
    current.quantity += quantity;
    current.salesAmount += salesAmount;
    grouped.set(unitPrice, current);
  };

  let posDrinkCount = 0;
  pos?.transactions.forEach((transaction) => transaction.items.forEach((item) => {
    if (item.category !== "castDrink" || !item.backTargetCastIds.includes(row.posCastId)) return;
    const divisor = Math.max(1, item.backTargetCastIds.length);
    append(item.price, item.quantity, item.price * item.quantity / divisor);
    posDrinkCount += 1;
  }));

  // POS注文を復元できない旧保存データだけは、保存済み配賦売上から単価を復元する。
  if (posDrinkCount === 0) (row.drinkAllocations || []).forEach((drink) => {
    const unitPrice = drink.quantity > 0 ? drink.salesAmount / drink.quantity : drink.salesAmount;
    append(unitPrice, drink.quantity, drink.salesAmount);
  });
  return [...grouped.values()].sort((left, right) => left.unitPrice - right.unitPrice);
}

function CastProductDetails({ row, pos }: { row: DailyCast; pos?: PosClosingV3 }) {
  const bottleRows = row.bottles.map((bottle, index) => <tr key={`bottle-${bottle.sourceKey || `${bottle.itemId}-${index}`}`}>
    <td>{bottle.name}</td>
    <td>{bottle.kind === "champagneWine" ? "シャンパン・ワイン" : "キープボトル"}{bottle.specialCost ? "（特別原価）" : ""}</td>
    <td>{bottle.quantity}</td>
    <td>{yen.format(bottle.salesAmount)}</td>
    <td>{yen.format(bottle.costAmount)}</td>
    <td>{bottleTargetLabel(pos, row.posCastId, bottle)}</td>
  </tr>);
  const drinkRows = summarizeCastDrinksByPrice(row, pos).map((drink) => <tr key={`drink-price-${drink.unitPrice}`}>
    <td>{yen.format(drink.unitPrice)}</td><td>キャストドリンク</td><td>{drink.quantity}杯</td><td>{yen.format(drink.salesAmount)}</td><td>—</td><td>ドリンクバック対象</td>
  </tr>);
  const legacyDrinkRow = drinkRows.length === 0 && row.drinkSales > 0
    ? <tr key="legacy-drink"><td>ドリンク（旧保存データ）</td><td>キャストドリンク</td><td>—</td><td>{yen.format(row.drinkSales)}</td><td>—</td><td>ドリンクバック対象</td></tr>
    : null;
  return <Table headers={["商品・単価", "商品区分", "注文数量", "配賦売上", "配賦原価", "バック対象区分"]}>{[...bottleRows, ...drinkRows, legacyDrinkRow]}</Table>;
}

function bottleTargetLabel(pos: PosClosingV3 | undefined, posCastId: string, bottle: BottleAllocation) {
  if (!pos) return "旧データ（区分確認不可）";
  const matches = pos.transactions.flatMap((transaction) => transaction.items.flatMap((item, itemIndex) => {
    const sourceKey = posItemOccurrenceKey(transaction, itemIndex);
    const sourceMatches = bottle.sourceKey ? sourceKey === bottle.sourceKey : item.itemId === bottle.itemId && item.label === bottle.name && item.category === bottle.kind;
    return sourceMatches ? [{ transaction, itemIndex }] : [];
  }));
  // sourceKeyのない旧データで同一商品が複数回現れる場合は、誤った区分を推測しない。
  if (matches.length !== 1) return bottle.sourceKey ? "区分確認不可" : "旧データ（区分特定不可）";
  const { transaction, itemIndex } = matches[0];
  const { honShimeiIds, banaiExtensionIds } = bottleOrderContext(transaction, itemIndex);
  if (honShimeiIds.has(posCastId)) return "本指名";
  return banaiExtensionIds.has(posCastId) ? "場内延長" : "対象外";
}

function bottleOrderContext(transaction: PosTransaction, itemIndex: number) {
  const honShimeiIds = new Set(transaction.items.filter((item) => item.isHonShimei).map((item) => item.castId).filter((id): id is string => Boolean(id)));
  let banaiExtensionIds = new Set<string>();
  for (let index = 0; index <= itemIndex; index += 1) {
    const item = transaction.items[index];
    if (item.isBanaiExtension) banaiExtensionIds = new Set([...(item.banaiExtCastIds || []), item.castId].filter((id): id is string => Boolean(id)));
  }
  return { honShimeiIds, banaiExtensionIds };
}

export function retainMatchingSpecialCosts(
  previousPos: PosClosingV3 | null,
  nextPos: PosClosingV3,
  costs: Record<string, number>,
) {
  // 元のPOS商品を照合できない旧日次では、同じキー文字列だけを根拠に原価を移さない。
  if (!previousPos) return {};
  const result: Record<string, number> = {};
  const previousItems = new Map(previousPos?.transactions.flatMap((transaction) => transaction.items.map((item, itemIndex) => [
    posItemOccurrenceKey(transaction, itemIndex),
    item,
  ] as const)) || []);
  const previousItemIdCount = new Map<string, number>();
  const nextItemIdCount = new Map<string, number>();
  previousPos?.transactions.forEach((transaction) => transaction.items.forEach((item) => {
    previousItemIdCount.set(item.itemId, (previousItemIdCount.get(item.itemId) || 0) + 1);
  }));
  nextPos.transactions.forEach((transaction) => transaction.items.forEach((item) => {
    nextItemIdCount.set(item.itemId, (nextItemIdCount.get(item.itemId) || 0) + 1);
  }));

  nextPos.transactions.forEach((transaction) => transaction.items.forEach((item, itemIndex) => {
    const sourceKey = posItemOccurrenceKey(transaction, itemIndex);
    const previousItem = previousItems.get(sourceKey);
    const sameOccurrence = Boolean(previousItem
      && previousItem.itemId === item.itemId
      && previousItem.label === item.label
      && previousItem.category === item.category
      && previousItem.price === item.price
      && previousItem.quantity === item.quantity);
    if (sameOccurrence && Object.hasOwn(costs, sourceKey)) {
      result[sourceKey] = costs[sourceKey];
      return;
    }
    // 旧画面でitemId単位に保存された原価は、新旧双方に同じ商品が1件だけの時に限り引き継ぐ。
    if (sameOccurrence
      && Object.hasOwn(costs, item.itemId)
      && previousItemIdCount.get(item.itemId) === 1
      && nextItemIdCount.get(item.itemId) === 1) {
      result[sourceKey] = costs[item.itemId];
    }
  }));
  return result;
}

function initialStoredBottleCosts(initial: DailyClosing | null, posOverride?: PosClosingV3) {
  if (!initial) return {};
  const costs: Record<string, number> = {};
  const sourcePos = posOverride || initial.posSnapshot;
  initial.casts.forEach((row) => row.bottles.forEach((bottle) => {
    if (!Number.isFinite(bottle.costAmount) || !Number.isFinite(bottle.quantity) || bottle.quantity <= 0) return;
    const unitCost = Math.max(0, Math.round(bottle.costAmount * posTargetCount(sourcePos, bottle) / bottle.quantity));
    if (bottle.sourceKey) {
      costs[bottle.sourceKey] = unitCost;
      return;
    }
    // 旧保存形式はitemId単位だったため、その値をfallbackとして保持し、該当する各出現キーにも展開する。
    const occurrences = sourcePos?.transactions.flatMap((transaction) => transaction.items.flatMap((item, itemIndex) =>
      item.itemId === bottle.itemId ? [{ transaction, itemIndex }] : [])) || [];
    // sourceKeyのない旧保存明細は、同一itemIdが一度だけ出現する場合に限り自動復元する。
    // 複数出現時は対応関係を推測せず、注文ごとの特別原価入力を必須にする。
    if (occurrences.length === 1) {
      costs[bottle.itemId] = unitCost;
      costs[posItemOccurrenceKey(occurrences[0].transaction, occurrences[0].itemIndex)] = unitCost;
    }
  }));
  return costs;
}

function posTargetCount(pos: PosClosingV3 | undefined, bottle: BottleAllocation) {
  if (!pos) return 1;
  const occurrence = pos.transactions.flatMap((transaction) => transaction.items.map((item, itemIndex) => ({ transaction, item, itemIndex })))
    .find(({ transaction, item, itemIndex }) => bottle.sourceKey
      ? posItemOccurrenceKey(transaction, itemIndex) === bottle.sourceKey
      : item.itemId === bottle.itemId);
  if (!occurrence) return 1;
  const salesTotal = occurrence.item.price * occurrence.item.quantity;
  if (bottle.salesAmount > 0 && salesTotal > 0) return Math.max(1, Math.round(salesTotal / bottle.salesAmount));
  return Math.max(1, occurrence.item.backTargetCastIds.length);
}

function specialCostValue(costs: Record<string, number>, bottle: Pick<MissingBottleCost, "sourceKey" | "item">) {
  if (Object.hasOwn(costs, bottle.sourceKey)) return costs[bottle.sourceKey];
  // Ver2.7以前にitemIdをキーとして保存・復元していた画面との互換用。
  return Object.hasOwn(costs, bottle.item.itemId) ? costs[bottle.item.itemId] : undefined;
}

function occurrenceSpecialCosts(pos: PosClosingV3, costs: Record<string, number>) {
  const result: Record<string, number> = {};
  pos.transactions.forEach((transaction) => transaction.items.forEach((item, itemIndex) => {
    const sourceKey = posItemOccurrenceKey(transaction, itemIndex);
    const value = Object.hasOwn(costs, sourceKey) ? costs[sourceKey] : costs[item.itemId];
    if (Number.isFinite(value) && value >= 0) result[sourceKey] = value;
  }));
  return result;
}
