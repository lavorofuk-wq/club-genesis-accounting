import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffRecord, WorkspaceData } from "@/domain/gms";

const draft = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  buttons: [] as Array<{ label: string; click: () => void }>,
  fields: [] as Array<{ label: string; children: ReactNode }>,
  submit: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
}));
vi.mock("./update-drafts", () => ({
  useRecoverableState<T>(key: string, initial: T | (() => T)) {
    if (!Object.hasOwn(draft.values, key)) draft.values[key] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [draft.values[key] as T, (next: T | ((previous: T) => T)) => {
      draft.values[key] = typeof next === "function" ? (next as (previous: T) => T)(draft.values[key] as T) : next;
    }];
  },
}));
vi.mock("@/lib/firebase/repository", () => ({
  saveStaff: vi.fn(async () => "saved-staff"),
  convertTrialStaff: vi.fn(async () => "converted-staff"),
}));
vi.mock("./ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui")>();
  const collect = (value: ReactNode) => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void; onSubmit?: typeof draft.submit }>(value)) return;
    if (value.type === "button" && value.props.onClick && typeof value.props.children === "string") {
      draft.buttons.push({ label: value.props.children, click: value.props.onClick });
    }
    if (value.type === "form" && value.props.onSubmit) draft.submit = value.props.onSubmit;
    collect(value.props.children);
  };
  return {
    ...actual,
    currentMonth: () => "2026-09",
    today: () => "2026-09-15",
    Card(props: Parameters<typeof actual.Card>[0]) {
      collect(props.action); collect(props.children);
      return createElement(actual.Card, props);
    },
    Modal(props: Parameters<typeof actual.Modal>[0]) {
      collect(props.children);
      return createElement(actual.Modal, props);
    },
    Field(props: Parameters<typeof actual.Field>[0]) {
      draft.fields.push(props);
      return createElement(actual.Field, props);
    },
  };
});
import { CommonForms } from "./common-forms";
import { convertTrialStaff, saveStaff } from "@/lib/firebase/repository";

const user = { uid: "staff-monthly-ui" } as User;
const member: StaffRecord = { id: "staff-1", name: "スタッフ", status: "active", hiredAt: "2026-08-01", hourlyRate: 1400, note: "", createdAt: "", updatedAt: "original" };
function render(staff: StaffRecord[] = [member]) {
  draft.buttons = []; draft.fields = []; draft.submit = undefined;
  const data: WorkspaceData = { casts: [], staff, drivers: [], introducers: [], liquor: [], closings: [], adjustments: [], cashFloat: 200000 };
  return renderToStaticMarkup(createElement(CommonForms, { section: "staff", data, user, busy: false,
    run: async (action) => { await action(); return true; } }));
}
function click(label: string) {
  const button = draft.buttons.find((row) => row.label === label);
  expect(button).toBeDefined(); button!.click();
}
function field(label: string) {
  const children = draft.fields.find((row) => row.label === label)?.children;
  const elements = Array.isArray(children) ? children : [children];
  const input = elements.find((child) => isValidElement(child));
  expect(isValidElement(input)).toBe(true);
  return (input as { props: { value: unknown; min?: string; onChange: (value: unknown) => void } }).props;
}
async function submit() {
  expect(draft.submit).toBeDefined();
  await draft.submit!({ preventDefault() {} });
}
beforeEach(() => { draft.values = {}; draft.buttons = []; draft.fields = []; draft.submit = undefined; vi.clearAllMocks(); });

