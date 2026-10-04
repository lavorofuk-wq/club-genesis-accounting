import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, drafts: new Map<string, unknown>(), serial: 0,
  days: {} as Record<string, Array<{ businessDate: string; amount: number; legacyInputIds: string[]; hasRecord: boolean }>>,
  attendance: {} as Record<string, string[]>, unresolved: {} as Record<string, Array<{ id: string; label: string; amount: number }>> }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: <T,>(initial: T | (() => T)) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T | ((old: T) => T)) => { hooks.values[index] = typeof value === "function" ? (value as (old: T) => T)(hooks.values[index] as T) : value; }]; },
    useRef: <T,>(initial: T) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
    useMemo: <T,>(factory: () => T) => factory(), useEffect: () => {}, useId: () => "transport-test",
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T) => { if (!hooks.drafts.has(key)) hooks.drafts.set(key, initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value)]; },
  useUpdateDraftBusy: vi.fn(),
}));
vi.mock("@/lib/firebase/repository", () => ({ saveCastTransportDay: vi.fn(), saveDriverTransportDay: vi.fn(), saveTransportSettings: vi.fn() }));
vi.mock("@/lib/crypto-compat", () => ({ secureRandomUUID: () => "new_" + (++hooks.serial) }));
vi.mock("@/domain/transport", async (original) => {
  const actual = await original<typeof import("@/domain/transport")>();
  return { ...actual, transportAttendance: (_data: unknown, _month: string, id: string) => (hooks.attendance[id] || []).map((businessDate) => ({ businessDate, closingId: "closing", index: 0 })),
    transportCastDays: (_data: unknown, _month: string, id: string) => hooks.days[id] || [], transportUnresolvedLegacyInputs: (_data: unknown, _month: string, id: string) => hooks.unresolved[id] || [] };
});
import { saveCastTransportDay, saveDriverTransportDay, saveTransportSettings } from "@/lib/firebase/repository";
import { TransportWork, TransportCalendar, TransportAmountChoices, transportCalendarCells, shiftTransportMonth, transportSourceKey } from "./transport-work";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

type Element = ReactElement<Record<string, any>>;
type Props = Parameters<typeof TransportWork>[0];
const month = "2026-10";
const date = month + "-02";
const user = { uid: "shop" } as Props["user"];
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const value = node as Element; return [value, ...elements(value.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || !("props" in node)) return "";
  const value = node as Element; return (value.props.title || "") + text(value.props.children);
}
function find(node: ReactNode, predicate: (element: Element) => boolean) { const value = elements(node).find(predicate); if (!value) throw new Error("対象の要素がありません"); return value; }
const button = (node: ReactNode, label: string) => find(node, (row) => row.type === "button" && text(row.props.children) === label);
const component = (node: ReactNode, type: unknown) => find(node, (row) => row.type === type);
const panel = () => hooks.drafts.get("store.transport.panel") as Record<string, any> | null;
function fixture(): AccountingWorkspaceData {
  return { casts: [{ id: "cast", name: "あい", status: "active" }, { id: "legacy", name: "旧記録あり", status: "active" }],
    archivedCasts: [], drivers: [{ id: "driver", name: "運転手", status: "active" }], closings: [], adjustments: [], monthStates: [], monthSnapshots: [],
    transportSettings: { revision: 4, castRegistrations: { cast: { amounts: [500, 1000] } }, remoteAmounts: [500, 1500] },
    transportMonths: { [month]: { revision: 8, casts: {}, drivers: {} } }, transportLegacyInputs: {}, transportLegacyRemote: {},
  } as unknown as AccountingWorkspaceData;
}
const run: Props["run"] = async (action) => { try { await action(); return true; } catch { return false; } };
function render(data = fixture(), busy = false, action = run) { hooks.cursor = 0; return TransportWork({ data, user, busy, run: action }); }
function openCalendar(data: AccountingWorkspaceData, kind: "cast" | "driver" = "cast", id = kind === "cast" ? "cast" : "driver") {
  hooks.drafts.set("store.transport.panel", { type: "calendar", kind, id, date: "", amount: null, originalAmount: null, entries: {}, originalEntries: {}, hadRecord: false,
    revision: 8, context: transportSourceKey(data, month) });
  component(render(data), TransportCalendar).props.onSelect(date);
}
function chooseAmount(data: AccountingWorkspaceData, amount: number) { component(render(data), TransportAmountChoices).props.onSelect(amount); }
beforeEach(() => {
  vi.clearAllMocks(); hooks.values = []; hooks.cursor = 0; hooks.serial = 0; hooks.drafts.clear(); hooks.drafts.set("store.transport.month", month);
  hooks.days = {}; hooks.unresolved = {}; hooks.attendance = { cast: [date], legacy: [date], driver: [date] };
  vi.mocked(saveCastTransportDay).mockReset(); vi.mocked(saveDriverTransportDay).mockReset(); vi.mocked(saveTransportSettings).mockReset();
});

