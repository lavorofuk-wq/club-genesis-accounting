import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastRecord, DailyClosing, DriverRecord, IntroducerRecord, LiquorRecord, MonthlyAdjustments, StaffRecord } from "@/domain/gms";

// get() の単発読込ではキャッシュを保持せず、onValue の初回通知後から
// 購読解除までだけトランザクションに既存値を渡す。Firebaseへの通信はしない。
const fakeDatabase = vi.hoisted(() => {
  const server = new Map<string, unknown>();
  const listeners = new Set<{ path: string; ready: boolean }>();
  const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
  const read = (path: string): unknown => {
    if (server.has(path)) return clone(server.get(path));
    const descendants = [...server].filter(([key]) => key.startsWith(`${path}/`));
    if (!descendants.length) return null;
    const result: Record<string, unknown> = {};
    for (const [key, value] of descendants) {
      const segments = key.slice(path.length + 1).split("/");
      let parent = result;
      for (const segment of segments.slice(0, -1)) {
        parent[segment] ??= {};
        parent = parent[segment] as Record<string, unknown>;
      }
      parent[segments.at(-1)!] = clone(value);
    }
    return result;
  };
  const snapshot = (path: string) => ({ val: () => read(path), exists: () => read(path) !== null });
  const onValue = vi.fn((reference: { path: string }, callback: (value: ReturnType<typeof snapshot>) => void,
    _cancel?: (error: Error) => void, options?: { onlyOnce?: boolean }) => {
    const listener = { path: reference.path, ready: false };
    listeners.add(listener);
    queueMicrotask(() => {
      if (!listeners.has(listener)) return;
      listener.ready = true;
      callback(snapshot(reference.path));
      if (options?.onlyOnce) listeners.delete(listener);
    });
    return () => { listeners.delete(listener); };
  });
  const runTransaction = vi.fn(async (reference: { path: string }, callback: (value: unknown) => unknown) => {
    const ready = [...listeners].some((listener) => listener.path === reference.path && listener.ready);
    const next = callback(ready ? read(reference.path) : null);
    if (next !== undefined) {
      if (next === null) server.delete(reference.path);
      else server.set(reference.path, clone(next));
    }
    return { committed: next !== undefined, snapshot: snapshot(reference.path) };
  });
  return { server, listeners, read, snapshot, onValue, runTransaction };
});

vi.mock("firebase/database", () => ({
  ref: (_database: unknown, path: string) => ({ path }),
  get: async (reference: { path: string }) => fakeDatabase.snapshot(reference.path),
  onValue: fakeDatabase.onValue,
  runTransaction: fakeDatabase.runTransaction,
  serverTimestamp: () => ({ ".sv": "timestamp" }),
  set: vi.fn(),
  update: vi.fn(),
}));
vi.mock("./client", () => ({
  database: {},
  rootRef: (path = "") => ({ path: `accounting-dev${path ? `/${path}` : ""}` }),
}));

import {
  approveClosing, returnClosing, saveCast, saveDriver, saveIntroducer, saveLiquor,
  saveMonthlyAdjustments, saveStaff, withdrawClosing,
} from "./repository";

const user = { uid: "test-op" } as User;
const timestamp = "2026-09-01T12:00:00.000Z";
const common = { note: "", createdAt: timestamp, updatedAt: timestamp };
const store = (path: string, value: unknown) => fakeDatabase.server.set(`accounting-dev/${path}`, structuredClone(value));
const stored = (path: string) => fakeDatabase.read(`accounting-dev/${path}`);

