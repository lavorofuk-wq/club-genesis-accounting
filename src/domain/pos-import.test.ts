import { describe, expect, it } from "vitest";
import { closingChecksum, parsePosClosing, previewRoster } from "./pos-import";

function payload() {
  const value = {
    schema: "club-genesis-pos-closing",
    schemaVersion: 2,
    submissionId: "closing_2026-07-31_001",
    generatedAt: "2026-07-31T12:00:00.000Z",
    businessDate: "2026-07-31",
    sales: { totalSales: 120000, cashSales: 70000, cardSales: 50000 },
    customers: { groupCount: 4, totalCustomers: 8 },
    nominations: { honShimeiCount: 2, jonaiCount: 1 },
    expenses: [],
    allowances: [],
    transactions: [],
    castSales: [],
    castWork: [],
    trialWork: [],
    staffWork: [],
    rosterSnapshot: {
      complete: true,
      capturedAt: "2026-07-31T11:59:00.000Z",
      casts: [{ castId: "pos-1", name: "あい", internalNo: 1, status: "active" }]
    },
    lifecycleEvents: []
  };
  return { ...value, checksum: closingChecksum(value) };
}

describe("POS JSON import", () => {
  it("schemaVersion 2とチェックサムを検証する", () => {
    const closing = parsePosClosing(payload());
    expect(closing.submissionId).toBe("closing_2026-07-31_001");
    expect(closing.rosterSnapshot?.casts[0].castId).toBe("pos-1");
  });

  it("改変されたJSONを拒否する", () => {
    const input = { ...payload(), sales: { totalSales: 1, cashSales: 1, cardSales: 0 } };
    expect(() => parsePosClosing(input)).toThrow("チェックサム");
  });

  it("GMSだけに残る在籍者を自動退店せずブロックする", () => {
    const preview = previewRoster(parsePosClosing(payload()), [{
      id: "member-2",
      posCastId: "pos-2",
      name: "ゆい",
      internalNo: 2,
      status: "active"
    }]);
    expect(preview.differences.some((item) => item.kind === "missing-local" && item.blocking)).toBe(true);
    expect(preview.newCount).toBe(1);
  });

  it("schemaVersion 1の参照キャストと入退店配列を変換する", () => {
    const value = {
      schema: "club-genesis-pos-closing",
      schemaVersion: 1,
      businessDate: "2026-06-30",
      sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
      customers: { groupCount: 0, totalCustomers: 0 },
      nominations: {},
      expenses: [],
      allowances: [],
      transactions: [],
      castSales: [],
      castWork: [{ castId: "legacy-1", castName: "旧名", internalNo: 9, hours: 4 }],
      staffWork: [],
      enteredCasts: [{ castId: "legacy-1", castName: "旧名" }]
    };
    const closing = parsePosClosing({ ...value, checksum: closingChecksum(value) });
    const preview = previewRoster(closing, []);
    expect(closing.lifecycleEvents[0].eventType).toBe("entered");
    expect(preview.differences[0]).toMatchObject({
      kind: "new",
      sourceCastId: "legacy-1",
      sourceInternalNo: 9
    });
  });
});