describe("送迎カレンダー", () => {
  it("閏年と前後月を扱い、出勤日と記録日だけ選択できる", () => {
    expect(transportCalendarCells("2028-02").filter(Boolean)).toHaveLength(29);
    expect(transportCalendarCells("2026-02").filter(Boolean)).toHaveLength(28);
    expect(shiftTransportMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftTransportMonth("2026-12", 1)).toBe("2027-01");
    const selected = vi.fn();
    const node = TransportCalendar({ month, attendance: [date], records: { "2026-10-03": { amount: 1500, count: 2 } }, selected: date, disabled: false, onSelect: selected });
    const day = (value: string) => find(node, (row) => row.type === "button" && row.props["aria-label"].startsWith(value));
    expect(day(date).props["aria-pressed"]).toBe(true);
    expect(day("2026-10-01").props.disabled).toBe(true);
    day("2026-10-01").props.onClick(); expect(selected).not.toHaveBeenCalled();
    expect(day("2026-10-03").props["aria-label"]).toContain("2件");
    day("2026-10-03").props.onClick(); expect(selected).toHaveBeenCalledWith("2026-10-03");
  });
  it("候補金額は指定の4種類で、無効時にイベントを実行しない", () => {
    const select = vi.fn();
    const node = TransportAmountChoices({ selected: [500, 1500], multiple: true, disabled: true, onSelect: select });
    const buttons = elements(node).filter((row) => row.type === "button");
    expect(buttons).toHaveLength(4); expect(buttons.filter((row) => row.props["aria-pressed"])).toHaveLength(2);
    buttons.forEach((row) => row.props.onClick()); expect(select).not.toHaveBeenCalled();
  });
});

describe("送迎登録・記録の操作", () => {
  it("旧記録のある未登録キャストを表示し、旧合計から選択した1日額へ編集する", async () => {
    const data = fixture(); hooks.days.legacy = [{ businessDate: date, amount: 2500, legacyInputIds: ["old"], hasRecord: true }];
    expect(text(render(data))).toContain("旧記録あり"); expect(text(render(data))).toContain("送迎記録あり・未登録");
    openCalendar(data, "cast", "legacy"); expect(panel()?.amount).toBe(2500);
    expect(component(render(data), TransportAmountChoices).props.amounts).toEqual([500, 1000, 1500, 2000]);
    chooseAmount(data, 1500); button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveCastTransportDay).toHaveBeenCalledExactlyOnceWith(month, "legacy", date, 1500, 8, user));
  });
  it("対象月に旧送迎記録があると登録削除をシステム内警告で止める", () => {
    const data = fixture(); hooks.days.cast = [{ businessDate: date, amount: 500, legacyInputIds: [], hasRecord: true }];
    hooks.drafts.set("store.transport.panel", { type: "castInfo", id: "cast", amounts: [500, 1000], original: [500, 1000], revision: 4, context: transportSourceKey(data, month) });
    button(render(data), "送迎登録を削除").props.onClick();
    expect(text(render(data))).toContain("当月に送迎記録があるため削除できません");
    expect(saveTransportSettings).not.toHaveBeenCalled();
  });
  it("未保存の月移動はモーダル確認し、取消で入力を保持する", () => {
    const data = fixture(); openCalendar(data); chooseAmount(data, 1000);
    find(render(data), (row) => row.type === "input" && row.props.type === "month").props.onChange({ target: { value: "2026-11" } });
    expect(text(render(data))).toContain("保存していない入力を破棄して移動しますか");
    button(render(data), "戻る").props.onClick();
    expect(panel()?.amount).toBe(1000); expect(hooks.drafts.get("store.transport.month")).toBe(month);
    find(render(data), (row) => row.type === "input" && row.props.type === "month").props.onChange({ target: { value: "2026-11" } });
    button(render(data), "破棄して移動").props.onClick();
    expect(hooks.drafts.get("store.transport.month")).toBe("2026-11"); expect(panel()?.date).toBe("");
  });
  it.each(["busy", "closed", "closing", "stale"] as const)("%sでは記録保存イベントを直接呼んでも保存しない", (mode) => {
    const data = fixture(); openCalendar(data); chooseAmount(data, 1000);
    if (mode === "closed" || mode === "closing") data.monthStates = [{ month, status: mode, revision: 1 }] as never;
    if (mode === "stale") data.transportMonths![month].revision++;
    const node = render(data, mode === "busy");
    const save = button(node, "記録を保存"); expect(save.props.disabled).toBe(true); save.props.onClick();
    expect(saveCastTransportDay).not.toHaveBeenCalled(); expect(panel()?.amount).toBe(1000);
  });
  it("保存エラー時に記録の入力と元の版を保持する", async () => {
    const data = fixture(); openCalendar(data); chooseAmount(data, 1000);
    vi.mocked(saveCastTransportDay).mockRejectedValue(new Error("他の端末で更新されました"));
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(text(render(data))).toContain("他の端末で更新されました"));
    expect(panel()?.amount).toBe(1000); expect(panel()?.revision).toBe(8);
  });
  it("同一日の遠方手当を同じ金額でも別の明細として追加する", async () => {
    const data = fixture(); data.transportLegacyRemote = { [month]: { driver: 3000 } };
    openCalendar(data, "driver"); chooseAmount(data, 500); chooseAmount(data, 500);
    expect(panel()?.entries).toEqual({ new_1: 500, new_2: 500 });
    expect(text(render(data))).toContain("既存の月額遠方手当");
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveDriverTransportDay).toHaveBeenCalledExactlyOnceWith(month, "driver", date, { new_1: 500, new_2: 500 }, 8, user));
    expect(data.transportLegacyRemote[month].driver).toBe(3000);
  });
  it("遠方手当の一つを変更・削除しても同日別明細を保持する", async () => {
    const data = fixture(); data.transportMonths![month].drivers.driver = { [date]: { entries: { one: 500, two: 1500, three: 500 }, attendanceClosingId: "closing", attendanceIndex: 0 } };
    openCalendar(data, "driver");
    find(render(data), (row) => row.type === "select" && row.props["aria-label"] === "1件目の遠方手当").props.onChange({ target: { value: "1500" } });
    find(render(data), (row) => row.type === "button" && row.props["aria-label"] === "2件目の遠方手当を削除").props.onClick();
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveDriverTransportDay).toHaveBeenCalledWith(month, "driver", date, { one: 1500, three: 500 }, 8, user));
    expect(data.transportMonths![month].drivers.driver[date].entries).toEqual({ one: 500, two: 1500, three: 500 });
  });
  it("記録済み送迎は削除確認後に0を保存し、元の旧記録を直接変更しない", async () => {
    const data = fixture(); hooks.days.cast = [{ businessDate: date, amount: 1500, legacyInputIds: ["legacy"], hasRecord: true }];
    openCalendar(data); button(render(data), "この日の記録を削除").props.onClick();
    expect(saveCastTransportDay).not.toHaveBeenCalled(); button(render(data), "削除する").props.onClick();
    await vi.waitFor(() => expect(saveCastTransportDay).toHaveBeenCalledExactlyOnceWith(month, "cast", date, 0, 8, user));
    expect(hooks.days.cast[0].amount).toBe(1500);
  });
});


