"use client";

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "firebase/firestore";
import type { User } from "firebase/auth";
import type {
  CastMember,
  FinalizedClosing,
  FixedExpense,
  ImportPreview,
  Introducer,
  LiquorCost,
  LocalLifecycleAction,
  PartTimeWorker,
  PosClosing,
  StoreClosingInput
} from "@/domain/types";
import { safeDocumentId } from "@/domain/pos-import";
import { applyIdentityResolutions } from "@/domain/closing-calculation";
import { collectionNames, db } from "./client";

export type WorkspaceData = {
  closings: (PosClosing & { id: string })[];
  casts: CastMember[];
  staff: PartTimeWorker[];
  introducers: Introducer[];
  liquorCosts: LiquorCost[];
  fixedExpenses: FixedExpense[];
};

const number = (value: unknown) => Number(value || 0);
const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

function normalizeClosing(id: string, raw: Record<string, unknown>): PosClosing & { id: string } {
  const sales = (raw.sales || {}) as Record<string, unknown>;
  const customers = (raw.customers || {}) as Record<string, unknown>;
  const nominations = (raw.nominations || raw.shimeiInfo || {}) as Record<string, unknown>;
  const businessDate = String(raw.businessDate || raw.date || id);
  return {
    ...raw,
    id,
    schema: "club-genesis-pos-closing",
    schemaVersion: ([1, 2].includes(number(raw.schemaVersion)) ? number(raw.schemaVersion) : 1) as 1 | 2,
    submissionId: String(raw.submissionId || (raw.source as Record<string, unknown> | undefined)?.submissionId || id),
    checksum: String(raw.checksum || ""),
    businessDate,
    status: String(raw.status || "submitted"),
    sales: {
      totalSales: number(sales.totalSales ?? raw.totalSales),
      cashSales: number(sales.cashSales ?? raw.cashSales),
      cardSales: number(sales.cardSales ?? raw.cardSales)
    },
    customers: {
      groupCount: number(customers.groupCount ?? raw.groupCount),
      totalCustomers: number(customers.totalCustomers ?? raw.totalCustomers),
      customerUnitPrice: number(customers.customerUnitPrice ?? raw.customerUnitPrice)
    },
    nominations: {
      honShimeiCount: number(nominations.honShimeiCount ?? nominations.honShimei),
      jonaiCount: number(nominations.jonaiCount ?? nominations.jonai)
    },
    expenses: array<Record<string, unknown>>(raw.expenses).map((item) => ({ ...item, amount: number(item.amount) })),
    allowances: array<Record<string, unknown>>(raw.allowances).map((item) => ({ ...item, amount: number(item.amount) })),
    transactions: array(raw.transactions),
    castSales: array(raw.castSales),
    castWork: array<Record<string, unknown>>(raw.castWork || raw.castHours).map((item) => ({ ...item, hours: number(item.hours) })),
    trialWork: array<Record<string, unknown>>(raw.trialWork).map((item) => ({ ...item, hours: number(item.hours) })),
    staffWork: array<Record<string, unknown>>(raw.staffWork || raw.staffHours).map((item) => ({ ...item, hours: number(item.hours) })),
    lifecycleEvents: array(raw.lifecycleEvents)
  } as PosClosing & { id: string };
}

function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => withoutUndefined(item)).filter((item) => item !== undefined) as T;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)])
    ) as T;
  }
  return value;
}

export async function userRole(user: User): Promise<string> {
  const token = await user.getIdTokenResult();
  const claimRole = String(token.claims.role || "");
  if (claimRole === "shop" || claimRole === "accounting") return claimRole;
  const snapshot = await getDoc(doc(db, "users", user.uid));
  return snapshot.exists() ? String(snapshot.data().role || "") : "";
}

