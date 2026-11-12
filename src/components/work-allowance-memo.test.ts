import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, drafts: new Map<string, unknown>() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T | ((old: T) => T)) => {
        hooks.values[index] = typeof value === "function" ? (value as (old: T) => T)(hooks.values[index] as T) : value;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useMemo: <T,>(factory: () => T, dependencies: readonly unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.values[index] as { value: T; dependencies: readonly unknown[] } | undefined;
      if (!previous || previous.dependencies.length !== dependencies.length || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        hooks.values[index] = { value: factory(), dependencies: [...dependencies] };
      }
      return (hooks.values[index] as { value: T }).value;
    },
    useEffect: () => {}, useId: () => "work-allowance-memo",
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T) => {
    if (!hooks.drafts.has(key)) hooks.drafts.set(key, initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => {
      hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value);
    }];
  },
  useUpdateDraftBusy: vi.fn(),
}));
vi.mock("@/lib/firebase/repository", () => ({
  saveBeautyAllowanceDay: vi.fn(), saveCastTransportDay: vi.fn(), saveDriverTransportDay: vi.fn(), saveTransportSettings: vi.fn(),
}));
vi.mock("@/domain/beauty-allowance", async (original) => {
  const actual = await original<typeof import("@/domain/beauty-allowance")>();
  return { ...actual, beautyAttendance: vi.fn(actual.beautyAttendance), beautyCastDays: vi.fn(actual.beautyCastDays), normalizeBeautyMonth: vi.fn(actual.normalizeBeautyMonth) };
});
vi.mock("@/domain/transport", async (original) => {
  const actual = await original<typeof import("@/domain/transport")>();
  return { ...actual, transportAttendance: vi.fn(actual.transportAttendance), transportCastDays: vi.fn(actual.transportCastDays),
    transportUnresolvedLegacyInputs: vi.fn(actual.transportUnresolvedLegacyInputs), normalizeTransportMonth: vi.fn(actual.normalizeTransportMonth), normalizeTransportSettings: vi.fn(actual.normalizeTransportSettings) };
});

import { beautyAttendance, beautyCastDays, normalizeBeautyMonth } from "@/domain/beauty-allowance";
import { transportAttendance, transportCastDays, transportUnresolvedLegacyInputs, normalizeTransportMonth, normalizeTransportSettings } from "@/domain/transport";
import { BeautyAllowanceWork, beautySourceKey } from "./beauty-allowance-work";
import { TransportWork, transportSourceKey } from "./transport-work";

type Kind = "beauty" | "transport";
const month = "2026-10";
const user = { uid: "shop" } as Parameters<typeof TransportWork>[0]["user"];
const run = vi.fn(async () => true);
const spies = (kind: Kind) => kind === "beauty"
  ? [beautyAttendance, beautyCastDays, normalizeBeautyMonth]
  : [transportAttendance, transportCastDays, transportUnresolvedLegacyInputs, normalizeTransportMonth, normalizeTransportSettings];
const counts = (kind: Kind) => spies(kind).map((fn) => vi.mocked(fn).mock.calls.length);
function fixture(): AccountingWorkspaceData {
  return {
    casts: [{ id: "cast", name: "あい" }, { id: "other", name: "ゆり" }].map((cast) => ({
      ...cast, status: "active", hiredAt: "2026-09-01", legalName: "", hourlyRates: { [month]: 3000 }, note: "",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    })),
    archivedCasts: [], archivedStaff: [], staff: [], drivers: [], introducers: [], liquor: [], closings: [], adjustments: [],
    monthStates: [], monthSnapshots: [], introducerEntryEvents: [], introducerDeletionCommits: [], introducerMonthEvents: [], cashFloat: 200000,
    transportSettings: { revision: 1, castRegistrations: { cast: { amounts: [500] }, other: { amounts: [500] } }, remoteAmounts: [500] },
    transportMonths: { [month]: { revision: 1, casts: {}, drivers: {} } }, transportLegacyInputs: {}, transportLegacyRemote: {},
    beautyMonths: { [month]: { revision: 1, casts: {} } },
  };
}
function render(kind: Kind, data: AccountingWorkspaceData, busy = false) {
  hooks.cursor = 0;
  return kind === "beauty" ? BeautyAllowanceWork({ data, user, busy, run }) : TransportWork({ data, user, busy, run });
}
function panel(kind: Kind, data: AccountingWorkspaceData, id = "cast") {
  const context = kind === "beauty" ? beautySourceKey(data, month) : transportSourceKey(data, month);
  hooks.drafts.set(`store.${kind}.panel`, kind === "beauty"
    ? { id, date: "", eligible: null, originalEligible: null, hadRecord: false, revision: 1, context }
    : { type: "calendar", kind: "cast", id, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false, revision: 1, context });
}
beforeEach(() => {
  vi.clearAllMocks(); hooks.values = []; hooks.cursor = 0; hooks.drafts.clear();
  hooks.drafts.set("store.beauty.month", month); hooks.drafts.set("store.transport.month", month);
});

describe.each<Kind>(["beauty", "transport"])("%s 一覧計算の再利用", (kind) => {
  it("保存中の表示変更だけでは一覧・月記録・本人出勤を再集計しない", () => {
    const data = fixture(); panel(kind, data); render(kind, data);
    const before = counts(kind);
    render(kind, data, true); render(kind, data, false);
    expect(counts(kind)).toEqual(before);
    expect(vi.mocked(kind === "beauty" ? beautyCastDays : transportCastDays)).toHaveBeenCalled();
  });
  it("日付・入力値だけが変わっても月間一覧を再集計しない", () => {
    const data = fixture(); panel(kind, data); render(kind, data);
    const before = counts(kind);
    const key = `store.${kind}.panel`;
    hooks.drafts.set(key, { ...(hooks.drafts.get(key) as Record<string, unknown>), date: month + "-02", eligible: true, amount: 500 });
    render(kind, data);
    expect(counts(kind)).toEqual(before);
  });
  it("保存データの更新・対象月の変更は再集計する", () => {
    const data = fixture(); render(kind, data);
    const days = vi.mocked(kind === "beauty" ? beautyCastDays : transportCastDays);
    const before = days.mock.calls.length;
    const next = { ...data, casts: data.casts.map((cast) => ({ ...cast, name: cast.name + "更新" })) };
    render(kind, next);
    expect(days.mock.calls.length).toBeGreaterThan(before);
    const after = days.mock.calls.length;
    hooks.drafts.set(`store.${kind}.month`, "2026-11"); render(kind, next);
    expect(days.mock.calls.length).toBeGreaterThan(after);
    expect(days.mock.calls.at(-1)?.[1]).toBe("2026-11");
  });
  it("選択キャストが変わったら本人の出勤・日別額を更新する", () => {
    const data = fixture(); panel(kind, data); render(kind, data);
    const attendance = vi.mocked(kind === "beauty" ? beautyAttendance : transportAttendance);
    const days = vi.mocked(kind === "beauty" ? beautyCastDays : transportCastDays);
    const before = attendance.mock.calls.length;
    panel(kind, data, "other"); render(kind, data);
    expect(attendance.mock.calls.length).toBeGreaterThan(before);
    expect(attendance.mock.calls.at(-1)?.[2]).toBe("other");
    expect(days.mock.calls.at(-1)?.[2]).toBe("other");
  });
});
