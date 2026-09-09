import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { DailyCast, DailyClosing, DailyStaffWork } from "@/domain/gms";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  get: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
}));

vi.mock("firebase/database", () => ({
  get: memory.get,
  ref: (_database: unknown, path: string) => ({ path }),
  serverTimestamp: () => Date.now(),
  onValue: (_reference: unknown, callback: (snapshot: { val: () => number }) => void) => {
    callback({ val: () => 0 }); return () => undefined;
  }, set: vi.fn(), update: memory.update,
}));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/domain/gms", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/domain/gms")>(),
  // POS原本の検証は専用テストに任せ、ここではrepositoryの金額・再送検証を実行する。
  parsePosClosingV3: vi.fn().mockResolvedValue(undefined),
}));

import { submitClosing } from "./repository";

const user = { uid: "test-shop" } as User;
const timestamp = "2026-09-09T12:00:00.000Z";
const id = "daily_20260909";
const path = `history/${id}`;

function staff(payment: number, overrides: Partial<DailyStaffWork> = {}): DailyStaffWork {
  return { staffId: "staff-1", name: "体入スタッフ", kind: "trial", startTime: "20:00", endTime: "21:15",
    hours: 1.25, hourlyRate: 1203, dailyPayment: payment, ...overrides };
}

function fixture(payment: number): DailyClosing {
  const sales = { totalSales: 10000, cashSales: 10000, cardSales: 0 };
  const customers = { groupCount: 0, totalCustomers: 0 };
  const nominations = { honShimeiCount: 0, jonaiCount: 0 };
  const expectedClosingCash = sales.cashSales + 200000 - payment;
  return {
    id, businessDate: "2026-09-09", status: "submitted", submissionId: "submission-1", checksum: "a".repeat(64),
    updatedAt: timestamp, sales, customers, nominations, casts: [], staffWork: [staff(payment)], drivers: [], expenses: [],
    staffDailyPaymentTotal: payment, dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { ...sales, cashFloat: 200000, expenseAndPaymentTotal: payment, expectedClosingCash,
      actualClosingCash: expectedClosingCash, cashProfit: expectedClosingCash - 200000, difference: 0,
      funding: { schema: 2, previousClosingId: "", previousBusinessDate: "", previousClosingCash: 200000,
        openingShortfall: 0, openingPersonalDebt: 0, companyReplenishment: 0, personalReplenishment: 0,
        companyTransfer: 0, personalRepayment: 0, closingPersonalDebt: 0, confirmed: true } },
    posSnapshot: { schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: "2026-09-09", status: "closed",
      submissionId: "submission-1", checksum: "a".repeat(64), generatedAt: timestamp,
      checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1",
      sales, customers, nominations, transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
      rosterSnapshot: { complete: true, capturedAt: timestamp, casts: [] }, lifecycleEvents: [] },
  };
}

function saved(payment = 1500): DailyClosing {
  return { ...fixture(payment), status: "returned" };
}

beforeEach(() => {
  memory.values.clear();
  vi.clearAllMocks();
  memory.values.set("users/test-shop/role", "shop");
  memory.get.mockImplementation(async (reference: { path: string }) => ({
    val: () => structuredClone(memory.values.get(reference.path) ?? null),
    exists: () => memory.values.has(reference.path),
  }));
  memory.transaction.mockImplementation(async (reference: { path: string }, callback: (value: unknown) => unknown) => {
    const value = callback(structuredClone(memory.values.get(reference.path) ?? null));
    if (value !== undefined) memory.values.set(reference.path, structuredClone(value));
    return { committed: value !== undefined, snapshot: { val: () => value } };
  });
  memory.update.mockImplementation(async (_reference: unknown, plan: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(plan)) memory.values.set(path, structuredClone(value));
  });
});

