import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";

const memory = vi.hoisted(() => {
  const root: Record<string, unknown> = {};
  const read = (path: string): unknown => path.split("/").filter(Boolean)
    .reduce<unknown>((value, key) => value && typeof value === "object"
      ? (value as Record<string, unknown>)[key] : undefined, root) ?? null;
  const write = (path: string, value: unknown) => {
    const keys = path.split("/").filter(Boolean);
    let parent = root;
    for (const key of keys.slice(0, -1)) {
      parent[key] ??= {};
      parent = parent[key] as Record<string, unknown>;
    }
    if (value === null) delete parent[keys.at(-1)!];
    else parent[keys.at(-1)!] = structuredClone(value);
  };
  const snapshot = (path: string) => ({ val: () => structuredClone(read(path)), exists: () => read(path) !== null });
  return { root, read, write, snapshot, update: vi.fn(), transaction: vi.fn() };
});

vi.mock("firebase/database", () => ({
  get: async (reference: { path: string }) => memory.snapshot(reference.path),
  ref: (_database: unknown, path: string) => ({ path }),
  serverTimestamp: () => Date.now(),
  onValue: (_reference: unknown, callback: (snapshot: { val: () => number }) => void) => {
    callback({ val: () => 0 }); return () => undefined;
  },
  set: vi.fn(), update: memory.update,
}));
vi.mock("./client", () => ({ database: {}, rootRef: (path = "") => ({ path }) }));
vi.mock("./ready-transaction", () => ({ runReadyTransaction: memory.transaction }));
vi.mock("../client-release", () => ({ assertCurrentClientRelease: vi.fn().mockResolvedValue(undefined) }));


import { convertTrialCast, saveCast } from "./repository";
import type { CastRecord, IntroducerRecord } from "@/domain/gms";
import type { IntroducerEntryEvent } from "@/domain/month-accounting";

const user = { uid: "test-op" } as User;
const initialTime = "2026-09-02T03:00:00.000Z";
const intro: IntroducerRecord = { id: "intro-1", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
  entryAdvisoryEnabled: true, createdAt: initialTime, updatedAt: initialTime };
const trial: CastRecord = { id: "trial-1", name: "花子", legalName: "山田花子", status: "trial", trialDate: "2026-09-01",
  trialHourlyRate: 2000, hourlyRates: {}, introducerId: intro.id, createdAt: initialTime, updatedAt: initialTime };
const entryPath = (id: string) => "introducerEntryEvents/2026-09/" + id;
const getCast = (id: string) => ({ ...structuredClone(memory.read("casts/" + id) as CastRecord), id });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(initialTime));
  for (const key of Object.keys(memory.root)) delete memory.root[key];
  vi.clearAllMocks();
  memory.write("users/test-op/role", "op");
  memory.write("introducers/intro-1", intro);
  memory.write("casts/trial-1", trial);
  memory.transaction.mockImplementation(async (reference: { path: string }, callback: (value: unknown) => unknown) => {
    const value = callback(structuredClone(memory.read(reference.path)));
    if (value !== undefined) memory.write(reference.path, value);
    return { committed: value !== undefined, snapshot: memory.snapshot(reference.path) };
  });
  memory.update.mockImplementation(async (reference: { path: string }, plan: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(plan)) memory.write([reference.path, path].filter(Boolean).join("/"), value);
  });
});
afterEach(() => vi.useRealTimers());

async function converted() {
  const id = await convertTrialCast(trial.id, { ...trial, hiredAt: "2026-09-02", hourlyRates: { "2026-09": 3000 },
    entryAdvisoryFee: 30000, attendanceAdvisoryFee: 500 }, user);
  expect(memory.read(entryPath(id))).toMatchObject({ amount: 30000 });
  return getCast(id);
}

