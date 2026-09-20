"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { CastCorrectionDraft, CastCorrectionEntry, CastCorrectionProduct } from "@/domain/gms";
import { hoursBetweenQuarter, splitItemBackPerTarget } from "@/domain/gms";
import { calculateMonthlyAccounting, type AccountingWorkspaceData } from "@/domain/month-accounting";
import { applyCastCorrections, castCorrectionDohanBack, createCastCorrectionDraft, sealCastCorrectionDraft, validateCastCorrectionDraft } from "@/domain/cast-corrections";
import { saveCastCorrection } from "@/lib/firebase/repository";
import { secureRandomUUID } from "@/lib/crypto-compat";
import { Field, Modal, MoneyInput, Table, yen } from "./ui";
import { useRecoverableState } from "./update-drafts";

type EditState = {
  draft: CastCorrectionDraft; revision: number; initial: string; reason: string;
  entryId?: string; changed?: boolean; visibleProductIds?: string[];
};
type Props = {
  data: AccountingWorkspaceData; user: User; busy: boolean; month: string; locked: boolean;
  request?: { sourceId: string; entryId: string; sequence: number };
  run: (action: () => Promise<unknown>, message: string) => Promise<boolean>;
  onDirtyChange: (value: boolean) => void;
};
type Confirmation = {
  draft: CastCorrectionDraft; data: AccountingWorkspaceData;
  months: Array<{ month: string; result: ReturnType<typeof calculateMonthlyAccounting> }>;
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (error: unknown) => error instanceof Error ? error.message : "経理修正の入力を確認してください。";

/** Product-only arithmetic is cheap enough for each keystroke; monthly accounting is not. */
export function castCorrectionProductBack(product?: CastCorrectionProduct) {
  if (!product || (product.kind !== "castDrink" && product.classification === "excluded")) return 0;
  const count = product.targets.length + product.externalTargetCount;
  const amount = (product.unitPrice - (product.kind === "castDrink" ? 0 : product.unitCost)) * product.quantity;
  return count ? splitItemBackPerTarget(amount, product.kind === "castDrink" ? 0.1 : product.kind === "keepBottle" ? 0.15 : 0.25, count) : 0;
}

function HistoryInputs({ draft, entryId }: { draft: CastCorrectionDraft; entryId: string }) {
  const entry = draft.entries.find((row) => row.id === entryId);
  if (!entry) return <p className="muted">この版には対象の出勤行がありません。</p>;
  return <div className="correction-history"><p>{entry.name}／{entry.businessDate}{entry.deleted && "【削除】"}<br />勤務 {entry.startTime}–{entry.endTime}（休憩 {entry.breakMinutes}分）<br />本指名 {entry.honShimeiCount}本／場内 {entry.banaiShimeiCount}本<br />本指名売上 {yen.format(entry.honShimeiSales)}／場内延長売上 {yen.format(entry.jonaiExtensionSales)}<br />美容室 {yen.format(entry.beautyAllowance)}</p>
    {entry.dohan.map((row, i) => <p key={i}>同伴 {row.arrivalTime} {row.quantity}本{row.extended && "・延長あり"}</p>)}
    <Table headers={["商品", "単価／原価", "数量", "配賦先"]}>{draft.products.filter((product) => product.targets.includes(entryId)).map((product) => <tr key={product.id}><td>{product.name}</td><td>{yen.format(product.unitPrice)}／{yen.format(product.unitCost)}</td><td>{product.quantity}</td><td>{product.targets.map((id) => draft.entries.find((row) => row.id === id)?.name || "不明").join("、")}{product.externalTargetCount > 0 && `／派遣等 ${product.externalTargetCount}人`}</td></tr>)}</Table>
  </div>;
}

export function CastDailyEditor({ data, user, busy, month, locked, request, run, onDirtyChange }: Props) {
  const [editing, setEditing] = useRecoverableState<EditState | null>("accounting.castDaily.editing", null);
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const [productSelection, setProductSelection] = useState("");
  const [targetPicker, setTargetPicker] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState<number | null>(null);
  const dialogScope = useRef<HTMLDivElement>(null);
  const closeAction = useRef<() => void>(() => {});
  const requestSequence = useRef<number | undefined>(undefined);
  const previousMonth = useRef(month);
  // Do not stringify the entire business day whenever a single input changes.
  // Missing `changed` is a recovered draft from the previous, whole-day editor.
  const dirty = Boolean(editing && (editing.changed !== false || editing.reason.trim()));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!editing) return;
    const dialog = dialogScope.current?.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.tabIndex = -1;
    dialog.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAction.current(); }
      if (event.key !== "Tab") return;
      const fields = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter((element) => element.getClientRects().length);
      const first = fields[0], last = fields[fields.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => { dialog.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
    // Input changes must neither refocus the dialog nor rewrite the scroll lock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(editing), editing?.entryId]);
  useEffect(() => {
    if (previousMonth.current === month) return;
    previousMonth.current = month;
    if (!dirty) { setEditing(null); setNotice(""); setConfirmation(null); }
  }, [month, dirty, setEditing]);
  const source = data.closings.find((row) => row.id === editing?.draft.sourceClosingId);
  const stored = data.castCorrections?.find((row) => row.sourceClosingId === source?.id);
  const entry = editing?.draft.entries.find((row) => row.id === editing.entryId && !row.deleted);
  const initial = useMemo(() => {
    if (!editing?.initial) return undefined;
    try { return JSON.parse(editing.initial) as CastCorrectionDraft; } catch { return undefined; }
  }, [editing?.initial]);
  const involvedDates = useMemo(() => [source?.businessDate, ...(editing?.draft.entries.map((row) => row.businessDate) || []), ...(stored?.current?.entries.map((row) => row.businessDate) || [])], [source?.businessDate, editing?.draft.entries, stored?.current?.entries]);
  const affectedLocked = involvedDates.some((date) => date && data.monthStates.some((state) => state.month === date.slice(0, 7) && state.status !== "open"));
  const disabled = busy || locked || affectedLocked;
  const stale = Boolean(editing && source && (source.status !== "approved" || source.updatedAt !== editing.draft.sourceUpdatedAt || (stored?.revision || 0) !== editing.revision));
  const confirmed = Boolean(confirmation && editing && confirmation.draft === editing.draft && confirmation.data === data && !stale);
  const resetTransient = () => {
    setNotice(""); setConfirmation(null); setShowProductPicker(false); setProductSelection(""); setTargetPicker(null); setHistoryOpen(false); setHistoryRevision(null);
  };
  const open = (sourceId: string, entryId: string) => {
    if (dirty && !window.confirm("未保存の経理修正を破棄して別の出勤行を開きますか？")) return;
    const closing = data.closings.find((row) => row.id === sourceId);
    if (!closing) { setNotice("対象の店舗データを読み込めません。最新データを読み直してください。"); return; }
    try {
      const record = data.castCorrections?.find((row) => row.sourceClosingId === sourceId);
      const draft = record?.active && record.current ? clone(record.current)
        : createCastCorrectionDraft(closing, data.adjustments.find((row) => row.month === closing.businessDate.slice(0, 7)));
      // Accepted handoffs retain stable entry IDs, while newly added legacy rows
      // receive a store-facing POS ID. Either may identify the clicked daily row.
      const selected = draft.entries.find((row) => row.id === entryId && !row.deleted)
        || draft.entries.find((row) => row.originalPosCastId === entryId && !row.deleted);
      if (!selected) throw new Error("対象キャストの出勤行が更新されています。最新データを読み込み、対象行の「編集」を押し直してください。");
      setEditing({ draft, entryId: selected.id, revision: record?.revision || 0, initial: JSON.stringify(draft), reason: "", changed: false, visibleProductIds: draft.products.filter((row) => row.targets.includes(selected.id)).map((row) => row.id) });
      resetTransient();
    } catch (error) { setNotice(errorText(error)); }
  };
  useEffect(() => {
    if (!request || requestSequence.current === request.sequence) return;
    requestSequence.current = request.sequence;
    open(request.sourceId, request.entryId);
    // Requests are explicit row clicks. Data refresh must not replace unsaved inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const edit = (change: (draft: CastCorrectionDraft) => CastCorrectionDraft, visibleProductId?: string) => {
    setConfirmation(null); setNotice("");
    setEditing((state) => state ? { ...state, changed: true, draft: change(state.draft), visibleProductIds: visibleProductId ? [...new Set([...(state.visibleProductIds || []), visibleProductId])] : state.visibleProductIds } : state);
  };
  const editEntry = (patch: Partial<CastCorrectionEntry>) => {
    if (entry) edit((draft) => ({ ...draft, entries: draft.entries.map((row) => row.id === entry.id ? { ...row, ...patch } : row) }));
  };
  const editProduct = (id: string, patch: Partial<CastCorrectionProduct>) => edit((draft) => ({ ...draft, products: draft.products.map((row) => row.id === id ? { ...row, ...patch } : row) }), id);
  const confirmChanges = () => {
    if (!editing || !entry || !source || disabled || stale) return;
    setConfirmation(null); setNotice("");
    try {
      validateCastCorrectionDraft(editing.draft, data);
      const sealed = sealCastCorrectionDraft(editing.draft, data);
      const previewData = { ...data, castCorrections: [...(data.castCorrections || []).filter((row) => row.sourceClosingId !== editing.draft.sourceClosingId), {
        sourceClosingId: editing.draft.sourceClosingId, revision: editing.revision + 1, active: true, current: sealed,
        history: { ...(stored?.history || {}), [editing.revision + 1]: { revision: editing.revision + 1, active: true, draft: sealed, reason: "入力確認", createdAt: new Date().toISOString(), createdBy: user.uid } },
      }] };
      const corrected = applyCastCorrections(previewData);
      if (corrected.issues.length) throw new Error(corrected.issues.join("\n"));
      const affectedMonths = [...new Set(involvedDates.flatMap((date) => date ? [date.slice(0, 7)] : []))].sort();
      const months = affectedMonths.map((targetMonth) => ({ month: targetMonth, result: calculateMonthlyAccounting(previewData, targetMonth,
        data.adjustments.find((row) => row.month === targetMonth) || { month: targetMonth, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 }, data.introducerEntryEvents) }));
      setConfirmation({ draft: editing.draft, data, months });
    } catch (error) { setNotice(errorText(error)); }
  };
  const save = async () => {
    if (!editing || !entry || disabled || stale || !confirmed) return;
    if (!editing.reason.trim()) { setNotice("修正理由を入力してください。"); return; }
    if (!window.confirm(`${entry.name}・${entry.businessDate}の経理修正を保存しますか？\n共有商品の変更は共有相手のバックにも反映します。店舗送信原本と現金照合は変更しません。`)) return;
    const saved = await run(() => saveCastCorrection(editing.draft, editing.draft.sourceClosingId, editing.revision, editing.reason, user), "キャスト日次の経理修正を保存しました。");
    if (saved) { setEditing(null); resetTransient(); }
  };
  const close = () => {
    if (busy || (dirty && !window.confirm("未保存の修正を破棄して閉じますか？"))) return;
    setEditing(null); resetTransient();
  };
  closeAction.current = close;
  if (!editing) return notice ? <div className="notice error" role="alert">{notice}</div> : null;
  if (!entry || !source || !initial) return <div ref={dialogScope} className="cast-daily-editor"><Modal title="退避した経理修正の確認" onClose={close} disabled={busy}><p className="notice error">以前の全員編集画面の退避入力、または対象行を確認できない入力が残っています。この画面からは保存しません。必要な入力内容を控えてから閉じ、キャストの日次行から開き直してください。</p><button className="button secondary" onClick={() => setHistoryOpen((value) => !value)}>退避内容を{historyOpen ? "閉じる" : "表示"}</button>{historyOpen && <pre className="correction-history">{JSON.stringify(editing.draft, null, 2)}{editing.reason && `\n修正理由：${editing.reason}`}</pre>}</Modal></div>;
  const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId);
  const visibleProducts = editing.draft.products.filter((row) => row.targets.includes(entry.id) || editing.visibleProductIds?.includes(row.id));
  const productsToAssign = showProductPicker ? editing.draft.products.filter((row) => !row.targets.includes(entry.id)) : [];
  const backTotal = editing.draft.products.filter((row) => row.targets.includes(entry.id)).reduce((sum, row) => sum + castCorrectionProductBack(row), 0);
  return <div ref={dialogScope} className="cast-daily-editor"><Modal title={`${entry.name}・${entry.businessDate} の日次編集`} onClose={close} disabled={busy}>
    <p className="muted">この人・この日の勤務と売上を編集します。出勤の追加・削除、日付・人物の変更、支払実績の訂正は店舗への差戻しから行ってください。</p>
    {notice && <div className="notice error" role="alert">{notice}</div>}
    {disabled && <div className="notice">処理中または関係する月が確定済みです。関係月の確定を解除してから編集してください。</div>}
    {stale && <div className="notice error">別の操作で元データまたは経理修正が更新されています。入力を控えて閉じ、対象行の「編集」を押し直してください。</div>}
    <fieldset disabled={disabled || stale} className="correction-fields">
      <section className="correction-entry"><h3>勤務・売上・本数</h3><div className="grid form-row">
        <Field label="出勤時刻"><input className="input" type="time" value={entry.startTime} onChange={(event) => editEntry({ startTime: event.target.value })} /></Field>
        <Field label="退勤時刻"><input className="input" type="time" value={entry.endTime} onChange={(event) => editEntry({ endTime: event.target.value })} /></Field>
        <Field label="休憩（分）"><MoneyInput value={entry.breakMinutes} onChange={(value) => editEntry({ breakMinutes: value })} /></Field>
        <Field label="勤務時間（自動）"><output>{entry.startTime && entry.endTime ? hoursBetweenQuarter(entry.startTime, entry.endTime, entry.breakMinutes) : "—"} 時間</output></Field>
        <Field label="本指名本数"><MoneyInput value={entry.honShimeiCount} onChange={(value) => editEntry({ honShimeiCount: value })} /></Field>
        <Field label="場内指名本数"><MoneyInput value={entry.banaiShimeiCount} onChange={(value) => editEntry({ banaiShimeiCount: value })} /></Field>
        <Field label="本指名売上"><MoneyInput value={entry.honShimeiSales} step={10} onChange={(value) => editEntry({ honShimeiSales: value })} /></Field>
        <Field label="場内延長売上"><MoneyInput value={entry.jonaiExtensionSales} step={10} onChange={(value) => editEntry({ jonaiExtensionSales: value })} /></Field>
        <Field label="美容室手当"><span className="check-row"><input type="checkbox" checked={entry.beautyAllowance === 500} disabled={entry.kind === "trial"} onChange={(event) => editEntry({ beautyAllowance: event.target.checked ? 500 : 0 })} />500円{entry.kind === "trial" && "（体入支払は差戻しで訂正）"}</span></Field>
      </div><p className="muted">指名バック {yen.format(entry.honShimeiCount * 1000 + entry.banaiShimeiCount * 500)}／同伴バック {yen.format(castCorrectionDohanBack(entry.dohan))}／商品バック {yen.format(backTotal)}（体入のバック支給対象は入店状況により月次計算で判定）</p>
      {original && <p className="muted">保持する実績：日払い {yen.format(original.dailyPayment)}／立替 {yen.format(original.advancePayment)}／送迎控除 {yen.format(original.transportFee)}</p>}
      <h4>同伴の内訳</h4>{entry.dohan.map((dohan, index) => <div className="row-actions" key={index}>
        <Field label="入店時刻"><input className="input" type="time" value={dohan.arrivalTime} onChange={(event) => editEntry({ dohan: entry.dohan.map((row, i) => i === index ? { ...row, arrivalTime: event.target.value } : row) })} /></Field>
        <Field label="同伴本数"><MoneyInput value={dohan.quantity} onChange={(value) => editEntry({ dohan: entry.dohan.map((row, i) => i === index ? { ...row, quantity: value } : row) })} /></Field>
        <label className="check-row"><input type="checkbox" checked={dohan.extended} onChange={(event) => editEntry({ dohan: entry.dohan.map((row, i) => i === index ? { ...row, extended: event.target.checked } : row) })} />この同伴セットが延長</label>
        <button className="button danger mini" onClick={() => editEntry({ dohan: entry.dohan.filter((_, i) => i !== index) })}>同伴を削除</button>
      </div>)}<button className="button secondary mini top-gap" onClick={() => editEntry({ dohan: [...entry.dohan, { arrivalTime: "", extended: false, quantity: 1 }] })}>同伴を追加</button></section>
      <h3 className="top-gap">このキャストの商品明細</h3><p className="muted">商品1件全体の単価・原価・数量です。共有商品を変更すると共有相手のバックも変わります。本指名・場内延長売上は上の売上欄で別途確認してください。</p>
      {!visibleProducts.length && <p className="muted">対象の商品はありません。</p>}
      {visibleProducts.map((product) => {
        const before = initial.products.find((row) => row.id === product.id);
        const targetCount = product.targets.length + product.externalTargetCount;
        const allTargetIds = [...new Set([...(before?.targets || []), ...product.targets])];
        return <section className="correction-entry" key={product.id}><h4>{product.name || "新しい商品"}　{product.quantity}本／杯</h4><div className="grid form-row">
          <Field label="銘柄・商品名"><input className="input" value={product.name} onChange={(event) => editProduct(product.id, { name: event.target.value })} /></Field>
          <Field label="商品区分"><select aria-label="商品区分" className="input" value={product.kind} onChange={(event) => editProduct(product.id, { kind: event.target.value as CastCorrectionProduct["kind"], ...(event.target.value === "castDrink" ? { unitCost: 0 } : {}) })}><option value="champagneWine">シャンパン・ワイン</option><option value="keepBottle">キープボトル</option><option value="castDrink">ドリンク</option></select></Field>
          <Field label="販売単価"><MoneyInput value={product.unitPrice} onChange={(value) => editProduct(product.id, { unitPrice: value })} /></Field>
          {product.kind !== "castDrink" && <Field label="原価単価"><MoneyInput value={product.unitCost} onChange={(value) => editProduct(product.id, { unitCost: value })} /></Field>}
          <Field label="数量"><MoneyInput value={product.quantity} onChange={(value) => editProduct(product.id, { quantity: value })} /></Field>
          {product.kind !== "castDrink" && <Field label="売上・バック対象区分"><select aria-label="売上・バック対象区分" className="input" value={product.classification} onChange={(event) => editProduct(product.id, { classification: event.target.value as CastCorrectionProduct["classification"] })}><option value="honShimei">本指名</option><option value="jonaiExtension">場内延長</option><option value="excluded">対象外</option></select></Field>}
        </div><p>{targetCount}人で均等配分／1人分バック {yen.format(castCorrectionProductBack(product))}</p>
        {allTargetIds.map((id) => <div className="muted" key={id}>{editing.draft.entries.find((row) => row.id === id)?.name || initial.entries.find((row) => row.id === id)?.name || "不明"}：{yen.format(before?.targets.includes(id) ? castCorrectionProductBack(before) : 0)} → {yen.format(product.targets.includes(id) ? castCorrectionProductBack(product) : 0)}{id === entry.id ? "（編集中）" : "（共有相手）"}</div>)}
        {product.externalTargetCount > 0 && <p className="muted">派遣等 {product.externalTargetCount}人を配分人数に含みます。派遣の支払実績は変更しません。</p>}
        <button className="button secondary mini top-gap" onClick={() => setTargetPicker(targetPicker === product.id ? null : product.id)}>配賦先の選択を{targetPicker === product.id ? "閉じる" : "開く"}</button>
        {targetPicker === product.id && <div className="row-actions top-gap">{editing.draft.entries.filter((row) => !row.deleted).map((target) => <label className="check-row" key={target.id}><input type="checkbox" checked={product.targets.includes(target.id)} onChange={(event) => editProduct(product.id, { targets: event.target.checked ? [...new Set([...product.targets, target.id])] : product.targets.filter((id) => id !== target.id) })} />{target.name}（{target.businessDate}）</label>)}</div>}
        <div className="row-actions top-gap"><button className="button danger mini" onClick={() => {
          const names = product.targets.map((id) => editing.draft.entries.find((row) => row.id === id)?.name).filter(Boolean).join("、");
          if (window.confirm(`「${product.name || "新しい商品"}」を削除しますか？\n${names || "対象者なし"}のこの商品のバックがなくなります。他の人の勤務・売上欄は変更しません。`)) edit((draft) => ({ ...draft, products: draft.products.filter((row) => row.id !== product.id) }));
        }}>商品を削除</button></div></section>;
      })}
      <div className="row-actions top-gap"><button className="button secondary" onClick={() => setShowProductPicker((value) => !value)}>未配賦の既存商品を{showProductPicker ? "閉じる" : "選ぶ"}</button><button className="button secondary" onClick={() => {
        const id = `product_${secureRandomUUID().replaceAll("-", "")}`;
        edit((draft) => ({ ...draft, products: [...draft.products, { id, name: "", kind: "champagneWine", unitPrice: 0, unitCost: 0, quantity: 1, classification: "honShimei", targets: [entry.id], externalTargetCount: 0 }] }), id);
      }}>この人の商品を追加</button></div>
      {showProductPicker && <div className="row-actions top-gap"><Field label="この人に未配賦の既存商品"><select aria-label="この人に未配賦の既存商品" className="input" value={productSelection} onChange={(event) => setProductSelection(event.target.value)}><option value="">選択してください</option>{productsToAssign.map((product) => <option value={product.id} key={product.id}>{product.name}／{yen.format(product.unitPrice)} × {product.quantity}／現在 {product.targets.map((id) => editing.draft.entries.find((row) => row.id === id)?.name).join("、") || "キャスト未配賦"}</option>)}</select></Field><button className="button secondary" disabled={!productsToAssign.some((row) => row.id === productSelection)} onClick={() => {
        const selected = productsToAssign.find((row) => row.id === productSelection);
        if (selected) { editProduct(selected.id, { targets: [...selected.targets, entry.id] }); setProductSelection(""); setShowProductPicker(false); }
      }}>この人を配賦先に追加</button></div>}
      <Field label="修正理由（必須・500文字以内）"><textarea className="input top-gap" maxLength={500} value={editing.reason} onChange={(event) => setEditing((state) => state ? { ...state, reason: event.target.value } : state)} /></Field>
      <div className="row-actions top-gap"><button className="button secondary" disabled={!editing.changed} onClick={confirmChanges}>変更内容を確認</button><button className="button" disabled={!editing.changed || !editing.reason.trim() || !confirmed} onClick={() => void save()}>経理修正を保存</button></div>
      <p className="muted">月次試算は「変更内容を確認」を押した時に行います。入力内容や元データが変わった場合は、保存前に再確認してください。</p>
      {confirmed && confirmation && <section className="top-gap"><h3>保存後の月次計算プレビュー</h3><Table headers={["対象月", "キャスト総支給", "紹介者支払", "月次収支"]}>{confirmation.months.map(({ month: targetMonth, result }) => <tr key={targetMonth}><td>{targetMonth}</td><td>{yen.format(result.balance.cast)}</td><td>{yen.format(result.balance.introducer)}</td><td>{yen.format(result.balance.profit)}</td></tr>)}</Table>
        {confirmation.months.filter(({ result }) => result.warnings.length > 0).map(({ month: targetMonth, result }) => <div className="notice error" key={targetMonth}><strong>{targetMonth}の計算には確認が必要な項目があります。</strong><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>)}
        <p className="muted">店舗の現金支払実績と現金照合は変更しません。</p></section>}
    </fieldset>
    {stored && <section className="top-gap"><button className="button secondary" onClick={() => setHistoryOpen((value) => !value)}>修正履歴を{historyOpen ? "閉じる" : "表示"}（営業日全体 {stored.revision}件）</button>{historyOpen && <Table headers={["版", "日時・操作者", "内容", "理由"]}>{Object.values(stored.history).sort((a, b) => b.revision - a.revision).map((event) => <tr key={event.revision}><td>{event.revision}</td><td>{new Date(event.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}<br /><small>{event.createdBy}</small></td><td>{event.active ? "経理修正" : "経理修正の解除"}{event.draft && <><button className="button secondary mini" onClick={() => setHistoryRevision(historyRevision === event.revision ? null : event.revision)}>この人の当時の入力</button>{historyRevision === event.revision && <HistoryInputs draft={event.draft} entryId={entry.id} />}</>}</td><td className="wrap-cell">{event.reason}</td></tr>)}</Table>}</section>}
  </Modal></div>;
}
