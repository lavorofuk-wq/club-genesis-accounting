import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { DailyClosing } from "@/domain/gms";
import { calculateCashFunding, cashFundingContext, type CashFundingInputs } from "@/domain/cash-funding";

const memory = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const read = (path: string): unknown => {
    if (values.has(path)) return structuredClone(values.get(path));
    const descendants = [...values].filter(([key]) => key.startsWith(`${path}/`));
    if (!descendants.length) return null;
    return Object.fromEntries(descendants.map(([key, value]) => [key.slice(path.length + 1), structuredClone(value)]));
  };
  return { values, read, get: vi.fn(), transaction: vi.fn(), update: vi.fn(), beforeLockRead: undefined as (() => void) | undefined };
});

vi.mock("firebase/database", () => ({
  get: memory.get, ref: (_db: unknown, path: string) => ({ path }), serverTimestamp: () => Date.now(),
  onValue: (_reference: unknown, callback: (snapshot: { val: () => number }) => void) => {
    callback({ val: () => 0 }); return () => undefined;
  }, set: vi.fn(), update: memory.update,
}));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/domain/gms", async (original) => ({
  ...await original<typeof import("@/domain/gms")>(), parsePosClosingV3: vi.fn().mockResolvedValue(undefined),
}));

import { approveClosing, deleteUnapprovedClosing, submitClosing } from "./repository";

const user = { uid: "cash-op" } as User;
const stamp = "2026-09-09T12:00:00.000Z";
const emptyInputs: CashFundingInputs = { companyReplenishment: 0, personalReplenishment: 0, companyTransfer: 0 };

function fixture(date = "2026-09-09", cashSales = 10000, payment = 0, previous: DailyClosing[] = [], inputs = emptyInputs): DailyClosing {
  const id = `daily_${date.replaceAll("-", "")}`;
  const checksum = date.replaceAll("-", "").repeat(8);
  const sales = { totalSales: cashSales, cashSales, cardSales: 0 };
  const customers = { groupCount: 0, totalCustomers: 0 };
  const nominations = { honShimeiCount: 0, jonaiCount: 0 };
  const cashProfit = cashSales - payment;
  const funding = calculateCashFunding(cashFundingContext(previous, date, 200000, id), inputs, cashProfit, true);
  funding.schema = 2;
  const expectedClosingCash = 200000 + cashProfit + funding.companyTransfer - funding.personalRepayment;
  return {
    id, businessDate: date, status: "submitted", submissionId: `submission-${date}`, checksum, updatedAt: stamp,
    sales, customers, nominations, casts: [], staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0,
    dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: payment, liquorDeliveryAmount: 0,
    cash: { ...sales, cashFloat: 200000, expenseAndPaymentTotal: payment, expectedClosingCash,
      actualClosingCash: expectedClosingCash, cashProfit, difference: 0, funding },
    posSnapshot: { schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate: date, status: "closed",
      submissionId: `submission-${date}`, checksum, generatedAt: stamp, checksumAlgorithm: "sha256",
      checksumCanonicalization: "recursive-key-sort-v1", sales, customers, nominations,
      transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
      rosterSnapshot: { complete: true, capturedAt: stamp, casts: [] }, lifecycleEvents: [] },
  };
}
const store = (value: DailyClosing) => memory.values.set(`history/${value.id}`, structuredClone(value));
const historyWrites = () => memory.transaction.mock.calls.filter(([reference]) => reference.path.startsWith("history/"));
const lock = (overrides: Record<string, unknown> = {}) => ({ id: "daily_20260909", operation: "submit", owner: user.uid,
  token: "other-operation", acquiredAtMs: Date.now(), expiresAt: Date.now() + 60000, ...overrides });

