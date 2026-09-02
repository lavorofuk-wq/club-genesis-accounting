import type {
  CastSalesRow,
  ClosingTransaction,
  IdentityResolution,
  PosClosing,
  TransactionItem,
  WorkRow
} from "./types";

const number = (value: unknown) => {
  const result = Number(value || 0);
  return Number.isFinite(result) ? result : 0;
};

const unique = (values: unknown[]) => [...new Set(values.filter(Boolean).map(String).filter(Boolean))];

export function hoursBetween(startTime: string, endTime: string): number {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  if (![startHour, startMinute, endHour, endMinute].every(Number.isFinite)) return 0;
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (minutes < 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

export function transactionItemAmount(item: TransactionItem): number {
  const price = number(item.price ?? item.unitPrice);
  const quantity = number(item.quantity ?? item.qty);
  const calculated = price > 0 && quantity > 0 ? price * quantity : 0;
  const explicit = number(item.lineTotal ?? item.priceTotal ?? item.subtotal ?? item.total ?? item.amount);
  if (calculated > 0 && explicit > 0) return Math.min(calculated, explicit);
  return explicit || calculated;
}

function sourceNames(closing: PosClosing) {
  const names = new Map<string, string>();
  const add = (id: unknown, name: unknown) => {
    if (id && name) names.set(String(id), String(name));
  };
  closing.castSales.forEach((row) => add(row.castId || row.posCastId, row.castName || row.name));
  closing.castWork.forEach((row) => add(row.castId || row.id, row.castName || row.name));
  closing.trialWork.forEach((row) => add(row.castId || row.id, row.castName || row.name));
  closing.rosterSnapshot?.casts.forEach((row) => add(row.castId, row.name));
  closing.transactions.forEach((transaction) =>
    transaction.items?.forEach((item) => add(item.castId, item.castName)));
  return names;
}

function banaiPhases(items: TransactionItem[]) {
  const phases = new Map<string, { castIds: string[]; subtotal: number }>();
  let currentCastIds: string[] = [];
  items.forEach((item) => {
    if (item.isBanaiExtension) {
      currentCastIds = unique([...(item.banaiExtCastIds || []), item.banaiExtCastId, item.castId]);
    }
    if (!currentCastIds.length || item.isDiscount) return;
    const castIds = [...currentCastIds].sort();
    const key = castIds.join("|");
    const current = phases.get(key) || { castIds, subtotal: 0 };
    current.subtotal += transactionItemAmount(item);
    phases.set(key, current);
  });
  return [...phases.values()];
}

export function calculateCastSales(closing: PosClosing): CastSalesRow[] {
  if (!closing.transactions.length) {
    return closing.castSales.map((row) => ({
      ...row,
      honShimeiSales: number(row.honShimeiSales),
      jonaiExtensionSales: number(row.jonaiExtensionSales),
      totalAttributedSales: number(row.totalAttributedSales)
        || number(row.honShimeiSales) + number(row.jonaiExtensionSales)
    }));
  }
  const names = sourceNames(closing);
  const rows = new Map<string, Required<Pick<CastSalesRow,
    "castId" | "castName" | "honShimeiSales" | "jonaiExtensionSales" | "totalAttributedSales">>>();
  const ensure = (id: string) => {
    if (!rows.has(id)) {
      rows.set(id, {
        castId: id,
        castName: names.get(id) || "名称未設定",
        honShimeiSales: 0,
        jonaiExtensionSales: 0,
        totalAttributedSales: 0
      });
    }
    return rows.get(id)!;
  };

  closing.transactions.forEach((transaction: ClosingTransaction) => {
    const items = transaction.items || [];
    const honCastIds = unique([
      ...(transaction.honShimeiCastIds || []),
      ...items.filter((item) => item.isHonShimei).map((item) => item.castId)
    ]);
    if (honCastIds.length) {
      const share = Math.floor(number(transaction.subtotal) / honCastIds.length);
      honCastIds.forEach((id) => {
        const row = ensure(id);
        row.honShimeiSales += share;
        row.totalAttributedSales += share;
      });
      return;
    }
    banaiPhases(items).forEach((phase) => {
      const share = Math.floor(phase.subtotal / phase.castIds.length);
      phase.castIds.forEach((id) => {
        const row = ensure(id);
        row.jonaiExtensionSales += share;
        row.totalAttributedSales += share;
      });
    });
  });
  return [...rows.values()].sort((a, b) => b.totalAttributedSales - a.totalAttributedSales);
}

export function applyIdentityResolutions(
  closing: PosClosing,
  resolutions: IdentityResolution[]
): PosClosing {
  const resolutionMap = new Map(resolutions.map((item) => [item.sourceCastId, item]));
  const remap = (row: WorkRow): WorkRow => {
    const sourceId = String(row.castId || row.id || "");
    const target = resolutionMap.get(sourceId);
    if (!target) return row;
    return {
      ...row,
      id: target.targetId,
      castId: target.targetId,
      name: target.targetName,
      castName: target.targetName
    };
  };
  const computedSales = calculateCastSales(closing).map((row) => {
    const sourceId = String(row.castId || row.posCastId || "");
    const target = resolutionMap.get(sourceId);
    return target ? {
      ...row,
      posCastId: sourceId,
      castId: target.targetId,
      castName: target.targetName,
      name: target.targetName
    } : row;
  });
  return {
    ...closing,
    castSales: computedSales,
    castWork: closing.castWork.map(remap),
    trialWork: closing.trialWork.map(remap)
  };
}
