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
import type { CastMember, FinalizedClosing, FixedExpense, ImportPreview, PosClosing } from "@/domain/types";
import { safeDocumentId } from "@/domain/pos-import";
import { collectionNames, db } from "./client";

export type WorkspaceData = {
  closings: (PosClosing & { id: string })[];
  casts: CastMember[];
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
  const snapshot = await getDoc(doc(db, "users", user.uid));
  return snapshot.exists() ? String(snapshot.data().role || "") : "";
}

export async function loadWorkspaceData(): Promise<WorkspaceData> {
  const names = collectionNames();
  const [closingsSnapshot, castsSnapshot, fixedSnapshot] = await Promise.all([
    getDocs(collection(db, names.closings)),
    getDocs(collection(db, names.casts)),
    getDocs(collection(db, names.fixedExpenses))
  ]);
  return {
    closings: closingsSnapshot.docs
      .map((item) => normalizeClosing(item.id, item.data()))
      .sort((a, b) => b.businessDate.localeCompare(a.businessDate)),
    casts: castsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() } as CastMember)),
    fixedExpenses: fixedSnapshot.docs.map((item) => ({
      month: String(item.data().month || item.id),
      rent: number(item.data().rent),
      karaoke: number(item.data().karaoke),
      towel: number(item.data().towel),
      leasekin: number(item.data().leasekin),
      landline: number(item.data().landline),
      saibuGas: number(item.data().saibuGas),
      usen: number(item.data().usen)
    }))
  };
}

export async function importClosing(preview: ImportPreview, user: User): Promise<void> {
  if (preview.blockingCount) throw new Error("未解決の在籍差分があります。取込を中止しました。");
  const names = collectionNames();
  const closing = preview.closing;
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
    + preview.differences.filter((item) => item.kind === "new").length * 2
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

    preview.differences.filter((item) => item.kind === "new").forEach((item) => {
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