beforeEach(() => {
  vi.clearAllMocks(); memory.values.clear(); memory.beforeLockRead = undefined;
  memory.values.set("users/cash-op/role", "op");
  memory.get.mockImplementation(async (reference: { path: string }) => {
    if (reference.path === "cashManagementLock") memory.beforeLockRead?.();
    return { val: () => memory.read(reference.path), exists: () => memory.read(reference.path) !== null };
  });
  memory.transaction.mockImplementation(async (reference: { path: string }, callback: (current: unknown) => unknown) => {
    const value = callback(memory.read(reference.path));
    if (value !== undefined) {
      if (value === null) memory.values.delete(reference.path);
      else memory.values.set(reference.path, structuredClone(value));
    }
    return { committed: value !== undefined, snapshot: { val: () => memory.read(reference.path) } };
  });
  memory.update.mockImplementation(async (_reference: unknown, plan: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(plan)) {
      if (!path.startsWith("history/") || !value) continue;
      const next = value as DailyClosing;
      if (!next.cashRevisionId) continue;
      const current = memory.read(path) as DailyClosing | null;
      const revisionPath = `cashRevisions/${path.slice("history/".length)}/${next.cashRevisionId}`;
      if (!current || current.updatedAt !== next.previousUpdatedAt || memory.read(revisionPath) || !plan[revisionPath]) {
        throw new Error("PERMISSION_DENIED");
      }
    }
    for (const [path, value] of Object.entries(plan)) {
      if (value === null) memory.values.delete(path);
      else memory.values.set(path, structuredClone(value));
    }
  });
});