export async function loadWorkspaceData(): Promise<WorkspaceData> {
  const names = collectionNames();
  const [closingsSnapshot, castsSnapshot, staffSnapshot, introducerSnapshot, liquorSnapshot, fixedSnapshot] = await Promise.all([
    getDocs(collection(db, names.closings)),
    getDocs(collection(db, names.casts)),
    getDocs(collection(db, names.staff)),
    getDocs(collection(db, names.introducers)),
    getDocs(collection(db, names.liquorCosts)),
    getDocs(collection(db, names.fixedExpenses))
  ]);
  return {
    closings: closingsSnapshot.docs
      .map((item) => normalizeClosing(item.id, item.data()))
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
    casts: castsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CastMember)),
    staff: staffSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as PartTimeWorker)),
    introducers: introducerSnapshot.docs.map((item) => ({
      id: item.id,
      name: String(item.data().name || ""),
      introductionFeeAmount: number(item.data().introductionFeeAmount),
      advisoryFeeEnabled: item.data().advisoryFeeEnabled === true,
      advisoryFeeAmount: number(item.data().advisoryFeeAmount),
      note: String(item.data().note || ""),
      feeSystem: item.data().feeSystem || "higher10"
    } as Introducer)),
    liquorCosts: liquorSnapshot.docs.map((item) => ({
      id: item.id,
      brandName: String(item.data().brandName || ""),
      costAmount: number(item.data().costAmount)
    })),
    fixedExpenses: fixedSnapshot.docs.map((item) => ({
      month: String(item.data().month || item.id),
      rent: number(item.data().rent),
      utilities: number(item.data().utilities ?? item.data().saibuGas),
      karaoke: number(item.data().karaoke),
      towel: number(item.data().towel),
      leasekin: number(item.data().leasekin),
      communications: number(item.data().communications ?? item.data().landline) + number(item.data().usen),
      landline: number(item.data().landline),
      saibuGas: number(item.data().saibuGas),
      usen: number(item.data().usen)
    }))
  };
}

type ImportOptions = {
  lifecycleActions?: LocalLifecycleAction[];
  identityResolutions?: StoreClosingInput["identityResolutions"];
  staffWork?: StoreClosingInput["staffWork"];
  expenses?: StoreClosingInput["expenses"];
  auricLiquorAmount?: number;
  payrollDeductions?: StoreClosingInput["payrollDeductions"];
};

