import { describe, expect, it } from "vitest";
import { calculateCastSales, hoursBetween } from "./closing-calculation";
import type { PosClosing } from "./types";

const closing = (transactions: PosClosing["transactions"]): PosClosing => ({
  schema: "club-genesis-pos-closing",
  schemaVersion: 2,
  submissionId: "test",
  checksum: "test",
  businessDate: "2026-07-31",
  sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
  customers: { groupCount: 0, totalCustomers: 0 },
  nominations: {},
  expenses: [],
  allowances: [],
  transactions,
  castSales: [],
  castWork: [],
  trialWork: [],
  staffWork: [],
  lifecycleEvents: []
});

describe("締め売上計算", () => {
  it("本指名テーブルの小計を本指名キャストへ均等配分する", () => {
    const rows = calculateCastSales(closing([{
      subtotal: 10_001,
      items: [
        { isHonShimei: true, castId: "a", castName: "A" },
        { isHonShimei: true, castId: "b", castName: "B" }
      ]
    }]));
    expect(rows.map((row) => row.honShimeiSales)).toEqual([5_000, 5_000]);
  });

  it("オールフリーだけ場内延長以降の明細を配分する", () => {
    const rows = calculateCastSales(closing([{
      subtotal: 12_000,
      items: [
        { isSet: true, price: 5_000, quantity: 1 },
        { isBanaiExtension: true, banaiExtCastIds: ["a", "b"], price: 3_000, quantity: 1 },
        { label: "追加", price: 1_000, quantity: 1 }
      ]
    }]));
    expect(rows.map((row) => row.jonaiExtensionSales)).toEqual([2_000, 2_000]);
  });

  it("本指名テーブルでは場内延長へ売上配分しない", () => {
    const rows = calculateCastSales(closing([{
      subtotal: 10_000,
      items: [
        { isHonShimei: true, castId: "a", castName: "A" },
        { isBanaiExtension: true, banaiExtCastIds: ["b"], price: 3_000, quantity: 1 }
      ]
    }]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ castId: "a", honShimeiSales: 10_000, jonaiExtensionSales: 0 });
  });

  it("日跨ぎの勤務時間を計算する", () => {
    expect(hoursBetween("20:00", "02:00")).toBe(6);
  });
});