describe("現金補充・返済の直列化と確認済み送信", () => {
  it("初回に確認済み現金をtoken付きで保存し、自己ロックを解放する", async () => {
    const value = fixture(); await submitClosing(value, user);
    expect(memory.read(`history/${value.id}`)).toMatchObject({ cash: value.cash, cashManagementToken: expect.any(String) });
    expect(memory.read("cashManagementLock")).toBeNull();
    expect(memory.transaction.mock.calls[0][0]).toEqual({ path: "cashManagementLock" });
    expect(memory.get.mock.calls.findIndex(([reference]) => reference.path === "history")).toBeGreaterThanOrEqual(0);
  });

  it.each(["missing", "unconfirmed", "actual", "repayment", "replenishment"])("%s の不正な現金確認を拒否する", async (mode) => {
    const value = fixture();
    if (mode === "missing") delete value.cash.funding;
    if (mode === "unconfirmed") value.cash.funding!.confirmed = false;
    if (mode === "actual") { value.cash.actualClosingCash -= 1; value.cash.difference = -1; }
    if (mode === "repayment") value.cash.funding!.personalRepayment = 1;
    if (mode === "replenishment") value.cash.funding!.personalReplenishment = 100;
    await expect(submitClosing(value, user)).rejects.toThrow();
    expect(historyWrites()).toHaveLength(0); expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("会社入金と返済を現金収支から分離し、開店補充を二重加算しない", async () => {
    const before = fixture("2026-08-31", 0, 20000); store(before);
    const value = fixture("2026-09-09", 10000, 0, [before], { companyReplenishment: 5000, personalReplenishment: 15000, companyTransfer: 3000 });
    await submitClosing(value, user);
    expect(memory.read(`history/${value.id}`)).toMatchObject({ cash: { cashProfit: 10000, expectedClosingCash: 200000,
      funding: { openingShortfall: 20000, personalRepayment: 13000, closingPersonalDebt: 2000 } } });
  });

  it("legacy の実在高との差額は維持し、繰越は計算上残額を使う", async () => {
    const before = fixture("2026-08-31", 0, 10000); delete before.cash.funding;
    before.cash.actualClosingCash = 189000; before.cash.difference = -1000; before.status = "returned"; store(before);
    const value = fixture("2026-09-09", 10000, 0, [before], { ...emptyInputs, personalReplenishment: 10000 });
    await submitClosing(value, user);
    expect(memory.read(`history/${value.id}`)).toMatchObject({ cash: { funding: { previousClosingCash: 190000, openingPersonalDebt: 0 } } });
    expect(memory.read(`history/${before.id}`)).toEqual(before);
  });

  it("サーバーに増えた前営業日を無視した初回コンテキストを拒否する", async () => {
    const value = fixture(); store(fixture("2026-09-08"));
    await expect(submitClosing(value, user)).rejects.toThrow("前営業日");
    expect(historyWrites()).toHaveLength(0);
  });

  it("他端末の有効ロック中は送信を拒否し、そのロックを解放しない", async () => {
    const other = lock(); memory.values.set("cashManagementLock", other);
    await expect(submitClosing(fixture(), user)).rejects.toThrow("別の端末");
    expect(historyWrites()).toHaveLength(0); expect(memory.read("cashManagementLock")).toEqual(other);
  });

  it("期限切れロックは新しいtokenで取得し直せる", async () => {
    memory.values.set("cashManagementLock", lock({ expiresAt: Date.now() - 1 }));
    const value = fixture(); await submitClosing(value, user);
    expect(memory.read(`history/${value.id}`)).not.toMatchObject({ cashManagementToken: "other-operation" });
    expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("保存直前に別tokenへ変わった場合は保存せず、新所有者のロックを残す", async () => {
    const other = lock(); memory.beforeLockRead = () => memory.values.set("cashManagementLock", other);
    await expect(submitClosing(fixture(), user)).rejects.toThrow("更新ロックが期限切れまたは更新済み");
    expect(historyWrites()).toHaveLength(0); expect(memory.read("cashManagementLock")).toEqual(other);
  });

  it("保存直前に期限切れになった場合は保存しない", async () => {
    memory.beforeLockRead = () => {
      const current = memory.read("cashManagementLock") as Record<string, unknown>;
      memory.values.set("cashManagementLock", { ...current, expiresAt: Date.now() - 1 });
    };
    await expect(submitClosing(fixture(), user)).rejects.toThrow("期限切れ"); expect(historyWrites()).toHaveLength(0);
  });

  it("history保存が拒否されても自己cash lockと未確定claimを解放する", async () => {
    const original = memory.transaction.getMockImplementation()!;
    memory.transaction.mockImplementation(async (reference, callback) => {
      if (reference.path.startsWith("history/")) throw new Error("PERMISSION_DENIED");
      return original(reference, callback);
    });
    const value = fixture(); await expect(submitClosing(value, user)).rejects.toThrow("PERMISSION_DENIED");
    expect(memory.read("cashManagementLock")).toBeNull(); expect(memory.read(`history/${value.id}`)).toBeNull();
    expect(memory.read(`posSubmissionClaims/${value.checksum}`)).toBeNull();
  });
});

describe("後続営業日の現金実績と削除保護", () => {
  it("未確定の後続日が参照する過去の変更は理由と監査を伴い保存できる", async () => {
    const before = fixture("2026-09-08"); before.status = "returned"; store(before);
    const successor = fixture("2026-09-09", 10000, 0, [before]); store(successor);
    const changed = fixture("2026-09-08", 20000);
    changed.cashRevisionReason = "実績確認による訂正";
    await submitClosing(changed, user, stamp);
    expect(memory.read(`history/${before.id}`)).toMatchObject({ cash: changed.cash, cashRevisionId: expect.any(String) });
    expect(memory.read(`history/${successor.id}`)).toEqual(successor);
  });

  it("後続日が参照していても現金不変の再送は許可する", async () => {
    const before = fixture("2026-09-08"); before.status = "returned"; store(before);
    store(fixture("2026-09-09", 10000, 0, [before]));
    await submitClosing(before, user, stamp);
    expect(memory.read(`history/${before.id}`)).toMatchObject({ status: "submitted", cash: before.cash });
  });

  it("後続参照がある日次は削除ロック取得より前に拒否する", async () => {
    const before = fixture("2026-09-08"); store(before); store(fixture("2026-09-09", 10000, 0, [before]));
    await expect(deleteUnapprovedClosing(before.id, before, user)).rejects.toThrow("削除はできません");
    expect(memory.update).not.toHaveBeenCalled(); expect(memory.read(`history/${before.id}`)).toEqual(before);
    expect(memory.transaction.mock.calls.some(([reference]) => reference.path === "dailyClosingDeletionLock")).toBe(false);
    expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("最新未承認日はcash→delete順でロックし、日次とclaimをまとめて削除する", async () => {
    const value = fixture(); store(value); memory.values.set(`posSubmissionClaims/${value.checksum}`, value.id);
    await deleteUnapprovedClosing(value.id, value, user);
    expect(memory.transaction.mock.calls.slice(0, 2).map(([reference]) => reference.path)).toEqual(["cashManagementLock", "dailyClosingDeletionLock"]);
    expect(memory.read(`history/${value.id}`)).toBeNull(); expect(memory.read(`posSubmissionClaims/${value.checksum}`)).toBeNull();
    expect(memory.read("cashManagementLock")).toBeNull(); expect(memory.read("dailyClosingDeletionLock")).toBeNull();
  });

  it("承認済み日次の完全削除は従来どおり拒否する", async () => {
    const value = fixture(); value.status = "approved"; store(value);
    await expect(deleteUnapprovedClosing(value.id, value, user)).rejects.toThrow("承認済みデータは完全削除できません");
    expect(memory.read(`history/${value.id}`)).toEqual(value); expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("原子的削除が失敗した場合は日次を保持し両方の自己ロックを解放する", async () => {
    const value = fixture(); store(value); memory.update.mockRejectedValue(new Error("network failure"));
    await expect(deleteUnapprovedClosing(value.id, value, user)).rejects.toThrow("network failure");
    expect(memory.read(`history/${value.id}`)).toEqual(value);
    expect(memory.read("cashManagementLock")).toBeNull(); expect(memory.read("dailyClosingDeletionLock")).toBeNull();
  });

  it("旧funding無しデータは承認を拒否し、現金を自動変更しない", async () => {
    const value = fixture(); delete value.cash.funding; store(value);
    await expect(approveClosing(value.id, value, user)).rejects.toThrow("現金");
    expect(memory.read(`history/${value.id}`)).toEqual(value);
    expect(memory.read("cashManagementLock")).toBeNull();
  });
});

describe("全日次の現金確認と原子的な改訂履歴", () => {
  function legacy(date = "2026-09-07") {
    const value = fixture(date); delete value.cash.funding; value.status = "returned";
    return value;
  }
  const revisions = () => [...memory.values].filter(([path]) => path.startsWith("cashRevisions/"))
    .map(([, value]) => value as { operationId: string; beforeCash: DailyClosing["cash"]; beforeRecordJson: string; beforeUpdatedAt: string; reason: string });

  it("旧9/7をschema2へ確認移行し、後続旧9/8は自動変更しない", async () => {
    const before = legacy(); store(before); const nextDay = legacy("2026-09-08"); nextDay.status = "withdrawn"; store(nextDay);
    const candidate = fixture("2026-09-07"); candidate.cashRevisionReason = "旧日の実際の補充・返済を確認";
    await submitClosing(candidate, user, stamp);
    const saved = memory.read(`history/${before.id}`) as DailyClosing;
    expect(saved.cash.funding?.schema).toBe(2); expect(saved.previousUpdatedAt).toBe(stamp);
    expect(revisions()).toHaveLength(1);
    expect(revisions()[0]).toMatchObject({ operationId: saved.cashRevisionId, beforeCash: before.cash, beforeUpdatedAt: stamp });
    expect(JSON.parse(revisions()[0].beforeRecordJson)).toEqual(before);
    expect(memory.read(`history/${nextDay.id}`)).toEqual(nextDay);
  });

  it("同額2回目の再送も別UUIDで旧日次を保存し、既存監査を上書きしない", async () => {
    const before = fixture(); before.status = "returned"; store(before);
    await submitClosing(before, user, stamp);
    const first = memory.read(`history/${before.id}`) as DailyClosing;
    const firstAudit = structuredClone(revisions()[0]);
    const returned = { ...first, id: before.id, status: "returned" as const, updatedAt: "2026-09-10T01:00:00.000Z" }; store(returned);
    await submitClosing(returned, user, returned.updatedAt);
    const second = memory.read(`history/${before.id}`) as DailyClosing;
    expect(second.cashRevisionId).not.toBe(first.cashRevisionId); expect(revisions()).toHaveLength(2);
    expect(revisions()[0]).toEqual(firstAudit); expect(revisions()[1].reason).toBe("店舗データ再送");
  });

  it("旧本文のPOS・給与・経費を監査JSONへ保存するが監査本文を再帰埋込しない", async () => {
    const before = fixture(); before.status = "returned";
    const raw = { ...before, cashRevisions: { embedded: "exclude" }, beforeRecordJson: "exclude" }; store(raw);
    await submitClosing(before, user, stamp);
    const archived = JSON.parse(revisions()[0].beforeRecordJson);
    expect(archived.posSnapshot).toEqual(before.posSnapshot); expect(archived.staffWork).toEqual(before.staffWork);
    expect(archived.expenses).toEqual(before.expenses); expect(archived.cashRevisions).toBeUndefined();
    expect(archived.beforeRecordJson).toBeUndefined();
    const current = memory.read(`history/${before.id}`) as Record<string, unknown>;
    expect(current.beforeRecordJson).toBeUndefined(); expect(current.cashRevisions).toBeUndefined();
  });

  it("旧確認flagを付けてもfunding無し再送は許可しない", async () => {
    const before = legacy(); store(before);
    await expect(submitClosing({ ...before, legacyCashConfirmed: true }, user, stamp)).rejects.toThrow("現金補充");
    expect(memory.update).not.toHaveBeenCalled();
  });

  it("cash変更の理由がなければ監査も本体も作成しない", async () => {
    const before = legacy(); store(before);
    await expect(submitClosing(fixture("2026-09-07"), user, stamp)).rejects.toThrow("理由");
    expect(memory.update).not.toHaveBeenCalled(); expect(revisions()).toHaveLength(0);
  });

  it("新規schema1を拒否し、保存済みschema1の全値不変再送だけ許可する", async () => {
    const before = fixture(); before.cash.funding!.schema = 1; before.status = "returned";
    await expect(submitClosing(before, user)).rejects.toThrow("新しい補充");
    store(before); await submitClosing(before, user, stamp);
    expect(revisions()).toHaveLength(1); expect(memory.read(`history/${before.id}`)).toMatchObject({ cash: before.cash });
  });

  it("schema2では実際の返済0円と、初回の明示された未返済12300円を保持できる", async () => {
    const value = fixture(); value.cash.funding!.openingPersonalDebt = 12300;
    value.cash.funding!.closingPersonalDebt = 12300; value.cash.funding!.personalRepayment = 0;
    await submitClosing(value, user);
    expect(memory.read(`history/${value.id}`)).toMatchObject({ cash: value.cash });
  });

  it("先読み後に日次の状態と版が変わればCASで本体・監査とも拒否する", async () => {
    const before = fixture(); before.status = "returned"; store(before);
    const original = memory.update.getMockImplementation()!;
    memory.update.mockImplementationOnce(async (reference, plan) => {
      store({ ...before, status: "withdrawn", updatedAt: "2026-09-10T00:00:00.000Z" });
      return original(reference, plan);
    });
    await expect(submitClosing(before, user, stamp)).rejects.toThrow("PERMISSION_DENIED");
    expect(revisions()).toHaveLength(0); expect(memory.read(`history/${before.id}`)).toMatchObject({ status: "withdrawn" });
  });

  it("原子的保存の応答だけ失われても同じUUIDの履歴と本体を確認して成功する", async () => {
    const before = fixture(); before.status = "returned"; store(before);
    const original = memory.update.getMockImplementation()!;
    memory.update.mockImplementationOnce(async (reference, plan) => { await original(reference, plan); throw new Error("response lost"); });
    await submitClosing(before, user, stamp);
    expect(memory.update).toHaveBeenCalledTimes(1); expect(revisions()).toHaveLength(1);
    expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("保存結果の読取も失敗した場合は不明を伝え、pending claimを消さずに残す", async () => {
    const before = fixture(); before.status = "returned"; store(before);
    const original = memory.update.getMockImplementation()!;
    memory.update.mockImplementationOnce(async (reference, plan) => {
      await original(reference, plan); memory.get.mockRejectedValue(new Error("offline")); throw new Error("response lost");
    });
    await expect(submitClosing(before, user, stamp)).rejects.toThrow("保存結果を確認できません");
    expect(revisions()).toHaveLength(1);
    expect(memory.read(`posSubmissionClaims/${before.checksum}`)).toMatchObject({ state: "pending" });
  });

  it("後続の空月が確定済みなら未返済額の発生を伴う過去移行を拒否する", async () => {
    const before = legacy(); store(before);
    memory.values.set("accountingMonthStates/2026-10", { month: "2026-10", status: "closed", revision: 1 });
    const value = fixture("2026-09-07"); value.cashRevisionReason = "旧日を確認";
    await expect(submitClosing(value, user, stamp)).rejects.toThrow("確定");
    expect(revisions()).toHaveLength(0);
  });

  it("前日cash変更で当日参照が古くなった場合は承認を拒否する", async () => {
    const before = fixture("2026-09-08"); const value = fixture("2026-09-09", 10000, 0, [before]);
    store(fixture("2026-09-08", 20000)); store(value);
    await expect(approveClosing(value.id, value, user)).rejects.toThrow("現金");
    expect(memory.read(`history/${value.id}`)).toEqual(value); expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("整合したschema2の承認もcash lockで直列化し、そのtokenで確定する", async () => {
    const value = fixture(); store(value); await approveClosing(value.id, value, user);
    expect(memory.read(`history/${value.id}`)).toMatchObject({ status: "approved", cashManagementToken: expect.any(String), cash: value.cash });
    expect(memory.transaction.mock.calls[0][0]).toEqual({ path: "cashManagementLock" });
    expect(memory.read("cashManagementLock")).toBeNull();
  });
});
