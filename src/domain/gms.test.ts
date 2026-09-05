import { describe, expect, it } from "vitest";
import {
  buildDailyCasts,
  calculateCash,
  calculateCastSalesReports,
  calculateCastRewards,
  calculateDriverPayroll,
  canMapAsDispatch,
  dayAfterIsoDate,
  floorHundred,
  findUnclassifiedLegacyBottles,
  hoursBetweenQuarter,
  introducerSalesBase,
  isUnapprovedClosingStatus,
  isStaffHireDateAfterTrial,
  isCastMappingComplete,
  japanMonthFromTimestamp,
  legacyBottleSourceKey,
  normalizeDailyClosing,
  normalizeMonthlyAdjustments,
  parsePosClosingV3,
  posSubmissionClaimKey,
  posItemOccurrenceKey,
  posCastReferences,
  requiresBottleCost,
  restoreDailyCastBackMetadata,
  rewardRateForSales,
  sha256Checksum,
  staffCandidatesForBusinessDate,
  type DailyClosing,
  type CastRecord,
  type PosClosingV3,
  type StaffRecord,
} from "./gms";

function pos(): PosClosingV3 {
  return {
    schema: "club-genesis-pos-closing",
    schemaVersion: 3,
    businessDate: "2026-09-02",
    status: "submitted",
    sales: { totalSales: 100000, cashSales: 60000, cardSales: 40000 },
    customers: { groupCount: 1, totalCustomers: 1 },
    nominations: { honShimeiCount: 2, jonaiCount: 0 },
    transactions: [{
      transactionId: "tx1", tableId: "1", tableLabel: "1", startTime: new Date("2026-09-02T20:30:00+09:00").getTime(), endTime: new Date("2026-09-03T00:30:00+09:00").getTime(), payMethod: "split", splits: [{ method: "cash", amount: 60000 }, { method: "card", amount: 40000 }], subtotal: 100000, discount: 0, tax: 0, total: 100000,
      items: [
        { itemId: "hon", label: "本指名", category: "honShimei", price: 2000, quantity: 1, castId: "p1", castName: "花子", backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [], isSet: false, isHonShimei: true, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
        { itemId: "hon-2", label: "本指名", category: "honShimei", price: 2000, quantity: 1, castId: "p2", castName: "春子", backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [], isSet: false, isHonShimei: true, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
        { itemId: "dohan", label: "同伴料", category: "dohan", price: 3000, quantity: 1, backTargetCastIds: ["p1"], backTargetCastNames: ["花子"], backType: "dohan", backAllocation: "single", banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
        { itemId: "extension", label: "延長60分", category: "extension", price: 7000, quantity: 1, backTargetCastIds: [], backTargetCastNames: [], banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: true, isBanaiExtension: false, isDiscount: false },
        { itemId: "bottle", label: "テストシャンパン", category: "champagneWine", price: 30000, quantity: 1, backTargetCastIds: ["p1", "p2"], backTargetCastNames: ["花子", "春子"], backType: "champagneWine", backAllocation: "equal", banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false },
        { itemId: "drink", label: "キャストドリンク", category: "castDrink", price: 2000, quantity: 1, backTargetCastIds: ["p1"], backTargetCastNames: ["花子"], backType: "castDrink", backAllocation: "single", banaiExtCastIds: [], isSet: false, isHonShimei: false, isBanaiShimei: false, isExtension: false, isBanaiExtension: false, isDiscount: false }
      ]
    }],
    castSales: [{ castId: "p1", castName: "花子", honShimeiSales: 1300000, jonaiExtensionSales: 0, drinkSales: 2000, totalAttributedSales: 1300000 }, { castId: "p2", castName: "春子", honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, totalAttributedSales: 0 }],
    castWork: [{ castId: "p1", castName: "花子", castType: "regular", isTrial: false, startTime: "20:00", endTime: "00:07", breakMinutes: 0, hours: 4 }, { castId: "p2", castName: "春子", castType: "regular", isTrial: false, startTime: "20:00", endTime: "00:00", breakMinutes: 0, hours: 4 }],
    enteredCasts: [], exitedCasts: [], trialCasts: [],
    rosterSnapshot: { complete: true, capturedAt: "2026-09-02T10:00:00.000Z", casts: [] },
    lifecycleEvents: [],
    source: { businessStartedAt: new Date("2026-09-02T19:00:00+09:00").getTime(), businessEndedAt: new Date("2026-09-03T03:00:00+09:00").getTime() },
    submissionId: "submission-1", generatedAt: "2026-09-03T03:00:00+09:00", checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "0".repeat(64)
  };
}

async function signedPos(value: PosClosingV3) {
  value.checksum = await sha256Checksum(value as unknown as Record<string, unknown>);
  return value;
}

describe("GMS報酬・日次計算", () => {
  it("経理未承認の日次状態だけを完全削除対象にする", () => {
    expect(isUnapprovedClosingStatus("submitted")).toBe(true);
    expect(isUnapprovedClosingStatus("returned")).toBe(true);
    expect(isUnapprovedClosingStatus("withdrawn")).toBe(true);
    expect(isUnapprovedClosingStatus("approved")).toBe(false);
  });

  it("POS重複防止キーをRulesの動的パスで安全な64桁hexに限定する", () => {
    expect(posSubmissionClaimKey("a".repeat(64))).toBe("a".repeat(64));
    expect(() => posSubmissionClaimKey("A".repeat(64))).toThrow("POSチェックサムが正しくありません。");
    expect(() => posSubmissionClaimKey(`submission~${"a".repeat(64)}`)).toThrow("POSチェックサムが正しくありません。");
  });

  it("UTC月末時刻をAsia/Tokyoの削除月へ変換する", () => {
    expect(japanMonthFromTimestamp("2026-08-31T14:59:59.999Z")).toBe("2026-08");
    expect(japanMonthFromTimestamp("2026-08-31T15:00:00.000Z")).toBe("2026-09");
    expect(() => japanMonthFromTimestamp("invalid")).toThrow("日時が正しくありません");
  });
  it("体入スタッフの採用日は体入日の翌日以降だけを許可する", () => {
    expect(isStaffHireDateAfterTrial("2026-09-01", "2026-09-01")).toBe(false);
    expect(isStaffHireDateAfterTrial("2026-09-01", "2026-09-02")).toBe(true);
    expect(isStaffHireDateAfterTrial("2026-09-01", "2026-08-31")).toBe(false);
    expect(isStaffHireDateAfterTrial("2026-02-30", "2026-03-01")).toBe(false);
    expect(dayAfterIsoDate("2028-02-29")).toBe("2028-03-01");
    expect(dayAfterIsoDate("2026-12-31")).toBe("2027-01-01");
  });

  it("旧版の同日在籍化データでも体入日は体入スタッフだけを勤務候補にする", () => {
    const base = { name: "体入スタッフ", note: "", createdAt: "", updatedAt: "" };
    const trial: StaffRecord = {
      ...base, id: "trial-staff", status: "trial", trialDate: "2026-09-01",
      trialHourlyRate: 1_500, convertedToStaffId: "active-staff",
    };
    const legacyActive: StaffRecord = {
      ...base, id: "active-staff", status: "active", hiredAt: "2026-09-01", trialDate: "2026-09-01",
      hourlyRate: 2_000, convertedFromTrialId: trial.id,
    };
    const regular: StaffRecord = {
      ...base, id: "regular-staff", name: "在籍スタッフ", status: "active", hiredAt: "2026-08-01", hourlyRate: 2_000,
    };

    expect(staffCandidatesForBusinessDate([trial, legacyActive, regular], [], "2026-09-01").map((row) => row.id))
      .toEqual([trial.id, regular.id]);
    expect(staffCandidatesForBusinessDate([trial, legacyActive, regular], [], "2026-09-02").map((row) => row.id))
      .toEqual([legacyActive.id, regular.id]);
    // 店舗権限で削除済み体入マスタを取得できなくても、在籍側に保持した体入日で同日候補化を防ぐ。
    expect(staffCandidatesForBusinessDate([legacyActive], [], "2026-09-01")).toEqual([]);
  });

  it("100円未満と15分未満を切り捨てる", () => {
    expect(floorHundred(1234)).toBe(1200);
    expect(floorHundred(99.999)).toBe(0);
    // 15%・70%計算で生じるIEEE 754の微小誤差により100円過少にならない。
    expect(floorHundred((2000 / 3) * 0.15)).toBe(100);
    expect(floorHundred(5_243_000 * 0.7)).toBe(3_670_100);
    expect(hoursBetweenQuarter("20:00", "02:07")).toBe(6);
  });

  it("売上報酬率の境界を正しく判定する", () => {
    expect(rewardRateForSales(1209999)).toBe(0);
    expect(rewardRateForSales(1210000)).toBe(0.6);
    expect(rewardRateForSales(2509999)).toBe(0.6);
    expect(rewardRateForSales(2510000)).toBe(0.65);
    expect(rewardRateForSales(4009999)).toBe(0.65);
    expect(rewardRateForSales(4010000)).toBe(0.7);
    expect(rewardRateForSales(6009999)).toBe(0.7);
    expect(rewardRateForSales(6010000)).toBe(0.75);
    expect(rewardRateForSales(8009999)).toBe(0.75);
    expect(rewardRateForSales(8010000)).toBe(0.8);
  });

  it("複数キャストのボトル売上と原価を均等分配する", () => {
    const rows = buildDailyCasts(pos(), {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    expect(rows[0].bottles[0].salesAmount).toBe(15000);
    expect(rows[0].bottles[0].costAmount).toBe(5000);
    expect(rows[0].dohanBack).toBe(5000);
  });

  it("同伴バックを入店時刻の境界と20:30までの延長有無で判定する", () => {
    const amountAt = (time: string, extended = true) => {
      const value = pos();
      value.transactions[0].startTime = new Date(`2026-09-02T${time}:00+09:00`).getTime();
      if (!extended) value.transactions[0].items = value.transactions[0].items.filter((item) => !item.isExtension);
      return buildDailyCasts(value, {
        p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
        p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
      }, [], {})[0].dohanBack;
    };

    expect(amountAt("20:30", false)).toBe(3000);
    expect(amountAt("20:30")).toBe(5000);
    expect(amountAt("20:31")).toBe(2000);
    expect(amountAt("21:00")).toBe(2000);
    expect(amountAt("21:01")).toBe(0);
  });

  it("商品IDが別会計で重複しても出現キーで特別原価と売上区分を識別する", () => {
    const value = pos();
    const honTransaction = value.transactions[0];
    const freeTransaction = {
      ...honTransaction,
      transactionId: "tx-free.with/slash",
      items: honTransaction.items.filter((item) => !item.isHonShimei).map((item) => ({ ...item })),
    };
    value.transactions = [freeTransaction, honTransaction];
    const bottleIndex = honTransaction.items.findIndex((item) => item.itemId === "bottle");
    const sourceKey = posItemOccurrenceKey(honTransaction, bottleIndex);
    const rows = buildDailyCasts(value, {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [], { [sourceKey]: 12000 });
    const row = rows.find((candidate) => candidate.posCastId === "p1")!;

    expect(sourceKey).not.toMatch(/[.#$/\[\]]/);
    expect(row.bottles).toHaveLength(1);
    expect(row.bottles[0]).toMatchObject({ itemId: "bottle", sourceKey, costAmount: 6000, specialCost: true });
    const report = calculateCastSalesReports([
      { id: "d1", businessDate: value.businessDate, status: "approved", casts: rows, posSnapshot: value } as DailyClosing,
    ], [], "2026-09")[0];
    expect(report.totals.honShimeiLiquorCost).toBe(6000);
    expect(report.totals.jonaiExtensionLiquorCost).toBe(0);
  });

  it("フリー卓のボトルはバック・酒代原価の対象にしない", () => {
    const value = pos();
    value.transactions[0].items = value.transactions[0].items.filter((item) => !item.isHonShimei);
    const bottle = value.transactions[0].items.find((item) => item.itemId === "bottle")!;
    const rows = buildDailyCasts(value, {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});

    expect(rows.every((row) => row.bottles.length === 0 && row.liquorCost === 0)).toBe(true);
    expect(requiresBottleCost(value.transactions[0], bottle, { p1: "c1", p2: "c2" })).toBe(false);
  });

  it("フリー卓でも場内延長後のボトルは対象者へ均等分配する", () => {
    const value = pos();
    value.transactions[0].items = value.transactions[0].items.filter((item) => !item.isHonShimei);
    const extension = value.transactions[0].items.find((item) => item.itemId === "extension")!;
    extension.isBanaiExtension = true;
    extension.banaiExtCastIds = ["p1", "p2"];
    const rows = buildDailyCasts(value, {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});

    expect(rows[0].bottles[0]).toMatchObject({ salesAmount: 15000, costAmount: 5000 });
    expect(rows[1].bottles[0]).toMatchObject({ salesAmount: 15000, costAmount: 5000 });
  });

  it("Firebaseで消えた空配列を復元して経理集計を継続する", () => {
    const snapshot = pos();
    const itemWithoutEmptyArrays = { ...snapshot.transactions[0].items[0] } as Record<string, unknown>;
    delete itemWithoutEmptyArrays.backTargetCastIds;
    delete itemWithoutEmptyArrays.backTargetCastNames;
    delete itemWithoutEmptyArrays.banaiExtCastIds;
    const rows = buildDailyCasts(pos(), {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    const stored = {
      id: "daily_20260902",
      businessDate: "2026-09-02",
      status: "approved",
      casts: rows.map((row, index) => {
        if (index === 0) return row;
        const { bottles: _bottles, ...storedRow } = row;
        return storedRow;
      }),
      staffWork: undefined,
      drivers: undefined,
      expenses: undefined,
      posSnapshot: {
        ...snapshot,
        transactions: [{
          ...snapshot.transactions[0],
          items: [itemWithoutEmptyArrays, ...snapshot.transactions[0].items.slice(1)]
        }]
      }
    } as unknown as DailyClosing;

    const normalized = normalizeDailyClosing(stored);

    expect(normalized.staffWork).toEqual([]);
    expect(normalized.drivers).toEqual([]);
    expect(normalized.expenses).toEqual([]);
    expect(normalized.casts.every((row) => Array.isArray(row.bottles))).toBe(true);
    expect(normalized.casts[0].bottles).toHaveLength(1);
    expect(normalized.casts[1].bottles).toEqual([]);
    expect(normalized.posSnapshot.transactions[0].items[0].backTargetCastIds).toEqual([]);
    expect(normalized.posSnapshot.transactions[0].items[0].backTargetCastNames).toEqual([]);
    expect(normalized.posSnapshot.transactions[0].items[0].banaiExtCastIds).toEqual([]);
    expect(normalized.sales).toEqual({ totalSales: 0, cashSales: 0, cardSales: 0 });
    expect(normalized.cash.difference).toBe(0);
    expect(normalized.integrityIssues).toEqual(expect.arrayContaining([
      "売上データが不完全です。店舗送信データを確認してください。",
      "現金照合データが不完全です。店舗送信データを確認してください。",
    ]));
    expect(() => calculateCastRewards([stored], [], "2026-09")).not.toThrow();
    expect(() => calculateCastRewards([normalized], [], "2026-09")).not.toThrow();
  });

  it("過去データの送迎ドライバー日払い未設定を0円で復元する", () => {
    const stored = {
      businessDate: "2026-09-02",
      sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
      cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
      drivers: [{ driverId: "driver-1", name: "太郎", dailyRate: 10000 }]
    } as DailyClosing;

    expect(normalizeDailyClosing(stored).drivers[0].dailyPayment).toBe(0);
  });

  it("旧日次データの文字列金額・表示値・欠損値を補正し警告する", () => {
    const stored = {
      businessDate: "2026-09-02",
      sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
      cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
      casts: [{
        masterId: "c1", posCastId: "p1", name: "花子", kind: "regular",
        startTime: "20:00", endTime: "00:00", hours: "4時間", hourlyRate: "￥3,000円",
        honShimeiCount: undefined, banaiShimeiCount: "2本", dohanCount: 0, dohanBack: "5,000円",
        honShimeiSales: "100,000円", jonaiExtensionSales: 0, drinkSales: "1,500円",
        bottles: [{ itemId: "b1", name: "ボトル", kind: "champagneWine", quantity: "1本", salesAmount: "30,000円", costAmount: "￥10,000", specialCost: false }],
        liquorCost: "10,000円", beautyAllowance: 0, dailyPayment: 0, advancePayment: undefined, transportFee: "500円",
        introducer: { id: "i1", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: "false", entryAdvisoryEnabled: "true", attendanceAdvisoryFee: "100円", entryAdvisoryFee: "200円" },
      }],
      staffWork: [{ staffId: "s1", name: "スタッフ", kind: "regular", startTime: "20:00", endTime: "02:00", hours: "6時間", hourlyRate: "1,500円", dailyPayment: undefined }],
      expenses: [{ id: "e1", category: "supplies", payee: "備品店", amount: "￥1,200円" }],
    } as unknown as DailyClosing;

    const normalized = normalizeDailyClosing(stored);

    expect(normalized.casts[0]).toMatchObject({
      hours: 4, hourlyRate: 3000, honShimeiCount: 0, banaiShimeiCount: 2,
      dohanBack: 5000, honShimeiSales: 100000, drinkSales: 1500,
      liquorCost: 10000, advancePayment: 0, transportFee: 500,
    });
    expect(normalized.casts[0].bottles[0]).toMatchObject({ quantity: 1, salesAmount: 30000, costAmount: 10000 });
    expect(normalized.casts[0].introducer).toMatchObject({ attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: true, attendanceAdvisoryFee: 100, entryAdvisoryFee: 200 });
    expect(normalized.staffWork[0]).toMatchObject({ hours: 6, hourlyRate: 1500, dailyPayment: 0 });
    expect(normalized.expenses[0].amount).toBe(1200);
    expect(normalized.integrityIssues?.some((issue) => issue.includes("キャスト明細「花子」"))).toBe(true);
    expect(normalized.integrityIssues?.some((issue) => issue.includes("スタッフ勤務「スタッフ」"))).toBe(true);
    expect(normalized.integrityIssues?.some((issue) => issue.includes("経費明細「備品店」"))).toBe(true);
  });

  it("旧日次データの人物ID欠落・重複と名前欠落を警告し、同名別IDは許可する", () => {
    const snapshot = pos();
    const rows = buildDailyCasts(snapshot, {
      p1: { masterId: "c1", name: "同名", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "同名", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    const stored = {
      businessDate: "2026-09-02",
      sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
      cash: { cashSales: 0, cardSales: 0, totalSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000, cashProfit: 0, actualClosingCash: 200000, difference: 0 },
      casts: [rows[0], { ...rows[1], posCastId: rows[0].posCastId }, { ...rows[0], masterId: "", posCastId: "", name: "", kind: "trial" }],
      staffWork: [
        { staffId: "s1", name: "同名スタッフ", kind: "regular", startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 1500, dailyPayment: 0 },
        { staffId: "s1", name: "同名スタッフ", kind: "invalid", startTime: "20:00", endTime: "02:00", hours: 6, hourlyRate: 1500, dailyPayment: 0 },
      ],
      drivers: [
        { driverId: "d1", name: "同名運転手", dailyRate: 10000, dailyPayment: 0 },
        { driverId: "d1", name: "同名運転手", dailyRate: 10000, dailyPayment: 0 },
        { driverId: "", name: "", dailyRate: 10000, dailyPayment: 0 },
      ],
      expenses: [],
    } as unknown as DailyClosing;

    const issues = normalizeDailyClosing(stored).integrityIssues?.join("\n") || "";
    expect(issues).toContain("POSキャストIDが重複");
    expect(issues).toContain("マスターIDがありません");
    expect(issues).toContain("スタッフIDが重複");
    expect(issues).toContain("スタッフ区分が不正");
    expect(issues).toContain("ドライバーIDが重複");
    expect(issues).toContain("名前がありません");
    expect(issues).not.toContain("名前が重複");
  });

  it("Firebaseの月次調整オブジェクトを安全な配列と金額マップへ復元する", () => {
    const normalized = normalizeMonthlyAdjustments({
      month: "2026-09",
      withholdingByCast: { c1: 1234 },
      staffSalesAllowance: undefined,
      staffBottleAllowance: undefined,
      driverRemoteAllowance: undefined,
      fixedExpenses: {
        0: { id: "fixed-1", account: "家賃", amount: 100000 },
      },
      cardFee: undefined,
      legacyBottleClassifications: { valid: "honShimei", excluded: "excluded", invalid: "guess" },
      revision: "3",
    } as unknown as Parameters<typeof normalizeMonthlyAdjustments>[0]);

    expect(normalized.withholdingByCast).toEqual({ c1: 1234 });
    expect(normalized.staffSalesAllowance).toEqual({});
    expect(normalized.fixedExpenses).toEqual([
      { id: "fixed-1", account: "家賃", amount: 100000 },
    ]);
    expect(normalized.cardFee).toBe(0);
    expect(normalized.legacyBottleClassifications).toEqual({ valid: "honShimei", excluded: "excluded" });
    expect(normalized.revision).toBe(3);
  });

  it("POSの派遣区分を売上・商品参照で在籍へ上書きしない", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "dispatch", isTrial: false };
    expect(posCastReferences(value).find((row) => row.id === "p1")?.kind).toBe("dispatch");
  });

  it("勤務記録のない売上・商品参照キャストを日次出勤として作成しない", () => {
    const value = pos();
    value.castSales.push({ castId: "p3", castName: "未出勤", honShimeiSales: 10000, jonaiExtensionSales: 0, drinkSales: 0, totalAttributedSales: 10000 });
    value.transactions[0].items.push({
      ...value.transactions[0].items[0], itemId: "hon-3", castId: "p3", castName: "未出勤",
    });
    const rows = buildDailyCasts(value, {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
      p3: { masterId: "c3", name: "未出勤", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});

    expect(rows.map((row) => row.posCastId)).toEqual(["p1", "p2"]);
  });

  it("体入の日払いはPOS集約hoursではなく出退勤から15分単位で算出する", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "trial", isTrial: true, hours: 99 };
    const rows = buildDailyCasts(value, {
      p1: { masterId: "trial-1", name: "花子", kind: "trial", hourlyRate: 1234 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    const trial = rows.find((row) => row.posCastId === "p1")!;

    expect(trial.hours).toBe(4);
    expect(trial.dailyPayment).toBe(4900);
  });

  it("完全削除された体入を在籍側の逆参照で同月報酬・売上へ統合する", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "trial", isTrial: true };
    const rows = buildDailyCasts(value, {
      p1: {
        masterId: "deleted-trial", name: "花子", kind: "trial", hourlyRate: 3000,
        introducer: { id: "i1", name: "紹介者", feeType: "sales10", attendanceAdvisoryFee: 0, entryAdvisoryFee: 0 },
      },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    const active = {
      id: "active-1", name: "花子", legalName: "", status: "active", hiredAt: "2026-09-10",
      hourlyRates: { "2026-09": 3000 }, convertedFromTrialId: "deleted-trial", note: "", createdAt: "", updatedAt: "",
    } as CastRecord;
    const closing = { id: "d1", businessDate: value.businessDate, status: "approved", casts: rows, posSnapshot: value } as DailyClosing;

    const reward = calculateCastRewards([closing], [active], "2026-09").find((row) => row.id === active.id)!;
    expect(reward).toMatchObject({ trialOnly: false, honShimeiBack: 1000, introducer: { id: "i1" } });
    expect(reward.salesReward).toBeGreaterThan(0);
    const report = calculateCastSalesReports([closing], [active], "2026-09").find((row) => row.id === active.id)!;
    expect(report.name).toBe("花子");
    expect(report.totals.backs.find((back) => back.key === "honShimei")?.amount).toBe(1000);
  });

  it("ボトル・ドリンクの％バックをPOS商品1行ごとに100円未満切捨てする", () => {
    const value = pos();
    const bottle = value.transactions[0].items.find((item) => item.itemId === "bottle")!;
    Object.assign(bottle, { price: 11000, backTargetCastIds: ["p1"], backTargetCastNames: ["花子"], backAllocation: "single" });
    value.transactions[0].items.push({ ...bottle, itemId: "bottle-2" });
    const drink = value.transactions[0].items.find((item) => item.itemId === "drink")!;
    drink.price = 1550;
    value.transactions[0].items.push({ ...drink, itemId: "drink-2" });
    const rows = buildDailyCasts(value, {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 11000, costPrice: 0, createdAt: "", updatedAt: "" }], {});
    const reward = calculateCastRewards([
      { id: "d1", businessDate: value.businessDate, status: "approved", casts: rows, posSnapshot: value } as DailyClosing,
    ], [], "2026-09").find((row) => row.id === "c1")!;

    expect(rows[0].drinkAllocations).toHaveLength(2);
    expect(reward.bottleBack).toBe(5400); // 2,750円→2,700円を2商品分
    expect(reward.drinkBack).toBe(200); // 155円→100円を2商品分
  });

  it("商品1行のバック総額を先に切り捨て、3人へ333円ずつ均等分配する", () => {
    const value = pos();
    const transaction = value.transactions[0];
    transaction.items.push({
      ...transaction.items.find((item) => item.itemId === "hon-2")!,
      itemId: "hon-3",
      castId: "p3",
      castName: "夏子",
    });
    const bottle = transaction.items.find((item) => item.itemId === "bottle")!;
    Object.assign(bottle, {
      price: 2_000,
      quantity: 2,
      backTargetCastIds: ["p1", "p2", "p3"],
      backTargetCastNames: ["花子", "春子", "夏子"],
      backAllocation: "equal",
    });
    const drink = transaction.items.find((item) => item.itemId === "drink")!;
    Object.assign(drink, {
      price: 5_000,
      quantity: 2,
      backTargetCastIds: ["p1", "p2", "p3"],
      backTargetCastNames: ["花子", "春子", "夏子"],
      backAllocation: "equal",
    });
    value.castWork.push({
      castId: "p3", castName: "夏子", castType: "regular", isTrial: false,
      startTime: "20:00", endTime: "00:00", breakMinutes: 0, hours: 4,
    });
    value.castSales.push({
      castId: "p3", castName: "夏子", honShimeiSales: 0,
      jonaiExtensionSales: 0, drinkSales: 0, totalAttributedSales: 0,
    });
    const mapping = {
      p1: { masterId: "c1", name: "花子", kind: "regular" as const, hourlyRate: 3_000 },
      p2: { masterId: "c2", name: "春子", kind: "regular" as const, hourlyRate: 3_000 },
      p3: { masterId: "c3", name: "夏子", kind: "regular" as const, hourlyRate: 3_000 },
    };
    const rows = buildDailyCasts(value, mapping, [{
      id: "l1", kind: "champagneWine", name: "テストシャンパン",
      salePrice: 2_000, costPrice: 0, createdAt: "", updatedAt: "",
    }], {});
    const closing = {
      id: "three-way", businessDate: value.businessDate, status: "approved",
      casts: rows, posSnapshot: value,
    } as DailyClosing;
    const rewards = calculateCastRewards([closing], [], "2026-09");
    const reports = calculateCastSalesReports([closing], [], "2026-09");

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.bottles[0].backAmount)).toEqual([333, 333, 333]);
    expect(rows.map((row) => row.drinkAllocations?.[0].backAmount)).toEqual([333, 333, 333]);
    expect(rewards.map((row) => row.bottleBack)).toEqual([333, 333, 333]);
    expect(rewards.map((row) => row.drinkBack)).toEqual([333, 333, 333]);
    expect(rewards.reduce((sum, row) => sum + row.bottleBack, 0)).toBe(999);
    expect(rewards.reduce((sum, row) => sum + row.drinkBack, 0)).toBe(999);
    expect(reports.map((report) => report.days[0].backs.find((back) => back.key === "bottle")?.amount)).toEqual([333, 333, 333]);
    expect(reports.map((report) => report.days[0].backs.find((back) => back.key === "drink")?.amount)).toEqual([333, 333, 333]);
    rewards.forEach((reward) => expect(reward.hourlyAndBack).toBe(
      reward.hourlyPay + reward.honShimeiBack + reward.banaiShimeiBack
      + reward.dohanBack + reward.bottleBack + reward.drinkBack,
    ));

    // backAmountをまだ保存していない既存日次も、posSnapshotの原本から同じ結果へ再計算する。
    const existingRows = rows.map((row) => ({
      ...row,
      bottles: row.bottles.map(({ backAmount: _backAmount, ...stored }) => stored),
      drinkAllocations: row.drinkAllocations?.map(({
        backAmount: _backAmount,
        sourceKey: _sourceKey,
        ...stored
      }) => stored),
    }));
    const recalculated = calculateCastRewards([{
      id: "existing-pos-snapshot", businessDate: value.businessDate, status: "approved",
      casts: existingRows, posSnapshot: value,
    } as DailyClosing], [], "2026-09");
    expect(recalculated.map((row) => row.bottleBack)).toEqual([333, 333, 333]);
    expect(recalculated.map((row) => row.drinkBack)).toEqual([333, 333, 333]);

    const restored = restoreDailyCastBackMetadata(value, existingRows.map((row, index) => ({
      ...row,
      beautyAllowance: index === 0 ? 500 : 0,
      dailyPayment: index === 0 ? 2_000 : 0,
    })));
    expect(restored.map((row) => row.bottles[0].backAmount)).toEqual([333, 333, 333]);
    expect(restored.map((row) => row.drinkAllocations?.[0].backAmount)).toEqual([333, 333, 333]);
    expect(restored[0]).toMatchObject({ beautyAllowance: 500, dailyPayment: 2_000 });
  });

  it("体入扱いで出力された派遣キャストを日次キャストデータから除外する", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "trial", isTrial: true };
    const rows = buildDailyCasts(value, {
      p1: { masterId: "", name: "花子", kind: "dispatch", hourlyRate: 0 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    expect(rows.map((row) => row.posCastId)).toEqual(["p2"]);
    expect(rows[0].bottles[0]).toMatchObject({ salesAmount: 15000, costAmount: 5000, backAmount: 2500 });
    const reward = calculateCastRewards([{
      id: "dispatch-target", businessDate: value.businessDate, status: "approved",
      casts: rows, posSnapshot: value,
    } as DailyClosing], [], "2026-09")[0];
    // 派遣分の給与データは作らないが、商品バックの分母にはPOS上の全対象者を使う。
    expect(reward.bottleBack).toBe(2500);
  });

  it("体入行は派遣を選ぶと照合完了になり、在籍行では派遣を選べない", () => {
    expect(canMapAsDispatch("trial")).toBe(true);
    expect(canMapAsDispatch("regular")).toBe(false);
    expect(isCastMappingComplete([{ id: "trial-1", name: "派遣A", kind: "trial" }], { "trial-1": "dispatch" })).toBe(true);
    expect(isCastMappingComplete([{ id: "regular-1", name: "在籍A", kind: "regular" }], { "regular-1": "dispatch" })).toBe(false);
  });

  it("派遣キャストだけを対象とするボトルは原価照合を要求しない", () => {
    const value = pos();
    const transaction = value.transactions[0];
    const bottle = transaction.items.find((item) => item.itemId === "bottle")!;
    expect(requiresBottleCost(transaction, bottle, { p1: "dispatch", p2: "dispatch" })).toBe(false);
    expect(requiresBottleCost(transaction, bottle, { p1: "dispatch", p2: "cast-2" })).toBe(true);
  });

  it("時給＋バックと売上報酬を比較する", () => {
    const snapshot = pos();
    const rows = buildDailyCasts(snapshot, { p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 }, p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 } }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    rows.find((row) => row.masterId === "c1")!.beautyAllowance = 500;
    const closing = { id: "d1", businessDate: "2026-09-02", status: "approved", casts: rows, posSnapshot: snapshot } as DailyClosing;
    const rewards = calculateCastRewards([closing], [], "2026-09");
    const salesRewardCast = rewards.find((row) => row.id === "c1")!;
    const hourlyAndBackCast = rewards.find((row) => row.id === "c2")!;
    expect(salesRewardCast.salesRewardBase).toBe(1297500);
    expect(salesRewardCast.salesReward).toBe(778500);
    expect(salesRewardCast.adoptedSystem).toBe("salesReward");
    expect(salesRewardCast.grossPay).toBe(salesRewardCast.adoptedReward + 500);
    expect(hourlyAndBackCast.adoptedSystem).toBe("hourlyAndBack");
    expect(hourlyAndBackCast.adoptedReward).toBe(hourlyAndBackCast.hourlyAndBack);
  });

  it("紹介者の原価引き売上は本指名売上から本指名酒代原価だけを控除する", () => {
    const hon = pos();
    const banai = pos();
    banai.businessDate = "2026-09-03";
    banai.transactions[0].items = banai.transactions[0].items.filter((item) => !item.isHonShimei);
    const extension = banai.transactions[0].items.find((item) => item.itemId === "extension")!;
    extension.isBanaiExtension = true;
    extension.banaiExtCastIds = ["p1", "p2"];
    banai.castSales = banai.castSales.map((row) => ({
      ...row,
      honShimeiSales: 0,
      jonaiExtensionSales: row.castId === "p1" ? 400000 : 0,
      totalAttributedSales: row.castId === "p1" ? 400000 : 0
    }));
    const mapping = {
      p1: { masterId: "c1", name: "花子", kind: "regular" as const, hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular" as const, hourlyRate: 3000 }
    };
    const liquor = [{ id: "l1", kind: "champagneWine" as const, name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }];
    const honRows = buildDailyCasts(hon, mapping, liquor, {});
    const banaiRows = buildDailyCasts(banai, mapping, liquor, {});
    const reward = calculateCastRewards([
      { id: "hon", businessDate: hon.businessDate, status: "approved", casts: honRows, posSnapshot: hon },
      { id: "banai", businessDate: banai.businessDate, status: "approved", casts: banaiRows, posSnapshot: banai }
    ] as DailyClosing[], [], "2026-09").find((row) => row.id === "c1")!;

    expect(reward.honShimeiSales).toBe(1300000);
    expect(reward.jonaiExtensionSales).toBe(400000);
    expect(reward.liquorCost).toBe(10000);
    expect(reward.honShimeiLiquorCost).toBe(5000);
    expect(introducerSalesBase(reward, "sales10")).toBe(1300000);
    expect(introducerSalesBase(reward, "netSales10")).toBe(1295000);
    expect(introducerSalesBase(reward, "higherNetSalesGross10")).toBe(1295000);
  });

  it("キャスト売上を出勤日別に集計し本指名と場内延長の原価を分ける", () => {
    const hon = pos();
    const banai = pos();
    banai.businessDate = "2026-09-03";
    banai.transactions[0].items = banai.transactions[0].items.filter((item) => !item.isHonShimei);
    const extension = banai.transactions[0].items.find((item) => item.itemId === "extension")!;
    extension.isBanaiExtension = true;
    extension.banaiExtCastIds = ["p1", "p2"];
    banai.castSales = banai.castSales.map((row) => ({
      ...row,
      honShimeiSales: 0,
      jonaiExtensionSales: row.castId === "p1" ? 400000 : 0,
      totalAttributedSales: row.castId === "p1" ? 400000 : 0
    }));
    const mapping = {
      p1: { masterId: "c1", name: "花子", kind: "regular" as const, hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular" as const, hourlyRate: 3000 }
    };
    const liquor = [{ id: "l1", kind: "champagneWine" as const, name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }];
    const honRows = buildDailyCasts(hon, mapping, liquor, {}).map((row) => row.posCastId === "p1" ? { ...row, beautyAllowance: 500 } : row);
    const banaiRows = buildDailyCasts(banai, mapping, liquor, {});
    const reports = calculateCastSalesReports([
      { id: "hon", businessDate: hon.businessDate, status: "approved", casts: honRows, posSnapshot: hon },
      { id: "banai", businessDate: banai.businessDate, status: "approved", casts: banaiRows, posSnapshot: banai },
      { id: "pending", businessDate: "2026-09-04", status: "submitted", casts: honRows, posSnapshot: hon }
    ] as DailyClosing[], [], "2026-09");
    const report = reports.find((row) => row.id === "c1")!;

    expect(report.attendanceDays).toBe(2);
    expect(report.days.map((day) => day.businessDate)).toEqual(["2026-09-02", "2026-09-03"]);
    expect(report.days[0]).toMatchObject({
      startTime: "20:00", endTime: "00:07", hours: 4,
      honShimeiSales: 1300000, jonaiExtensionSales: 0,
      honShimeiLiquorCost: 5000, jonaiExtensionLiquorCost: 0,
      beautyAllowance: 500
    });
    expect(report.days[1]).toMatchObject({
      honShimeiSales: 0, jonaiExtensionSales: 400000,
      honShimeiLiquorCost: 0, jonaiExtensionLiquorCost: 5000,
      beautyAllowance: 0
    });
    expect(report.totals).toMatchObject({
      attendanceDays: 2, hours: 8,
      honShimeiSales: 1300000, jonaiExtensionSales: 400000, totalSales: 1700000,
      honShimeiLiquorCost: 5000, jonaiExtensionLiquorCost: 5000, totalLiquorCost: 10000,
      beautyAllowance: 500
    });
    expect(report.totals.bottles).toEqual([{ name: "テストシャンパン", quantity: 2 }]);
    expect(report.days.map((day) => day.bottleBackByKind)).toEqual([
      { keepBottle: 0, champagneWine: 2500 },
      { keepBottle: 0, champagneWine: 2500 },
    ]);
    expect(report.totals.bottleBackByKind).toEqual({ keepBottle: 0, champagneWine: 5000 });
    expect(report.totals.backTotal).toBe(report.totals.backs.reduce((sum, back) => sum + back.amount, 0));
  });

  it("通常ボトルとシャンパンのバックを分離し、体入のみでは両方0にする", () => {
    const source = pos();
    const bottle = source.transactions[0].items.find((item) => item.itemId === "bottle")!;
    source.transactions[0].items.push({ ...bottle, itemId: "keep", label: "テスト通常ボトル", category: "keepBottle", backType: "keepBottle", price: 11000 });
    const mapping = {
      p1: { masterId: "c1", name: "花子", kind: "regular" as const, hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular" as const, hourlyRate: 3000 },
    };
    const bottles = [
      { id: "l1", kind: "champagneWine" as const, name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" },
      { id: "l2", kind: "keepBottle" as const, name: "テスト通常ボトル", salePrice: 11000, costPrice: 3300, createdAt: "", updatedAt: "" },
    ];
    const rows = buildDailyCasts(source, mapping, bottles, {});
    const closing = { id: "mixed", businessDate: source.businessDate, status: "approved", casts: rows, posSnapshot: source } as DailyClosing;
    const result = calculateCastSalesReports([closing], [], "2026-09")[0];
    // (11,000 - 3,300) × 15% = 1,155 → 1,100 → 2人で550円。
    expect(result.days[0].bottleBackByKind).toEqual({ keepBottle: 550, champagneWine: 2500 });
    expect(result.totals.bottleBackByKind).toEqual({ keepBottle: 550, champagneWine: 2500 });
    expect(result.totals.backs.find((back) => back.key === "bottle")?.amount).toBe(3050);
    const trialResult = calculateCastSalesReports([{ ...closing, casts: rows.map((row) => ({ ...row, kind: "trial" })) }], [], "2026-09")[0];
    expect(trialResult.totals.bottleBackByKind).toEqual({ keepBottle: 0, champagneWine: 0 });
  });

  it("過去データに残るフリー卓ボトルをキャスト売上の原価へ含めない", () => {
    const snapshot = pos();
    const mapping = {
      p1: { masterId: "c1", name: "花子", kind: "regular" as const, hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular" as const, hourlyRate: 3000 }
    };
    const liquor = [{ id: "l1", kind: "champagneWine" as const, name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }];
    // 旧ロジックで本指名卓として作られた保存済み明細を再現する。
    const storedRows = buildDailyCasts(snapshot, mapping, liquor, {});
    // POSスナップショット上は本指名も場内延長もないフリー卓へ修正済み。
    snapshot.transactions[0].items = snapshot.transactions[0].items.filter((item) => !item.isHonShimei);
    snapshot.castSales = snapshot.castSales.map((row) => ({
      ...row,
      honShimeiSales: 0,
      totalAttributedSales: 0
    }));
    const report = calculateCastSalesReports([
      { id: "free", businessDate: snapshot.businessDate, status: "approved", casts: storedRows, posSnapshot: snapshot }
    ] as DailyClosing[], [], "2026-09").find((row) => row.id === "c1")!;

    expect(report.totals.totalLiquorCost).toBe(0);
    expect(report.totals.bottles).toEqual([]);
    expect(report.totals.backs.find((back) => back.key === "bottle")?.amount).toBe(0);
    const reward = calculateCastRewards([
      { id: "free", businessDate: snapshot.businessDate, status: "approved", casts: storedRows, posSnapshot: snapshot }
    ] as DailyClosing[], [], "2026-09").find((row) => row.id === "c1")!;
    expect(reward.liquorCost).toBe(0);
    expect(reward.bottleBack).toBe(0);
  });

  it("posSnapshotのない旧ボトルは手動3区分だけを原価・バックへ反映する", () => {
    const dailyRow = buildDailyCasts(pos(), {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {})[0];
    const closing = {
      id: "legacy|closing", businessDate: "2026-09-02", status: "approved", updatedAt: "revision-1", checksum: "checksum-1",
      casts: [{ ...dailyRow, bottles: [
        { itemId: "b1", name: "本指名ボトル", kind: "champagneWine", quantity: 1, salesAmount: 10000, costAmount: 2000, specialCost: false },
        { itemId: "b2", name: "場内延長ボトル", kind: "keepBottle", quantity: 1, salesAmount: 10000, costAmount: 2000, specialCost: false },
        { itemId: "b3", name: "対象外ボトル", kind: "champagneWine", quantity: 1, salesAmount: 100000, costAmount: 50000, specialCost: false },
      ] }],
    } as unknown as DailyClosing;
    const unclassified = findUnclassifiedLegacyBottles([closing], "2026-09");
    expect(unclassified).toHaveLength(3);
    const adjustments = normalizeMonthlyAdjustments({
      month: "2026-09", withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0,
      legacyBottleClassifications: {
        [legacyBottleSourceKey(closing, dailyRow, 0)]: "honShimei",
        [legacyBottleSourceKey(closing, dailyRow, 1)]: "jonaiExtension",
        [legacyBottleSourceKey(closing, dailyRow, 2)]: "excluded",
      },
      revision: 4,
    });

    expect(findUnclassifiedLegacyBottles([closing], "2026-09", adjustments)).toEqual([]);
    const report = calculateCastSalesReports([closing], [], "2026-09", adjustments)[0];
    expect(report.totals).toMatchObject({ honShimeiLiquorCost: 2000, jonaiExtensionLiquorCost: 2000, totalLiquorCost: 4000 });
    expect(report.totals.bottles).toEqual([
      { name: "本指名ボトル", quantity: 1 },
      { name: "場内延長ボトル", quantity: 1 },
    ]);
    expect(report.totals.backs.find((back) => back.key === "bottle")?.amount).toBe(3200);
    const reward = calculateCastRewards([closing], [], "2026-09", adjustments)[0];
    expect(reward.liquorCost).toBe(4000);
    expect(reward.honShimeiLiquorCost).toBe(2000);
    expect(reward.bottleBack).toBe(3200);
  });

  it("旧ボトルsourceKeyは区切り文字で衝突せず、更新後リビジョンには流用されない", () => {
    const row = { posCastId: "cast|1" } as DailyClosing["casts"][number];
    const left = { id: "a|b.", updatedAt: "c", checksum: "sum" } as DailyClosing;
    const right = { id: "a", updatedAt: "b.|c", checksum: "sum" } as DailyClosing;
    expect(legacyBottleSourceKey(left, row, 0)).not.toBe(legacyBottleSourceKey(right, row, 0));
    expect(legacyBottleSourceKey(left, row, 0)).not.toMatch(/[.#$/\[\]]/);

    const dailyRow = buildDailyCasts(pos(), {
      p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 },
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {})[0];
    const closing = { id: "legacy", businessDate: "2026-09-02", status: "approved", updatedAt: "old", checksum: "sum", casts: [dailyRow] } as unknown as DailyClosing;
    const oldKey = legacyBottleSourceKey(closing, dailyRow, 0);
    const adjustments = { legacyBottleClassifications: { [oldKey]: "honShimei" } } as Parameters<typeof findUnclassifiedLegacyBottles>[2];
    closing.updatedAt = "new";

    expect(findUnclassifiedLegacyBottles([closing], "2026-09", adjustments)).toHaveLength(1);
    expect(calculateCastRewards([closing], [], "2026-09", adjustments)[0].liquorCost).toBe(0);
  });

  it("営業終了時点の現金残額を算出する", () => {
    const result = calculateCash({ sales: { totalSales: 100000, cashSales: 60000, cardSales: 40000 }, cashFloat: 200000, expenses: 10000, regularDailyPayments: 5000, trialDailyPayments: 5000, staffDailyPayments: 0, driverDailyPayments: 5000, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 235000 });
    expect(result.expectedClosingCash).toBe(235000);
    expect(result.cashProfit).toBe(35000);
    expect(result.difference).toBe(0);
  });

  it("送迎ドライバー給与から日払いを控除する", () => {
    const closings = [{ drivers: [{ driverId: "driver-1", name: "太郎", dailyRate: 10000, dailyPayment: 6000 }] }] as DailyClosing[];
    expect(calculateDriverPayroll(closings, { "driver-1": 2000 })).toEqual([{
      id: "driver-1", name: "太郎", days: 1, basic: 10000, remote: 2000,
      gross: 12000, dailyPayment: 6000, net: 6000
    }]);
  });
});

describe("POS schemaVersion 3", () => {
  it("SHA-256を検証して取り込む", async () => {
    const value = await signedPos(pos()) as unknown as Record<string, unknown>;
    await expect(parsePosClosingV3(value)).resolves.toMatchObject({ schemaVersion: 3, submissionId: "submission-1" });
    (value.sales as { totalSales: number }).totalSales = 99999;
    await expect(parsePosClosingV3(value)).rejects.toThrow("チェックサム");
  });

  it("フリー卓の有償ボトルはバック対象なしで取り込める", async () => {
    const value = pos();
    value.transactions[0].items = value.transactions[0].items
      .filter((item) => !item.isHonShimei)
      .map((item) => item.itemId === "bottle" ? {
        ...item,
        backTargetCastIds: [],
        backTargetCastNames: [],
        backType: undefined,
        backAllocation: undefined
      } : item);
    value.checksum = await sha256Checksum(value as unknown as Record<string, unknown>);

    await expect(parsePosClosingV3(value)).resolves.toMatchObject({ schemaVersion: 3 });
  });

  it("フリー卓のボトルにバック対象がある不正データは拒否する", async () => {
    const value = pos();
    value.transactions[0].items = value.transactions[0].items.filter((item) => !item.isHonShimei);
    value.checksum = await sha256Checksum(value as unknown as Record<string, unknown>);

    await expect(parsePosClosingV3(value)).rejects.toThrow("本指名・場内延長対象外");
  });

  it("実在しない営業日と必須配列欠落を安全に拒否する", async () => {
    const invalidDate = pos();
    invalidDate.businessDate = "2026-02-30";
    await signedPos(invalidDate);
    await expect(parsePosClosingV3(invalidDate)).rejects.toThrow("営業日が実在しない");

    const missingItems = pos() as unknown as Record<string, unknown>;
    delete ((missingItems.transactions as Record<string, unknown>[])[0]).items;
    missingItems.checksum = await sha256Checksum(missingItems);
    await expect(parsePosClosingV3(missingItems)).rejects.toThrow("items");

    const missingItemArray = pos() as unknown as Record<string, unknown>;
    delete ((((missingItemArray.transactions as Record<string, unknown>[])[0]).items as Record<string, unknown>[])[0]).backTargetCastIds;
    missingItemArray.checksum = await sha256Checksum(missingItemArray);
    await expect(parsePosClosingV3(missingItemArray)).rejects.toThrow("backTargetCastIds");

    const missingRootArray = pos() as unknown as Record<string, unknown>;
    delete missingRootArray.lifecycleEvents;
    missingRootArray.checksum = await sha256Checksum(missingRootArray);
    await expect(parsePosClosingV3(missingRootArray)).rejects.toThrow("lifecycleEvents");
  });

  it("金額・時刻・数量の非数値、負数、ボトル数量0を拒否する", async () => {
    const numericString = pos() as unknown as Record<string, unknown>;
    ((numericString.sales as Record<string, unknown>).totalSales) = "100000";
    numericString.checksum = await sha256Checksum(numericString);
    await expect(parsePosClosingV3(numericString)).rejects.toThrow("総売上は有限の数値");

    const negative = pos();
    negative.castSales[0].drinkSales = -1;
    await signedPos(negative);
    await expect(parsePosClosingV3(negative)).rejects.toThrow("0以上");

    const invalidTime = pos();
    invalidTime.transactions[0].startTime = Number.NaN;
    await signedPos(invalidTime);
    await expect(parsePosClosingV3(invalidTime)).rejects.toThrow("有限の数値");

    const zeroBottle = pos();
    zeroBottle.transactions[0].items.find((item) => item.itemId === "bottle")!.quantity = 0;
    await signedPos(zeroBottle);
    await expect(parsePosClosingV3(zeroBottle)).rejects.toThrow("0より大きい");
  });

  it("会計合計と決済方法別合計の不一致を拒否する", async () => {
    const transactionMismatch = pos();
    transactionMismatch.sales.totalSales = 100100;
    transactionMismatch.sales.cashSales = 60100;
    await signedPos(transactionMismatch);
    await expect(parsePosClosingV3(transactionMismatch)).rejects.toThrow("会計データの合計と総売上");

    const paymentMismatch = pos();
    paymentMismatch.transactions[0].splits = [{ method: "cash", amount: 50000 }, { method: "card", amount: 50000 }];
    await signedPos(paymentMismatch);
    await expect(parsePosClosingV3(paymentMismatch)).rejects.toThrow("現金の決済内訳合計");
  });

  it("キャストID重複・未出勤売上・対象ID重複を拒否する", async () => {
    const duplicateWork = pos();
    duplicateWork.castWork.push({ ...duplicateWork.castWork[0] });
    await signedPos(duplicateWork);
    await expect(parsePosClosingV3(duplicateWork)).rejects.toThrow("キャスト勤務ID");

    const duplicateSales = pos();
    duplicateSales.castSales.push({ ...duplicateSales.castSales[0] });
    await signedPos(duplicateSales);
    await expect(parsePosClosingV3(duplicateSales)).rejects.toThrow("キャスト売上ID");

    const salesWithoutWork = pos();
    salesWithoutWork.castSales.push({ castId: "p3", castName: "未出勤", honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, totalAttributedSales: 0 });
    await signedPos(salesWithoutWork);
    await expect(parsePosClosingV3(salesWithoutWork)).rejects.toThrow("勤務記録のないキャスト");

    const duplicateTarget = pos();
    const bottle = duplicateTarget.transactions[0].items.find((item) => item.itemId === "bottle")!;
    bottle.backTargetCastIds = ["p1", "p1"];
    bottle.backTargetCastNames = ["花子", "花子"];
    await signedPos(duplicateTarget);
    await expect(parsePosClosingV3(duplicateTarget)).rejects.toThrow("重複したID");
  });

  it("同一キャストIDの名前が勤務・売上・商品間で異なるデータを拒否する", async () => {
    const salesNameMismatch = pos();
    salesNameMismatch.castSales[0].castName = "別人";
    await signedPos(salesNameMismatch);
    await expect(parsePosClosingV3(salesNameMismatch)).rejects.toThrow("IDと名前が勤務記録に一致");

    const targetNameMismatch = pos();
    const bottle = targetNameMismatch.transactions[0].items.find((item) => item.itemId === "bottle")!;
    bottle.backTargetCastNames[0] = "別人";
    await signedPos(targetNameMismatch);
    await expect(parsePosClosingV3(targetNameMismatch)).rejects.toThrow("バック対象IDと名前");
  });
});
