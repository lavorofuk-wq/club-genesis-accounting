import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastCorrectionDraft, CastRecord, DailyCast, DailyClosing } from "@/domain/gms";

const memory = vi.hoisted(() => {
  let rootName = "accounting-dev";
  let tree: Record<string, unknown> = {};
  let updateHook: ((plan: Record<string, unknown>) => Promise<void>) | undefined;
  const parts = (path: string) => path.split("/").filter(Boolean);
  const read = (path: string) => parts(path).reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, tree) ?? null;
  const write = (path: string, value: unknown) => {
    const keys = parts(path);
    let parent = tree;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== "object") parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    const last = keys.at(-1)!;
    if (value === null) delete parent[last];
    else parent[last] = structuredClone(value);
  };
  const snapshot = (path: string) => ({ val: () => structuredClone(read(path)), exists: () => read(path) !== null });
  const update = vi.fn(async (_reference: unknown, plan: Record<string, unknown>) => {
    if (updateHook) return updateHook(plan);
    for (const [path, value] of Object.entries(plan)) write(`${rootName}/${path}`, value);
  });
  return {
    get rootName() { return rootName; }, set rootName(value: string) { rootName = value; },
    get tree() { return tree; }, reset() { tree = {}; updateHook = undefined; }, read, write, snapshot, update,
    hook(value?: (plan: Record<string, unknown>) => Promise<void>) { updateHook = value; },
  };
});

vi.mock("firebase/database", () => ({
  ref: (_database: unknown, path: string) => ({ path, key: path.split("/").filter(Boolean).at(-1) || null }),
  get: async (reference: { path: string }) => memory.snapshot(reference.path),
  onValue: (reference: { path: string }, callback: (snapshot: ReturnType<typeof memory.snapshot>) => void) => {
    callback(memory.snapshot(reference.path)); return () => undefined;
  },
  serverTimestamp: () => Date.now(), set: vi.fn(), update: memory.update,
}));
vi.mock("./client", () => ({
  database: {},
  rootRef: (path = "") => ({ path: `${memory.rootName}${path ? `/${path}` : ""}`, key: path ? path.split("/").at(-1) : memory.rootName }),
}));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));

import { loadWorkspaceData, saveCastCorrection } from "./repository";

const user = { uid: "op-user" } as User;
const updatedAt = "2026-09-01T12:00:00.000Z";
const checksum = "a".repeat(64);

function dailyCast(): DailyCast {
  return { masterId: "cast-1", posCastId: "pos-1", name: "キャスト", kind: "regular", startTime: "20:00", endTime: "22:00",
    hours: 2, hourlyRate: 3000, honShimeiCount: 0, banaiShimeiCount: 0, dohanCount: 0, dohanBack: 0,
    honShimeiSales: 0, jonaiExtensionSales: 0, drinkSales: 0, drinkAllocations: [], bottles: [], liquorCost: 0,
    beautyAllowance: 0, dailyPayment: 0, advancePayment: 0, transportFee: 0 };
}

function closing(id: string, businessDate: string, casts: DailyCast[] = []): DailyClosing {
  const sales = { totalSales: 0, cashSales: 0, cardSales: 0 };
  const customers = { groupCount: 0, totalCustomers: 0 };
  const nominations = { honShimeiCount: 0, jonaiCount: 0 };
  return { id, businessDate, status: "approved", submissionId: `submission-${id}`,
    checksum, updatedAt, sales, customers, nominations, casts, staffWork: [], drivers: [], expenses: [], staffDailyPaymentTotal: 0,
    dispatchStaffPayment: 0, dispatchCastPayment: 0, dispatchFee: 0, liquorDeliveryAmount: 0,
    cash: { ...sales, cashFloat: 200000, expenseAndPaymentTotal: 0, expectedClosingCash: 200000,
      cashProfit: 0, actualClosingCash: 200000, difference: 0 },
    posSnapshot: { schema: "club-genesis-pos-closing", schemaVersion: 3, businessDate, status: "closed", sales, customers, nominations,
      transactions: [], castSales: [], castWork: [], enteredCasts: [], exitedCasts: [], trialCasts: [],
      rosterSnapshot: { complete: true, capturedAt: updatedAt, casts: [] }, lifecycleEvents: [], submissionId: `submission-${id}`,
      generatedAt: updatedAt, checksumAlgorithm: "sha256", checksumCanonicalization: "recursive-key-sort-v1", checksum } };
}

function draft(targetClosingId = "source", businessDate = "2026-09-01", sales = 0): CastCorrectionDraft {
  return { sourceClosingId: "source", sourceUpdatedAt: updatedAt, sourceChecksum: checksum, sourceSubmissionId: "submission-source",
    entries: [{ id: "pos-1", originalPosCastId: "pos-1", targetClosingId, businessDate, masterId: "cast-1", name: "キャスト",
      kind: "regular", startTime: "20:00", endTime: "22:00", breakMinutes: 0, hourlyRate: 3000,
      honShimeiCount: 0, banaiShimeiCount: 0, honShimeiSales: sales, jonaiExtensionSales: 0,
      beautyAllowance: 0, dohan: [], deleted: false }], products: [] };
}

