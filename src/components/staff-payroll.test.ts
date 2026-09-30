import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffHourlySource, StaffPayrollRow } from "@/domain/month-accounting";
import { StaffPayroll } from "./staff-payroll";

const capturedInputs = vi.hoisted(() => [] as Array<{ value: number; disabled?: boolean; onChange: (value: number) => void }>);
vi.mock("./ui", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ui")>();
  return { ...original, MoneyInput: (props: Parameters<typeof original.MoneyInput>[0]) => {
    capturedInputs.push(props);
    return original.MoneyInput(props);
  } };
});

function source(staffId: string, kind: StaffHourlySource["kind"]): StaffHourlySource {
  return { businessDate: "2026-09-01", staffId, kind, hours: 3.25, hourlyRate: 1_400 };
}
function payroll(id: string, name: string, kind: StaffHourlySource["kind"] = "regular"): StaffPayrollRow {
  return {
    id, name, hours: 3.25, hourly: 4_550, sales: 501, bottle: 223, gross: 5_274, daily: 1_009, net: 4_265,
    hourlySources: [source(id, kind)],
    hourlyByDay: [{ businessDate: "2026-09-01", hours: 3.25, amount: 4_550 }],
  };
}
function render(rows: StaffPayrollRow[], disabled = false, onSales = vi.fn(), onBottle = vi.fn()) {
  return renderToStaticMarkup(createElement(StaffPayroll, { rows, disabled, onSales, onBottle }));
}
function group(markup: string, title: string): string {
  const sections = (markup.match(/<section\b[\s\S]*?<\/section>/g) || [])
    .filter((section) => section.includes(`<h2>${title}</h2>`));
  expect(sections).toHaveLength(1);
  return sections[0];
}
function mainTable(section: string): string {
  const table = section.match(/<table\b[^>]*>[\s\S]*?<\/table>/)?.[0];
  expect(table).toBeDefined();
  return table!;
}
function totalCells(section: string): string[] {
  const table = mainTable(section);
  const totals = table.match(/<tr\b[^>]*class="total-row"[^>]*>[\s\S]*?<\/tr>/g) || [];
  expect(totals).toHaveLength(1);
  const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  expect((body.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) || []).at(-1)).toBe(totals[0]);
  expect(totals[0]).not.toContain("<input");
  const totalRow = totals[0];
  if (!totalRow) throw new Error("給与合計行がありません。");
  return [...totalRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
    .map((cell) => cell[1].replace(/<[^>]*>/g, ""));
}

beforeEach(() => { capturedInputs.length = 0; });