describe("在籍化後の入店顧問料0円訂正", () => {
  it.each(["2026-09-20T03:00:00.000Z", "2026-10-01T03:00:00.000Z"])("%sの保存で原本と0円履歴をまとめて更新する", async (time) => {
    const cast = await converted();
    const original = memory.read(entryPath(cast.id)) as IntroducerEntryEvent;
    vi.setSystemTime(new Date(time));
    await saveCast({ ...cast, entryAdvisoryFee: 0 }, user);
    expect(getCast(cast.id)).toMatchObject({ entryAdvisoryFee: 0, attendanceAdvisoryFee: 500, convertedFromTrialId: trial.id });
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 0, createdAt: original.createdAt, createdBy: original.createdBy, updatedBy: user.uid });
    expect(memory.update).toHaveBeenLastCalledWith({ path: "" }, expect.objectContaining({
      ["casts/" + cast.id]: expect.objectContaining({ entryAdvisoryFee: 0 }),
      [entryPath(cast.id)]: expect.objectContaining({ amount: 0 }),
    }));
    const zeroEvent = structuredClone(memory.read(entryPath(cast.id)));
    vi.setSystemTime(new Date("2026-10-02T03:00:00.000Z"));
    await saveCast({ ...getCast(cast.id), note: "備考のみ" }, user);
    expect(memory.read(entryPath(cast.id))).toEqual(zeroEvent);
  });

  it("旧処理でマスタだけ0円になった場合も再保存で採用月を訂正する", async () => {
    const cast = await converted();
    memory.write("casts/" + cast.id + "/entryAdvisoryFee", 0);
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    await saveCast({ ...getCast(cast.id), entryAdvisoryFee: 0 }, user);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 0 });
  });

  it("旧処理で取消し履歴が消えていた場合も0円を再保存できる", async () => {
    const cast = await converted();
    memory.write("casts/" + cast.id + "/entryAdvisoryFee", 0);
    memory.write(entryPath(cast.id), null);
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    await saveCast(getCast(cast.id), user);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 0, introducerId: intro.id });
  });

  it("元々0円で履歴がない確定済みキャストも備考は編集できる", async () => {
    const cast = await converted();
    memory.write("casts/" + cast.id + "/entryAdvisoryFee", 0);
    memory.write(entryPath(cast.id), null);
    memory.write("accountingMonthStates/2026-09", { status: "closed" });
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    await saveCast({ ...getCast(cast.id), note: "備考の訂正" }, user);
    expect(getCast(cast.id)).toMatchObject({ note: "備考の訂正", entryAdvisoryFee: 0 });
    expect(memory.read(entryPath(cast.id))).toBeNull();
  });

  it.each(["closing", "closed"])("採用月が%sなら翌月の0円訂正も拒否し元の値を保持する", async (status) => {
    const cast = await converted();
    memory.write("accountingMonthStates/2026-09", { status });
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    await expect(saveCast({ ...cast, entryAdvisoryFee: 0 }, user)).rejects.toThrow("月次確定処理中または確定済み");
    expect(getCast(cast.id).entryAdvisoryFee).toBe(30000);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 30000 });
  });

  it("他端末で更新されたキャストの0円訂正は拒否する", async () => {
    const cast = await converted();
    memory.write("casts/" + cast.id + "/updatedAt", "2026-09-10T03:00:00.000Z");
    await expect(saveCast({ ...cast, entryAdvisoryFee: 0 }, user)).rejects.toThrow("別の端末で更新");
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 30000 });
  });

  it("原子的保存が失敗したらマスタと入店顧問料をともに保持する", async () => {
    const cast = await converted();
    vi.setSystemTime(new Date("2026-09-20T03:00:00.000Z"));
    memory.update.mockRejectedValue(new Error("PERMISSION_DENIED"));
    await expect(saveCast({ ...cast, entryAdvisoryFee: 0 }, user)).rejects.toThrow("PERMISSION_DENIED");
    expect(getCast(cast.id).entryAdvisoryFee).toBe(30000);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 30000 });
  });

  it("翌月に別紹介者へ変更しても採用月の別紹介者の顧問料は変更しない", async () => {
    const cast = await converted();
    memory.write("introducers/intro-2", { ...intro, id: "intro-2", name: "別紹介者" });
    vi.setSystemTime(new Date("2026-10-01T03:00:00.000Z"));
    await saveCast({ ...cast, introducerId: "intro-2", entryAdvisoryFee: 0 }, user);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 30000, introducerId: intro.id });
  });
});