describe("体入スタッフの日別1円給与と既存実支払の送信検証", () => {
  it("新規送信は当日1203円×1.25時間の1円未満切捨て1503円を許可する", async () => {
    const value = fixture(1503);
    await submitClosing(value, user);
    expect(memory.values.get(path)).toMatchObject({ status: "submitted", staffDailyPaymentTotal: 1503,
      staffWork: [staff(1503)], cash: value.cash });
  });

  it.each([1500, 1501, 1503.75, 1504])("新規送信の給与全額と異なる日払い%s円を拒否する", async (payment) => {
    await expect(submitClosing(fixture(payment), user)).rejects.toThrow("体入給与は当日の基本給与全額を日払いにしてください。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });

  it("再送ではサーバーに保存された旧1500円の実支払額と現金照合を維持できる", async () => {
    const before = saved();
    memory.values.set(path, before);
    const value = fixture(1500);
    await submitClosing(value, user, timestamp);
    expect(memory.get).toHaveBeenCalledWith({ path });
    expect(memory.values.get(path)).toMatchObject({ staffDailyPaymentTotal: 1500, staffWork: before.staffWork, cash: before.cash });
    expect(before).toEqual(saved());
  });

  it("勤務時間を修正しても、同じスタッフの既支払実額はそのまま維持できる", async () => {
    memory.values.set(path, saved());
    const value = fixture(1500);
    value.staffWork[0].hours = 1.5;
    value.staffWork[0].endTime = "21:30";
    await submitClosing(value, user, timestamp);
    expect(memory.values.get(path)).toMatchObject({ staffWork: [{ hours: 1.5, dailyPayment: 1500 }] });
  });

  it("Firebaseが旧勤務配列をオブジェクトで返しても保存済み実額を維持する", async () => {
    const before = saved();
    memory.values.set(path, { ...before, staffWork: { 0: before.staffWork[0] } });
    await submitClosing(fixture(1500), user, timestamp);
    expect(memory.values.get(path)).toMatchObject({ staffDailyPaymentTotal: 1500, staffWork: before.staffWork, cash: before.cash });
  });

  it("再送の値が旧実支払額とも新しい給与全額とも異なる場合は拒否する", async () => {
    const before = saved();
    memory.values.set(path, before);
    await expect(submitClosing(fixture(1501), user, timestamp)).rejects.toThrow("体入給与は当日の基本給与全額を日払いにしてください。");
    expect(memory.values.get(path)).toEqual(before);
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });

  it("クライアント側が旧額を主張してもサーバーの保存実額と異なれば拒否する", async () => {
    memory.values.set(path, saved(1400));
    await expect(submitClosing(fixture(1500), user, timestamp)).rejects.toThrow("体入給与は当日の基本給与全額を日払いにしてください。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });

  it.each([
    { staffId: "other-staff" },
    { kind: "regular" as const },
  ])("別スタッフ・別区分の保存実額を流用しない %#", async (override) => {
    const before = saved();
    before.staffWork[0] = { ...before.staffWork[0], ...override };
    memory.values.set(path, before);
    await expect(submitClosing(fixture(1500), user, timestamp)).rejects.toThrow("体入給与は当日の基本給与全額を日払いにしてください。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });

  it("同一IDの保存済み体入スタッフが重複する場合は旧額を推測して採用しない", async () => {
    const before = saved();
    before.staffWork.push({ ...before.staffWork[0] });
    memory.values.set(path, before);
    await expect(submitClosing(fixture(1500), user, timestamp)).rejects.toThrow("体入給与は当日の基本給与全額を日払いにしてください。");
  });

  it("他端末で更新された日次は旧実額を保持していても上書きしない", async () => {
    memory.values.set(path, { ...saved(), updatedAt: "2026-09-09T13:00:00.000Z" });
    await expect(submitClosing(fixture(1500), user, timestamp)).rejects.toThrow("別の端末で更新されています。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });

  it("日払いだけ変更して現金照合が不整合なデータを保存しない", async () => {
    const value = fixture(1503);
    value.cash = fixture(1500).cash;
    await expect(submitClosing(value, user)).rejects.toThrow("合計が現金照合と一致しません。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });
});

describe("体入キャスト日払いの1円送信", () => {
  function castFixture(payment: number): DailyClosing {
    const value = fixture(payment);
    const row: DailyCast = { masterId: "cast-1", posCastId: "pos-cast-1", name: "体入キャスト", kind: "trial",
      startTime: "20:00", endTime: "21:15", hours: 1.25, hourlyRate: 1203,
      honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0, honShimeiSales: 0,
      jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
      beautyAllowance: 0, dailyPayment: payment, advancePayment: 0, transportFee: 0 };
    value.staffWork = [];
    value.staffDailyPaymentTotal = 0;
    value.casts = [row];
    value.posSnapshot.castWork = [{ castId: row.posCastId, castName: row.name, castType: "trial",
      startTime: row.startTime, endTime: row.endTime, hours: row.hours, isTrial: true, breakMinutes: 0 }];
    return value;
  }

  it("体入キャストの1503円日払いを10円へ丸めず保存する", async () => {
    const value = castFixture(1503);
    await submitClosing(value, user);
    expect(memory.values.get(path)).toMatchObject({ casts: [{ dailyPayment: 1503 }], cash: value.cash });
  });

  it("体入キャストの日払いに1円未満の端数を保存しない", async () => {
    await expect(submitClosing(castFixture(1503.75), user)).rejects.toThrow("体入即日支払いは1円単位で入力してください。");
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path.startsWith("history/"))).toBe(false);
  });
});
