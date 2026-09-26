import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { fillReceiptTemplate } from "@/lib/xlsx/receipt-template";
import type { CastReward, CastSalesReport, ResolvedCastAccountingInput } from "./gms";
import { buildCastReceiptSheets, buildCastStatementSheets } from "./cast-receipt";

const reward: CastReward = {
  id: "cast-1", name: "花子", days: 1, advisoryDays: 1, hours: 4.25, trialOnly: false,
  hourlyPay: 12750, honShimeiSales: 40000, jonaiExtensionSales: 10000,
  liquorCost: 15000, honShimeiLiquorCost: 10000,
  honShimeiBack: 2000, banaiShimeiBack: 500, dohanBack: 4000, bottleBack: 1999, drinkBack: 333,
  hourlyAndBack: 21582, rewardRate: 0, salesRewardBase: 42500, salesReward: 0,
  adoptedSystem: "hourlyAndBack", adoptedReward: 21582, beautyAllowance: 500, grossPay: 22082,
  dailyPayment: 1000, advancePayment: 2000, transportFee: 500, withholding: 1000, netPay: 17582,
};

describe("キャスト報酬から受領書への転記", () => {
  it("時給・全5種類のバック・美容室・日払立替送迎・源泉・差引を指定欄へ出す", () => {
    expect(buildCastReceiptSheets([reward], "2026-09")).toMatchObject([{ template: "hourlyAndBack", name: "花子", cells: {
      G1: "9月報酬分", G2: 12750, G3: 8832, G4: 500, G5: 22082, G6: 3500, G7: 1000, G8: 17582, G10: "花子",
    } }]);
  });
  it("売上報酬採用時は専用様式の6項目へ転記し、保存された採用率を見出しに記載する", () => {
    const saved = { ...reward, adoptedSystem: "salesReward" as const, rewardRate: .65, salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 };
    const sheet = buildCastReceiptSheets([saved], "2026-12")[0];
    expect(sheet).toMatchObject({ template: "salesReward", name: "花子", cells: {
      B2: "①　日売上－酒代（50％）×65％", G1: "12月報酬分", G2: 100000, G3: 500, G4: 100500, G5: 3500, G6: 1000, G7: 96000, G9: "花子",
    } });
    expect(saved.hourlyPay).toBe(12750);
    expect(saved.bottleBack).toBe(1999);
  });
  it.each([.5, .6, .7, .8, .655])("旧確定を含む保存率%sを表示し、現在の基準率で再計算しない", (rewardRate) => {
    const saved = { ...reward, id: "sales-cast", adoptedSystem: "salesReward" as const, rewardRate, salesReward: 123456, adoptedReward: 123456, grossPay: 123956, netPay: 119456 };
    const sheets = buildCastReceiptSheets([saved, reward], "2026-09");
    expect(sheets[0].template).toBe("salesReward");
    expect(sheets[1].template).toBe("hourlyAndBack");
    expect(sheets[0].cells.B2).toBe(`①　日売上－酒代（50％）×${rewardRate * 100}％`);
    expect(sheets[0].cells.G2).toBe(123456);
    expect(sheets[0].cells.G7).toBe(119456);
  });
  it.each([undefined, NaN, 0, -1, 1.01])("売上報酬の保存率%sが不正なら50％等で補完せず停止する", (rewardRate) => {
    expect(() => buildCastReceiptSheets([{ ...reward, adoptedSystem: "salesReward", rewardRate } as CastReward], "2026-09")).toThrow("不一致");
  });
  it("旧確定の1円・小数端数や0円・マイナスの保存金額を丸め直さない", () => {
    const saved = { ...reward, hourlyPay: 12750.5, hourlyAndBack: 21582.5, adoptedReward: 21582.5, grossPay: 22082.5, netPay: 17582.5 };
    expect(buildCastReceiptSheets([saved], "2026-09")[0].cells.G8).toBe(17582.5);
    for (const netPay of [0, -1000]) {
      expect(buildCastReceiptSheets([{ ...reward, netPay, withholding: 18582 - netPay }], "2026-09")[0].cells.G8).toBe(netPay);
    }
  });
  it("在籍だけの保存名・方式・金額を使い、体入を含む入力データ自体は変更しない", () => {
    const rows = [reward, { ...reward, id: "trial", name: "体入キャスト", trialOnly: true }];
    const before = structuredClone(rows);
    const sheets = buildCastReceiptSheets(rows, "2026-09");
    expect(sheets.map((sheet) => sheet.cells.G10)).toEqual(["花子"]);
    expect(rows).toEqual(before);
  });
  it("体入のみ・空の月は在籍対象なしとして出力しない", () => {
    for (const rows of [[], [{ ...reward, trialOnly: true }]]) {
      expect(() => buildCastReceiptSheets(rows, "2026-09")).toThrow("承認済み在籍キャスト報酬がありません");
    }
  });
  it.each([undefined, null, 0, 1, "false", "true"])("区分%sを在籍と推測せず停止する", (trialOnly) => {
    expect(() => buildCastReceiptSheets([{ ...reward, trialOnly } as unknown as CastReward], "2026-09")).toThrow("在籍・体入区分");
  });
  it("混在・同名でも在籍のIDに対応した本名を出し、在籍の元の順序を保つ", () => {
    const converted = { ...reward, id: "converted", name: "同月入店", appliedHourlyRates: [1500, 3000] };
    const trial = { ...reward, id: "trial", trialOnly: true };
    const before = structuredClone([trial, converted, reward]);
    const output = buildCastReceiptSheets([trial, converted, reward], "2026-09", {
      "cast-1": "在籍の本名", trial: "体入の本名", converted: "同月入店者の本名",
    });
    expect(output.map((sheet) => sheet.name)).toEqual(["同月入店", "花子"]);
    expect(output.map((sheet) => sheet.statementCells.E5)).toEqual(["同月入店者の本名", "在籍の本名"]);
    expect(output[0].statementCells.F8).toBe("1,500 / 3,000");
    expect([trial, converted, reward]).toEqual(before);
  });
  it.each(["receipt", "statement"] as const)("%sのXLSXにも在籍分のみのシート・値を格納する", async (document) => {
    const sales = { ...reward, id: "sales", name: "在籍売上", adoptedSystem: "salesReward" as const,
      rewardRate: .65, salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 };
    const trial = { ...reward, id: "trial", name: "体入除外テスト", trialOnly: true };
    const sheets = buildCastReceiptSheets([trial, reward, sales], "2026-09", { trial: "体入本名除外", "cast-1": "在籍本名テスト" });
    const zip = await JSZip.loadAsync(await fillReceiptTemplate(await readFile("public/templates/cast-receipt-v3.xlsx"), sheets, document));
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    expect(workbook).toContain('name="花子"');
    expect(workbook).toContain('name="在籍売上"');
    expect(workbook.match(/<sheet\b/g)).toHaveLength(2);
    const paths = Object.keys(zip.files).filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    expect(paths).toHaveLength(2);
    const content = (await Promise.all(Object.keys(zip.files).filter((name) => /\.xml$/.test(name)).map((name) => zip.file(name)!.async("string")))).join("");
    expect(content).not.toContain("体入除外テスト");
    expect(content).not.toContain("体入本名除外");
    if (document === "receipt") {
      expect(content).not.toContain("在籍本名テスト");
      expect(content).not.toContain("報酬明細書");
    } else {
      expect(content).toContain("在籍本名テスト");
      expect(content).toContain("報酬明細書");
      expect(content).not.toContain("受領印");
    }
    expect(await zip.file(paths[0])!.async("string")).toContain("<v>17582</v>");
    expect(await zip.file(paths[1])!.async("string")).toContain("<v>96000</v>");
  });
  it.each(["grossPay", "netPay", "hourlyAndBack", "adoptedReward", "bottleBack", "dailyPayment"] as const)("%sが内訳と不一致なら停止する", (key) => {
    expect(() => buildCastReceiptSheets([{ ...reward, [key]: reward[key] + 1 }], "2026-09")).toThrow("不一致");
  });
  it("対象月・識別情報・金額の欠損・重複を0で補完しない", () => {
    expect(() => buildCastReceiptSheets([reward], "2026-13")).toThrow("対象月");
    expect(() => buildCastReceiptSheets([], "2026-09")).toThrow("ありません");
    expect(() => buildCastReceiptSheets([reward, reward], "2026-09")).toThrow("識別情報");
    for (const change of [{ name: "" }, { id: "" }, { withholding: NaN }, { grossPay: Infinity }, { beautyAllowance: undefined }, { dailyPayment: -1 }]) {
      expect(() => buildCastReceiptSheets([{ ...reward, ...change } as CastReward], "2026-09")).toThrow();
    }
  });
  it("時給明細の内訳と受領書の支給・控除・差引が一致し、本名と未保存時給を表示する", () => {
    const sheet = buildCastReceiptSheets([reward], "2026-09", { "cast-1": "山田花子" })[0];
    expect(sheet.statementCells).toEqual({
      D3: "2026年9月分", F4: "花子", E5: "山田花子", F6: 1, F7: 4.25, F8: "未保存",
      F9: 12750, F10: 2000, F11: 500, F12: 4000, F13: 1999, F14: 333, F15: 500,
      F18: 22082, F19: 1000, F20: 1000, F21: 500, F22: 2000, F25: 4500, F26: 17582,
    });
    expect(sheet.statementCells.F26).toBe(sheet.cells.G8);
    expect(sheet.statementCells).not.toHaveProperty("F16");
    expect(sheet.statementCells).not.toHaveProperty("F23");
    expect(buildCastReceiptSheets([reward], "2026-09")[0].statementCells.E5).toBe("");
  });
  it("売上明細に保存された売上・酒代50％・採用率・採用額を使う", () => {
    const sheet = buildCastReceiptSheets([{ ...reward, adoptedSystem: "salesReward", rewardRate: .65,
      salesReward: 100000, adoptedReward: 100000, grossPay: 100500, netPay: 96000 }], "2026-09")[0];
    expect(sheet.statementCells).toMatchObject({ F9: 50000, F10: 7500, B11: "報酬率", F11: 65, F12: 100000, F18: 100500, F26: 96000 });
    expect(sheet.statementCells).not.toHaveProperty("F13");
    expect(sheet.statementCells).not.toHaveProperty("F14");
    expect(sheet.statementCells.F26).toBe(sheet.cells.G7);
  });
  it("単一時給は数値、複数時給は重複を除き併記し、未保存を平均額で推定しない", () => {
    expect(buildCastReceiptSheets([{ ...reward, appliedHourlyRates: [3000] }], "2026-09")[0].statementCells.F8).toBe(3000);
    expect(buildCastReceiptSheets([{ ...reward, appliedHourlyRates: [4000, 3000, 4000] }], "2026-09")[0].statementCells.F8).toBe("3,000 / 4,000");
    expect(buildCastReceiptSheets([reward], "2026-09")[0].statementCells.F8).toBe("未保存");
    for (const appliedHourlyRates of [[], [NaN], [-1], [Infinity]]) {
      expect(() => buildCastReceiptSheets([{ ...reward, appliedHourlyRates }], "2026-09")).toThrow("不一致");
    }
  });
});