function closing(status: DailyClosing["status"] = "submitted"): DailyClosing {
  const sales = { totalSales: 0, cashSales: 0, cardSales: 0 };
  const customers = { groupCount: 0, totalCustomers: 0 };
  const nominations = { honShimeiCount: 0, jonaiCount: 0 };
  return {
    id: "closing-1", businessDate: "2026-09-01", status,
    submissionId: "submission-1", checksum: "a".repeat(64), updatedAt: timestamp,
    sales, customers, nominations, casts: [], staffWork: [], drivers: [], expenses: [],
    staffDailyPaymentTotal: 0, dispatchStaffPayment: 0, dispatchCastPayment: 0,
    dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { ...sales, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000,
      cashProfit: 0, actualClosingCash: 200000, difference: 0 },
    posSnapshot: {
      schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: "2026-09-01", status: "closed",
      sales, customers, nominations, transactions: [], castSales: [], castWork: [], enteredCasts: [],
      exitedCasts: [], trialCasts: [], rosterSnapshot: { complete: true, capturedAt: timestamp, casts: [] },
      lifecycleEvents: [], submissionId: "submission-1", generatedAt: timestamp,
      checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum: "a".repeat(64),
    },
  };
}

function adjustments(revision = 3): MonthlyAdjustments {
  return { month: "2026-09", revision, withholdingByCast: {}, staffSalesAllowance: {},
    staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 1000 };
}

beforeEach(() => {
  fakeDatabase.server.clear();
  fakeDatabase.listeners.clear();
  vi.clearAllMocks();
  fakeDatabase.server.set("users/test-op/role", "op");
  fakeDatabase.server.set(".info/serverTimeOffset", 0);
});

afterEach(() => {
  // 正常終了・業務エラーとも、明示的に開始した購読を残さない。
  expect(fakeDatabase.listeners.size).toBe(0);
});

