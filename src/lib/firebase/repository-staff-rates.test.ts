import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import type { StaffRecord } from "@/domain/gms";

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

import { convertTrialStaff, saveStaff } from "./repository";

const user = { uid: "test-op" } as User;
const timestamp = "2026-09-01T12:00:00.000Z";
const member: StaffRecord = { id: "staff-1", name: "スタッフ", status: "active", hiredAt: "2026-08-01",
  hourlyRate: 1500, note: "", createdAt: timestamp, updatedAt: timestamp };
const trial: StaffRecord = { id: "trial-1", name: "体入スタッフ", status: "trial", trialDate: "2026-09-01",
  trialHourlyRate: 1603, note: "", createdAt: timestamp, updatedAt: timestamp };

beforeEach(() => {
  for (const key of Object.keys(memory.root)) delete memory.root[key];
  vi.clearAllMocks();
  memory.write("users/test-op/role", "op");
  memory.transaction.mockImplementation(async (reference: { path: string }, callback: (value: unknown) => unknown) => {
    const value = callback(structuredClone(memory.read(reference.path)));
    if (value !== undefined) memory.write(reference.path, value);
    return { committed: value !== undefined, snapshot: memory.snapshot(reference.path) };
  });
  memory.update.mockImplementation(async (reference: { path: string }, plan: Record<string, unknown>) => {
    for (const [path, value] of Object.entries(plan)) memory.write([reference.path, path].filter(Boolean).join("/"), value);
  });
});

describe("スタッフ月度時給の保存・移行", () => {
  it("初回に10月を保存しても9月初期単価を保持し、旧単価と確定値は変更しない", async () => {
    memory.write("staff/staff-1", member);
    const snapshot = { staffPayroll: [{ hourly: 9000, daily: 3000, net: 6000 }] };
    memory.write("accountingMonthlySnapshots/2026-08/1", snapshot);
    await saveStaff({ ...member, hourlyRates: { "2026-10": 1800 } }, user);
    expect(memory.read("staff/staff-1")).toMatchObject({ hourlyRate: 1500,
      hourlyRates: { "2026-09": 1500, "2026-10": 1800 } });
    expect(memory.read("accountingMonthlySnapshots/2026-08/1")).toEqual(snapshot);
  });

  it("初回9月変更では9月単価だけ置換し、旧単価は保持する", async () => {
    memory.write("staff/staff-1", member);
    await saveStaff({ ...member, hourlyRates: { "2026-09": 1800 } }, user);
    expect(memory.read("staff/staff-1")).toMatchObject({ hourlyRate: 1500, hourlyRates: { "2026-09": 1800 } });
  });

  it("既存月を省略した更新でも月度履歴を落とさない", async () => {
    const existing = { ...member, hourlyRates: { "2026-09": 1500, "2026-10": 1800 } };
    memory.write("staff/staff-1", existing);
    await saveStaff({ ...member, hourlyRates: { "2026-11": 1900 } }, user);
    expect(memory.read("staff/staff-1")).toMatchObject({ hourlyRates: { "2026-09": 1500, "2026-10": 1800, "2026-11": 1900 } });
  });

  it("旧画面の単一時給変更を拒否し、備考だけの編集は移行して保存する", async () => {
    memory.write("staff/staff-1", member);
    await expect(saveStaff({ ...member, hourlyRate: 1800 }, user)).rejects.toThrow("月度時給から変更");
    expect(memory.read("staff/staff-1")).toEqual(member);
    await saveStaff({ ...member, note: "備考更新" }, user);
    expect(memory.read("staff/staff-1")).toMatchObject({ note: "備考更新", hourlyRate: 1500, hourlyRates: { "2026-09": 1500 } });
  });

  it("採用月が10月の旧マスタは9月へ遡って初期登録しない", async () => {
    const existing = { ...member, hiredAt: "2026-10-01" };
    memory.write("staff/staff-1", existing);
    await saveStaff({ ...existing, hourlyRates: { "2026-11": 1800 } }, user);
    expect(memory.read("staff/staff-1")).toMatchObject({ hourlyRates: { "2026-10": 1500, "2026-11": 1800 } });
  });

  it.each([{ "2026-09": 0 }, { "2026-08": 1500 }, { "2026-13": 1500 }, { "2026-09": 1500.5 }, { "2026-09": Number.MAX_SAFE_INTEGER + 1 }] as Array<Record<string, number>>)("不正月度設定を保存しない %#", async (hourlyRates) => {
    memory.write("staff/staff-1", member);
    await expect(saveStaff({ ...member, hourlyRates }, user)).rejects.toThrow();
    expect(memory.read("staff/staff-1")).toEqual(member);
  });

  it("新規在籍登録は月度設定が必要で、monthly-onlyを保存できる", async () => {
    await expect(saveStaff({ name: "新規", status: "active", hiredAt: "2026-09-01", hourlyRate: 1500 }, user)).rejects.toThrow("月度時給");
    const id = await saveStaff({ name: "新規", status: "active", hiredAt: "2026-09-01", hourlyRates: { "2026-09": 1500 } }, user);
    expect(memory.read(`staff/${id}`)).toMatchObject({ name: "新規", hourlyRates: { "2026-09": 1500 } });
  });

  it("体入時給は月度化せず維持する", async () => {
    memory.write("staff/trial-1", trial);
    await saveStaff({ ...trial, note: "体入備考" }, user);
    expect(memory.read("staff/trial-1")).toMatchObject({ trialHourlyRate: 1603, note: "体入備考" });
    expect(memory.read("staff/trial-1/hourlyRates")).toBeNull();
  });

  it("体入在籍化は月度時給が必要で、体入元の時給を保存する", async () => {
    memory.write("staff/trial-1", trial);
    await expect(convertTrialStaff(trial.id, { hiredAt: "2026-09-02", hourlyRate: 1800, updatedAt: timestamp }, user)).rejects.toThrow("月度時給");
    const id = await convertTrialStaff(trial.id, { hiredAt: "2026-09-02", hourlyRates: { "2026-09": 1800 }, updatedAt: timestamp }, user);
    expect(memory.read(`staff/${id}`)).toMatchObject({ status: "active", convertedFromTrialId: trial.id,
      trialHourlyRate: 1603, hourlyRates: { "2026-09": 1800 } });
    expect(memory.read("staff/trial-1")).toMatchObject({ status: "trial", trialHourlyRate: 1603, convertedToStaffId: id });
  });
});
