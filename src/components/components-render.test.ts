import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { describe, expect, it } from "vitest";
import { invalidTrialBeautyExpensesForRows, mergeReconciledDailyCastInputs, posItemOccurrenceKey, type DailyClosing, type PosClosingV3 } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { buildMonthlySnapshot, calculateMonthlyAccounting } from "@/domain/month-accounting";
import { introducerDeletionLinkedCastSignature } from "@/lib/firebase/repository";
import { AccountingForms, BalanceExport, ClosingCastProductDetails, ExpenseExport } from "./accounting-forms";
import { CommonForms, introducerDeletionConfirmation } from "./common-forms";
import { CastProductSummary, closingDeletionConfirmation, DailyPreview, jsonReimportConfirmation, reconcileTrialBeautyExpenses, retainCurrentCastMappingForJson, retainMatchingSpecialCosts, shouldResetDailyInputsForJson, StoreWork, summarizeCastDrinksByPrice } from "./store-work";
import { Modal, currentMonth } from "./ui";

const month = currentMonth();
const businessDate = `${month}-02`;
const user = { uid: "render-test-user", email: "render@example.com" } as User;
const run = async (_action: () => Promise<unknown>, _message: string) => true;

const closing: DailyClosing = {
  id: "render-closing",
  businessDate,
  status: "approved",
  submissionId: "render-submission",
  checksum: "a".repeat(64),
  sales: { cashSales: 60_000, cardSales: 40_000, totalSales: 100_000 },
  customers: { groupCount: 2, totalCustomers: 3 },
  nominations: { honShimeiCount: 1, jonaiCount: 1 },
  casts: [{
    masterId: "cast-1", posCastId: "pos-cast-1", name: "花子", kind: "regular",
    startTime: "20:00", endTime: "00:00", hours: 4, hourlyRate: 3_000,
    honShimeiCount: 1, banaiShimeiCount: 1, dohanCount: 0, dohanBack: 0,
    honShimeiSales: 30_000, jonaiExtensionSales: 10_000,
    drinkSales: 1_000, drinkAllocations: [{ itemId: "drink-1", name: "ドリンク", quantity: 1, salesAmount: 1_000 }],
    bottles: [], liquorCost: 0, beautyAllowance: 500, dailyPayment: 1_000,
    advancePayment: 0, transportFee: 500,
    introducer: {
      id: "introducer-1", name: "紹介者A", feeType: "sales10",
      attendanceAdvisoryEnabled: true, entryAdvisoryEnabled: false,
      attendanceAdvisoryFee: 500, entryAdvisoryFee: 0,
    },
  }],
  staffWork: [{
    staffId: "staff-1", name: "スタッフ一郎", kind: "regular",
    startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 2_000, dailyPayment: 1_000,
  }],
  drivers: [{ driverId: "driver-1", name: "ドライバー一郎", dailyRate: 8_000, dailyPayment: 2_000 }],
  expenses: [{ id: "expense-1", category: "supplies", payee: "備品店", amount: 1_000 }],
  staffDailyPaymentTotal: 1_000,
  dispatchStaffPayment: 0,
  dispatchCastPayment: 0,
  dispatchFee: 0,
  liquorDeliveryAmount: 5_000,
  cash: {
    cashSales: 60_000, cardSales: 40_000, totalSales: 100_000, cashFloat: 200_000,
    expenseAndPaymentTotal: 5_500, expectedClosingCash: 254_500, cashProfit: 54_500,
    actualClosingCash: 254_500, difference: 0,
  },
  posSnapshot: {
    schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate, status: "closed",
    sales: { cashSales: 60_000, cardSales: 40_000, totalSales: 100_000 },
    customers: { groupCount: 2, totalCustomers: 3 },
    nominations: { honShimeiCount: 1, jonaiCount: 1 },
    transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
    rosterSnapshot: { complete: true, capturedAt: `${businessDate}T19:00:00+09:00`, casts: [] },
    lifecycleEvents: [], submissionId: "render-submission", generatedAt: `${businessDate}T03:00:00.000Z`,
    checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
  },
  approvedAt: `${businessDate}T03:00:00.000Z`,
  approvedBy: "accounting-user",
  updatedAt: `${businessDate}T03:00:00.000Z`,
};