describe("日次処理のコールドキャッシュ回帰", () => {
  it.each(["submitted", "approved"] as const)("%s を初回操作で差し戻せる", async (status) => {
    const current = closing(status);
    store("history/closing-1", current);
    await returnClosing(current.id, current, " 金額を確認してください ", user);
    expect(stored("history/closing-1")).toMatchObject({ status: "returned", returnedFromStatus: status,
      returnedBy: user.uid, returnReason: "金額を確認してください", businessMonth: "2026-09" });
    expect(fakeDatabase.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("承認は初回操作で成功する", async () => {
    const current = closing();
    store("history/closing-1", current);
    await approveClosing(current.id, current, user);
    expect(stored("history/closing-1")).toMatchObject({ status: "approved", approvedBy: user.uid });
    expect(fakeDatabase.runTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(["submitted", "returned"] as const)("%s の取下げは初回操作で成功する", async (status) => {
    const current = closing(status);
    store("history/closing-1", current);
    await withdrawClosing(current.id, current, user);
    expect(stored("history/closing-1")).toMatchObject({ status: "withdrawn" });
  });

  it.each(["returned", "withdrawn"] as const)("本当に対象外の %s は差戻しを拒否する", async (status) => {
    const current = closing(status);
    store("history/closing-1", current);
    await expect(returnClosing(current.id, current, "再確認", user))
      .rejects.toThrow("経理確認待ちまたは承認済みのデータだけ差し戻せます。");
    expect(stored("history/closing-1")).toEqual(current);
  });

  it("他端末で更新済みの日次は上書きしない", async () => {
    const previous = closing();
    const latest = { ...previous, updatedAt: "2026-09-02T12:00:00.000Z" };
    store("history/closing-1", latest);
    await expect(returnClosing(previous.id, previous, "再確認", user)).rejects.toThrow("店舗データが更新されています。");
    expect(stored("history/closing-1")).toEqual(latest);
  });

  it("読込完了後にも存在しない日次は差戻しを拒否する", async () => {
    const missing = closing();
    await expect(returnClosing(missing.id, missing, "再確認", user))
      .rejects.toThrow("経理確認待ちまたは承認済みのデータだけ差し戻せます。");
    expect(stored("history/closing-1")).toBeNull();
  });
});

describe("共通フォーム保存のコールドキャッシュ回帰", () => {
  const staff: StaffRecord = { id: "staff-1", name: "スタッフ", status: "active", hiredAt: "2026-09-01", hourlyRate: 2000, ...common };
  const driver: DriverRecord = { id: "driver-1", name: "ドライバー", status: "active", hiredAt: "2026-09-01", dailyRate: 5000, ...common };
  const introducer: IntroducerRecord = { id: "introducer-1", name: "紹介者", feeType: "netSales10", attendanceAdvisoryEnabled: false, entryAdvisoryEnabled: false, ...common };
  const cast: CastRecord = { id: "cast-1", name: "キャスト", legalName: "テスト本名", status: "active", hiredAt: "2026-09-01", hourlyRates: { "2026-09": 3000 }, ...common };
  const liquor: LiquorRecord = { id: "liquor-1", kind: "champagneWine", name: "テスト銘柄", salePrice: 35000, costPrice: 12500, createdAt: timestamp, updatedAt: timestamp };
  const cases = [
    { label: "スタッフ", path: "staff/staff-1", value: staff, save: () => saveStaff({ ...staff, note: "更新内容" }, user) },
    { label: "ドライバー", path: "drivers/driver-1", value: driver, save: () => saveDriver({ ...driver, note: "更新内容" }, user) },
    { label: "紹介者", path: "introducers/introducer-1", value: introducer, save: () => saveIntroducer({ ...introducer, note: "更新内容" }, user) },
    { label: "キャスト", path: "casts/cast-1", value: cast, save: () => saveCast({ ...cast, note: "更新内容" }, user) },
    { label: "酒代原価", path: "liquorCosts/liquor-1", value: liquor, save: () => saveLiquor({ ...liquor, costPrice: 13000 }, user) },
  ];

  it.each(cases)("$label の既存データを初回操作で保存できる", async ({ path, value, save }) => {
    store(path, value);
    await expect(save()).resolves.toBe(value.id);
    expect(stored(path)).toMatchObject(path.startsWith("liquorCosts/") ? { costPrice: 13000 } : { note: "更新内容" });
    expect(stored(path)).toMatchObject({ createdAt: timestamp });
  });

  it.each(cases)("$label の真の同時編集競合は拒否する", async ({ path, value, save }) => {
    const latest = { ...value, updatedAt: "2026-09-02T12:00:00.000Z" };
    store(path, latest);
    await expect(save()).rejects.toThrow("別の端末で更新されています。");
    expect(stored(path)).toEqual(latest);
  });

  it.each(cases)("$label の真の削除済みデータを再作成しない", async ({ path, label, save }) => {
    await expect(save()).rejects.toThrow(`対象の${label}データが見つかりません。`);
    expect(stored(path)).toBeNull();
  });

  it("新規スタッフは取得完了後の null を有効な新規登録として扱う", async () => {
    const { id: _id, updatedAt: _updatedAt, ...newStaff } = staff;
    const id = await saveStaff(newStaff, user);
    expect(stored(`staff/${id}`)).toMatchObject({ name: staff.name, hourlyRate: 2000 });
  });
});

describe("月次入力のコールドキャッシュ回帰", () => {
  it("既存 revision を初回操作で更新できる", async () => {
    const value = adjustments();
    store("accountingAdjustments/2026-09", { ...value, cardFee: 500 });
    await saveMonthlyAdjustments(value, user);
    expect(stored("accountingAdjustments/2026-09")).toMatchObject({ revision: 4, cardFee: 1000, updatedBy: user.uid });
    expect(fakeDatabase.runTransaction).toHaveBeenCalledTimes(1);
  });

  it("本当に revision が異なる場合は上書きしない", async () => {
    const latest = adjustments(4);
    store("accountingAdjustments/2026-09", latest);
    await expect(saveMonthlyAdjustments(adjustments(3), user)).rejects.toThrow("別の端末で月次入力が更新されています。");
    expect(stored("accountingAdjustments/2026-09")).toEqual(latest);
  });

  it("月次確定済みの場合は保存しない", async () => {
    store("accountingMonthStates/2026-09", { status: "closed" });
    await expect(saveMonthlyAdjustments(adjustments(), user)).rejects.toThrow("月次確定処理中または確定済み");
    expect(fakeDatabase.runTransaction).not.toHaveBeenCalled();
  });
});