describe("明細書の追加手当名目", () => {
  function entry(id: string, label: string, amount: number, kind: ResolvedCastAccountingInput["kind"] = "allowance"): ResolvedCastAccountingInput {
    return { id, castId: reward.id, castName: reward.name, kind, label, amount, businessDate: "2026-09-02" };
  }
  function input(entries: ResolvedCastAccountingInput[]) {
    const allowance = entries.filter((item) => item.kind === "allowance").reduce((sum, item) => sum + item.amount, 0);
    const row: CastReward = { ...reward, additionalAllowance: allowance, grossPay: reward.grossPay + allowance,
      netPay: reward.netPay + allowance };
    const totals: CastSalesReport["totals"] = { attendanceDays: 1, hours: reward.hours,
      honShimeiSales: reward.honShimeiSales, jonaiExtensionSales: reward.jonaiExtensionSales,
      totalSales: reward.honShimeiSales + reward.jonaiExtensionSales,
      honShimeiLiquorCost: reward.honShimeiLiquorCost, jonaiExtensionLiquorCost: 5000,
      totalLiquorCost: reward.liquorCost, honShimeiCount: 2, banaiShimeiCount: 1, nominationCount: 3, dohanCount: 1,
      backs: [], backTotal: 0, bottles: [], beautyAllowance: reward.beautyAllowance,
      additionalAllowance: allowance, accountingInputs: entries };
    const report: CastSalesReport = { id: row.id, name: row.name, attendanceDays: 1,
      days: [{ ...totals, businessDate: "2026-09-02", startTime: "20:00", endTime: "00:15" }], totals };
    return { row, report };
  }

  it.each(["hourlyAndBack", "salesReward"] as const)("%s明細は美容室と同名合算の追加手当を分け、受領書は変更しない", (system) => {
    const { row, report } = input([
      entry("a", "イベント手当", 1001), entry("b", "皆勤手当", 2000),
      { ...entry("c", "イベント手当", 999), businessDate: "2026-09-03" },
      entry("d", "追加売上", 10000, "sales"), entry("e", "追加送迎", 500, "transport"),
    ]);
    if (system === "salesReward") Object.assign(row, { adoptedSystem: system, rewardRate: .65,
      salesReward: 100000, adoptedReward: 100000, grossPay: 104500, netPay: 100000 });
    const before = structuredClone({ row, report });
    const originalReceipt = buildCastReceiptSheets([row], "2026-09", { [row.id]: "本名" })[0];
    const sheet = buildCastStatementSheets([row], [report], "2026-09", { [row.id]: "本名" })[0];
    expect(sheet.cells).toEqual(originalReceipt.cells);
    expect(sheet.statementCells).toMatchObject({ B15: "美容室手当", F15: 500, F18: row.grossPay, F26: row.netPay, E5: "本名" });
    expect(sheet.statementAllowances).toEqual([{ label: "イベント手当", amount: 2000 }, { label: "皆勤手当", amount: 2000 }]);
    expect(sheet.statementAllowances[0]).not.toHaveProperty("businessDate");
    expect(sheet.statementAllowances[0]).not.toHaveProperty("castId");
    expect(originalReceipt.statementCells.F15).toBe(4500);
    expect({ row, report }).toEqual(before);
  });

  it("同名は完全一致だけを集約し、初出順・0円名目・美容室と同じ入力名目を保持する", () => {
    const { row, report } = input([entry("a", "手当", 0), entry("b", "手当 ", 2),
      entry("c", "手当", 3), entry("d", "美容室手当", 4), entry("e", "0円手当", 0)]);
    const sheet = buildCastStatementSheets([row], [report], "2026-09")[0];
    expect(sheet.statementCells.F15).toBe(500);
    expect(sheet.statementAllowances).toEqual([{ label: "手当", amount: 3 }, { label: "手当 ", amount: 2 },
      { label: "美容室手当", amount: 4 }, { label: "0円手当", amount: 0 }]);
  });

  it("件数や100文字名目を省略せずテンプレートへ引き渡す", () => {
    const entries = Array.from({ length: 30 }, (_, index) => entry(`item-${index}`, `${index}`.padStart(100, "手"), 1));
    const { row, report } = input(entries);
    expect(buildCastStatementSheets([row], [report], "2026-09")[0].statementAllowances)
      .toEqual(entries.map(({ label, amount }) => ({ label, amount })));
  });

  it("旧確定・0円の報告書やFirebase空配列の欠損を許容し、名目を推定しない", () => {
    const { row, report } = input([]);
    delete report.totals.accountingInputs;
    for (const selected of [reward, row]) {
      for (const reports of [[], [report]]) {
        const sheet = buildCastStatementSheets([selected], reports, "2026-09")[0];
        expect(sheet.statementAllowances).toEqual([]);
        expect(sheet.statementCells.F15).toBe(500);
        expect(sheet.statementCells.F26).toBe(selected.netPay);
      }
    }
  });

  it("在籍のみをIDで照合し、同名別人の手当を混ぜない", () => {
    const first = input([entry("a", "手当A", 1)]);
    const second = input([entry("b", "手当B", 2)]);
    second.row.id = "cast-2"; second.report.id = "cast-2";
    second.report.totals.accountingInputs![0].castId = "cast-2";
    const trial = { ...reward, id: "trial", trialOnly: true };
    const sheets = buildCastStatementSheets([trial, second.row, first.row], [first.report, second.report], "2026-09");
    expect(sheets.map((sheet) => sheet.statementAllowances)).toEqual([[{ label: "手当B", amount: 2 }], [{ label: "手当A", amount: 1 }]]);
  });

  const corruptions: Array<[string, (report: CastSalesReport) => void]> = [
    ["名目欠損", (r) => { delete r.totals.accountingInputs; }],
    ["空明細", (r) => { r.totals.accountingInputs = []; }],
    ["別人の明細", (r) => { r.totals.accountingInputs![0].castId = "other"; }],
    ["重複ID", (r) => { r.totals.accountingInputs!.push({ ...r.totals.accountingInputs![0] }); }],
    ["白紙名目", (r) => { r.totals.accountingInputs![0].label = " "; }],
    ["長すぎる名目", (r) => { r.totals.accountingInputs![0].label = "手".repeat(101); }],
    ["日付未解決", (r) => { delete (r.totals.accountingInputs![0] as Partial<ResolvedCastAccountingInput>).businessDate; }],
    ["別月", (r) => { r.totals.accountingInputs![0].businessDate = "2026-10-02"; }],
    ["金額不一致", (r) => { r.totals.accountingInputs![0].amount += 1; }],
    ["報告書合計不一致", (r) => { r.totals.additionalAllowance = 0; }],
    ["マイナス", (r) => { r.totals.accountingInputs![0].amount = -1; }],
    ["手当の小数", (r) => { r.totals.accountingInputs![0].amount = 1.5; }],
    ["上限超過", (r) => { r.totals.accountingInputs![0].amount = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  it.each(corruptions)("%sは明細だけ拒否し、受領書出力を妨げない", (_name, corrupt) => {
    const { row, report } = input([entry("a", "手当", 100)]);
    corrupt(report);
    expect(() => buildCastStatementSheets([row], [report], "2026-09")).toThrow();
    expect(() => buildCastReceiptSheets([row], "2026-09")).not.toThrow();
  });

  it("追加手当がある報告書の欠落・同一人物報告書重複を拒否する", () => {
    const { row, report } = input([entry("a", "手当", 100)]);
    expect(() => buildCastStatementSheets([row], [], "2026-09")).toThrow("追加手当");
    expect(() => buildCastStatementSheets([row], [report, report], "2026-09")).toThrow("追加手当");
    expect(() => buildCastReceiptSheets([row], "2026-09")).not.toThrow();
  });
});