describe("日付未解決の旧送迎・継続入力", () => {
  it("日付未解決の旧送迎を隠さず、カレンダーに推測日付を作らず登録削除を止める", () => {
    const data = fixture(); hooks.unresolved.cast = [{ id: "unknown", label: "保存済み送迎代", amount: 2500 }];
    expect(text(render(data))).toContain("日付確認待ち");
    openCalendar(data); expect(text(render(data))).toContain("日付を確認できない送迎代");
    expect(component(render(data), TransportCalendar).props.records).toEqual({});
    hooks.drafts.set("store.transport.panel", { type: "castInfo", id: "cast", amounts: [500, 1000], original: [500, 1000], revision: 4, context: transportSourceKey(data, month) });
    button(render(data), "送迎登録を削除").props.onClick();
    expect(text(render(data))).toContain("当月に送迎記録があるため削除できません");
    expect(saveTransportSettings).not.toHaveBeenCalled();
  });
  it("記録保存後は同じキャストのカレンダーで次の日を続けて入力できる", async () => {
    const data = fixture(); openCalendar(data); chooseAmount(data, 500);
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(panel()?.date).toBe(""));
    expect(panel()?.type).toBe("calendar"); expect(panel()?.id).toBe("cast");
    data.transportMonths![month].revision = 9;
    expect(text(render(data))).not.toContain("元データが更新されました");
    component(render(data), TransportCalendar).props.onSelect(date);
    expect(panel()?.revision).toBe(9);
  });
  it("遠方手当候補の変更は既存のキャスト設定を保ち、設定世代を渡す", async () => {
    const data = fixture(); button(render(data), "遠方手当").props.onClick();
    chooseAmount(data, 1000); button(render(data), "設定を保存").props.onClick();
    await vi.waitFor(() => expect(saveTransportSettings).toHaveBeenCalledExactlyOnceWith({
      revision: 4, castRegistrations: { cast: { amounts: [500, 1000] } }, remoteAmounts: [500, 1000, 1500],
    }, month, user));
  });
});


describe("再送後の出勤根拠の更新", () => {
  it.each(["cast", "driver"] as const)("%s は同額・同明細でも出勤配列位置を保存し直せる", async (kind) => {
    const data = fixture();
    if (kind === "cast") {
      data.transportSettings!.castRegistrations.cast.amounts = [500];
      data.transportMonths![month].casts.cast = { [date]: { amount: 500, legacyInputIds: [], attendanceClosingId: "closing", attendanceIndex: 2 } };
      hooks.days.cast = [{ businessDate: date, amount: 500, legacyInputIds: [], hasRecord: true }];
    } else {
      data.transportMonths![month].drivers.driver = { [date]: { entries: { one: 500 }, attendanceClosingId: "closing", attendanceIndex: 2 } };
    }
    openCalendar(data, kind);
    expect(text(render(data))).toContain("出勤情報が更新されています");
    const save = button(render(data), "記録を保存");
    expect(save.props.disabled).toBe(false); save.props.onClick();
    await vi.waitFor(() => expect(kind === "cast" ? saveCastTransportDay : saveDriverTransportDay).toHaveBeenCalledOnce());
  });
});
