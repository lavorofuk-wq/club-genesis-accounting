import { describe, expect, it } from "vitest";
import { calculateCash, normalizeDailyClosing, type DailyClosing, type MonthlyAdjustments, type StaffRecord, type WorkspaceData } from "./gms";
import { calculateCashFunding, cashFundingContext } from "./cash-funding";
import { calculateEmployeePayments, normalizeDailyEmployeePayments, normalizeEmployeePaymentsSummary, supportsEmployeePaymentsSnapshot } from "./employee-payments";
import { buildMonthlySnapshot, calculateMonthlyAccounting, calculateStaffPayroll, canFinalizeMonthlyAccounting, monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot } from "./month-accounting";

const month = "2026-09";
function employee(extra: Partial<StaffRecord> = {}): StaffRecord {
  return { id: "employee_1", name: "社員一郎", employmentType: "employee", status: "active", hiredAt: "2026-09-01",
    note: "", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...extra };
}
function adjustments(extra: Partial<MonthlyAdjustments> = {}): MonthlyAdjustments {
  return { month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [], cardFee: 0, consumptionTaxRate: 0, ...extra };
}
function closing(day = "02", dailyPayment = 10000): DailyClosing {
  const businessDate = `${month}-${day}`;
  const sales = { cashSales: 100000, cardSales: 0, totalSales: 100000 };
  const cash = calculateCash({ sales, cashFloat: 200000, expenses: 0, regularDailyPayments: 0, trialDailyPayments: 0,
    staffDailyPayments: 0, employeeDailyPayments: dailyPayment, driverDailyPayments: 0, dispatchCastPayment: 0,
    dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 300000 - dailyPayment });
  cash.funding = calculateCashFunding(cashFundingContext([], businessDate, 200000),
    { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 }, cash.cashProfit, true);
  return { id: `closing_${day}`, businessDate, status: "approved", submissionId: `submission_${day}`, checksum: "a".repeat(64),
    updatedAt: "2026-09-30T12:00:00Z", sales, customers: { groupCount: 0, totalCustomers: 0 }, nominations: { honShimeiCount: 0, jonaiCount: 0 },
    casts: [], staffWork: [], employeePayments: [{ staffId: "employee_1", name: "社員一郎", dailyPayment }], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0, cash,
    posSnapshot: { businessDate, nominations: { honShimeiCount: 0, jonaiCount: 0 }, castWork: [], transactions: [] } as unknown as DailyClosing["posSnapshot"] };
}
function workspace(extra: Partial<WorkspaceData> = {}): WorkspaceData {
  return { casts: [], staff: [employee()], drivers: [], introducers: [], liquor: [], closings: [closing()], adjustments: [], cashFloat: 200000, ...extra };
}
function snapshot() {
  const data = workspace();
  const inputs = adjustments({ staffSalesAllowance: { employee_1: 1500 }, staffBottleAllowance: { employee_1: 2500 } });
  const results = calculateMonthlyAccounting(data, month, inputs);
  const saved = buildMonthlySnapshot(month, 1, "b".repeat(64), inputs, results, data.closings, "accounting", "2026-09-30T12:00:00Z");
  return { data, inputs, results, saved };
}

