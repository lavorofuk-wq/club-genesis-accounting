import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonthlyAdjustments } from "@/domain/gms";
import type { AccountingWorkspaceData, MonthlyAccountingResults, MonthlyAccountingSnapshot } from "@/domain/month-accounting";

const harness = vi.hoisted(() => ({
  draft: undefined as unknown, results: undefined as unknown, integrityIssues: [] as string[],
  buildStaff: vi.fn(), buildDriver: vi.fn(),
}));
vi.mock("./update-drafts", () => ({
  useRecoverableState: (key: string, initial: unknown) => [
    key === "accounting.monthly.month" ? "2026-09"
      : key === "accounting.monthly.adjustments" && harness.draft ? harness.draft
      : typeof initial === "function" ? initial() : initial,
    vi.fn(),
  ],
  useUpdateDraftBusy: vi.fn(),
}));
vi.mock("@/domain/payroll-export", () => ({ buildStaffPaymentExport: harness.buildStaff, buildDriverPaymentExport: harness.buildDriver }));
vi.mock("@/domain/month-accounting", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/domain/month-accounting")>(),
  calculateMonthlyAccounting: () => harness.results,
  canFinalizeMonthlyAccounting: () => ({ allowed: true, integrityIssues: harness.integrityIssues, unresolvedDaily: [] }),
}));
import { AccountingForms } from "./accounting-forms";

function adjustments(): MonthlyAdjustments {
  return { month: "2026-09", revision: 1, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {},
    driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0, legacyBottleClassifications: {} };
}
function results(): MonthlyAccountingResults {
  return { approvedDays: 0, castSalesReports: [], castRewards: [], introducerPayments: [], staffPayroll: [], driverPayroll: [],
    expenses: { byCategory: {}, dailyExpenseTotal: 0, dispatchCast: 0, dispatchStaff: 0, dispatchFee: 0, dispatchTotal: 0,
      liquorDelivery: 0, fixed: 0, cardFee: 0, total: 0 }, sales: { cash: 0, card: 0, total: 0 },
    balance: { cast: 0, introducer: 0, staff: 0, driver: 0, expenses: 0, totalCosts: 0, profit: 0 }, warnings: [] };
}
function workspace(): AccountingWorkspaceData {
  return { casts: [], archivedCasts: [], staff: [], archivedStaff: [], drivers: [], introducers: [], liquor: [], closings: [],
    adjustments: [adjustments()], cashFloat: 200_000, introducerEntryEvents: [], introducerDeletionCommits: [],
    introducerMonthEvents: [], monthStates: [], monthSnapshots: [] };
}
function render(section: "staffPayroll" | "driverPayroll", data = workspace(), busy = false) {
  return renderToStaticMarkup(createElement(AccountingForms, { section, data, user: { uid: "test" } as never, busy, run: vi.fn() }));
}
function exportButton(markup: string, kind: "staffPayroll" | "driverPayroll") {
  const label = kind === "staffPayroll" ? "スタッフ支払" : "ドライバー支払";
  const matches = markup.match(new RegExp(`<button[^>]*>${label}をXLSX出力</button>`, "g"));
  expect(matches).toHaveLength(1);
  return matches![0];
}
beforeEach(() => {
  vi.clearAllMocks(); harness.draft = undefined; harness.results = results(); harness.integrityIssues = [];
  harness.buildStaff.mockReturnValue({}); harness.buildDriver.mockReturnValue({});
});

describe("給与画面と支払XLSXの接続", () => {
  it.each(["staffPayroll", "driverPayroll"] as const)("%sは対応する支払出力のみを表示する", (section) => {
    const source = workspace(); const markup = render(section, source);
    expect(exportButton(markup, section)).not.toContain("disabled");
    expect(markup).not.toContain(`${section === "staffPayroll" ? "ドライバー支払" : "スタッフ支払"}をXLSX出力`);
    const build = section === "staffPayroll" ? harness.buildStaff : harness.buildDriver;
    expect(build).toHaveBeenCalledWith({ results: harness.results, closings: source.closings, month: "2026-09", snapshot: undefined,
      staff: source.staff, archivedStaff: source.archivedStaff });
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sは操作中に停止する", (section) => {
    const markup = render(section, workspace(), true);
    expect(exportButton(markup, section)).toContain("disabled");
    expect(exportButton(markup, section)).toContain("処理中です。");
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sは未保存手当を出力しない", (section) => {
    harness.draft = { ...adjustments(), staffSalesAllowance: { staff: 500 } };
    const markup = render(section);
    expect(exportButton(markup, section)).toContain("disabled");
    expect(exportButton(markup, section)).toContain("未保存の経理入力を保存してください。");
    expect(harness.buildStaff).not.toHaveBeenCalled(); expect(harness.buildDriver).not.toHaveBeenCalled();
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sは古い入力版の出力を停止する", (section) => {
    harness.draft = { ...adjustments(), revision: 0 };
    const markup = render(section);
    expect(exportButton(markup, section)).toContain("disabled");
    expect(exportButton(markup, section)).toContain("別の操作で月次入力が更新されています。");
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sは月次確定処理中に停止する", (section) => {
    const source = workspace(); source.monthStates = [{ month: "2026-09", status: "closing", revision: 1 } as never];
    expect(exportButton(render(section, source), section)).toContain("月次確定処理中です。");
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sは計算警告と不整合を出力前に止める", (section) => {
    harness.results = { ...results(), warnings: ["給与を計算できません。"] };
    expect(exportButton(render(section), section)).toContain("データの警告を解消してから出力してください。");
    harness.results = results(); harness.integrityIssues = ["日次不整合"];
    expect(exportButton(render(section), section)).toContain("データの警告を解消してから出力してください。");
  });

  it.each(["staffPayroll", "driverPayroll"] as const)("%sの確定月は現在マスタや現在の計算結果を保存値へ置き換えない", (section) => {
    const source = workspace();
    const snapshot = { ...results(), month: "2026-09", revision: 2 } as MonthlyAccountingSnapshot;
    source.monthSnapshots = [snapshot];
    source.monthStates = [{ month: "2026-09", status: "closed", revision: 3, currentSnapshotRevision: 2 } as never];
    harness.results = { ...results(), warnings: ["現在マスタは変更済み"] }; harness.integrityIssues = ["現在の営業日変更"];
    const markup = render(section, source);
    expect(exportButton(markup, section)).not.toContain("disabled");
    const build = section === "staffPayroll" ? harness.buildStaff : harness.buildDriver;
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ results: snapshot, snapshot }));
    expect(markup).toContain("月次確定済み 第2版");
    source.monthSnapshots = [];
    expect(exportButton(render(section, source), section)).toContain("出力する月次データを読み込めません。");
  });
});