const data: AccountingWorkspaceData = {
  casts: [{
    id: "cast-1", name: "花子", legalName: "山田花子", status: "active", hiredAt: `${month}-01`,
    hourlyRates: { [month]: 3_000 }, introducerId: "introducer-1", attendanceAdvisoryFee: 500,
    note: "", createdAt: `${businessDate}T00:00:00.000Z`, updatedAt: `${businessDate}T00:00:00.000Z`,
  }],
  staff: [{
    id: "staff-1", name: "スタッフ一郎", status: "active", hiredAt: `${month}-01`, hourlyRate: 2_000,
    note: "", createdAt: `${businessDate}T00:00:00.000Z`, updatedAt: `${businessDate}T00:00:00.000Z`,
  }],
  drivers: [{
    id: "driver-1", name: "ドライバー一郎", status: "active", hiredAt: `${month}-01`, dailyRate: 8_000,
    note: "", createdAt: `${businessDate}T00:00:00.000Z`, updatedAt: `${businessDate}T00:00:00.000Z`,
  }],
  introducers: [{
    id: "introducer-1", name: "紹介者A", feeType: "sales10", attendanceAdvisoryEnabled: true,
    entryAdvisoryEnabled: false, note: "", createdAt: `${businessDate}T00:00:00.000Z`, updatedAt: `${businessDate}T00:00:00.000Z`,
  }],
  liquor: [{
    id: "liquor-1", kind: "champagneWine", name: "シャンパン", salePrice: 30_000, costPrice: 10_000,
    createdAt: `${businessDate}T00:00:00.000Z`, updatedAt: `${businessDate}T00:00:00.000Z`,
  }],
  closings: [closing],
  adjustments: [{
    month, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {},
    fixedExpenses: [], cardFee: 0, legacyBottleClassifications: {}, revision: 1,
  }],
  cashFloat: 200_000,
  archivedCasts: [],
  archivedStaff: [],
  introducerEntryEvents: [],
  introducerDeletionCommits: [],
  introducerMonthEvents: [],
  monthStates: [],
  monthSnapshots: [],
};

function balanceWorkspace(): AccountingWorkspaceData {
  const source = structuredClone(data);
  const daily = source.closings[0];
  daily.nominations = { honShimeiCount: 0, jonaiCount: 0 };
  daily.liquorDeliveryAmount = 0;
  daily.casts = daily.casts.map((cast) => ({ ...cast, honShimeiCount: 0, banaiShimeiCount: 0, introducer: undefined }));
  source.casts = source.casts.map((cast) => ({ ...cast, introducerId: undefined, attendanceAdvisoryFee: 0 }));
  source.introducers = [];
  daily.posSnapshot = {
    ...daily.posSnapshot!,
    nominations: { ...daily.nominations },
    castWork: daily.casts.map((cast) => ({
      castId: cast.posCastId, castName: cast.name, castType: cast.kind, isTrial: cast.kind === "trial",
      startTime: cast.startTime, endTime: cast.endTime, breakMinutes: 0, hours: cast.hours,
    })),
  };
  return source;
}

