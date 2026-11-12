import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DailyClosing } from "@/domain/gms";

type Constraint = { type: "order" | "start" | "end"; value: string };
type Query = { path: string; constraints: Constraint[] };
const memory = vi.hoisted(() => ({ values: {} as Record<string, DailyClosing>, get: vi.fn(), query: vi.fn(), rootRef: vi.fn() }));
vi.mock("firebase/database", () => ({
  get: memory.get, query: memory.query,
  orderByChild: (value: string): Constraint => ({ type: "order", value }),
  startAt: (value: string): Constraint => ({ type: "start", value }),
  endAt: (value: string): Constraint => ({ type: "end", value }),
}));
vi.mock("./client", () => ({ rootRef: memory.rootRef }));
import { readWorkAllowanceClosings } from "./work-allowance-sources";

const closing = (businessDate: string, status: DailyClosing["status"] = "approved") => ({
  id: "stale-stored-id", businessDate, status, checksum: "a".repeat(64), submissionId: "test",
  sales: { totalSales: 0, cashSales: 0, cardSales: 0 },
  cash: { totalSales: 0, cashSales: 0, cardSales: 0, cashFloat: 200000, expenseAndPaymentTotal: 0,
    expectedClosingCash: 200000, actualClosingCash: 200000, cashProfit: 0, difference: 0 },
  casts: [], staffWork: [], drivers: [], expenses: [],
} as unknown as DailyClosing);

beforeEach(() => {
  vi.clearAllMocks(); memory.values = {};
  memory.rootRef.mockImplementation((path: string) => ({ path }));
  memory.query.mockImplementation((reference: { path: string }, ...constraints: Constraint[]) => ({ ...reference, constraints }));
  memory.get.mockImplementation(async ({ path, constraints }: Query) => {
    expect(path).toBe("history");
    expect(constraints.find((row) => row.type === "order")?.value).toBe("businessDate");
    const start = constraints.find((row) => row.type === "start")!.value;
    const end = constraints.find((row) => row.type === "end")!.value;
    const selected = Object.fromEntries(Object.entries(memory.values)
      .filter(([, row]) => row.businessDate >= start && row.businessDate <= end));
    return { val: () => structuredClone(selected) };
  });
});

describe("送迎・美容室の月限定日次読取", () => {
  it("月の両端を含め、前月・翌月・ID形式に依存せず対象月だけ取得する", async () => {
    memory.values = {
      before: closing("2026-09-30"), noncanonical_first: closing("2026-10-01"),
      noncanonical_last: closing("2026-10-31"), after: closing("2026-11-01"),
    };
    const rows = await readWorkAllowanceClosings("2026-10");
    expect(rows.map((row) => row.id)).toEqual(["noncanonical_first", "noncanonical_last"]);
    expect(rows.map((row) => row.businessDate)).toEqual(["2026-10-01", "2026-10-31"]);
    expect(memory.get).toHaveBeenCalledTimes(1);
    expect(memory.query).toHaveBeenCalledWith({ path: "history" }, { type: "order", value: "businessDate" },
      { type: "start", value: "2026-10-01" }, { type: "end", value: "2026-10-31" });
  });

  it("差戻し・取下げ・未承認も除外せず、旧額の訂正根拠を残す", async () => {
    const statuses: DailyClosing["status"][] = ["submitted", "approved", "returned", "withdrawn"];
    memory.values = Object.fromEntries(statuses.map((status) => [status, closing("2026-10-02", status)]));
    expect((await readWorkAllowanceClosings("2026-10")).map((row) => row.status)).toEqual(statuses);
  });

  it.each(["2026-01", "2026-12", "2024-02"])("%sの月範囲を時差や年境界によらず指定する", async (month) => {
    memory.values = { first: closing(month + "-01"), leap: closing(month + "-29") };
    expect(await readWorkAllowanceClosings(month)).toHaveLength(2);
    expect(memory.query.mock.calls[0].slice(1)).toEqual([
      { type: "order", value: "businessDate" }, { type: "start", value: month + "-01" }, { type: "end", value: month + "-31" },
    ]);
  });

  it("Firebaseで欠落する空配列を日次と同じ読取境界で復元する", async () => {
    const row = closing("2026-10-02");
    delete (row as Partial<DailyClosing>).casts;
    delete (row as Partial<DailyClosing>).drivers;
    memory.values = { legacy: row };
    const [result] = await readWorkAllowanceClosings("2026-10");
    expect(result.casts).toEqual([]);
    expect(result.drivers).toEqual([]);
    expect(result.id).toBe("legacy");
  });

  it("記録がなければ空配列を返す", async () => {
    memory.get.mockResolvedValueOnce({ val: () => null });
    expect(await readWorkAllowanceClosings("2026-10")).toEqual([]);
  });

  it.each(["", "2026-00", "2026-13", "2026-1", "2026-10-01", "../history"])("不正な月%sでは通信しない", async (month) => {
    await expect(readWorkAllowanceClosings(month)).rejects.toThrow("対象月");
    expect(memory.rootRef).not.toHaveBeenCalled();
    expect(memory.get).not.toHaveBeenCalled();
  });

  it("権限・通信エラーを空データに置き換えず呼出元へ返す", async () => {
    const failure = new Error("PERMISSION_DENIED");
    memory.get.mockRejectedValueOnce(failure);
    await expect(readWorkAllowanceClosings("2026-10")).rejects.toBe(failure);
  });
});
