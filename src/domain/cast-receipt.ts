import type { CastReward, CastSalesReport } from "./gms";
import { additionalCastAmounts } from "./cast-input-export";
import { normalizeCastAccountingInputs } from "./cast-accounting-inputs";

const amountKeys = ["hourlyPay", "honShimeiBack", "banaiShimeiBack", "dohanBack", "bottleBack", "drinkBack",
  "hourlyAndBack", "salesReward", "adoptedReward", "beautyAllowance", "grossPay", "dailyPayment",
  "advancePayment", "transportFee", "withholding", "netPay", "days", "hours",
  "honShimeiSales", "jonaiExtensionSales", "liquorCost"] as const;
const equalAmount = (left: number, right: number) => Math.abs(left - right) < 0.000001;

/** 承認済み結果／確定スナップショットの在籍分だけを出力し、報酬や月次区分を再計算しない。 */
export function buildCastReceiptSheets(rows: CastReward[], month: string, legalNames: Readonly<Record<string, string>> = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月が正しくありません。");
  if (rows.some((row) => typeof row.trialOnly !== "boolean")) throw new Error("キャストの在籍・体入区分を確認できません。報酬データを再読み込みしてください。");
  // 同月入店者は体入分も含めtrialOnly=false。現在のマスタではなく対象月の保存区分を使う。
  const regularRows = rows.filter((row) => !row.trialOnly);
  if (!regularRows.length) throw new Error("対象月の承認済み在籍キャスト報酬がありません。");
  const ids = new Set<string>();
  return regularRows.map((row) => {
    if (!row.id?.trim() || !row.name?.trim() || ids.has(row.id)) throw new Error("キャストの名前・識別情報が正しくありません。");
    ids.add(row.id);
    const fail = () => { throw new Error(`${row.name}の報酬内訳に欠損または合計の不一致があります。元データを確認してください。`); };
    if (amountKeys.some((key) => !Number.isFinite(row[key]) || Math.abs(row[key]) > Number.MAX_SAFE_INTEGER || (key !== "netPay" && row[key] < 0))
      || !["hourlyAndBack", "salesReward"].includes(row.adoptedSystem)) fail();
    const backs = row.honShimeiBack + row.banaiShimeiBack + row.dohanBack + row.bottleBack + row.drinkBack;
    const deductions = row.dailyPayment + row.advancePayment + row.transportFee;
    const sales = row.adoptedSystem === "salesReward";
    const additional = additionalCastAmounts(row);
    const allowances = row.beautyAllowance + additional.allowance;
    if (!Number.isSafeInteger(row.days) || (row.appliedHourlyRates !== undefined && (!Array.isArray(row.appliedHourlyRates)
      || !row.appliedHourlyRates.length || row.appliedHourlyRates.some((rate) => !Number.isFinite(rate) || rate < 0 || rate > Number.MAX_SAFE_INTEGER)))) fail();
    if (sales && (!Number.isFinite(row.rewardRate) || row.rewardRate <= 0 || row.rewardRate > 1)) fail();
    if (!equalAmount(row.hourlyAndBack, row.hourlyPay + backs)
      || !equalAmount(row.adoptedReward, sales ? row.salesReward : row.hourlyAndBack)
      || !equalAmount(row.grossPay, row.adoptedReward + allowances)
      || !equalAmount(row.netPay, row.grossPay - deductions - row.withholding)) fail();
    const cells: Record<string, string | number> = sales ? {
      B2: `①　日売上－酒代（50％）×${Number((row.rewardRate * 100).toFixed(10))}％`,
      G1: `${Number(month.slice(5))}月報酬分`,
      G2: row.adoptedReward,
      G3: allowances,
      G4: row.grossPay,
      G5: deductions,
      G6: row.withholding,
      G7: row.netPay,
      G9: row.name,
    } : {
      G1: `${Number(month.slice(5))}月報酬分`,
      G2: row.hourlyPay,
      G3: backs,
      G4: allowances,
      G5: row.grossPay,
      G6: deductions,
      G7: row.withholding,
      G8: row.netPay,
      G10: row.name,
    };
    const rates = row.appliedHourlyRates && [...new Set(row.appliedHourlyRates)].sort((a, b) => a - b);
    const statementCells: Record<string, string | number> = {
      D3: `${Number(month.slice(0, 4))}年${Number(month.slice(5))}月分`,
      F4: row.name,
      E5: legalNames[row.id] || "",
      F6: row.days,
      F7: row.hours,
      F8: !rates ? "未保存" : rates.length === 1 ? rates[0] : rates.map((rate) => rate.toLocaleString("ja-JP", { maximumFractionDigits: 15 })).join(" / "),
      ...(sales ? {
        F9: row.honShimeiSales + row.jonaiExtensionSales + additional.sales,
        F10: row.liquorCost * 0.5,
        B11: "報酬率",
        F11: Number((row.rewardRate * 100).toFixed(10)),
        F12: row.adoptedReward,
      } : {
        F9: row.hourlyPay,
        F10: row.honShimeiBack,
        F11: row.banaiShimeiBack,
        F12: row.dohanBack,
        F13: row.bottleBack,
        F14: row.drinkBack,
      }),
      F15: allowances,
      ...(additional.allowance > 0 ? { B15: "美容室・手当て等" } : {}),
      F18: row.grossPay,
      F19: row.withholding,
      F20: row.dailyPayment,
      F21: row.transportFee,
      F22: row.advancePayment,
      F25: deductions + row.withholding,
      F26: row.netPay,
    };
    return { template: row.adoptedSystem, name: row.name, cells, statementCells };
  });
}