describe("社員日払いの原額と独立した保存", () => {
  it("保存JSONから原額で復元し、再読込でも同じ配列と原本JSONを保持する", () => {
    const source = closing();
    source.employeePayments![0].dailyPayment = 100.5;
    const expected = structuredClone(source.employeePayments);
    source.employeePaymentsJson = JSON.stringify(source.employeePayments);
    delete source.employeePayments;
    const before = structuredClone(source);
    const restored = normalizeDailyClosing(source);
    expect(restored.employeePayments).toEqual(expected);
    expect(restored.employeePaymentsJson).toBe(before.employeePaymentsJson);
    const repeated = normalizeDailyClosing(restored);
    expect(repeated.employeePayments).toEqual(expected);
    expect(repeated.employeePaymentsJson).toBe(before.employeePaymentsJson);
    expect(repeated.integrityIssues?.filter((issue) => issue.includes("社員日払い"))).toEqual([]);
    expect(source).toEqual(before);
    expect(normalizeDailyEmployeePayments(JSON.stringify(expected))).toEqual(expected);
  });
  it("JSONと配列が両方ある場合は内容を突合し、相違を記録したうえで保存JSONを優先する", () => {
    const source = closing();
    source.employeePaymentsJson = JSON.stringify(source.employeePayments);
    source.employeePayments![0].dailyPayment += 1;
    const restored = normalizeDailyClosing(source);
    expect(restored.employeePayments![0].dailyPayment).toBe(10000);
    expect(restored.employeePaymentsJson).toBe(source.employeePaymentsJson);
    expect(restored.integrityIssues?.join(" ")).toContain("保存JSONと読込済み明細が一致しません");
    expect(canFinalizeMonthlyAccounting(workspace({ closings: [restored] }), month, adjustments(), true).allowed).toBe(false);
  });
  it("同じ内容の並び順だけ異なる配列とJSONは不一致にせず、JSONの並びを保持する", () => {
    const source = closing();
    source.employeePayments!.push({ staffId: "employee_2", name: "社員二郎", dailyPayment: 200 });
    source.employeePaymentsJson = JSON.stringify(source.employeePayments);
    const expected = structuredClone(source.employeePayments);
    source.employeePayments!.reverse();
    const restored = normalizeDailyClosing(source);
    expect(restored.employeePayments).toEqual(expected);
    expect(restored.integrityIssues?.filter((issue) => issue.includes("社員日払い"))).toEqual([]);
  });
  it.each(["[{", "null", "{}", '""', "[null]"])("破損・配列以外・空明細の保存JSON %s を拒否して異常を記録する", (value) => {
    expect(() => normalizeDailyEmployeePayments(value)).toThrow();
    const source = closing(); source.employeePaymentsJson = value;
    const restored = normalizeDailyClosing(source);
    expect(restored.employeePayments).toEqual([]);
    expect(restored.employeePaymentsJson).toBe(value);
    expect(restored.integrityIssues?.join(" ")).toContain("社員日払い");
  });
  it.each(["salary", "hourlyRate", "hours", "unknown"])("日払いに給与項目・未定義項目 %s が混在するJSONと配列を拒否する", (key) => {
    const rows = [{ staffId: "employee_1", name: "社員一郎", dailyPayment: 10000, [key]: 50000 }];
    expect(() => normalizeDailyEmployeePayments(rows)).toThrow("以外の項目");
    expect(() => normalizeDailyEmployeePayments(JSON.stringify(rows))).toThrow("以外の項目");
  });
  it("Firebase形式を復元しても原額・名前を変更せず、旧日次には項目を後付けしない", () => {
    const row = { staffId: "employee_1", name: "社員一郎", dailyPayment: 100.5 };
    expect(normalizeDailyEmployeePayments({ 0: row })).toEqual([row]);
    expect(normalizeDailyEmployeePayments(undefined)).toEqual([]);
    const original = closing(); delete original.employeePayments;
    const before = structuredClone(original);
    expect(normalizeDailyClosing(original).employeePayments).toBeUndefined();
    expect(original).toEqual(before);
    const current = closing(); current.employeePayments![0].dailyPayment = 100.5;
    expect(normalizeDailyClosing(current).employeePayments).toEqual([{ ...row }]);
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", undefined])("不正日払い %s を補正せず拒否する", (dailyPayment) => {
    expect(() => normalizeDailyEmployeePayments([{ staffId: "employee_1", name: "社員一郎", dailyPayment }])).toThrow();
  });
  it("同一営業日の重複社員を拒否し、日次読込時は原因を残す", () => {
    const data = closing(); data.employeePayments!.push({ ...data.employeePayments![0] });
    expect(() => normalizeDailyEmployeePayments(data.employeePayments)).toThrow("重複");
    const restored = normalizeDailyClosing(data);
    expect(restored.employeePayments).toEqual([]);
    expect(restored.integrityIssues?.join(" ")).toContain("重複");
  });
  it("社員日払いを現金から一度だけ控除し、アルバイト日払い合計を変更しない", () => {
    const data = closing();
    expect(data.cash).toMatchObject({ expenseAndPaymentTotal: 10000, cashProfit: 90000, expectedClosingCash: 290000, difference: 0 });
    expect(data.staffDailyPaymentTotal).toBe(0);
    const old = calculateCash({ sales: data.sales, cashFloat: 200000, expenses: 0, regularDailyPayments: 0, trialDailyPayments: 0,
      staffDailyPayments: 500, driverDailyPayments: 0, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 299500 });
    expect(old).toMatchObject({ expenseAndPaymentTotal: 500, cashProfit: 99500, difference: 0 });
  });
});