describe("主要ページのSSRスモーク", () => {
  it("収支表XLSXは未確定の承認済みデータを出力でき、日別配分・紹介料列・Excel入金入力を案内する", () => {
    const markup = renderToStaticMarkup(createElement(AccountingForms, {
      section: "balance", data: balanceWorkspace(), user, busy: false, run,
    }));
    expect(markup).toContain("収支表をXLSX出力");
    expect(markup).toContain("承認済みデータ（未確定）");
    expect(markup).toContain("月間の採用報酬方式を日別に配分");
    expect(markup).toContain("紹介料を独立列で出力");
    expect(markup).toContain("カード入金額はExcel内で入力してください");
    expect(markup).toContain("未承認・差戻し中・店舗編集中の日次は含みません");
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
  });

  it("収支表XLSXは未承認日があっても承認済み部分を出力し、処理中・不整合時は止める", () => {
    const source = balanceWorkspace();
    const render = (workspace: AccountingWorkspaceData, busy = false) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "balance", data: workspace, user, busy, run,
    }));
    const partial = render({ ...source, closings: [source.closings[0], { ...source.closings[0], id: "unapproved", status: "submitted", businessDate: `${month}-03` }] });
    expect(partial).not.toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(render(source, true)).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    const invalid = render({ ...source, closings: [{ ...source.closings[0], integrityIssues: ["日次経費が破損しています。"] }] });
    expect(invalid).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(invalid).toContain("データの警告を解消してから出力してください。");
  });

  it("確定した収支表は保存結果と元の日次・経理入力版が揃う場合だけ出力できる", () => {
    const source = balanceWorkspace();
    const result = calculateMonthlyAccounting(source, month, source.adjustments[0]);
    const snapshot = buildMonthlySnapshot(month, 3, "a".repeat(64), source.adjustments[0], result, source.closings, user.uid, new Date().toISOString());
    const closed: AccountingWorkspaceData = {
      ...source, monthSnapshots: [snapshot],
      monthStates: [{ month, status: "closed", revision: 1, currentSnapshotRevision: 3, updatedAt: "", updatedBy: user.uid }],
    };
    const render = (workspace: AccountingWorkspaceData) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "balance", data: workspace, user, busy: false, run,
    }));
    expect(render(closed)).toContain("月次確定済み 第3版");
    expect(render(closed)).not.toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(render({ ...closed, closings: [] })).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(render({ ...closed, adjustments: [{ ...source.adjustments[0], revision: 2 }] })).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(render({ ...closed, monthSnapshots: [] })).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(render({ ...closed, monthStates: [{ ...closed.monthStates[0], status: "closing" }] })).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
  });

  it("収支表XLSXの事前検査はPOS原本欠損時に理由を表示して出力を止める", () => {
    const source = balanceWorkspace();
    source.closings[0].posSnapshot = undefined as unknown as DailyClosing["posSnapshot"];
    const markup = renderToStaticMarkup(createElement(AccountingForms, {
      section: "balance", data: source, user, busy: false, run,
    }));
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(markup).toContain("POS");
  });

  it("収支表XLSXは未保存・未計算・対象月不一致・入力欠損の場合に操作できない", () => {
    const source = balanceWorkspace();
    const input = {
      results: calculateMonthlyAccounting(source, month, source.adjustments[0]), closings: source.closings,
      adjustments: source.adjustments[0], month, staff: source.staff, archivedStaff: source.archivedStaff,
    };
    for (const disabledReason of ["未保存の経理入力を保存してください。", "ボトル区分を確認して保存してください。"]) {
      const markup = renderToStaticMarkup(createElement(BalanceExport, { input, month, sourceLabel: "未確定", disabledReason }));
      expect(markup).toContain(disabledReason);
      expect(markup).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    }
    const missing = renderToStaticMarkup(createElement(BalanceExport, { month, sourceLabel: "未確定", disabledReason: "" }));
    expect(missing).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    const mismatch = renderToStaticMarkup(createElement(BalanceExport, { input: { ...input, month: "2000-01" }, month, sourceLabel: "未確定", disabledReason: "" }));
    expect(mismatch).toMatch(/<button[^>]*disabled[^>]*>収支表をXLSX出力/);
    expect(mismatch).toContain("表示中の対象月と出力データが一致しません。");
  });

  it("経費表XLSXは承認済みデータを出力し、日次なしでも固定費を出力できる", () => {
    const render = (source: AccountingWorkspaceData) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "expenses", data: source, user, busy: false, run,
    }));
    const markup = render(data);
    expect(markup).toContain("経費表をXLSX出力");
    expect(markup).toContain("未承認・差戻し中・店舗編集中の日次は含みません");
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    const fixedOnly = render({
      ...data, closings: [],
      adjustments: [{ ...data.adjustments[0], fixedExpenses: [{ id: "rent", account: "賃料", amount: 100_000 }] }],
    });
    expect(fixedOnly).not.toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(fixedOnly).toContain("￥100,000");
  });

  it("経費表XLSXは未承認日があっても承認済み部分を出力し、処理中・不整合時は止める", () => {
    const render = (source: AccountingWorkspaceData, busy = false) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "expenses", data: source, user, busy, run,
    }));
    const partial = render({ ...data, closings: [closing, { ...closing, id: "unapproved", status: "submitted", businessDate: `${month}-03` }] });
    expect(partial).not.toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(render(data, true)).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    const invalid = render({ ...data, closings: [{ ...closing, integrityIssues: ["日次経費が破損しています。"] }] });
    expect(invalid).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(invalid).toContain("データの警告を解消してから出力してください。");
  });

  it("確定した経費表は保存結果と元の日次・経理入力版が揃う場合だけ出力できる", () => {
    const result = calculateMonthlyAccounting(data, month, data.adjustments[0]);
    const snapshot = buildMonthlySnapshot(month, 3, "a".repeat(64), data.adjustments[0], result, data.closings, user.uid, new Date().toISOString());
    const closed: AccountingWorkspaceData = {
      ...data, monthSnapshots: [snapshot],
      monthStates: [{ month, status: "closed", revision: 1, currentSnapshotRevision: 3, updatedAt: "", updatedBy: user.uid }],
    };
    const render = (source: AccountingWorkspaceData) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "expenses", data: source, user, busy: false, run,
    }));
    expect(render(closed)).toContain("月次確定済み 第3版");
    expect(render(closed)).not.toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(render({ ...closed, closings: [] })).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(render({ ...closed, adjustments: [{ ...data.adjustments[0], revision: 2 }] })).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(render({ ...closed, monthSnapshots: [] })).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    expect(render({ ...closed, monthStates: [{ ...closed.monthStates[0], status: "closing" }] })).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
  });

  it("経費表XLSXは未保存・未計算の理由を表示し、入力結果がない場合も操作できない", () => {
    const input = { results: calculateMonthlyAccounting(data, month, data.adjustments[0]), closings: data.closings, adjustments: data.adjustments[0], month };
    for (const disabledReason of ["未保存の経理入力を保存してください。", "ボトル区分を確認して保存してください。"]) {
      const markup = renderToStaticMarkup(createElement(ExpenseExport, { input, month, sourceLabel: "未確定", disabledReason }));
      expect(markup).toContain(disabledReason);
      expect(markup).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
    }
    const missing = renderToStaticMarkup(createElement(ExpenseExport, { month, sourceLabel: "未確定", disabledReason: "" }));
    expect(missing).toMatch(/<button[^>]*disabled[^>]*>経費表をXLSX出力/);
  });

  it("キャスト売上の全員一括XLSXを表示し、対象データなしなら無効にする", () => {
    const render = (source: AccountingWorkspaceData) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "castSales", data: source, user, busy: false, run,
    }));
    const markup = render(data);
    expect(markup).toContain("全員分をXLSX出力");
    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
    const empty = render({ ...data, closings: [] });
    expect(empty).toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
    const unapproved = render({ ...data, closings: [{ ...closing, status: "submitted" }] });
    expect(unapproved).toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
  });

  it("確定月は保存結果を表示して出力でき、確定結果が欠損していれば出力を止める", () => {
    const result = calculateMonthlyAccounting(data, month, data.adjustments[0]);
    result.castSalesReports[0].name = "確定時のキャスト名";
    const snapshot = buildMonthlySnapshot(month, 3, "a".repeat(64), data.adjustments[0], result, data.closings, user.uid, new Date().toISOString());
    const closed: AccountingWorkspaceData = {
      ...data, closings: [], casts: [], monthSnapshots: [snapshot],
      monthStates: [{ month, status: "closed", revision: 1, currentSnapshotRevision: 3, updatedAt: "", updatedBy: user.uid }],
    };
    const render = (source: AccountingWorkspaceData) => renderToStaticMarkup(createElement(AccountingForms, {
      section: "castSales", data: source, user, busy: false, run,
    }));
    expect(render(closed)).toContain("確定時のキャスト名");
    expect(render(closed)).not.toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
    expect(render({ ...closed, monthSnapshots: [] })).toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
    expect(render({ ...closed, monthStates: [{ ...closed.monthStates[0], status: "closing" }] }))
      .toMatch(/<button[^>]*disabled[^>]*>全員分をXLSX出力/);
  });

  it("経理未承認の3状態だけに完全削除操作を表示する", () => {
    const statusRows = (["submitted", "returned", "withdrawn", "approved"] as const).map((status, index) => ({
      ...closing,
      id: `render-closing-${status}`,
      businessDate: `${month}-${String(index + 2).padStart(2, "0")}`,
      status,
    }));
    const markup = renderToStaticMarkup(createElement(StoreWork, {
      data: { ...data, closings: statusRows }, user, busy: false, run,
    }));
    const renderedRows = markup.split("<tr>").slice(1);

    for (const label of ["経理確認待ち", "差戻し", "取下げ"]) {
      const row = renderedRows.find((candidate) => candidate.includes(`>${label}</span>`));
      expect(row).toContain(">完全削除</button>");
    }
    const approvedRow = renderedRows.find((candidate) => candidate.includes(">承認済み</span>"));
    expect(approvedRow).not.toContain(">完全削除</button>");
    expect(markup.match(/>完全削除<\/button>/g)).toHaveLength(3);
  });

  it("完全削除の確認文で対象日と不可逆な削除範囲を明示する", () => {
    const message = closingDeletionConfirmation({ businessDate: "2026-09-02", status: "returned" });
    expect(message).toContain("2026-09-02");
    expect(message).toContain("差戻し");
    expect(message).toContain("POS原本・店舗入力・現金照合・差戻し履歴");
    expect(message).toContain("復元できません");
  });

  it("同じ営業日のJSON再取込は店舗入力の保持とPOS項目の再計算を明示する", () => {
    const message = jsonReimportConfirmation("2026-09-02", "2026-09-02");

    expect(shouldResetDailyInputsForJson("2026-09-02", "2026-09-02")).toBe(false);
    expect(message).toContain("2026-09-02");
    expect(message).toContain("入力済みの店舗データ");
    expect(message).toContain("現金実在高");
    expect(message).toContain("保持");
    expect(message).toContain("POS由来");
    expect(message).toContain("再計算");
    expect(message).not.toContain("すべて初期化");
  });

  it("別営業日のJSONへ変更する場合は入力を初期化すると明示する", () => {
    const message = jsonReimportConfirmation("2026-09-02", "2026-09-03");

    expect(shouldResetDailyInputsForJson("2026-09-02", "2026-09-03")).toBe(true);
    expect(message).toContain("2026-09-02");
    expect(message).toContain("2026-09-03");
    expect(message).toContain("別営業日");
    expect(message).toContain("店舗データ");
    expect(message).toContain("現金照合");
    expect(message).toContain("特別原価");
    expect(message).toContain("すべて初期化");
  });

  it("同日JSON再取込では画面上で修正したキャスト照合を保持し、別日へは移さない", () => {
    const previous = structuredClone(closing.posSnapshot!) as PosClosingV3;
    previous.castWork = [{
      castId: "pos-trial", castName: "同名", castType: "trial", isTrial: true,
      startTime: "20:00", endTime: "00:00", breakMinutes: 0, hours: 4,
    }];
    const sameDay = structuredClone(previous) as PosClosingV3;
    const changedDay = { ...structuredClone(previous), businessDate: "2026-09-03" } as PosClosingV3;

    expect(retainCurrentCastMappingForJson(previous, sameDay, { "pos-trial": "master-new" }))
      .toEqual({ "pos-trial": "master-new" });
    expect(retainCurrentCastMappingForJson(previous, changedDay, { "pos-trial": "master-new" }))
      .toEqual({});
  });

  it("体入美容室経費は一意なmasterIdの現在名へ更新し、欠落や名前不一致を送信不可として検出する", () => {
    const previous = { ...closing.casts[0], masterId: "trial-1", name: "旧名", kind: "trial" as const };
    const next = { ...previous, name: "新名" };
    const expense = {
      id: "beauty-trial-1", category: "beautyTrial" as const, payee: "旧名", amount: 3_000,
      personId: "trial-1", personName: "旧名",
    };

    const reconciled = reconcileTrialBeautyExpenses([expense], { rows: [next], matches: [] });

    expect(reconciled[0]).toMatchObject({ personId: "trial-1", personName: "新名", payee: "新名" });
    expect(invalidTrialBeautyExpensesForRows(reconciled, [next])).toEqual([]);
    expect(invalidTrialBeautyExpensesForRows([expense], [next])).toEqual([expense]);
    expect(invalidTrialBeautyExpensesForRows([{ ...expense, personId: undefined }], [next])).toHaveLength(1);
  });

  it("同名体入2名の照合先を入れ替えても美容室経費を同じPOS人物行へ追従させる", () => {
    const previousA = { ...closing.casts[0], posCastId: "pos-trial-a", masterId: "trial-a", name: "同名", kind: "trial" as const };
    const previousB = { ...closing.casts[0], posCastId: "pos-trial-b", masterId: "trial-b", name: "同名", kind: "trial" as const };
    const nextA = { ...previousA, masterId: "trial-b" };
    const nextB = { ...previousB, masterId: "trial-a" };
    const castResult = mergeReconciledDailyCastInputs([previousA, previousB], [nextA, nextB]);
    const expenses = [
      { id: "beauty-a", category: "beautyTrial" as const, payee: "同名", amount: 1_000, personId: "trial-a", personName: "同名" },
      { id: "beauty-b", category: "beautyTrial" as const, payee: "同名", amount: 2_000, personId: "trial-b", personName: "同名" },
    ];

    const reconciled = reconcileTrialBeautyExpenses(expenses, castResult);

    expect(reconciled.map((expense) => expense.personId)).toEqual(["trial-b", "trial-a"]);
    expect(invalidTrialBeautyExpensesForRows(reconciled, castResult.rows)).toEqual([]);
  });

  it("特別原価は同じ商品出現だけ保持し、商品内容または出現位置が変われば破棄する", () => {
    const previous = structuredClone(closing.posSnapshot!) as PosClosingV3;
    previous.transactions = [{
      transactionId: "tx-special", tableId: "1", tableLabel: "1",
      startTime: 0, endTime: 1, payMethod: "cash", splits: [{ method: "cash", amount: 35_000 }],
      subtotal: 35_000, discount: 0, tax: 0, total: 35_000,
      items: [{
        itemId: "bottle-special", label: "特別シャンパン", category: "champagneWine",
        price: 35_000, quantity: 1, backTargetCastIds: ["pos-cast-1"],
        backTargetCastNames: ["花子"], banaiExtCastIds: [], isSet: false,
        isHonShimei: false, isBanaiShimei: false, isExtension: false,
        isBanaiExtension: false, isDiscount: false,
      }],
    }];
    const sourceKey = posItemOccurrenceKey(previous.transactions[0], 0);
    const costs = { [sourceKey]: 12_500, unrelated: 99_999 };

    const same = structuredClone(previous) as PosClosingV3;
    expect(retainMatchingSpecialCosts(previous, same, costs)).toEqual({ [sourceKey]: 12_500 });
    expect(retainMatchingSpecialCosts(null, same, costs)).toEqual({});

    const changed = structuredClone(previous) as PosClosingV3;
    changed.transactions[0].items[0].price = 36_000;
    expect(retainMatchingSpecialCosts(previous, changed, costs)).toEqual({});

    const moved = structuredClone(previous) as PosClosingV3;
    moved.transactions[0].items.unshift({
      ...moved.transactions[0].items[0],
      itemId: "another-item",
      label: "別商品",
    });
    expect(retainMatchingSpecialCosts(previous, moved, costs)).toEqual({});
  });

  it.each([
    ["closing", "月次確定処理中"],
    ["closed", "月次確定済み"],
  ] as const)("月次が%sなら完全削除操作を無効化する", (status, message) => {
    const unlockedClosing = { ...closing, id: `render-closing-${status}`, status: "returned" as const };
    const markup = renderToStaticMarkup(createElement(StoreWork, {
      data: {
        ...data,
        closings: [unlockedClosing],
        monthStates: [{
          month,
          status,
          revision: 1,
          updatedAt: `${businessDate}T03:00:00.000Z`,
          updatedBy: "accounting-user",
        }],
      },
      user,
      busy: false,
      run,
    }));
    const deleteButton = markup.match(/<button class="button danger mini"[^>]*>完全削除<\/button>/)?.[0];

    expect(deleteButton).toBeDefined();
    expect(deleteButton).toContain('disabled=""');
    expect(deleteButton).toContain(message);
  });

  it("キャストドリンクを販売単価ごとの杯数に集約する", () => {
    const rows = summarizeCastDrinksByPrice({
      posCastId: "pos-cast-1",
      drinkAllocations: [
        { itemId: "drink-a", name: "ドリンクA", quantity: 1, salesAmount: 2_000 },
        { itemId: "drink-b", name: "ドリンクB", quantity: 3, salesAmount: 6_000 },
        { itemId: "drink-c", name: "ドリンクC", quantity: 6, salesAmount: 18_000 },
      ],
    });
    expect(rows).toEqual([
      { unitPrice: 2_000, quantity: 4, salesAmount: 8_000 },
      { unitPrice: 3_000, quantity: 6, salesAmount: 18_000 },
    ]);
  });

  it("POS原本がある場合は複数対象への配賦後金額ではなく販売単価で集約する", () => {
    const item = (itemId: string, price: number, quantity: number) => ({
      itemId, label: itemId, category: "castDrink", price, quantity,
      backTargetCastIds: ["pos-cast-1", "pos-cast-2"], backTargetCastNames: ["花子", "春子"],
      banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false,
      isExtension: false, isBanaiExtension: false, isDiscount: false,
    });
    const pos = {
      ...closing.posSnapshot,
      transactions: [{
        transactionId: "tx-1", tableId: "table-1", tableLabel: "A",
        startTime: 0, endTime: 0, payMethod: "cash", splits: [], subtotal: 26_000,
        discount: 0, tax: 0, total: 26_000,
        items: [item("drink-a", 2_000, 1), item("drink-b", 2_000, 3), item("drink-c", 3_000, 6)],
      }],
    };
    expect(summarizeCastDrinksByPrice({ posCastId: "pos-cast-1", drinkAllocations: [] }, pos)).toEqual([
      { unitPrice: 2_000, quantity: 4, salesAmount: 4_000 },
      { unitPrice: 3_000, quantity: 6, salesAmount: 9_000 },
    ]);
    const legacyRow = { ...closing.casts[0], drinkSales: 13_000, drinkAllocations: undefined };
    const summaryMarkup = renderToStaticMarkup(createElement(CastProductSummary, { row: legacyRow, pos }));
    expect(summaryMarkup).toContain("ドリンク 10杯");
    expect(summaryMarkup).not.toContain("ドリンク —");
    const accountingMarkup = renderToStaticMarkup(createElement(ClosingCastProductDetails, { row: legacyRow, pos }));
    expect(accountingMarkup).toContain("￥2,000");
    expect(accountingMarkup).toContain("4杯");
    expect(accountingMarkup).not.toContain("キャストドリンク ￥13,000");
  });

  it("店舗の日次プレビューのキャスト欄へ本数・商品バック・控除をまとめる", () => {
    const groupedClosing: DailyClosing = {
      ...closing,
      casts: [{
        ...closing.casts[0],
        honShimeiCount: 11,
        banaiShimeiCount: 7,
        dohanCount: 3,
        bottles: [
          {
            itemId: "champagne-a",
            sourceKey: "tx-1|0|champagne-a",
            name: "銘柄A",
            kind: "champagneWine",
            quantity: 1,
            salesAmount: 17_500,
            costAmount: 6_250,
            backAmount: 2_810,
            specialCost: false,
          },
          {
            itemId: "keep-b",
            sourceKey: "tx-1|1|keep-b",
            name: "銘柄B",
            kind: "keepBottle",
            quantity: 1,
            salesAmount: 20_000,
            costAmount: 8_000,
            backAmount: 1_800,
            specialCost: true,
          },
        ],
        drinkSales: 32_000,
        drinkAllocations: [
          { itemId: "drink-a", name: "ドリンクA", quantity: 1, salesAmount: 2_000 },
          { itemId: "drink-b", name: "ドリンクB", quantity: 3, salesAmount: 6_000 },
          { itemId: "drink-c", name: "ドリンクC", quantity: 8, salesAmount: 24_000 },
        ],
        dailyPayment: 1_111,
        advancePayment: 2_222,
        transportFee: 3_500,
      }],
      posSnapshot: {
        ...closing.posSnapshot,
        transactions: [{
          transactionId: "preview-tx", tableId: "table-1", tableLabel: "A",
          startTime: 0, endTime: 0, payMethod: "cash", splits: [], subtotal: 32_000,
          discount: 0, tax: 0, total: 32_000,
          items: [
            { itemId: "drink-a", label: "ドリンクA", category: "castDrink", price: 2_000, quantity: 1, backTargetCastIds: ["pos-cast-1"], backTargetCastNames: ["花子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
            { itemId: "drink-b", label: "ドリンクB", category: "castDrink", price: 2_000, quantity: 3, backTargetCastIds: ["pos-cast-1"], backTargetCastNames: ["花子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
            { itemId: "drink-c", label: "ドリンクC", category: "castDrink", price: 3_000, quantity: 8, backTargetCastIds: ["pos-cast-1"], backTargetCastNames: ["花子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
          ],
        }],
      },
    };
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: groupedClosing }));
    expect(markup).toContain("<th>名前</th><th>勤務</th><th>本指名</th><th>場内指名</th><th>同伴</th><th>本指名売上</th><th>場内延長売上</th><th>ボトルバック</th><th>ドリンクバック</th><th>美容室</th><th>日払い</th><th>立替</th><th>送迎</th>");
    expect(markup).toContain("11本");
    expect(markup).toContain("7本");
    expect(markup).toContain("3本");
    expect(markup).toContain("銘柄A ×1本");
    expect(markup).toContain("シャンパン・ワイン");
    expect(markup).toContain("金額（配賦後） ￥17,500");
    expect(markup).toContain("酒代原価（配賦後） ￥6,250");
    expect(markup).toContain("バック率 25% / バック金額 ￥2,810");
    expect(markup).toContain("銘柄B ×1本");
    expect(markup).toContain("キープボトル（特別原価）");
    expect(markup).toContain("金額（配賦後） ￥20,000");
    expect(markup).toContain("酒代原価（配賦後） ￥8,000");
    expect(markup).toContain("バック率 15% / バック金額 ￥1,800");
    expect(markup).not.toContain("POSボトル・ドリンク注文明細");
    expect(markup).not.toContain("キャスト別ボトル・ドリンク配賦明細");
    expect(markup).toContain("￥2,000");
    expect(markup).toContain("4杯");
    expect(markup).toContain("￥3,000");
    expect(markup).toContain("8杯");
    expect(markup).not.toContain("ドリンクA");
    expect(markup).toContain("￥1,111");
    expect(markup).toContain("￥2,222");
    expect(markup).toContain("￥3,500");
    expect(markup).not.toContain("￥6,833");
  });

  it("店舗の日次プレビューは旧商品データを推測せず安全に表示する", () => {
    const legacyClosing: DailyClosing = {
      ...closing,
      casts: [{
        ...closing.casts[0],
        bottles: [{
          itemId: "legacy-bottle",
          name: "旧ボトル",
          kind: "keepBottle",
          quantity: 1,
          salesAmount: 10_000,
          costAmount: 4_000,
          specialCost: false,
        }],
        drinkSales: 2_460,
        drinkAllocations: [{ itemId: "legacy-drink", name: "旧ドリンク", quantity: 2, salesAmount: 2_460 }],
      }],
    };
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: legacyClosing }));
    expect(markup).toContain("バック金額 旧データのため確認不可");
    expect(markup).toContain("2杯 / 旧データのため単価確認不可");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("NaN");
    const totalRow = markup.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1];
    expect(totalRow).toContain("単価不明　2杯");
    expect(totalRow).toContain("合計杯数 2杯");
    expect(totalRow).not.toContain("￥1,230");
  });

  it("キャスト合計は表示行の売上・本数・手当人数と単価別の延べ杯数を集計する", () => {
    const source: DailyClosing = {
      ...closing,
      casts: [
        { ...closing.casts[0], honShimeiCount: 1, banaiShimeiCount: 2, dohanCount: 1, honShimeiSales: 30_010, jonaiExtensionSales: 10_020, beautyAllowance: 500 },
        { ...closing.casts[0], masterId: "cast-2", posCastId: "pos-cast-2", name: "春子", honShimeiCount: 2, banaiShimeiCount: 3, dohanCount: 0, honShimeiSales: 20_120, jonaiExtensionSales: 2_070, beautyAllowance: 500 },
        { ...closing.casts[0], masterId: "cast-3", posCastId: "pos-cast-3", name: "夏子", honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, honShimeiSales: 0, jonaiExtensionSales: 0, beautyAllowance: 0, drinkSales: 0, drinkAllocations: [] },
      ],
      posSnapshot: {
        ...closing.posSnapshot,
        transactions: [{
          transactionId: "totals-tx", tableId: "table-1", tableLabel: "A",
          startTime: 0, endTime: 0, payMethod: "cash", splits: [], subtotal: 42_000,
          discount: 0, tax: 0, total: 42_000,
          items: [
            { itemId: "shared", label: "共有ドリンク", category: "castDrink", price: 2_000, quantity: 2, backTargetCastIds: ["pos-cast-1", "pos-cast-2"], backTargetCastNames: ["花子", "春子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
            { itemId: "single-a", label: "ドリンクA", category: "castDrink", price: 2_000, quantity: 3, backTargetCastIds: ["pos-cast-1"], backTargetCastNames: ["花子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
            { itemId: "single-b", label: "ドリンクB", category: "castDrink", price: 3_000, quantity: 4, backTargetCastIds: ["pos-cast-2"], backTargetCastNames: ["春子"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
            { itemId: "dispatch", label: "派遣分", category: "castDrink", price: 2_000, quantity: 10, backTargetCastIds: ["pos-dispatch"], backTargetCastNames: ["派遣"], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
          ],
        }],
      },
    };
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: source }));
    const totalRow = markup.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1];
    expect(totalRow).toContain("<td>3本</td><td>5本</td><td>1本</td><td>￥50,130</td><td>￥12,090</td>");
    expect(totalRow).toContain("￥2,000　7杯");
    expect(totalRow).toContain("￥3,000　4杯");
    expect(totalRow).toContain("合計杯数 11杯");
    expect(totalRow).toContain("キャスト欄の延べ杯数");
    expect(totalRow).toContain("<td>2人</td>");
    expect(markup.indexOf('class="total-row"')).toBeLessThan(markup.indexOf("<h3>スタッフ</h3>"));
  });

  it("ドリンク杯数不明の旧データを合計ゼロと誤表示せず、キャストなしはゼロ表示する", () => {
    const unknown = renderToStaticMarkup(createElement(DailyPreview, { closing: {
      ...closing, casts: [{ ...closing.casts[0], drinkAllocations: undefined }],
    } }));
    expect(unknown.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1]).toContain("合計杯数 確認不可");
    const empty = renderToStaticMarkup(createElement(DailyPreview, { closing: { ...closing, casts: [] } }));
    const totalRow = empty.match(/<tr class="total-row">([\s\S]*?)<\/tr>/)?.[1];
    expect(totalRow).toContain("<td>0本</td><td>0本</td><td>0本</td><td>￥0</td><td>￥0</td>");
    expect(totalRow).toContain("合計杯数 0杯");
    expect(totalRow).toContain("<td>0人</td>");
  });

  it("紹介者削除の警告へ紐づく在籍・体入・退店キャストを一覧表示する", () => {
    const message = introducerDeletionConfirmation("紹介者A", [
      { name: "花子", status: "active" },
      { name: "春子", status: "trial" },
      { name: "夏子", status: "departed" },
    ]);
    expect(message).toContain("花子（在籍）");
    expect(message).toContain("春子（体入）");
    expect(message).toContain("夏子（退店）");
    expect(message).toContain("削除した月の紹介者報酬");
    expect(message).toContain("当月全体の算出対象");
  });

  it("紹介者削除前の紐づきキャスト版は順序に依存せず、追加・更新を検出する", () => {
    const confirmed = introducerDeletionLinkedCastSignature([
      { id: "cast-b", updatedAt: "2026-09-01T01:00:00.000Z" },
      { id: "cast-a", updatedAt: "2026-09-01T01:00:00.000Z" },
    ]);
    expect(confirmed).toBe(introducerDeletionLinkedCastSignature([
      { id: "cast-a", updatedAt: "2026-09-01T01:00:00.000Z" },
      { id: "cast-b", updatedAt: "2026-09-01T01:00:00.000Z" },
    ]));
    expect(confirmed).not.toBe(introducerDeletionLinkedCastSignature([
      { id: "cast-a", updatedAt: "2026-09-01T01:00:00.000Z" },
      { id: "cast-b", updatedAt: "2026-09-02T01:00:00.000Z" },
    ]));
  });

  it.each(["casts", "staff", "drivers", "introducers", "liquor", "cash"] as const)(
    "共通フォーム %s を代表データで描画できる",
    (section) => {
      expect(() => renderToStaticMarkup(createElement(CommonForms, { data, user, busy: false, run, section }))).not.toThrow();
    },
  );

  it.each(["approval", "castSales", "castRewards", "introducers", "staffPayroll", "driverPayroll", "expenses", "balance"] as const)(
    "経理フォーム %s を代表データで描画できる",
    (section) => {
      expect(() => renderToStaticMarkup(createElement(AccountingForms, { data, user, busy: false, run, section }))).not.toThrow();
    },
  );

  it("店舗作業と保存中モーダルを描画でき、保存中は全入力と閉じる操作を無効化する", () => {
    expect(() => renderToStaticMarkup(createElement(StoreWork, { data, user, busy: false, run }))).not.toThrow();
    const modal = renderToStaticMarkup(createElement(Modal, {
      title: "保存中",
      disabled: true,
      onClose: () => undefined,
      children: createElement("input", { name: "sample" }),
    }));
    expect(modal).toContain('aria-busy="true"');
    expect(modal).toContain('<fieldset class="modal-body" disabled=""');
    expect(modal).toContain('aria-label="閉じる" disabled=""');
  });
});
