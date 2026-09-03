export type MoneyRow = {
  id?: string;
  category?: string;
  type?: string;
  amount: number;
  note?: string;
  personId?: string;
  personName?: string;
  personType?: "cast" | "trial" | "staff";
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
  payType?: "hourly" | "daily" | string;
  payAmount?: number;
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
  itemId?: string;
  id?: string;
  name?: string;
  label?: string;
  category?: string;
  price?: number;
  unitPrice?: number;
  quantity?: number;
  qty?: number;
  amount?: number;
  lineTotal?: number;
  priceTotal?: number;
  subtotal?: number;
  total?: number;
  castId?: string;
  castName?: string;
  banaiExtCastIds?: string[];
  banaiExtCastId?: string;
  isSet?: boolean;
  isHonShimei?: boolean;
  isBanaiShimei?: boolean;
  isExtension?: boolean;
  isBanaiExtension?: boolean;
  isVipCharge?: boolean;
  isDiscount?: boolean;
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
  auricLiquorAmount?: number;
  payrollDeductions?: MoneyRow[];
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
  hourlyRate?: number;
  introducerId?: string;
  introducerName?: string;
  note?: string;
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
  utilities: number;
  karaoke: number;
  towel: number;
  leasekin: number;
  communications: number;
  landline?: number;
  saibuGas?: number;
  usen?: number;
};

export type Introducer = {
  id: string;
  name: string;
  introductionFeeAmount: number;
  advisoryFeeEnabled: boolean;
  advisoryFeeAmount: number;
  note: string;
  feeSystem?: "sales10" | "pay10" | "higher10";
  deleted?: boolean;
};

export type PartTimeWorker = {
  id: string;
  name: string;
  employmentType: "partTime";
  jobType: "hall" | "kitchen" | "driver";
  payType: "hourly" | "daily";
  payAmount: number;
  status: "active" | "departed";
};

export type LiquorCost = {
  id: string;
  brandName: string;
  costAmount: number;
  deleted?: boolean;
};

export type LocalLifecycleAction = {
  id: string;
  eventType: LifecycleEvent["eventType"];
  memberId?: string;
  name: string;
  hourlyRate?: number;
  introducerId?: string;
  introducerName?: string;
};

export type IdentityResolution = {
  sourceCastId: string;
  targetId: string;
  targetName: string;
};

export type StoreClosingInput = {
  preview: ImportPreview;
  lifecycleActions: LocalLifecycleAction[];
  identityResolutions: IdentityResolution[];
  staffWork: WorkRow[];
  expenses: MoneyRow[];
  auricLiquorAmount: number;
  payrollDeductions: MoneyRow[];
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
