import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { describe, expect, it } from "vitest";
import type { DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { AccountingForms } from "./accounting-forms";
import { CommonForms } from "./common-forms";
import { StoreWork } from "./store-work";
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
  monthStates: [],
  monthSnapshots: [],
};

describe("主要ページのSSRスモーク", () => {
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
