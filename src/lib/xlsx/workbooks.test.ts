import { describe, expect, it } from "vitest";
import type { FinalizedClosing } from "@/domain/types";
import {
  createCastMonthlyWorkbook,
  createCastStatementsWorkbook,
  createExpenseWorkbook,
  createFinalizedWorkbook
} from "./workbooks";

const closing: FinalizedClosing = {
  id: "closing-1",
  schema: "club-genesis-pos-closing",
  schemaVersion: 2,
  submissionId: "submission-1",
  checksum: "abc",
  businessDate: "2026-07-15",
  status: "finalized",
  sales: { totalSales: 100000, cashSales: 60000, cardSales: 40000 },
  customers: { groupCount: 3, totalCustomers: 6 },
  nominations: { honShimeiCount: 1, jonaiCount: 1 },
  expenses: [{ category: "酒代", amount: 5000 }],
  allowances: [{ amount: 1000 }],
  transactions: [],
  castSales: [{ castId: "pos-1", castName: "あい", honShimeiSales: 50000, totalAttributedSales: 50000 }],
  castWork: [{ castId: "pos-1", castName: "あい", hours: 5 }],
  trialWork: [],
  staffWork: [],
  lifecycleEvents: []
};

const casts = [{
  id: "member-1",
  personKey: "person-1",
  posCastId: "pos-1",
  name: "あい",
  internalNo: 1,
  status: "active" as const,
  guaranteedHourlyRate: 3000
}];

describe("preserved XLSX outputs", () => {
  it("確定データ収支表を生成する", () => {
    const book = createFinalizedWorkbook([closing], "2026-07");
    const sheet = book.getWorksheet("ジェネシス収支表")!;
    expect(sheet.getCell("B17").value).toBe(100000);
    expect(sheet.getCell("J17").value).toBe(94000);
  });

  it("経費表を生成する", () => {
    const book = createExpenseWorkbook([closing], [], "2026-07");
    const sheet = book.getWorksheet("ジェネシス経費表")!;
    expect(sheet.getCell("B17").value).toBe("酒代");
    expect(sheet.getCell("C17").value).toBe(5000);
  });

  it("明細書と月次報酬表を生成する", () => {
    const statements = createCastStatementsWorkbook([closing], casts, "2026-07");
    const monthly = createCastMonthlyWorkbook([closing], casts, "2026-07");
    expect(statements.worksheets).toHaveLength(1);
    expect(statements.worksheets[0].getCell("B12").value).toBe(15000);
    expect(monthly.getWorksheet("目次")).toBeTruthy();
    expect(monthly.worksheets).toHaveLength(2);
  });

  it("4種類すべてを実際のXLSXバイナリへ変換できる", async () => {
    const books = [
      createFinalizedWorkbook([closing], "2026-07"),
      createExpenseWorkbook([closing], [], "2026-07"),
      createCastStatementsWorkbook([closing], casts, "2026-07"),
      createCastMonthlyWorkbook([closing], casts, "2026-07")
    ];
    books.forEach((book) => expect(book.creator).toBe("GENESIS Management System Ver2.15.0"));
    const buffers = await Promise.all(books.map((book) => book.xlsx.writeBuffer()));
    buffers.forEach((buffer) => {
      expect(buffer.byteLength).toBeGreaterThan(1_000);
      expect(new Uint8Array(buffer).slice(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
    });
  });

  it("帳票のタイトル・見出し・本文をBIZ UDPゴシックへ統一する", () => {
    const sheet = createFinalizedWorkbook([closing], "2026-07").getWorksheet("ジェネシス収支表")!;
    expect(sheet.getCell("A1").font.name).toBe("BIZ UDPGothic");
    expect(sheet.getCell("A2").font.name).toBe("BIZ UDPGothic");
    expect(sheet.getCell("A3").font.name).toBe("BIZ UDPGothic");
  });
});