describe("スタッフ給与の在籍・体入別表示", () => {
  it("計算時の区分を使って1人1行へ分け、各一覧の順序と元データを保持する", () => {
    const rows = [payroll("t1", "体入一", "trial"), payroll("r1", "在籍一"),
      payroll("t2", "体入二", "trial"), payroll("r2", "在籍二")];
    const before = structuredClone(rows);
    const markup = render(rows);
    const regular = group(markup, "在籍スタッフ給与（2名）");
    const trial = group(markup, "体入スタッフ給与（2名）");
    expect(regular).not.toContain("体入一");
    expect(trial).not.toContain("在籍一");
    expect(mainTable(regular)).toMatch(/在籍一[\s\S]*在籍二/);
    expect(mainTable(trial)).toMatch(/体入一[\s\S]*体入二/);
    for (const row of rows) {
      expect((mainTable(regular) + mainTable(trial)).match(new RegExp(`<td>${row.name}</td>`, "g"))).toHaveLength(1);
    }
    expect(markup).not.toContain("区分記録なし（");
    expect(rows).toEqual(before);
  });

  it("体入・在籍が混在する行と、体入記録だけでも入店先IDに統合された行は在籍にする", () => {
    const mixed = { ...payroll("joined", "月内入店"),
      hourlySources: [source("trial-before-joining", "trial"), source("joined", "regular")] };
    const trialOnlyJoined = { ...payroll("joined-no-regular-work", "入店後勤務なし"),
      hourlySources: [source("trial-before-joining-2", "trial")] };
    const markup = render([mixed, trialOnlyJoined, payroll("trial", "未入店", "trial")]);
    const regular = group(markup, "在籍スタッフ給与（2名）");
    const trial = group(markup, "体入スタッフ給与（1名）");
    expect(regular).toContain("月内入店");
    expect(regular).toContain("入店後勤務なし");
    expect(regular).not.toContain("未入店");
    expect(trial).toContain("未入店");
    expect(trial).not.toContain("月内入店");
    expect(trial).not.toContain("入店後勤務なし");
  });

  it("同名別IDは統合せず、それぞれの給与と入力値を表示する", () => {
    const rows = [payroll("r", "同名"), payroll("t1", "同名", "trial"),
      { ...payroll("t2", "同名", "trial"), sales: 888, bottle: 444, gross: 5_882, net: 4_873 }];
    const markup = render(rows);
    const regular = mainTable(group(markup, "在籍スタッフ給与（1名）"));
    const trial = mainTable(group(markup, "体入スタッフ給与（2名）"));
    expect(regular.match(/<td>同名<\/td>/g)).toHaveLength(1);
    expect(trial.match(/<td>同名<\/td>/g)).toHaveLength(2);
    expect(regular.match(/<input\b/g)).toHaveLength(2);
    expect(trial.match(/<input\b/g)).toHaveLength(4);
    expect(trial).toContain('value="888"');
    expect(trial).toContain('value="444"');
    expect(trial).toContain("￥4,265");
    expect(trial).toContain("￥4,873");
  });

  it("各一覧の末尾に8列の合計を表示し、勤務時間や金額を区分間で混ぜない", () => {
    const rows = [
      { ...payroll("r1", "在籍一"), hours: 1.125, hourly: 1_551, sales: 101, bottle: 203, gross: 1_855, daily: 2_009, net: -154 },
      { ...payroll("t1", "体入一", "trial"), hours: 4.5, hourly: 6_303, sales: 307, bottle: 409, gross: 7_019, daily: 1_111, net: 5_908 },
      { ...payroll("r2", "在籍二"), hours: 2.25, hourly: 3_153, sales: 107, bottle: 211, gross: 3_471, daily: 1_003, net: 2_468 },
      { ...payroll("t2", "体入二", "trial"), hours: 0.25, hourly: 353, sales: 311, bottle: 419, gross: 1_083, daily: 2_003, net: -920 },
    ];
    const markup = render(rows);
    const regular = group(markup, "在籍スタッフ給与（2名）");
    const trial = group(markup, "体入スタッフ給与（2名）");
    for (const section of [regular, trial]) {
      expect([...mainTable(section).matchAll(/<th>(.*?)<\/th>/g)].map((match) => match[1]))
        .toEqual(["スタッフ", "勤務時間", "基本給与", "売上手当", "ボトル手当", "総支給", "日払い", "差引支給"]);
    }
    expect(totalCells(regular)).toEqual(["合計（2名）", "3.375時間", "￥4,704", "￥208", "￥414", "￥5,326", "￥3,012", "￥2,314"]);
    expect(totalCells(trial)).toEqual(["合計（2名）", "4.75時間", "￥6,656", "￥618", "￥828", "￥8,102", "￥3,114", "￥4,988"]);
  });

  it.each(([[], ["regular"], ["trial"], ["regular", "trial"]] as StaffHourlySource["kind"][][]).map((kinds) => ({ kinds })))(
    "空の区分も表示し、データがない一覧には合計行を作らない（$kinds）", ({ kinds }) => {
      const markup = render(kinds.map((kind, index) => payroll(`s${index}`, `スタッフ${index}`, kind)));
      for (const kind of ["regular", "trial"] as const) {
        const label = kind === "regular" ? "在籍" : "体入";
        const count = kinds.filter((value) => value === kind).length;
        const section = group(markup, `${label}スタッフ給与（${count}名）`);
        expect(section.includes(`当月の${label}スタッフ給与データはありません。`)).toBe(count === 0);
        expect(section.includes('class="total-row"')).toBe(count > 0);
      }
    },
  );

  it.each([
    { label: "未保存", sources: undefined },
    { label: "空配列", sources: [] },
    { label: "配列以外", sources: {} },
    { label: "null要素", sources: [null] },
    { label: "未知の区分", sources: [{ ...source("legacy", "regular"), kind: "unknown" }] },
    { label: "IDなし", sources: [{ ...source("legacy", "trial"), staffId: "" }] },
    { label: "有効記録と不正記録の混在", sources: [source("legacy", "regular"), { ...source("legacy", "trial"), staffId: "" }] },
  ])("$labelの行を推測で分類せず、区分記録なしに金額を保持する", ({ sources }) => {
    const legacy = { ...payroll("legacy", "旧スタッフ"), hourlySources: sources as StaffPayrollRow["hourlySources"] };
    const before = structuredClone(legacy);
    const markup = render([payroll("r", "在籍"), payroll("t", "体入", "trial"), legacy]);
    const regular = group(markup, "在籍スタッフ給与（1名）");
    const trial = group(markup, "体入スタッフ給与（1名）");
    const unknown = group(markup, "区分記録なし（1名）");
    expect(regular).not.toContain("旧スタッフ");
    expect(trial).not.toContain("旧スタッフ");
    expect(mainTable(unknown).match(/<td>旧スタッフ<\/td>/g)).toHaveLength(1);
    expect(unknown).toContain('value="501"');
    expect(unknown).toContain('value="223"');
    expect(totalCells(unknown)).toEqual(["合計（1名）", "3.25時間", "￥4,550", "￥501", "￥223", "￥5,274", "￥1,009", "￥4,265"]);
    expect(legacy).toEqual(before);
  });

  it("各区分で日別内訳、適用時給、旧確定月の案内を保持する", () => {
    const legacy = { ...payroll("legacy", "内訳未保存"), hourlySources: undefined, hourlyByDay: undefined };
    const markup = render([payroll("r", "在籍"), payroll("t", "体入", "trial"), legacy]);
    for (const label of ["在籍", "体入"]) {
      const section = group(markup, `${label}スタッフ給与（1名）`);
      expect(section).toContain("日別内訳");
      expect(section).toContain("適用時給（区分・時間）");
      expect(section).toContain(`￥1,400（${label}・3.25時間）`);
      expect(section).toContain("基本給与 ￥4,550");
    }
    expect(group(markup, "区分記録なし（1名）"))
      .toContain("この確定データには日別内訳が保存されていません。確定時の月額を表示しています。");
  });

  it.each([
    { label: "勤務時間がオブジェクト", invalid: { hours: { value: 3.25 } } },
    { label: "勤務時間が文字列", invalid: { hours: "3.25" } },
    { label: "時給がオブジェクト", invalid: { hourlyRate: { value: 1_400 } } },
    { label: "時給が非有限値", invalid: { hourlyRate: Infinity } },
  ])("$labelでも保存済み給与を表示し、無効な単価記録を日別内訳に使わない", ({ invalid }) => {
    const row = { ...payroll("regular", "旧形式の在籍"),
      hourlySources: [{ ...source("regular", "regular"), ...invalid }] as unknown as StaffHourlySource[] };
    const markup = render([row]);
    const regular = group(markup, "在籍スタッフ給与（1名）");
    expect(regular).toContain("確定時の単価記録なし");
    expect(regular).not.toContain("￥1,400（");
    expect(regular).not.toContain("NaN");
    expect(regular).not.toContain("Infinity");
    expect(totalCells(regular)).toEqual(["合計（1名）", "3.25時間", "￥4,550", "￥501", "￥223", "￥5,274", "￥1,009", "￥4,265"]);
  });

  it.each([false, true])("各区分の手当入力へdisabledを引き継ぐ（%s）", (disabled) => {
    const unknown = { ...payroll("legacy", "旧スタッフ"), hourlySources: undefined };
    const markup = render([payroll("r", "在籍"), payroll("t", "体入", "trial"), unknown], disabled);
    for (const title of ["在籍スタッフ給与（1名）", "体入スタッフ給与（1名）", "区分記録なし（1名）"]) {
      const inputs = group(markup, title).match(/<input\b[^>]*>/g) || [];
      expect(inputs).toHaveLength(2);
      for (const input of inputs) expect(/\bdisabled=""/.test(input)).toBe(disabled);
    }
  });

  it("同名別IDでも売上・ボトル手当の変更先IDと入力金額を保持する", () => {
    const rows = [
      { ...payroll("regular-id", "同名"), sales: 101, bottle: 102 },
      { ...payroll("trial-id", "同名", "trial"), sales: 201, bottle: 202 },
      { ...payroll("unknown-id", "同名"), hourlySources: undefined, sales: 301, bottle: 302 },
    ];
    const onSales = vi.fn();
    const onBottle = vi.fn();
    render(rows, false, onSales, onBottle);
    expect(capturedInputs).toHaveLength(6);
    for (const row of rows) {
      capturedInputs.find((input) => input.value === row.sales)!.onChange(row.sales + 1_000);
      capturedInputs.find((input) => input.value === row.bottle)!.onChange(row.bottle + 2_000);
    }
    expect(onSales.mock.calls).toEqual(rows.map((row) => [row.id, row.sales + 1_000]));
    expect(onBottle.mock.calls).toEqual(rows.map((row) => [row.id, row.bottle + 2_000]));
  });
});
