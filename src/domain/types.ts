export type MoneyRow = {
  category?: string;
  type?: string;
  amount: number;
  note?: string;
};

export type WorkRow = {
  id?: string;
  castId?: string;
  staffId?: string;
  name?: string;
  castName?: string;
  staffName?: string;
  startTime?: string;
  endTime?: string;
  hours: number;
  isTrial?: boolean;
};

export type CastSalesRow = {
  castId?: string;
  posCastId?: string;
  castName?: string;
  name?: string;
  totalAttributedSales?: number;
  honShimeiSales?: number;
  jonaiExtensionSales?: number;
};

export type TransactionItem = {
  name?: string;
  label?: string;
  category?: string;
  unitPrice?: number;
  quantity?: number;
  amount?: number;
  isHonShimei?: boolean;
  isBanaiShimei?: boolean;
  isExtension?: boolean;
  isBanaiExtension?: boolean;
};

export type ClosingTransaction = {
  tableId?: string;
  tableLabel?: string;
  subtotal?: number;
  total?: number;
  castIds?: string[];
  honShimeiCastIds?: string[];
  banaiCastIds?: string[];
  items?: TransactionItem[];
};

export type RosterCast = {
  castId: string;
  name: string;
  internalNo?: number;
  status?: string;
};

export type LifecycleEvent = {
  eventId: string;
  eventType: "entered" | "departed" | "trial";
  castId: string;
  castName?: string;
  eventAt: string;
};

export type PosClosing = {
  schema: "club-genesis-pos-closing";
  schemaVersion: 1 | 2;
  submissionId: string;
  checksum: string;
  generatedAt?: string;
  supersedesSubmissionId?: string;
  businessDate: string;
  status?: string;
  sales: {
    totalSales: number;
    cashSales: number;
    cardSales: number;
  };
  customers: {
    groupCount: number;
    totalCustomers: number;
    customerUnitPrice?: number;
  };
  nominations: {
    honShimeiCount?: number;
    honShimei?: number;
    jonaiCount?: number;
    jonai?: number;
  };
  expenses: MoneyRow[];
  allowances: MoneyRow[];
  transactions: ClosingTransaction[];
  castSales: CastSalesRow[];
  castWork: WorkRow[];
  trialWork: WorkRow[];
  staffWork: WorkRow[];
  rosterSnapshot?: {
    complete: boolean;
    capturedAt: string;
    casts: RosterCast[];
  };
  lifecycleEvents: LifecycleEvent[];
  source?: Record<string, unknown>;
  [key: string]: unknown;
};

export type CastMember = {
  id: string;
  posCastId: string;
  personKey?: string;
  name: string;
  internalNo: number;
  status: "active" | "departed" | "trial";
  deleted?: boolean;
  rewardSystem?: "" | "slideHourly" | "guaranteedHourly";
  guaranteedHourlyRate?: number;
  entryDate?: string;
  exitedDate?: string;
  previousNames?: string[];
  previousPosCastIds?: string[];
};

export type FinalizedClosing = PosClosing & {
  id: string;
  status: "finalized";
};

export type FixedExpense = {
  month: string;
  rent: number;
  karaoke: number;
  towel: number;
  leasekin: number;
  landline: number;
  saibuGas: number;
  usen: number;
};

export type ImportDifference = {
  kind: "linked" | "new" | "renamed" | "missing-local" | "conflict";
  sourceCastId: string;
  sourceName: string;
  sourceInternalNo?: number;
  sourceStatus?: string;
  memberId?: string;
  memberName?: string;
  message: string;
  blocking: boolean;
};

export type ImportPreview = {
  closing: PosClosing;
  differences: ImportDifference[];
  blockingCount: number;
  newCount: number;
};
