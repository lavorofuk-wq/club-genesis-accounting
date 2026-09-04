import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { describe, expect, it } from "vitest";
import type { DailyClosing } from "@/domain/gms";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";
import { introducerDeletionLinkedCastSignature } from "@/lib/firebase/repository";
import { AccountingForms, ClosingCastProductDetails } from "./accounting-forms";
import { CommonForms, introducerDeletionConfirmation } from "./common-forms";
import { CastProductSummary, DailyPreview, StoreWork, summarizeCastDrinksByPrice } from "./store-work";
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

describe("主要ページのSSRスモーク", () => {
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

  it("店舗の日次プレビューからPOS全件明細を除外する", () => {
    const groupedClosing: DailyClosing = {
      ...closing,
      casts: [{
        ...closing.casts[0],
        drinkSales: 26_000,
        drinkAllocations: [
          { itemId: "drink-a", name: "ドリンクA", quantity: 1, salesAmount: 2_000 },
          { itemId: "drink-b", name: "ドリンクB", quantity: 3, salesAmount: 6_000 },
          { itemId: "drink-c", name: "ドリンクC", quantity: 6, salesAmount: 18_000 },
        ],
      }],
    };
    const markup = renderToStaticMarkup(createElement(DailyPreview, { closing: groupedClosing }));
    expect(markup).not.toContain("POSボトル・ドリンク注文明細");
    expect(markup).toContain("キャスト別ボトル・ドリンク配賦明細");
    expect(markup).toContain("￥2,000");
    expect(markup).toContain("4杯");
    expect(markup).toContain("￥3,000");
    expect(markup).toContain("6杯");
    expect(markup).not.toContain("ドリンクA");
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
