import type { CastReward } from "./gms";

const amountKeys = ["hourlyPay", "honShimeiBack", "banaiShimeiBack", "dohanBack", "bottleBack", "drinkBack",
  "hourlyAndBack", "salesReward", "adoptedReward", "beautyAllowance", "grossPay", "dailyPayment",
  "advancePayment", "transportFee", "withholding", "netPay"] as const;
const equalAmount = (left: number, right: number) => Math.abs(left - right) < 0.000001;

/** 画面が選んだ承認済み結果／確定スナップショットを受け取り、報酬を再計算しない。 */
export function buildCastReceiptSheets(rows: CastReward[], month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("対象月が正しくありません。");
  if (!rows.length) throw new Error("対象月の承認済みキャスト報酬がありません。");
  const ids = new Set<string>();
  return rows.map((row) => {
    if (!row.id?.trim() || !row.name?.trim() || ids.has(row.id)) throw new Error("キャストの名前・識別情報が正しくありません。");
    ids.add(row.id);
    const fail = () => { throw new Error(`${row.name}の報酬内訳に欠損または合計の不一致があります。元データを確認してください。`); };
    if (amountKeys.some((key) => !Number.isFinite(row[key]) || Math.abs(row[key]) > Number.MAX_SAFE_INTEGER || (key !== "netPay" && row[key] < 0))
      || !["hourlyAndBack", "salesReward"].includes(row.adoptedSystem)) fail();
    const backs = row.honShimeiBack + row.banaiShimeiBack + row.dohanBack + row.bottleBack + row.drinkBack;
    const deductions = row.dailyPayment + row.advancePayment + row.transportFee;
    const sales = row.adoptedSystem === "salesReward";
    if (sales && (!Number.isFinite(row.rewardRate) || row.rewardRate <= 0 || row.rewardRate > 1)) fail();
    if (!equalAmount(row.hourlyAndBack, row.hourlyPay + backs)
      || !equalAmount(row.adoptedReward, sales ? row.salesReward : row.hourlyAndBack)
      || !equalAmount(row.grossPay, row.adoptedReward + row.beautyAllowance)
      || !equalAmount(row.netPay, row.grossPay - deductions - row.withholding)) fail();
    const cells: Record<string, string | number> = sales ? {
      B2: `①　日売上－酒代（50％）×${Number((row.rewardRate * 100).toFixed(10))}％`,
      G1: `${Number(month.slice(5))}月報酬分`,
      G2: row.adoptedReward,
      G3: row.beautyAllowance,
      G4: row.grossPay,
      G5: deductions,
      G6: row.withholding,
      G7: row.netPay,
      G9: row.name,
    } : {
      G1: `${Number(month.slice(5))}月報酬分`,
      G2: row.hourlyPay,
      G3: backs,
      G4: row.beautyAllowance,
      G5: row.grossPay,
      G6: deductions,
      G7: row.withholding,
      G8: row.netPay,
      G10: row.name,
    };
    return { template: row.adoptedSystem, name: row.name, cells };
  });
}
