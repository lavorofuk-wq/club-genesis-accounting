import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, drafts: new Map<string, unknown>(),
  days: {} as Record<string, Array<{ businessDate: string; eligible: boolean | null; hasRecord: boolean; legacy: boolean }>>,
  attendance: {} as Record<string, Array<{ businessDate: string; closingId: string; index: number; posCastId: string }>> }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual,
    useState: <T,>(initial: T | (() => T)) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [hooks.values[index], (value: T | ((old: T) => T)) => { hooks.values[index] = typeof value === "function" ? (value as (old: T) => T)(hooks.values[index] as T) : value; }]; },
    useRef: <T,>(initial: T) => { const index = hooks.cursor++; if (!(index in hooks.values)) hooks.values[index] = { current: initial }; return hooks.values[index]; },
    useMemo: <T,>(factory: () => T) => factory(), useEffect: () => {}, useId: () => "beauty-test",
  };
});
vi.mock("./update-drafts", () => ({
  useRecoverableState: <T,>(key: string, initial: T) => { if (!hooks.drafts.has(key)) hooks.drafts.set(key, initial);
    return [hooks.drafts.get(key), (value: T | ((old: T) => T)) => hooks.drafts.set(key, typeof value === "function" ? (value as (old: T) => T)(hooks.drafts.get(key) as T) : value)]; },
  useUpdateDraftBusy: vi.fn(),
}));
vi.mock("@/lib/firebase/repository", () => ({ saveBeautyAllowanceDay: vi.fn(), saveCastTransportDay: vi.fn(), saveDriverTransportDay: vi.fn(), saveTransportSettings: vi.fn() }));
vi.mock("@/domain/beauty-allowance", async (original) => {
  const actual = await original<typeof import("@/domain/beauty-allowance")>();
  return { ...actual, beautyAttendance: (_data: unknown, _month: string, id: string) => hooks.attendance[id] || [],
    beautyCastDays: (_data: unknown, _month: string, id: string) => hooks.days[id] || [] };
});
import { saveBeautyAllowanceDay } from "@/lib/firebase/repository";
import { BeautyAllowanceWork, BeautyCalendar } from "./beauty-allowance-work";
import type { AccountingWorkspaceData } from "@/domain/month-accounting";

type Element = ReactElement<Record<string, any>>;
type Props = Parameters<typeof BeautyAllowanceWork>[0];
const month = "2026-10", date = month + "-02", user = { uid: "shop" } as Props["user"];
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
const calendar = (node: ReactNode) => find(node, (row) => row.type === BeautyCalendar);
const panel = () => hooks.drafts.get("store.beauty.panel") as Record<string, any> | null;
function fixture(): AccountingWorkspaceData {
  return { casts: [{ id: "cast", name: "あい", status: "active" }, { id: "other", name: "ゆり", status: "active" },
      { id: "trial", name: "体入さん", status: "trial" }, { id: "old", name: "退店さん", status: "departed" }],
    archivedCasts: [], drivers: [], closings: [], adjustments: [], monthStates: [], monthSnapshots: [],
    beautyMonths: { [month]: { revision: 8, casts: {} } },
  } as unknown as AccountingWorkspaceData;
}
const run: Props["run"] = async (action) => { try { await action(); return true; } catch { return false; } };
function render(data = fixture(), busy = false, action = run) { hooks.cursor = 0; return BeautyAllowanceWork({ data, user, busy, run: action }); }
function open(data: AccountingWorkspaceData, name = "あい", selectedDate = date) {
  find(render(data), (row) => row.type === "button" && row.props.className === "transport-person" && text(row.props.children).startsWith(name)).props.onClick();
  calendar(render(data)).props.onSelect(selectedDate);
}
function record(id: string, eligible: boolean, legacy = false, businessDate = date) { hooks.days[id] = [{ businessDate, eligible, hasRecord: true, legacy }]; }
beforeEach(() => {
  vi.clearAllMocks(); hooks.values = []; hooks.cursor = 0; hooks.drafts.clear(); hooks.drafts.set("store.beauty.month", month);
  hooks.days = {}; hooks.attendance = { cast: [{ businessDate: date, closingId: "closing", index: 0, posCastId: "pos-cast" }] };
  vi.mocked(saveBeautyAllowanceDay).mockReset();
});