/** 明細書だけに保存済みの追加手当名目を渡す。受領書の合算表示・金額は変更しない。 */
export function buildCastStatementSheets(rows: CastReward[], reports: CastSalesReport[], month: string,
  legalNames: Readonly<Record<string, string>> = {}) {
  const sheets = buildCastReceiptSheets(rows, month, legalNames);
  if (!Array.isArray(reports)) throw new Error("明細書のキャスト売上データを読み込めません。");
  const regularRows = rows.filter((row) => !row.trialOnly);
  const usedInputIds = new Set<string>();
  return sheets.map((sheet, index) => {
    const reward = regularRows[index];
    const expectedAllowance = additionalCastAmounts(reward).allowance;
    const matching = reports.filter((report) => report?.id === reward.id);
    const fail = () => { throw new Error(`${reward.name}の追加手当の名目・金額を確認できません。明細書の出力元データを確認してください。`); };
    if (matching.length > 1 || !matching.length && expectedAllowance > 0) fail();
    const report = matching[0];
    if (report && (!report.totals || additionalCastAmounts(report.totals).allowance !== expectedAllowance)) fail();
    // 追加額0円の旧確定・Firebase空配列省略は許容する。正額の名目を推定しない。
    const inputs = normalizeCastAccountingInputs(report?.totals.accountingInputs);
    const grouped = new Map<string, number>();
    let total = 0;
    for (const input of inputs) {
      if (input.castId !== reward.id || usedInputIds.has(input.id)
        || typeof input.businessDate !== "string" || !input.businessDate.startsWith(`${month}-`)) fail();
      usedInputIds.add(input.id);
      if (input.kind !== "allowance") continue;
      total += input.amount;
      const amount = (grouped.get(input.label) || 0) + input.amount;
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(amount)) fail();
      grouped.set(input.label, amount);
    }
    if (total !== expectedAllowance) fail();
    const statementCells: Record<string, string | number> = {
      ...sheet.statementCells, B15: "美容室手当", F15: reward.beautyAllowance,
    };
    return {
      ...sheet,
      statementCells,
      statementAllowances: [...grouped].map(([label, amount]) => ({ label, amount })),
    };
  });
}
