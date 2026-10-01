import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { CastRecord, MonthlyAdjustments, WorkspaceData } from "@/domain/gms";
import { normalizeMonthlyAdjustments } from "@/domain/gms";
import { buildMonthlySnapshot, calculateMonthlyAccounting, monthlySourceFingerprint, normalizeMonthlyAccountingSnapshot } from "@/domain/month-accounting";
import { buildCastSalesRankingRoster } from "@/domain/cast-sales-ranking";

const memory = vi.hoisted(() => ({
  values: new Map<string, unknown>(), get: vi.fn(), transaction: vi.fn(), environment: "accounting-dev",
  afterSnapshot: undefined as (() => void) | undefined,
}));
vi.mock("firebase/database", () => ({
  get: memory.get, ref: (_db: unknown, path: string) => ({ path }), set: vi.fn(), update: vi.fn(), serverTimestamp: vi.fn(),
  onValue: (_ref: unknown, callback: (snap: { val: () => number }) => void) => { callback({ val: () => 0 }); return () => undefined; },
}));
vi.mock("./client", () => ({ database: {}, environmentRoot: () => memory.environment,
  rootRef: (path = "") => ({ path: [memory.environment, path].filter(Boolean).join("/") }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));

import { finalizeAccountingMonth } from "./repository";

const month = "2026-09";
const user = { uid: "accountant" } as User;
const scoped = (path: string) => memory.environment + "/" + path;
const cast = (extra: Partial<CastRecord> = {}): CastRecord => ({ id: "cast-1", name: "出勤ゼロ", status: "active",
  hiredAt: "2026-09-01", hourlyRates: { [month]: 3000 }, legalName: "", note: "",
  createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-01T12:00:00.000Z", ...extra });
const adjustments: MonthlyAdjustments = normalizeMonthlyAdjustments({ month, withholdingByCast: {}, staffSalesAllowance: {},
  staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 });
const data = (): WorkspaceData => ({
  casts: Object.values(memory.values.get(scoped("casts")) as Record<string, CastRecord> ?? {}),
  staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 0,
});
async function candidate(withRoster = memory.environment === "accounting-dev") {
  const current = data();
  const results = calculateMonthlyAccounting(current, month, adjustments);
  return buildMonthlySnapshot(month, 1, await monthlySourceFingerprint(current, month, adjustments), adjustments,
    results, [], user.uid, "2026-09-30T12:00:00.000Z",
    withRoster ? buildCastSalesRankingRoster(results, current.casts, month) : undefined);
}
const stored = () => memory.values.get(scoped("accountingMonthSnapshots/" + month + "/1"));

beforeEach(() => {
  vi.clearAllMocks(); memory.values.clear(); memory.environment = "accounting-dev"; memory.afterSnapshot = undefined;
  memory.values.set("users/accountant/role", "accounting");
  memory.values.set(scoped("casts"), { "cast-1": cast(), "cast-trial": cast({ id: "cast-trial", status: "trial" }) });
  memory.get.mockImplementation(async ({ path }: { path: string }) => ({ val: () => structuredClone(memory.values.get(path) ?? null) }));
  memory.transaction.mockImplementation(async ({ path }: { path: string }, callback: (v: unknown) => unknown) => {
    const result = callback(structuredClone(memory.values.get(path) ?? null));
    if (result !== undefined) memory.values.set(path, structuredClone(result));
    if (path.includes("/accountingMonthSnapshots/") && result !== undefined) memory.afterSnapshot?.();
    return { committed: result !== undefined, snapshot: { val: () => structuredClone(result) } };
  });
});

describe("売上順位表名簿のdev確定保存", () => {
  it("出勤0の在籍名簿を保存して読み戻せ、体入を加えず他の計算と本番を変更しない", async () => {
    const source = await candidate();
    memory.values.set("accounting/accountingMonthSnapshots/" + month + "/1", { unchanged: true });
    const masters = structuredClone(memory.values.get(scoped("casts")));
    await finalizeAccountingMonth(month, source, 0, user);
    const saved = normalizeMonthlyAccountingSnapshot(stored(), month, 1)!;
    expect(saved.castSalesRankingRoster).toEqual({ schemaVersion: 1, entries: [{ id: "cast-1", name: "出勤ゼロ" }] });
    for (const key of ["castRewards", "castSalesReports", "sales", "balance", "expenses"] as const) expect(saved[key]).toEqual(source[key]);
    expect(memory.values.get(scoped("casts"))).toEqual(masters);
    expect(memory.values.get("accounting/accountingMonthSnapshots/" + month + "/1")).toEqual({ unchanged: true });
    expect(memory.values.get(scoped("accountingMonthStates/" + month))).toMatchObject({ status: "closed" });
  });
  it("空名簿もschemaで保存済みと明示する", async () => {
    memory.values.set(scoped("casts"), {});
    await finalizeAccountingMonth(month, await candidate(), 0, user);
    expect(stored()).toMatchObject({ castSalesRankingRoster: { schemaVersion: 1, entries: [] } });
  });
  it("本番の新規確定は従来どおり名簿metadataを追加しない", async () => {
    memory.environment = "accounting";
    memory.values.set(scoped("casts"), { "cast-1": cast() });
    await finalizeAccountingMonth(month, await candidate(), 0, user);
    expect(stored()).not.toHaveProperty("castSalesRankingRoster");
  });
  it.each(["missing", "changed", "extra"])("入力名簿の%sを再計算と比較して保存前に拒否する", async (kind) => {
    const source = await candidate();
    if (kind === "missing") delete source.castSalesRankingRoster;
    if (kind === "changed") source.castSalesRankingRoster!.entries[0].name = "別名";
    if (kind === "extra") source.castSalesRankingRoster!.entries.push({ id: "injected", name: "追加" });
    await expect(finalizeAccountingMonth(month, source, 0, user)).rejects.toThrow("月次計算結果が現在の元データと一致しません");
    expect(stored()).toBeUndefined();
    expect(memory.values.get(scoped("accountingMonthStates/" + month))).toMatchObject({ status: "open" });
  });
  it("保存前後に名簿の元マスタが変わった場合は確定を完了しない", async () => {
    const source = await candidate();
    memory.afterSnapshot = () => memory.values.set(scoped("casts"), { "cast-1": cast({ name: "変更後" }) });
    await expect(finalizeAccountingMonth(month, source, 0, user)).rejects.toThrow("月次確定中に元データが更新されました");
    expect(memory.values.get(scoped("accountingMonthStates/" + month))).toMatchObject({ status: "open" });
    expect(stored()).toMatchObject({ castSalesRankingRoster: { schemaVersion: 1, entries: [{ id: "cast-1", name: "出勤ゼロ" }] } });
  });
});
