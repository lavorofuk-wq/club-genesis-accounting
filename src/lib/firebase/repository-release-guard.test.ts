import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { DailyClosing, MonthlyAdjustments } from "@/domain/gms";
import type { MonthlyAccountingSnapshot } from "@/domain/month-accounting";

const mocks = vi.hoisted(() => ({
  releaseError: new Error("最新版ではないため更新できません。"),
  assertCurrentClientRelease: vi.fn(),
  get: vi.fn(), set: vi.fn(), update: vi.fn(), runTransaction: vi.fn(), onValue: vi.fn(),
  ref: vi.fn(), rootRef: vi.fn(), serverTimestamp: vi.fn(),
}));

vi.mock("../client-release", () => ({ assertCurrentClientRelease: mocks.assertCurrentClientRelease }));
vi.mock("firebase/database", () => ({
  get: mocks.get, set: mocks.set, update: mocks.update, runTransaction: mocks.runTransaction,
  onValue: mocks.onValue, ref: mocks.ref, serverTimestamp: mocks.serverTimestamp,
}));
vi.mock("./client", () => ({ database: {}, rootRef: mocks.rootRef }));

import * as repository from "./repository";

const user = { uid: "test-op" } as User;
const month = "2026-09";
const date = "2026-09-01";
const updatedAt = "2026-09-01T12:00:00.000Z";
const expected = { businessDate: date, updatedAt, checksum: "a".repeat(64), submissionId: "submission-1" };
const adjustments: MonthlyAdjustments = {
  month, revision: 0, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {},
  driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0,
};

// 引数の内容を検査するよりも前にゲートへ到達することを確認するため、
// 日次・確定snapshotは最小fixtureとする。Firebase関数はすべてmock済み。
const closing = { id: "closing-1", ...expected } as DailyClosing;
const snapshot = { month } as MonthlyAccountingSnapshot;
const operations: Record<string, () => Promise<unknown>> = {
  saveCast: () => repository.saveCast({ name: "キャスト", legalName: "本名", status: "active" }, user),
  convertTrialCast: () => repository.convertTrialCast("cast-1", { hiredAt: date }, user),
  departCast: () => repository.departCast("cast-1", date, updatedAt, user),
  restoreCast: () => repository.restoreCast("cast-1", updatedAt, user),
  deleteCast: () => repository.deleteCast("cast-1", updatedAt, user),
  saveStaff: () => repository.saveStaff({ name: "スタッフ", status: "active" }, user),
  convertTrialStaff: () => repository.convertTrialStaff("staff-1", { hiredAt: date, hourlyRate: 2000 }, user),
  departStaff: () => repository.departStaff("staff-1", date, updatedAt, user),
  restoreStaff: () => repository.restoreStaff("staff-1", updatedAt, user),
  deleteStaff: () => repository.deleteStaff("staff-1", updatedAt, user),
  saveDriver: () => repository.saveDriver({ name: "ドライバー", status: "active", hiredAt: date, dailyRate: 5000 }, user),
  deleteDriver: () => repository.deleteDriver("driver-1", updatedAt, user),
  saveIntroducer: () => repository.saveIntroducer({ name: "紹介者", feeType: "netSales10" }, user),
  deleteIntroducer: () => repository.deleteIntroducer("introducer-1", updatedAt, [], user),
  saveLiquor: () => repository.saveLiquor({ name: "銘柄", kind: "champagneWine", salePrice: 35000, costPrice: 12500 }, user),
  deleteLiquor: () => repository.deleteLiquor("liquor-1", updatedAt, user),
  saveCashFloat: () => repository.saveCashFloat(200000, user),
  submitClosing: () => repository.submitClosing(closing, user, updatedAt),
  withdrawClosing: () => repository.withdrawClosing("closing-1", expected, user),
  deleteUnapprovedClosing: () => repository.deleteUnapprovedClosing("closing-1", expected, user),
  approveClosing: () => repository.approveClosing("closing-1", expected, user),
  returnClosing: () => repository.returnClosing("closing-1", expected, "再確認", user),
  saveMonthlyAdjustments: () => repository.saveMonthlyAdjustments(adjustments, user),
  finalizeAccountingMonth: () => repository.finalizeAccountingMonth(month, snapshot, 0, user),
  reopenAccountingMonth: () => repository.reopenAccountingMonth(month, 0, user),
  cancelAccountingMonthClosing: () => repository.cancelAccountingMonthClosing(month, 0, user),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertCurrentClientRelease.mockRejectedValue(mocks.releaseError);
});

describe("repository全更新APIの最新版ゲート", () => {
  it.each(Object.entries(operations))("%s はFirebaseへアクセスする前に更新を拒否する", async (_name, operation) => {
    await expect(operation()).rejects.toBe(mocks.releaseError);
    expect(mocks.assertCurrentClientRelease).toHaveBeenCalledTimes(1);
    for (const firebaseCall of [mocks.get, mocks.set, mocks.update, mocks.runTransaction,
      mocks.onValue, mocks.ref, mocks.rootRef, mocks.serverTimestamp]) {
      expect(firebaseCall).not.toHaveBeenCalled();
    }
  });
});

describe("更新APIがゲートを迂回しない構造の回帰検査", () => {
  const source = ts.createSourceFile("repository.ts", readFileSync(fileURLToPath(new URL("./repository.ts", import.meta.url)), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  const readOnly = new Set(["userRole", "loadWorkspaceData"]);
  const exportedAsyncFunctions = functions.filter((fn) => {
    const flags = ts.getCombinedModifierFlags(fn);
    return Boolean(flags & ts.ModifierFlags.Export) && Boolean(flags & ts.ModifierFlags.Async);
  });
  const mutationFunctions = exportedAsyncFunctions.filter((fn) => !readOnly.has(fn.name!.text));

  function firstAwaitedCall(fn: ts.FunctionDeclaration) {
    const first = fn.body?.statements[0];
    if (!first || !ts.isExpressionStatement(first) || !ts.isAwaitExpression(first.expression)) return undefined;
    const awaited = first.expression.expression;
    return ts.isCallExpression(awaited) && ts.isIdentifier(awaited.expression) ? awaited.expression.text : undefined;
  }

  it("すべての公開更新関数を実行テストに含める", () => {
    expect(mutationFunctions.map((fn) => fn.name!.text).sort()).toEqual(Object.keys(operations).sort());
  });

  it.each(mutationFunctions.map((fn) => [fn.name!.text, fn] as const))("%s は先頭で requireUser をawaitする", (_name, fn) => {
    expect(firstAwaitedCall(fn)).toBe("requireUser");
  });

  it("requireUser は権限読込より前に最新版ゲートをawaitする", () => {
    const requireUser = functions.find((fn) => fn.name?.text === "requireUser");
    expect(requireUser).toBeDefined();
    expect(firstAwaitedCall(requireUser!)).toBe("assertCurrentClientRelease");
  });
});
