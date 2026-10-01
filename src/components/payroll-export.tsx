"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildDriverPaymentExport, buildStaffPaymentExport, type PayrollExportInput } from "@/domain/payroll-export";
import { Card } from "./ui";
import { useUpdateDraftBusy } from "./update-drafts";

type PayrollKind = "staff" | "driver";

/** 呼び出し元でラッパーだけ再生成されても、出力元が同じなら継続する。 */
function sameInput(left?: PayrollExportInput, right?: PayrollExportInput) {
  return left === right || Boolean(left && right && left.results === right.results
    && left.closings === right.closings && left.month === right.month && left.snapshot === right.snapshot
    && left.staff === right.staff && left.archivedStaff === right.archivedStaff);
}

export function PayrollExport({ kind, input, month, sourceLabel, disabledReason }: {
  kind: PayrollKind;
  input?: PayrollExportInput;
  month: string;
  sourceLabel: string;
  disabledReason: string;
}) {
  const label = kind === "staff" ? "スタッフ支払" : "ドライバー支払";
  const exportingRef = useRef(false);
  const active = useRef(true);
  const revision = useRef(0);
  const current = useRef({ kind, input, month, sourceLabel, disabledReason });
  const previous = current.current;
  if (previous.kind !== kind || !sameInput(previous.input, input) || previous.month !== month
    || previous.sourceLabel !== sourceLabel || previous.disabledReason !== disabledReason) revision.current += 1;
  current.current = { kind, input, month, sourceLabel, disabledReason };
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<{ kind: PayrollKind; month: string; error: boolean; text: string }>();
  useUpdateDraftBusy(`accounting.export.${kind}Payment`, exporting);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current += 1; };
  }, []);
  const validationError = useMemo(() => {
    if (disabledReason) return disabledReason;
    if (!input) return "出力する月次データを読み込めません。";
    if (input.month !== month) return "出力対象月と給与データの月が一致しません。";
    try {
      if (kind === "staff") buildStaffPaymentExport(input);
      else buildDriverPaymentExport(input);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : "給与データを確認してください。";
    }
  }, [disabledReason, input, kind, month]);

  const exportPayroll = async () => {
    if (validationError || !input || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    setNotice(undefined);
    const exportRevision = revision.current;
    const ensureCurrent = () => {
      if (!active.current) throw new Error("画面を閉じたため出力を中止しました。");
      if (revision.current !== exportRevision) {
        throw new Error("出力中に対象月または給与データが更新されました。表示内容を確認して再度出力してください。");
      }
    };
    try {
      const [{ createStaffPaymentWorkbook, createDriverPaymentWorkbook }, { downloadReceiptFile }] = await Promise.all([
        import("@/lib/xlsx/payroll"), import("@/lib/xlsx/receipt-template"),
      ]);
      ensureCurrent();
      const book = await (kind === "staff" ? createStaffPaymentWorkbook(input) : createDriverPaymentWorkbook(input));
      ensureCurrent();
      const buffer = await book.xlsx.writeBuffer();
      ensureCurrent();
      downloadReceiptFile(new Uint8Array(buffer), `GENESIS${label}_${month}.xlsx`);
      if (active.current) setNotice({ kind, month, error: false, text: `${month}の${label}XLSXを出力しました。` });
    } catch (error) {
      if (active.current) setNotice({ kind, month, error: true, text: `${label}を出力できませんでした。${error instanceof Error ? error.message : "もう一度お試しください。"}` });
    } finally {
      exportingRef.current = false;
      if (active.current) setExporting(false);
    }
  };

  return <Card title={`${label}XLSX`} description={`${month}・${sourceLabel}。${kind === "staff" ? "在籍・体入を別シートに分けて出力します。" : "ドライバー全員の支払表を出力します。"}`}
    action={<button type="button" className="button" disabled={Boolean(validationError) || exporting} title={validationError || undefined} onClick={() => void exportPayroll()}>{exporting ? `${label}出力中…` : `${label}をXLSX出力`}</button>}>
    <p className="muted compact-text">A4横向きで、人数に応じて複数ページに分けます。確定済み月は保存金額を使用し、日別内訳が未保存の欄は空欄・注記付きで出力します。</p>
    {validationError && <p className="muted compact-text">{validationError}</p>}
    {notice?.month === month && notice.kind === kind && <div role="status" className={`notice${notice.error ? " error" : ""}`}>{notice.text}</div>}
  </Card>;
}
