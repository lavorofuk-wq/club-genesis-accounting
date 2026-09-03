import { describe, expect, it } from "vitest";
import {
  buildDailyCasts,
  calculateCash,
  calculateCastRewards,
  canMapAsDispatch,
  floorHundred,
  hoursBetweenQuarter,
  isCastMappingComplete,
  normalizeDailyClosing,
  normalizeMonthlyAdjustments,
  parsePosClosingV3,
  posCastReferences,
  requiresBottleCost,
  rewardRateForSales,
  sha256Checksum,
  type DailyClosing,
  type PosClosingV3
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
      transactionId: "tx1", tableId: "1", tableLabel: "1", startTime: new Date("2026-09-02T20:30:00+09:00").getTime(), endTime: new Date("2026-09-03T00:30:00+09:00").getTime(), payMethod: "cash", splits: [{ method: "cash", amount: 100000 }], subtotal: 100000, discount: 0, tax: 0, total: 100000,
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
    submissionId: "submission-1", generatedAt: "2026-09-03T03:00:00+09:00", checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "0".repeat(64)
  };
}

describe("GMS報酬・日次計算", () => {
  it("100円未満と15分未満を切り捨てる", () => {
    expect(floorHundred(1234)).toBe(1200);
    expect(hoursBetweenQuarter("20:00", "02:07")).toBe(6);
  });

  it("売上報酬率の境界を正しく判定する", () => {
    expect(rewardRateForSales(1209999)).toBe(0);
    expect(rewardRateForSales(1210000)).toBe(0.6);
    expect(rewardRateForSales(2510000)).toBe(0.65);
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
    } as unknown as Parameters<typeof normalizeMonthlyAdjustments>[0]);

    expect(normalized.withholdingByCast).toEqual({ c1: 1234 });
    expect(normalized.staffSalesAllowance).toEqual({});
    expect(normalized.fixedExpenses).toEqual([
      { id: "fixed-1", account: "家賃", amount: 100000 },
    ]);
    expect(normalized.cardFee).toBe(0);
  });

  it("POSの派遣区分を売上・商品参照で在籍へ上書きしない", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "dispatch", isTrial: false };
    expect(posCastReferences(value).find((row) => row.id === "p1")?.kind).toBe("dispatch");
  });

  it("体入扱いで出力された派遣キャストを日次キャストデータから除外する", () => {
    const value = pos();
    value.castWork[0] = { ...value.castWork[0], castType: "trial", isTrial: true };
    const rows = buildDailyCasts(value, {
      p1: { masterId: "", name: "花子", kind: "dispatch", hourlyRate: 0 },
      p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 }
    }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    expect(rows.map((row) => row.posCastId)).toEqual(["p2"]);
    expect(rows[0].bottles[0]).toMatchObject({ salesAmount: 15000, costAmount: 5000 });
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
    const rows = buildDailyCasts(pos(), { p1: { masterId: "c1", name: "花子", kind: "regular", hourlyRate: 3000 }, p2: { masterId: "c2", name: "春子", kind: "regular", hourlyRate: 3000 } }, [{ id: "l1", kind: "champagneWine", name: "テストシャンパン", salePrice: 30000, costPrice: 10000, createdAt: "", updatedAt: "" }], {});
    const closing = { id: "d1", businessDate: "2026-09-02", status: "approved", casts: rows } as DailyClosing;
    const rewards = calculateCastRewards([closing], [], "2026-09");
    expect(rewards[0].salesRewardBase).toBe(1297500);
    expect(rewards[0].salesReward).toBe(778500);
    expect(rewards[0].adoptedSystem).toBe("salesReward");
  });

  it("営業終了時点の現金残額を算出する", () => {
    const result = calculateCash({ sales: { totalSales: 100000, cashSales: 60000, cardSales: 40000 }, cashFloat: 200000, expenses: 10000, regularDailyPayments: 5000, trialDailyPayments: 5000, staffDailyPayments: 0, dispatchCastPayment: 0, dispatchStaffPayment: 0, dispatchFee: 0, actualClosingCash: 240000 });
    expect(result.expectedClosingCash).toBe(240000);
    expect(result.cashProfit).toBe(40000);
    expect(result.difference).toBe(0);
  });
});

describe("POS schemaVersion 3", () => {
  it("SHA-256を検証して取り込む", async () => {
    const value = pos() as unknown as Record<string, unknown>;
    value.checksum = await sha256Checksum(value);
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
});
