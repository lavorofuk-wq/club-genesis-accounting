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


import { approveClosing, cancelCastConversion, convertTrialCast, departCast, restoreCast, saveCast } from "./repository";
import type { CastRecord, IntroducerRecord } from "@/domain/gms";
import type { IntroducerEntryEvent } from "@/domain/month-accounting";
import { castIntroducerOverrideForMonth, castTrialRateForMonth } from "@/domain/cast-monthly";

const user = { uid: "test-op" } as User;
const initialTime = "2026-09-02T03:00:00.000Z";
const intro: IntroducerRecord = { id: "intro-1", name: "紹介者", feeType: "sales10", attendanceAdvisoryEnabled: true,
  entryAdvisoryEnabled: true, note: "", createdAt: initialTime, updatedAt: initialTime };
const trial: CastRecord = { id: "trial-1", name: "花子", legalName: "山田花子", status: "trial", trialDate: "2026-09-01",
  trialHourlyRate: 2000, hourlyRates: {}, introducerId: intro.id, note: "", createdAt: initialTime, updatedAt: initialTime };
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

describe("キャストの月度管理", () => {
  it("体入時給の月度設定を旧単価と区別して保存する", async () => {
    await saveCast({ ...trial, trialHourlyRate: 2600 }, user, "2026-09");
    const updated = getCast(trial.id);
    expect(updated.trialHourlyRate).toBe(2000);
    expect(castTrialRateForMonth(updated, "2026-10")).toBe(2600);
  });

  it("翌月の時給と紹介者なしを保存し、採用月の時給・紹介者・顧問料は保持する", async () => {
    const cast = await converted();
    vi.setSystemTime(new Date("2026-10-02T03:00:00.000Z"));
    await saveCast({ ...cast, introducerId: undefined, hourlyRates: { "2026-10": 3400 } }, user, "2026-10");
    const updated = getCast(cast.id);
    expect(updated.hourlyRates).toEqual({ "2026-09": 3000, "2026-10": 3400 });
    expect(updated.introducerId).toBe(intro.id);
    expect(castIntroducerOverrideForMonth(updated, "2026-09")).toBeUndefined();
    expect(castIntroducerOverrideForMonth(updated, "2026-11")).toBe(false);
    expect(memory.read(entryPath(cast.id))).toMatchObject({ amount: 30000, introducerId: intro.id });
  });

  it("承認済みの同月体入勤務があれば退店を拒否し、承認待ちだけの翌月は退店できる", async () => {
    const cast = await converted();
    memory.write("history/approved", { businessDate: "2026-09-01", status: "approved",
      casts: [{ kind: "trial", masterId: trial.id, name: trial.name, hours: 2 }] });
    memory.write("history/submitted", { businessDate: "2026-10-03", status: "submitted",
      casts: [{ kind: "regular", masterId: cast.id, name: cast.name, hours: 2 }] });
    await expect(departCast(cast.id, "2026-09-30", cast.updatedAt, user)).rejects.toThrow("承認済みの勤務実績");
    expect(getCast(cast.id).status).toBe("active");
    expect(memory.read("castDepartureLock")).toBeNull();
    await departCast(cast.id, "2026-10-20", cast.updatedAt, user);
    expect(getCast(cast.id)).toMatchObject({ status: "departed", departedAt: "2026-10-20" });
    expect(memory.read("castDepartureLock")).toBeNull();
  });
});
afterEach(() => vi.useRealTimers());

async function converted() {
  const id = await convertTrialCast(trial.id, { ...trial, hiredAt: "2026-09-02", hourlyRates: { "2026-09": 3000 },
    entryAdvisoryFee: 30000, attendanceAdvisoryFee: 500 }, user);
  expect(memory.read(entryPath(id))).toMatchObject({ amount: 30000 });
  return getCast(id);
}

const activeRegistration = {
  name: trial.name, legalName: trial.legalName, status: "active" as const, hiredAt: "2026-09-03",
  hourlyRates: { "2026-09": 3000 }, note: "",
};

function existingNameClaimPath() {
  return "castNameClaims/" + Object.keys(memory.root.castNameClaims as Record<string, unknown>)[0]!;
}