describe("社員手当と日払いの月次集計", () => {
  it("勤務なしでも在籍社員の手当を表示し、手当から日払いを引かず人件費に手当だけを計上する", () => {
    const { data, results } = snapshot();
    expect(results.staffPayroll).toEqual([]);
    expect(results.employeePayments).toEqual({ rows: [{ id: "employee_1", name: "社員一郎", sales: 1500, bottle: 2500,
      allowanceTotal: 4000, daily: 10000, days: [{ businessDate: "2026-09-02", dailyPayment: 10000 }] }], dailyTotal: 10000, allowanceTotal: 4000 });
    expect(results.balance).toMatchObject({ staff: 4000, totalCosts: 4000, profit: 96000 });
    expect(results.warnings).toEqual([]);
    expect(data.closings[0].cash.expectedClosingCash).toBe(290000);
  });
  it("日払いなしの在籍社員・当月退職者を掲載し、未入社・前月退職者は手当等がなければ掲載しない", () => {
    const members = [employee(), employee({ id: "left_current", status: "departed", departedAt: "2026-09-05" }),
      employee({ id: "future", hiredAt: "2026-10-01" }), employee({ id: "past", status: "departed", hiredAt: "2026-08-01", departedAt: "2026-08-31" })];
    expect(calculateEmployeePayments([], members, month, adjustments()).summary.rows.map((row) => row.id).sort()).toEqual(["employee_1", "left_current"]);
    const result = calculateEmployeePayments([], members, month, adjustments({ staffSalesAllowance: { past: 500 } }));
    expect(result.summary.rows.find((row) => row.id === "past")).toMatchObject({ sales: 500, allowanceTotal: 500, daily: 0, days: [] });
  });
  it("マスタ削除後も日次に保存した社員名・支払日・金額を保持する", () => {
    const rows = [closing("02", 1000), closing("03", 2000)];
    rows[1].employeePayments![0].name = "変更後社員名";
    const before = structuredClone(rows);
    const result = calculateEmployeePayments(rows, [], month, adjustments({ staffBottleAllowance: { employee_1: 300 } }));
    expect(result.summary.rows[0]).toMatchObject({ id: "employee_1", name: "変更後社員名", daily: 3000, bottle: 300, allowanceTotal: 300 });
    expect(result.summary.rows[0].days).toHaveLength(2);
    expect(rows).toEqual(before);
  });
  it("未承認・他月は社員日払い集計へ入れない", () => {
    const pending = closing("03", 2000); pending.status = "submitted";
    const otherMonth = closing("04", 3000); otherMonth.businessDate = "2026-10-04";
    expect(calculateEmployeePayments([closing(), pending, otherMonth], [employee()], month, adjustments()).summary.dailyTotal).toBe(10000);
  });
  it("社員を時給スタッフに混入させても給与計算せず、月次確定を拒否する", () => {
    const data = workspace();
    data.closings[0].staffWork = [{ staffId: "employee_1", name: "社員一郎", kind: "regular", startTime: "20:00", endTime: "22:00", hours: 2, hourlyRate: 1400, dailyPayment: 0 }];
    expect(calculateStaffPayroll(data.closings, adjustments(), data.staff, month)).toEqual([]);
    const validation = canFinalizeMonthlyAccounting(data, month, adjustments(), true);
    expect(validation.allowed).toBe(false);
    expect(validation.integrityIssues.join(" ")).toContain("社員のため");
  });
  it("アルバイトへの社員日払いと二重営業日の社員日払いを警告する", () => {
    const regular = employee({ employmentType: undefined, hourlyRates: { [month]: 1400 } });
    expect(calculateEmployeePayments([closing()], [regular], month, adjustments()).issues.join(" ")).toContain("アルバイト");
    const duplicate = closing(); duplicate.id = "second_closing";
    expect(calculateEmployeePayments([closing(), duplicate], [employee()], month, adjustments()).issues.join(" ")).toContain("重複");
  });
});