describe("スタッフ月度時給の共通フォーム", () => {
  it("既存単一時給を9月月度として表示し8月以前を選択できない", async () => {
    render(); click("編集");
    const markup = render();
    expect(field("時給の対象月")).toMatchObject({ value: "2026-09", min: "2026-09" });
    expect(field("2026-09 月度時給").value).toBe(1400);
    expect(markup).toContain("確定済み月と保存済みの日払い・現金照合は変更しません");
    field("2026-09 月度時給").onChange(1500); render(); await submit();
    expect(saveStaff).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 1400, hourlyRates: { "2026-09": 1500 }, updatedAt: "original" }), user);
  });

  it("選択した月だけ変更し、他月と旧互換単価を維持する", async () => {
    const staff = [{ ...member, hourlyRates: { "2026-09": 1400, "2026-11": 1800 } }];
    render(staff); click("編集"); render(staff);
    field("時給の対象月").onChange({ target: { value: "2026-10" } }); render(staff);
    expect(field("2026-10 月度時給").value).toBe(1400);
    field("2026-10 月度時給").onChange(1600); render(staff); await submit();
    expect(saveStaff).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: 1400,
      hourlyRates: { "2026-09": 1400, "2026-10": 1600, "2026-11": 1800 } }), user);
  });

  it("月度時給のみの既存スタッフを編集しても旧単一時給を補完しない", async () => {
    const staff = [{ ...member, hourlyRate: undefined, hourlyRates: { "2026-09": 1400 } }];
    render(staff); click("編集"); render(staff);
    field("2026-09 月度時給").onChange(1500); render(staff); await submit();
    expect(saveStaff).toHaveBeenCalledWith(expect.objectContaining({ hourlyRate: undefined,
      hourlyRates: { "2026-09": 1500 }, updatedAt: "original" }), user);
  });

  it("将来採用の新規スタッフは採用月を対象月の下限にする", async () => {
    render([]); click("新規登録"); render([]);
    field("名前").onChange({ target: { value: "新規スタッフ" } }); render([]);
    field("採用日").onChange({ target: { value: "2026-10-05" } }); render([]);
    expect(field("時給の対象月")).toMatchObject({ value: "2026-10", min: "2026-10" });
    field("2026-10 月度時給").onChange(1700); render([]); await submit();
    expect(saveStaff).toHaveBeenCalledWith(expect.objectContaining({ name: "新規スタッフ", hiredAt: "2026-10-05", hourlyRate: 1700, hourlyRates: { "2026-10": 1700 } }), user);
  });

  it("体入から在籍化しても体入単価を保持し在籍月度時給を別に保存する", async () => {
    const trial: StaffRecord = { ...member, status: "trial", hiredAt: undefined, trialDate: "2026-09-15", trialHourlyRate: 1203, hourlyRate: undefined };
    draft.values["common.staff.tab"] = "trial";
    render([trial]); click("入店"); render([trial]);
    expect(field("採用日")).toMatchObject({ min: "2026-09-16", value: "2026-09-16" });
    field("2026-09 月度時給").onChange(1500); render([trial]); await submit();
    expect(convertTrialStaff).toHaveBeenCalledWith(member.id, expect.objectContaining({ hiredAt: "2026-09-16", trialHourlyRate: 1203,
      hourlyRate: 1500, hourlyRates: { "2026-09": 1500 } }), user);
  });

  it("体入編集には月度時給を表示せず体入時給を保存する", async () => {
    const trial: StaffRecord = { ...member, status: "trial", hiredAt: undefined, trialDate: "2026-09-15", trialHourlyRate: 1203 };
    draft.values["common.staff.tab"] = "trial";
    render([trial]); click("編集"); render([trial]);
    expect(draft.fields.some((row) => row.label === "時給の対象月")).toBe(false);
    field("体入時給").onChange(1301); render([trial]); await submit();
    expect(saveStaff).toHaveBeenCalledWith(expect.objectContaining({ status: "trial", trialHourlyRate: 1301 }), user);
  });

  it("未保存の対象月・単価・元リビジョンを復元する", () => {
    draft.values["common.staff.editing"] = { ...member, hourlyRates: { "2026-09": 1400 } };
    draft.values["common.staff.month"] = "2026-10";
    draft.values["common.staff.rate"] = 1600;
    render();
    expect(field("時給の対象月").value).toBe("2026-10");
    expect(field("2026-10 月度時給").value).toBe(1600);
    expect(draft.values["common.staff.editing"]).toMatchObject({ updatedAt: "original" });
    expect(saveStaff).not.toHaveBeenCalled();
  });
});
