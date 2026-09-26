/** 旧確定月の未保存項目は0とし、新しい追加金額の改変を帳票で見逃さない。 */
export function additionalCastAmounts(value: {
  additionalSales?: number;
  additionalAllowance?: number;
  additionalTransportFee?: number;
}) {
  const result = {
    sales: value.additionalSales ?? 0,
    allowance: value.additionalAllowance ?? 0,
    transport: value.additionalTransportFee ?? 0,
  };
  if (Object.values(result).some((amount) => !Number.isSafeInteger(amount) || amount < 0)
    || result.sales % 10 !== 0 || result.transport % 500 !== 0) {
    throw new Error("キャストデータ入力の売上・手当・送迎代の金額を確認してください。");
  }
  return result;
}