describe("美容室手当カレンダー", () => {
  it("未登録・可・否を区別し、0円の記録日は出勤がなくても選択できる", () => {
    const select = vi.fn();
    const tree = BeautyCalendar({ month, attendance: [date], records: { "2026-10-03": true, "2026-10-04": false }, selected: date, disabled: false, onSelect: select });
    const day = (value: string) => find(tree, (row) => row.type === "button" && row.props["aria-label"].startsWith(value));
    expect(day(date).props["aria-label"]).toContain("未登録");
    expect(day("2026-10-03").props["aria-label"]).toContain("可 500円");
    expect(day("2026-10-04").props["aria-label"]).toContain("否 0円");
    expect(day("2026-10-04").props.disabled).toBe(false); day("2026-10-04").props.onClick();
    expect(select).toHaveBeenCalledWith("2026-10-04");
    expect(day("2026-10-01").props.disabled).toBe(true); day("2026-10-01").props.onClick();
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("処理中は記録済みの日も選択を止める", () => {
    const select = vi.fn();
    const tree = BeautyCalendar({ month, attendance: [date], records: { [date]: false }, selected: "", disabled: true, onSelect: select });
    elements(tree).filter((row) => row.type === "button").forEach((row) => row.props.onClick());
    expect(select).not.toHaveBeenCalled();
  });
});

describe("美容室手当の登録", () => {
  it("全在籍キャストを登録なしで表示し、体入を除き、退店者の過去記録は保持する", () => {
    record("old", false);
    const names = elements(render()).filter((row) => row.type === "button" && row.props.className === "transport-person").map((row) => text(row.props.children));
    expect(names.some((name) => name.startsWith("あい"))).toBe(true);
    expect(names.some((name) => name.startsWith("ゆり"))).toBe(true);
    expect(names.some((name) => name.startsWith("退店さん") && name.includes("否 1日"))).toBe(true);
    expect(names.some((name) => name.includes("体入さん"))).toBe(false);
  });
  it.each([true, false])("未登録日を%sで保存し、同じキャストのカレンダーで続けて入力する", async (eligible) => {
    const data = fixture(); open(data);
    expect(button(render(data), "記録を保存").props.disabled).toBe(true);
    button(render(data), eligible ? "可（500円）" : "否（0円）").props.onClick();
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveBeautyAllowanceDay).toHaveBeenCalledExactlyOnceWith(month, "cast", date, eligible, 8, user));
    await vi.waitFor(() => expect(panel()?.date).toBe(""));
    expect(panel()?.id).toBe("cast");
    data.beautyMonths![month].revision++;
    expect(text(render(data))).not.toContain("元データが更新されました");
    calendar(render(data)).props.onSelect(date);
    expect(panel()?.revision).toBe(9);
  });
  it("旧日次の手当を表示して否に変更しても旧原本を変更しない", async () => {
    const data = fixture(); record("cast", true, true); open(data);
    expect(text(render(data))).toContain("日次で登録された美容室手当を引き継いでいます");
    button(render(data), "否（0円）").props.onClick(); button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveBeautyAllowanceDay).toHaveBeenCalledWith(month, "cast", date, false, 8, user));
    expect(hooks.days.cast[0].eligible).toBe(true);
  });
  it("未保存の月移動は確認で取消でき、確認後だけ移動する", () => {
    const data = fixture(); open(data); button(render(data), "可（500円）").props.onClick();
    const nextMonth = () => find(render(data), (row) => row.type === "input" && row.props.type === "month").props.onChange({ target: { value: "2026-11" } });
    nextMonth(); expect(text(render(data))).toContain("保存していない入力を破棄");
    button(render(data), "戻る").props.onClick(); expect(panel()?.eligible).toBe(true); expect(hooks.drafts.get("store.beauty.month")).toBe(month);
    nextMonth(); button(render(data), "破棄して移動").props.onClick(); expect(hooks.drafts.get("store.beauty.month")).toBe("2026-11"); expect(panel()?.date).toBe("");
  });
  it.each(["busy", "closed", "closing", "stale"] as const)("%sでは保存・可否変更の直接呼び出しも止める", (mode) => {
    const data = fixture(); open(data); button(render(data), "可（500円）").props.onClick();
    if (mode === "closed" || mode === "closing") data.monthStates = [{ month, status: mode, revision: 1 }] as never;
    if (mode === "stale") data.beautyMonths![month].revision++;
    const tree = render(data, mode === "busy");
    const save = button(tree, "記録を保存"); expect(save.props.disabled).toBe(true); save.props.onClick();
    button(tree, "否（0円）").props.onClick();
    expect(saveBeautyAllowanceDay).not.toHaveBeenCalled(); expect(panel()?.eligible).toBe(true);
  });
  it("確定済みでもキャストから記録を閲覧できる", () => {
    const data = fixture(); data.monthStates = [{ month, status: "closed", revision: 1 }] as never; record("cast", true);
    open(data);
    expect(panel()?.eligible).toBe(true); expect(button(render(data), "否（0円）").props.disabled).toBe(true);
  });
  it("保存失敗は入力を保持し、同じボタンの二重操作は1回だけ保存する", async () => {
    const data = fixture(); open(data); button(render(data), "可（500円）").props.onClick();
    let reject!: (error: Error) => void;
    vi.mocked(saveBeautyAllowanceDay).mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    const save = button(render(data), "記録を保存"); save.props.onClick(); save.props.onClick();
    expect(saveBeautyAllowanceDay).toHaveBeenCalledTimes(1);
    reject(new Error("他の端末で更新されました"));
    await vi.waitFor(() => expect(text(render(data))).toContain("他の端末で更新されました"));
    expect(panel()?.eligible).toBe(true); expect(panel()?.revision).toBe(8);
  });
  it("出勤の差戻し後は既存記録を否にでき、新規の可にはできない", async () => {
    const data = fixture(); record("cast", true); hooks.attendance.cast = []; open(data);
    expect(button(render(data), "可（500円）").props.disabled).toBe(true);
    button(render(data), "否（0円）").props.onClick(); button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveBeautyAllowanceDay).toHaveBeenCalledWith(month, "cast", date, false, 8, user));
  });
  it("重複した出勤日では未登録の可否を保存できない", () => {
    const data = fixture(); hooks.attendance.cast.push({ businessDate: date, closingId: "duplicate", index: 0, posCastId: "pos-cast" }); open(data);
    expect(text(render(data))).toContain("複数の出勤記録");
    expect(button(render(data), "可（500円）").props.disabled).toBe(true);
    expect(button(render(data), "否（0円）").props.disabled).toBe(true);
    button(render(data), "記録を保存").props.onClick(); expect(saveBeautyAllowanceDay).not.toHaveBeenCalled();
  });
  it("退店者は既存手当を否にでき、出勤根拠だけの修復も同値で保存できる", async () => {
    const data = fixture(); data.casts[0].status = "departed"; record("cast", true);
    data.beautyMonths![month].casts.cast = { [date]: { eligible: true, attendanceClosingId: "closing", attendanceIndex: 2, attendancePosCastId: "pos-cast" } };
    open(data); expect(button(render(data), "可（500円）").props.disabled).toBe(true);
    expect(button(render(data), "記録を保存").props.disabled).toBe(false);
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveBeautyAllowanceDay).toHaveBeenCalledWith(month, "cast", date, true, 8, user));
  });
  it("マスタ削除後も日次の保存名と新記録を表示し、可への変更は止める", () => {
    const data = fixture(); data.casts = []; data.closings = [{ id: "closing", businessDate: date, casts: [{ masterId: "cast", name: "保存名", kind: "regular" }] }] as never;
    record("cast", false); open(data, "保存名");
    expect(panel()?.eligible).toBe(false); expect(button(render(data), "可（500円）").props.disabled).toBe(true);
  });
  it("マスタ不在の保存済み可は出勤根拠だけの更新を許可せず、否への訂正だけ可能", () => {
    const data = fixture(); data.casts = [];
    data.closings = [{ id: "closing", businessDate: date, casts: [{ masterId: "cast", name: "保存名", kind: "regular" }] }] as never;
    data.beautyMonths![month].casts.cast = { [date]: { eligible: true, attendanceClosingId: "closing", attendanceIndex: 2, attendancePosCastId: "pos-cast" } };
    record("cast", true); open(data, "保存名");
    expect(button(render(data), "記録を保存").props.disabled).toBe(true);
    button(render(data), "否（0円）").props.onClick();
    expect(button(render(data), "記録を保存").props.disabled).toBe(false);
  });

  it("配列位置が同じでもPOS人物IDが変われば出勤根拠の再確認を求める", async () => {
    const data = fixture(); record("cast", true);
    data.beautyMonths![month].casts.cast = { [date]: { eligible: true, attendanceClosingId: "closing", attendanceIndex: 0, attendancePosCastId: "old-pos" } };
    open(data);
    expect(text(render(data))).toContain("出勤情報が更新されています");
    expect(button(render(data), "記録を保存").props.disabled).toBe(false);
    button(render(data), "記録を保存").props.onClick();
    await vi.waitFor(() => expect(saveBeautyAllowanceDay).toHaveBeenCalledWith(month, "cast", date, true, 8, user));
  });
  it("否の旧出勤アンカーは再確認対象にせず、不要な保存を促さない", () => {
    const data = fixture(); record("cast", false);
    data.beautyMonths![month].casts.cast = { [date]: { eligible: false, attendanceClosingId: "closing", attendanceIndex: 2, attendancePosCastId: "old-pos" } };
    open(data);
    expect(text(render(data))).not.toContain("出勤情報が更新されています");
    expect(button(render(data), "記録を保存").props.disabled).toBe(true);
  });

});