describe("社員支払の確定保存と変更検知", () => {
  it("2.59以降のみ新集計を必須にし、旧確定を補完しない", () => {
    expect(supportsEmployeePaymentsSnapshot("2.58.99")).toBe(false);
    expect(supportsEmployeePaymentsSnapshot("2.59.0")).toBe(true);
    const { saved } = snapshot();
    expect(normalizeMonthlyAccountingSnapshot(saved, month, 1)).toEqual(saved);
    const missing = structuredClone(saved); delete missing.employeePayments;
    expect(normalizeMonthlyAccountingSnapshot(missing, month, 1)).toBeUndefined();
    const legacy = calculateMonthlyAccounting(workspace({ staff: [], closings: [] }), month, adjustments());
    const old = buildMonthlySnapshot(month, 1, "b".repeat(64), adjustments(), legacy, [], "accounting", "2026-09-30T12:00:00Z");
    old.calculationVersion = "2.58.0"; delete old.employeePayments;
    expect(normalizeMonthlyAccountingSnapshot(old, month, 1)).toEqual(old);
    expect(normalizeMonthlyAccountingSnapshot(old, month, 1)).not.toHaveProperty("employeePayments");
  });
  it("Firebaseで消える空のrows/daysを復元し、金額がある欠落や月外日付を拒否する", () => {
    expect(normalizeEmployeePaymentsSummary({ dailyTotal: 0, allowanceTotal: 0 }, month)).toEqual({ rows: [], dailyTotal: 0, allowanceTotal: 0 });
    const allowanceOnly = { id: "employee_1", name: "社員一郎", sales: 100.5, bottle: 0, allowanceTotal: 100.5, daily: 0 };
    expect(normalizeEmployeePaymentsSummary({ rows: { 0: allowanceOnly }, dailyTotal: 0, allowanceTotal: 100.5 }, month).rows[0].days).toEqual([]);
    expect(() => normalizeEmployeePaymentsSummary({ dailyTotal: 1, allowanceTotal: 0 }, month)).toThrow("一致");
    const { saved } = snapshot();
    saved.employeePayments!.rows[0].days[0].businessDate = "2026-10-02";
    expect(normalizeMonthlyAccountingSnapshot(saved, month, 1)).toBeUndefined();
  });
  it.each(["daily", "allowanceTotal", "sales", "bottle"] as const)("社員行の%s改変と総額不整合を拒否する", (key) => {
    const { saved } = snapshot(); saved.employeePayments!.rows[0][key] += 1;
    expect(normalizeMonthlyAccountingSnapshot(saved, month, 1)).toBeUndefined();
  });
  it("支払・手当・社員名簿の更新を指紋に含め、確定済み明細は現在マスタで変えない", async () => {
    const { data, inputs, saved } = snapshot();
    const before = structuredClone(saved);
    const original = await monthlySourceFingerprint(data, month, inputs);
    data.closings[0].employeePayments![0].dailyPayment += 1;
    expect(await monthlySourceFingerprint(data, month, inputs)).not.toBe(original);
    data.closings[0].employeePayments![0].dailyPayment -= 1;
    inputs.staffSalesAllowance.employee_1 += 1;
    expect(await monthlySourceFingerprint(data, month, inputs)).not.toBe(original);
    inputs.staffSalesAllowance.employee_1 -= 1;
    data.staff[0].name = "変更後の名前";
    expect(await monthlySourceFingerprint(data, month, inputs)).not.toBe(original);
    expect(normalizeMonthlyAccountingSnapshot(saved, month, 1)).toEqual(before);
    expect(saved).toEqual(before);
  });
});
