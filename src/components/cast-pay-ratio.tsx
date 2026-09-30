import type { CastReward } from "@/domain/gms";

type RatioBasis = Pick<CastReward, "adoptedReward" | "honShimeiSales" | "jonaiExtensionSales" | "additionalSales">;
const formula = "採用報酬 ÷（本指名売上＋場内延長売上＋追加売上）×100。原価控除前・手当加算前。小数第2位以下切捨て。";

function decimalParts(value: number) {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  return { units: BigInt(coefficient.replace(".", "")), scale: (coefficient.split(".")[1]?.length || 0) - Number(exponent) };
}

export function CastPayRatio({ row }: { row: RatioBasis }) {
  const amounts = [row.adoptedReward, row.honShimeiSales, row.jonaiExtensionSales, row.additionalSales ?? 0];
  if (amounts.some((value) => !Number.isFinite(value) || value < 0)) {
    return <span className="cast-pay-ratio cast-pay-ratio--red" title="採用報酬または売上の金額を確認できません。">計算不可</span>;
  }
  // 表示だけを十進数の整数比で扱い、旧小数や大きな金額でも境界・切捨てが浮動小数誤差でずれないようにする。
  const parts = amounts.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const [reward, honShimei, jonai, additional] = parts.map((part) => part.units * 10n ** BigInt(scale - part.scale));
  const sales = honShimei + jonai + additional;
  if (sales === 0n) return <span className="cast-pay-ratio cast-pay-ratio--red" title={formula}>売上0円</span>;
  const tenths = reward * 1000n / sales;
  const tone = reward < sales ? "blue" : reward * 10n < sales * 11n ? "yellow" : "red";
  return <span className={`cast-pay-ratio cast-pay-ratio--${tone}`} title={formula}>{`${tenths / 10n}.${tenths % 10n}%`}</span>;
}
