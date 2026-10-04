/** 在籍キャストの月次源泉税。総支給額の途中丸めをせず、最終税額のみ1円未満切捨て。 */
export function calculateCastWithholding(grossPay: number, month: string): number {
  const match = typeof month === "string" ? /^([0-9]{4})-(0[1-9]|1[0-2])$/.exec(month) : null;
  if (!match || Number(match[1]) < 1) throw new Error("源泉所得税の対象月が正しくありません。");
  if (!Number.isFinite(grossPay) || grossPay < 0 || grossPay > Number.MAX_SAFE_INTEGER) {
    throw new Error("源泉所得税の総支給額が処理可能な範囲外です。");
  }
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIndex];
  const deduction = days * 5000;
  if (grossPay <= deduction) return 0;

  // この範囲（控除額超～MAX_SAFE_INTEGER）のtoStringは指数表記にならない。
  // 旧保存値に小数があっても、epsilon補正や途中の円未満切捨ては行わない。
  const [integer, fraction = ""] = grossPay.toString().split(".");
  const scale = 10n ** BigInt(fraction.length);
  const grossUnits = BigInt(integer + fraction);
  const taxableUnits = grossUnits - BigInt(deduction) * scale;
  return Number(taxableUnits * 1021n / (scale * 10000n));
}