export async function importClosing(preview: ImportPreview, user: User, options: ImportOptions = {}): Promise<void> {
  if (preview.blockingCount) throw new Error("未解決の在籍差分があります。取込を中止しました。");
  const names = collectionNames();
  const lifecycleActions = options.lifecycleActions || [];
  const actionMemberIds = new Map(lifecycleActions.map((action) => [
    action.id,
    action.eventType === "trial" ? `member_${safeDocumentId(action.id)}` : String(action.memberId || "")
  ]));
  const identityResolutions = (options.identityResolutions || []).map((resolution) => ({
    ...resolution,
    targetId: actionMemberIds.get(resolution.targetId) || resolution.targetId
  }));
  const resolvedSourceIds = new Set(identityResolutions.map((item) => item.sourceCastId));
  const closing = applyIdentityResolutions(preview.closing, identityResolutions);
  if (options.staffWork) closing.staffWork = options.staffWork;
  if (options.expenses) closing.expenses = options.expenses;
  if (options.auricLiquorAmount !== undefined) closing.auricLiquorAmount = number(options.auricLiquorAmount);
  if (options.payrollDeductions) {
    closing.payrollDeductions = options.payrollDeductions.map((item) => ({
      ...item,
      personId: actionMemberIds.get(String(item.personId || "")) || item.personId
    }));
  }
  const importId = safeDocumentId(closing.submissionId);
  const importReference = doc(db, names.jsonImports, importId);
  const sameDate = await getDocs(query(collection(db, names.jsonImports), where("businessDate", "==", closing.businessDate)));
  const completedSameDate = sameDate.docs
    .map((item) => item.data())
    .filter((item) => item.status === "completed" && item.submissionId !== closing.submissionId);
  if (completedSameDate.length && !completedSameDate.some((item) => item.submissionId === closing.supersedesSubmissionId)) {
    throw new Error("同じ営業日のJSONが取込済みです。訂正版にはsupersedesSubmissionIdが必要です。");
  }
  const supersededImport = completedSameDate.find((item) => item.submissionId === closing.supersedesSubmissionId);
  const supersededClosingId = String(supersededImport?.closingId || "");
  if (supersededClosingId) {
    const previousClosing = await getDoc(doc(db, names.closings, supersededClosingId));
    if (previousClosing.exists() && previousClosing.data().status === "finalized") {
      throw new Error("訂正対象は経理確定済みです。先に確定データの扱いを確認してください。");
    }
  }
  const estimatedWrites = 2
    + preview.differences.filter((item) => item.kind === "new" && !resolvedSourceIds.has(item.sourceCastId)).length * 2
    + lifecycleActions.length * 2
    + identityResolutions.length
    + closing.lifecycleEvents.length
    + (supersededClosingId ? 1 : 0);
  if (estimatedWrites > 450) {
    throw new Error("1ファイルの更新件数が安全上限を超えています。JSONを確認してください。");
  }

  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(importReference);
    if (existing.exists()) {
      if (String(existing.data().checksum || "") !== closing.checksum) {
        throw new Error("同じsubmissionIdで内容の異なるJSONが存在します。");
      }
      if (existing.data().status === "completed") {
        throw new Error("このJSONは取込済み、または別端末で処理中です。");
      }
      if (existing.data().status === "processing") {
        const processingAt = existing.data().processingAt;
        const processingMillis = typeof processingAt?.toMillis === "function" ? processingAt.toMillis() : 0;
        if (!processingMillis || Date.now() - processingMillis < 15 * 60 * 1000) {
          throw new Error("このJSONは別端末で処理中です。15分後に取込履歴を確認してください。");
        }
      }
    }
    transaction.set(importReference, {
      submissionId: closing.submissionId,
      checksum: closing.checksum,
      schemaVersion: closing.schemaVersion,
      businessDate: closing.businessDate,
      status: "processing",
      processingBy: user.uid,
      processingAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  });

  try {
    const batch = writeBatch(db);
    const closingId = `pos_${safeDocumentId(closing.submissionId)}`;
    batch.set(doc(db, names.closings, closingId), withoutUndefined({
      ...closing,
      status: "submitted",
      importedBy: user.uid,
      importedAt: serverTimestamp(),
      source: {
        ...(closing.source || {}),
        importMethod: "jsonFile",
        submissionId: closing.submissionId
      }
    }));
    if (supersededClosingId) {
      batch.set(doc(db, names.closings, supersededClosingId), {
        status: "superseded",
        supersededByClosingId: closingId,
        supersededAt: serverTimestamp(),
        supersededBy: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
    }

    preview.differences.filter((item) => item.kind === "new" && !resolvedSourceIds.has(item.sourceCastId)).forEach((item) => {
      const memberId = `member_${safeDocumentId(item.sourceCastId)}`;
      batch.set(doc(db, names.casts, memberId), {
        posCastId: item.sourceCastId,
        personKey: `person_${memberId}`,
        name: item.sourceName,
        internalNo: number(item.sourceInternalNo),
        status: item.sourceStatus === "trial" ? "trial" : "active",
        source: "pos",
        previousNames: [],
        previousPosCastIds: [],
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedBy: user.uid,
        updatedAt: serverTimestamp()
      });
      batch.set(doc(db, names.castSourceLinks, safeDocumentId(item.sourceCastId)), {
        sourceSystem: "club-genesis-pos",
        sourceCastId: item.sourceCastId,
        memberId,
        personKey: `person_${memberId}`,
        status: "linked",
        updatedBy: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    lifecycleActions.forEach((action) => {
      const memberId = actionMemberIds.get(action.id);
      if (!memberId) return;
      const matchingSource = identityResolutions.find((item) =>
        (options.identityResolutions || []).some((raw) =>
          raw.sourceCastId === item.sourceCastId && raw.targetId === action.id));
      if (action.eventType === "trial") {
        const posCastId = matchingSource?.sourceCastId || `local_trial_${closing.businessDate}_${action.id}`;
        batch.set(doc(db, names.casts, memberId), {
          posCastId,
          personKey: `person_${memberId}`,
          name: action.name,
          internalNo: 0,
          status: "trial",
          source: "pos",
          hourlyRate: number(action.hourlyRate),
          introducerId: action.introducerId || "",
          introducerName: action.introducerName || "",
          previousNames: [],
          previousPosCastIds: [],
          entryDate: "",
          createdBy: user.uid,
          createdAt: serverTimestamp(),
          updatedBy: user.uid,
          updatedAt: serverTimestamp()
        }, { merge: true });
      } else {
        batch.set(doc(db, names.casts, memberId), {
          status: action.eventType === "entered" ? "active" : "departed",
          ...(action.eventType === "entered"
            ? { entryDate: closing.businessDate, exitedDate: "" }
            : { exitedDate: closing.businessDate }),
          updatedBy: user.uid,
          updatedAt: serverTimestamp()
        }, { merge: true });
      }
      const localEventId = `${closing.submissionId}_local_${action.id}`;
      batch.set(doc(db, names.castLifecycleEvents, safeDocumentId(localEventId)), {
        eventId: localEventId,
        eventType: action.eventType,
        sourceCastId: matchingSource?.sourceCastId || memberId,
        castName: action.name,
        eventAt: `${closing.businessDate}T12:00:00+09:00`,
        businessDate: closing.businessDate,
        submissionId: closing.submissionId,
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
    });

    identityResolutions.forEach((resolution) => {
      batch.set(doc(db, names.castSourceLinks, safeDocumentId(resolution.sourceCastId)), {
        sourceSystem: "club-genesis-pos",
        sourceCastId: resolution.sourceCastId,
        memberId: resolution.targetId,
        personKey: `person_${resolution.targetId}`,
        status: "linked",
        updatedBy: user.uid,
        updatedAt: serverTimestamp()
      }, { merge: true });
    });

    closing.lifecycleEvents.forEach((event) => {
      batch.set(doc(db, names.castLifecycleEvents, safeDocumentId(event.eventId)), {
        eventId: event.eventId,
        eventType: event.eventType,
        sourceCastId: event.castId,
        castName: event.castName || "",
        eventAt: event.eventAt,
        businessDate: closing.businessDate,
        submissionId: closing.submissionId,
        createdBy: user.uid,
        createdAt: serverTimestamp()
      });
    });
    batch.set(importReference, {
      status: "completed",
      closingId,
      completedBy: user.uid,
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    await batch.commit();
  } catch (error) {
    await setDoc(importReference, {
      status: "failed",
      failureMessage: error instanceof Error ? error.message.slice(0, 500) : "unknown",
      failedBy: user.uid,
      failedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true }).catch(() => undefined);
    throw error;
  }
}

export async function submitStoreClosing(input: StoreClosingInput, user: User): Promise<void> {
  await importClosing(input.preview, user, input);
}

function entityId(prefix: string, label: string) {
  return `${prefix}_${safeDocumentId(`${label}_${Date.now()}`)}`;
}

export async function saveIntroducer(value: Omit<Introducer, "id"> & { id?: string }, user: User): Promise<void> {
  const names = collectionNames();
  const id = value.id || entityId("introducer", value.name);
  await setDoc(doc(db, names.introducers, id), {
    name: value.name.trim(),
    feeSystem: value.feeSystem || "higher10",
    introductionFeeAmount: Math.max(0, Math.round(value.introductionFeeAmount)),
    advisoryFeeEnabled: value.advisoryFeeEnabled,
    advisoryFeeAmount: value.advisoryFeeEnabled ? Math.max(0, Math.round(value.advisoryFeeAmount)) : 0,
    note: value.note.trim(),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function savePartTimeWorker(value: Omit<PartTimeWorker, "id" | "employmentType" | "jobType" | "status"> & {
  id?: string;
  jobType?: PartTimeWorker["jobType"];
  status?: PartTimeWorker["status"];
}, user: User): Promise<void> {
  const names = collectionNames();
  const id = value.id || entityId("staff", value.name);
  await setDoc(doc(db, names.staff, id), {
    name: value.name.trim(),
    employmentType: "partTime",
    jobType: value.jobType || "hall",
    payType: value.payType,
    payAmount: Math.max(1, Math.round(value.payAmount)),
    status: value.status || "active",
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function saveLiquorCost(value: Omit<LiquorCost, "id"> & { id?: string }, user: User): Promise<void> {
  const names = collectionNames();
  const id = value.id || entityId("liquor", value.brandName);
  await setDoc(doc(db, names.liquorCosts, id), {
    brandName: value.brandName.trim(),
    costAmount: Math.max(0, Math.round(value.costAmount)),
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function saveFixedExpense(value: FixedExpense, user: User): Promise<void> {
  const names = collectionNames();
  await setDoc(doc(db, names.fixedExpenses, value.month), {
    month: value.month,
    rent: Math.max(0, Math.round(value.rent)),
    utilities: Math.max(0, Math.round(value.utilities)),
    karaoke: Math.max(0, Math.round(value.karaoke)),
    towel: Math.max(0, Math.round(value.towel)),
    leasekin: Math.max(0, Math.round(value.leasekin)),
    communications: Math.max(0, Math.round(value.communications)),
    landline: 0,
    saibuGas: 0,
    usen: 0,
    updatedBy: user.uid,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function finalizeClosing(id: string, user: User): Promise<void> {
  const names = collectionNames();
  await updateDoc(doc(db, names.closings, id), {
    status: "finalized",
    finalizedBy: user.uid,
    finalizedEmail: user.email || "",
    finalizedAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export function finalizedOnly(rows: WorkspaceData["closings"]): FinalizedClosing[] {
  return rows.filter((row) => row.status === "finalized") as FinalizedClosing[];
}