function seed() {
  const cast: CastRecord = { id: "cast-1", name: "キャスト", legalName: "本名", status: "active", hiredAt: "2026-01-01",
    hourlyRates: { "2026-09": 3000, "2026-10": 3000 }, note: "", createdAt: updatedAt, updatedAt };
  memory.write("users/op-user/role", "op");
  memory.write(".info/serverTimeOffset", 0);
  memory.write("accounting-dev/casts/cast-1", cast);
  memory.write("accounting-dev/history/source", closing("source", "2026-09-01", [dailyCast()]));
  memory.write("accounting-dev/history/target", closing("target", "2026-10-01"));
  memory.write("accounting-dev/config/cashFloat", 200000);
}

beforeEach(() => {
  memory.reset(); memory.rootName = "accounting-dev"; vi.clearAllMocks(); vi.setSystemTime(new Date("2026-09-17T10:00:00.000Z")); seed();
});

describe("キャスト日次経理訂正の永続化", () => {
  it("原本を変えず、訂正・別月移動・復元・再開を連番履歴と逆引きclaimで保存する", async () => {
    const original = structuredClone(memory.read("accounting-dev/history/source"));
    await saveCastCorrection(draft(), "source", 0, "売上確認", user);
    expect(memory.read("accounting-dev/castDailyCorrectionRevision")).toBe(1);
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/source/source")).toEqual({ sourceClosingId: "source", revision: 1 });

    await saveCastCorrection(draft("target", "2026-10-01", 1000), "source", 1, "日付訂正", user);
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/target/source")).toEqual({ sourceClosingId: "source", revision: 2 });
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/source/source")).toEqual({ sourceClosingId: "source", revision: 2 });

    await saveCastCorrection(null, "source", 2, "原本へ戻す", user);
    expect(memory.read("accounting-dev/castDailyCorrections/source")).toMatchObject({ revision: 3, active: false,
      history: { "3": { revision: 3, active: false, reason: "原本へ戻す", createdBy: user.uid } } });
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/source/source")).toBeNull();
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/target/source")).toBeNull();

    await saveCastCorrection(draft(), "source", 3, "再訂正", user);
    expect(memory.read("accounting-dev/castDailyCorrections/source")).toMatchObject({ revision: 4, active: true });
    expect(memory.read("accounting-dev/castDailyCorrectionClaims/source/source")).toEqual({ sourceClosingId: "source", revision: 4 });
    expect(memory.read("accounting-dev/history/source")).toEqual(original);
  });

  it("同じ版を別内容が先に保存した場合、曖昧な通信失敗を自分の成功と誤認しない", async () => {
    memory.hook(async () => {
      const competitor = draft("source", "2026-09-01", 2000);
      const history = { revision: 1, active: true, draft: competitor, reason: "他端末", createdAt: "2026-09-17T10:00:00.000Z", createdBy: user.uid };
      memory.write("accounting-dev/castDailyCorrectionRevision", 1);
      memory.write("accounting-dev/castDailyCorrections/source", { sourceClosingId: "source", revision: 1, active: true,
        current: competitor, history: { "1": history } });
      memory.write("accounting-dev/castDailyCorrectionClaims/source/source", { sourceClosingId: "source", revision: 1 });
      throw new Error("PERMISSION_DENIED");
    });
    await expect(saveCastCorrection(draft(), "source", 0, "自端末", user)).rejects.toThrow("PERMISSION_DENIED");
    expect(memory.read("accounting-dev/castDailyCorrections/source/history/1")).toMatchObject({ reason: "他端末" });
  });

  it("別原本の同時訂正で全体版CASを失った処理は保存成功にしない", async () => {
    memory.hook(async () => {
      memory.write("accounting-dev/castDailyCorrectionRevision", 1);
      throw new Error("PERMISSION_DENIED");
    });
    await expect(saveCastCorrection(draft(), "source", 0, "競合", user)).rejects.toThrow("PERMISSION_DENIED");
    expect(memory.read("accounting-dev/castDailyCorrections/source")).toBeNull();
  });

  it("確定済み変更先月と本番環境では保存しない", async () => {
    memory.write("accounting-dev/accountingMonthStates/2026-10", { month: "2026-10", status: "closed" });
    await expect(saveCastCorrection(draft("target", "2026-10-01"), "source", 0, "移動", user)).rejects.toThrow("月次確定中または確定済み");
    memory.rootName = "accounting";
    await expect(saveCastCorrection(draft(), "source", 0, "本番", user)).rejects.toThrow("開発環境でのみ");
  });

  it("読込時に不正な訂正履歴を黙って破棄しない", async () => {
    memory.write("accounting-dev/castDailyCorrections/source", { sourceClosingId: "source", revision: 1, active: true, history: {} });
    await expect(loadWorkspaceData("op")).rejects.toThrow(/経理訂正履歴.*欠落/);
  });
});