describe("入店取消", () => {
  it("承認済み体入・未承認在籍の日次を保持したまま元の体入IDへ戻し、同名で入店し直せる", async () => {
    const active = await converted();
    const trialDay = { businessDate: "2026-09-01", status: "approved",
      casts: [{ kind: "trial", masterId: trial.id, hours: 2, hourlyRate: 2000, dailyPayment: 4000 }] };
    const unapprovedDay = { businessDate: "2026-09-02", status: "submitted", updatedAt: initialTime,
      checksum: "checksum", submissionId: "submission", casts: [{ kind: "regular", masterId: active.id, hours: 2 }] };
    memory.write("history/trial-day", trialDay);
    memory.write("history/unapproved-day", unapprovedDay);
    vi.setSystemTime(new Date("2026-09-03T03:00:00.000Z"));

    await cancelCastConversion(active.id, active.updatedAt, user);

    const restored = getCast(trial.id);
    expect(restored).toMatchObject({ status: "trial", trialDate: trial.trialDate, trialHourlyRate: trial.trialHourlyRate });
    expect(restored.convertedToCastId).toBeUndefined();
    expect(getCast(active.id)).toMatchObject({ entryCancelledAt: expect.any(String), deletedAt: expect.any(String), deletedBy: user.uid });
    expect(memory.read("history/trial-day")).toEqual(trialDay);
    expect(memory.read("history/unapproved-day")).toEqual(unapprovedDay);
    expect(memory.read(entryPath(active.id))).toMatchObject({ amount: 30000 });
    expect(memory.read("cashManagementLock")).toBeNull();

    await expect(approveClosing("unapproved-day", unapprovedDay, user)).rejects.toThrow("入店取消済みの在籍キャスト");
    expect(memory.read("history/unapproved-day")).toEqual(unapprovedDay);
    const nextEntry = {
      ...restored, hiredAt: "2026-09-03", hourlyRates: { "2026-09": 3000 },
    };
    memory.write("accountingMonthStates/2026-09", { status: "closed" });
    await expect(convertTrialCast(trial.id, nextEntry, user, "2026-09")).rejects.toThrow("先に月次確定を解除");
    expect(getCast(trial.id).convertedToCastId).toBeUndefined();
    memory.write("accountingMonthStates/2026-09", { status: "open" });
    const nextId = await convertTrialCast(trial.id, nextEntry, user, "2026-09");
    expect(nextId).not.toBe(active.id);
    expect(getCast(trial.id).convertedToCastId).toBe(nextId);
  });

  it.each(["入店", "新規在籍", "退店取消"])("%sでは取消時の通信断で残った名義を回収できる", async (operation) => {
    const active = await converted();
    const claimPath = existingNameClaimPath();
    const staleClaim = operation === "新規在籍" ? active.id : { id: active.id, state: "committed" };
    memory.write(claimPath, staleClaim);
    vi.setSystemTime(new Date("2026-09-04T03:00:00.000Z"));
    const transact = memory.transaction.getMockImplementation()!;
    memory.transaction.mockImplementation(async (reference, callback) => {
      if (reference.path === claimPath) throw new Error("通信断");
      return transact(reference, callback);
    });
    await expect(cancelCastConversion(active.id, active.updatedAt, user)).rejects.toThrow("旧い重複防止情報を解放");
    expect(getCast(active.id)).toMatchObject({ entryCancelledAt: expect.any(String), deletedAt: expect.any(String) });
    expect(memory.read(claimPath)).toEqual(staleClaim);
    memory.transaction.mockImplementation(transact);

    let nextId: string;
    if (operation === "入店") {
      nextId = await convertTrialCast(trial.id, { ...getCast(trial.id), ...activeRegistration }, user, "2026-09");
    } else if (operation === "退店取消") {
      nextId = "departed-same-name";
      memory.write("casts/" + nextId, { ...activeRegistration, status: "departed", hiredAt: "2026-09-01",
        departedAt: "2026-09-02", createdAt: initialTime, updatedAt: initialTime });
      await restoreCast(nextId, initialTime, user);
    } else {
      nextId = await saveCast(activeRegistration, user, "2026-09");
    }
    expect(nextId).not.toBe(active.id);
    expect(getCast(nextId).status).toBe("active");
    expect(memory.read(claimPath)).toEqual({ id: nextId, state: "committed" });
  });

  it("通常の論理削除に紐づく名義は回収しない", async () => {
    const active = await converted();
    const claimPath = existingNameClaimPath();
    memory.write("casts/" + active.id + "/deletedAt", initialTime);
    await expect(saveCast(activeRegistration, user, "2026-09")).rejects.toThrow("同じキャスト名の在籍キャスト");
    expect(memory.read(claimPath)).toEqual({ id: active.id, state: "committed" });
  });

  it("名義の回収前に別のキャストが取得した場合はその名義を保持する", async () => {
    const active = await converted();
    const claimPath = existingNameClaimPath();
    memory.write("casts/" + active.id, { ...active, deletedAt: initialTime, entryCancelledAt: initialTime });
    const nextClaim = { id: "another-owner", state: "committed" };
    const transact = memory.transaction.getMockImplementation()!;
    let claimAttempts = 0;
    memory.transaction.mockImplementation(async (reference, callback) => {
      if (reference.path === claimPath && ++claimAttempts === 2) memory.write(claimPath, nextClaim);
      return transact(reference, callback);
    });
    await expect(saveCast(activeRegistration, user, "2026-09")).rejects.toThrow("同じキャスト名の在籍キャスト");
    expect(memory.read(claimPath)).toEqual(nextClaim);
  });

  it("別月の承認済み在籍勤務があれば元の入店登録を保持する", async () => {
    const active = await converted();
    memory.write("history/regular-day", { businessDate: "2026-10-05", status: "approved",
      casts: [{ kind: "regular", masterId: active.id, hours: 2 }] });

    await expect(cancelCastConversion(active.id, active.updatedAt, user)).rejects.toThrow("承認済みの在籍勤務");

    expect(getCast(active.id).deletedAt).toBeUndefined();
    expect(getCast(trial.id).convertedToCastId).toBe(active.id);
    expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("取消の一括保存が拒否されたときは双方の元データを保持し、日次ロックを解放する", async () => {
    const active = await converted();
    const originalTrial = getCast(trial.id);
    memory.update.mockRejectedValue(new Error("PERMISSION_DENIED"));

    await expect(cancelCastConversion(active.id, active.updatedAt, user)).rejects.toThrow("PERMISSION_DENIED");

    expect(getCast(active.id)).toEqual(active);
    expect(getCast(trial.id)).toEqual(originalTrial);
    expect(memory.read("cashManagementLock")).toBeNull();
  });

  it("本人が載る後月の現行確定名簿を全て示し、旧版・同名別人・名簿未保存を含めない", async () => {
    const active = await converted();
    const rosterPath = (month: string, revision: number) => `accountingMonthSnapshots/${month}/${revision}/castSalesRankingRoster`;
    const setState = (month: string, status: "closed" | "open") =>
      memory.write(`accountingMonthStates/${month}`, { status, currentSnapshotRevision: 2 });
    const entry = { id: active.id, name: "確定時の名前" };
    setState("2026-10", "closed");
    memory.write(rosterPath("2026-10", 2), { schemaVersion: 1, entries: [entry] });
    setState("2026-11", "closed");
    memory.write(rosterPath("2026-11", 2), { schemaVersion: 1, entries: { 0: entry } });
    setState("2026-12", "closed");
    memory.write(rosterPath("2026-12", 1), { schemaVersion: 1, entries: [entry] });
    setState("2027-01", "closed");
    memory.write(rosterPath("2027-01", 2), { schemaVersion: 1, entries: [{ id: "other", name: active.name }] });

    await expect(cancelCastConversion(active.id, active.updatedAt, user)).rejects.toThrow(
      "2026-10月度、2026-11月度は月次確定処理中または確定済みです。先に月次確定を解除してください。",
    );
    expect(getCast(active.id).entryCancelledAt).toBeUndefined();
    expect(getCast(trial.id).convertedToCastId).toBe(active.id);
    expect(memory.read("cashManagementLock")).toBeNull();

    setState("2026-10", "open");
    setState("2026-11", "open");
    await cancelCastConversion(active.id, active.updatedAt, user);
    expect(getCast(trial.id).convertedToCastId).toBeUndefined();
    expect(memory.read(rosterPath("2026-10", 2))).toEqual({ schemaVersion: 1, entries: [entry] });
  });

  it.each(["closing", "closed"])("採用月が%sなら月次確定の解除を要求する", async (status) => {
    const active = await converted();
    memory.write("accountingMonthStates/2026-09", { status });

    await expect(cancelCastConversion(active.id, active.updatedAt, user)).rejects.toThrow("先に月次確定を解除");

    expect(getCast(active.id).entryCancelledAt).toBeUndefined();
    expect(getCast(trial.id).convertedToCastId).toBe(active.id);
    expect(memory.read("cashManagementLock")).toBeNull();
  });
});

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
