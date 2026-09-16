"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import type { CastCorrectionDraft, CastCorrectionEntry, CastCorrectionProduct } from "@/domain/gms";
import { hoursBetweenQuarter, rateForMonth, splitItemBackPerTarget } from "@/domain/gms";
import { calculateMonthlyAccounting, type AccountingWorkspaceData } from "@/domain/month-accounting";
import { applyCastCorrections, createCastCorrectionDraft, sealCastCorrectionDraft, validateCastCorrectionDraft } from "@/domain/cast-corrections";
import { saveCastCorrection } from "@/lib/firebase/repository";
import { secureRandomUUID } from "@/lib/crypto-compat";
import { Card, Field, MoneyInput, Table, yen } from "./ui";
import { useRecoverableState } from "./update-drafts";

type EditState = { draft: CastCorrectionDraft; revision: number; initial: string; reason: string; removedTargets?: Record<string, string[]> };
type Props = {
  data: AccountingWorkspaceData; user: User; busy: boolean; month: string; locked: boolean;
  request?: { sourceId: string; sequence: number };
  run: (action: () => Promise<unknown>, message: string) => Promise<boolean>;
  onDirtyChange: (value: boolean) => void;
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (error: unknown) => error instanceof Error ? error.message : "経理修正の入力を確認してください。";

export function castCorrectionCashReason(source: AccountingWorkspaceData["closings"][number], entry: CastCorrectionEntry) {
  const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId);
  const beauty = original && source.expenses.some((expense) => expense.category === "beautyTrial" && expense.personId === original.masterId && expense.amount > 0);
  return original && (original.dailyPayment > 0 || original.advancePayment > 0 || original.transportFee > 0 || beauty)
    ? "支払・控除実績があります。削除・人物・営業日の訂正は経理修正を原本へ戻し、店舗へ差し戻して行ってください。" : "";
}

export function castCorrectionPersonValues(entry: CastCorrectionEntry, source: AccountingWorkspaceData["closings"][number], data: AccountingWorkspaceData) {
  const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId && row.masterId === entry.masterId && row.kind === entry.kind);
  const saved = data.castCorrections?.find((record) => record.active && record.sourceClosingId === source.id)?.current?.entries
    .find((row) => row.id === entry.id && row.masterId === entry.masterId && row.kind === entry.kind && row.businessDate.slice(0, 7) === entry.businessDate.slice(0, 7));
  const retained = original || saved;
  if (retained) return { name: retained.name, hourlyRate: retained.hourlyRate };
  const master = [...data.casts, ...data.archivedCasts].find((row) => row.id === entry.masterId);
  return master ? { name: master.name, hourlyRate: entry.kind === "trial" ? master.trialHourlyRate || 0 : rateForMonth(master.hourlyRates, entry.businessDate.slice(0, 7)) } : {};
}

function CorrectionHistoryInputs({ draft }: { draft: CastCorrectionDraft }) {
  const names = new Map(draft.entries.map((entry) => [entry.id, `${entry.name}（${entry.businessDate}）`]));
  return <div className="correction-history"><Table headers={["キャスト・営業日", "勤務", "本指名／場内", "売上（本指名／場内延長）", "同伴・美容室"]}>
    {draft.entries.map((entry) => <tr key={entry.id}><td>{names.get(entry.id)}{entry.deleted && "【削除】"}</td><td>{entry.startTime}–{entry.endTime}<br />休憩 {entry.breakMinutes}分</td><td>{entry.honShimeiCount}本／{entry.banaiShimeiCount}本</td><td>{yen.format(entry.honShimeiSales)}／{yen.format(entry.jonaiExtensionSales)}</td><td>{entry.dohan.map((row, i) => <div key={i}>{row.arrivalTime} {row.quantity}本{row.extended && "・延長"}</div>)}美容室 {yen.format(entry.beautyAllowance)}</td></tr>)}
  </Table><Table headers={["商品", "販売単価／原価単価", "数量・区分", "対象者"]}>{draft.products.map((product) => <tr key={product.id}><td>{product.name}<br />{product.kind === "castDrink" ? "ドリンク" : product.kind === "keepBottle" ? "キープボトル" : "シャンパン・ワイン"}</td><td>{yen.format(product.unitPrice)}／{yen.format(product.unitCost)}</td><td>{product.quantity}<br />{product.classification === "honShimei" ? "本指名" : product.classification === "jonaiExtension" ? "場内延長" : "対象外"}</td><td>{product.targets.map((id) => names.get(id)).join("、")}{product.externalTargetCount > 0 && `・派遣等${product.externalTargetCount}人`}</td></tr>)}</Table></div>;
}

export function CastDailyEditor({ data, user, busy, month, locked, request, run, onDirtyChange }: Props) {
  const [editing, setEditing] = useRecoverableState<EditState | null>("accounting.castDaily.editing", null);
  const [selection, setSelection] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const requestSequence = useRef<number | undefined>(undefined);
  const previousMonth = useRef(month);
  const dirty = Boolean(editing && (JSON.stringify(editing.draft) !== editing.initial || editing.reason.trim()));
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (previousMonth.current === month) return;
    previousMonth.current = month;
    if (!dirty) { setEditing(null); setSelection(""); setNotice(""); }
  }, [month, dirty, setEditing]);
  const source = data.closings.find((row) => row.id === editing?.draft.sourceClosingId);
  const stored = data.castCorrections?.find((row) => row.sourceClosingId === source?.id);
  const sourceLocked = source && data.monthStates.some((state) => state.month === source.businessDate.slice(0, 7) && state.status !== "open");
  const involvedDates = [source?.businessDate, ...(editing?.draft.entries.map((entry) => entry.businessDate) || []), ...(stored?.current?.entries.map((entry) => entry.businessDate) || [])];
  const affectedLocked = involvedDates.some((date) => date && data.monthStates.some((state) => state.month === date.slice(0, 7) && state.status !== "open"));
  const disabled = busy || locked || Boolean(sourceLocked) || affectedLocked;
  const stale = Boolean(editing && source && (source.updatedAt !== editing.draft.sourceUpdatedAt || (stored?.revision || 0) !== editing.revision));
  const approvedDates = data.closings.filter((row) => row.status === "approved" && !data.monthStates.some((state) => state.month === row.businessDate.slice(0, 7) && state.status !== "open"))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const choices = data.closings.filter((closing) => closing.status === "approved" && (closing.businessDate.startsWith(month)
    || data.castCorrections?.some((record) => record.sourceClosingId === closing.id && record.active && record.current?.entries.some((entry) => entry.businessDate.startsWith(month)))))
    .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const open = (sourceId: string) => {
    if (dirty && !window.confirm("未保存の経理修正を破棄して別の営業日を開きますか？")) return;
    const closing = data.closings.find((row) => row.id === sourceId);
    if (!closing) { setNotice("対象の店舗データを読み込めません。最新データを読み直してください。"); return; }
    try {
      const record = data.castCorrections?.find((row) => row.sourceClosingId === sourceId);
      const draft = record?.active && record.current ? clone(record.current)
        : createCastCorrectionDraft(closing, data.adjustments.find((row) => row.month === closing.businessDate.slice(0, 7)));
      setEditing({ draft, revision: record?.revision || 0, initial: JSON.stringify(draft), reason: "" });
      setSelection(sourceId);
      setNotice("");
      requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
    } catch (error) { setNotice(errorText(error)); }
  };
  useEffect(() => {
    if (!request || requestSequence.current === request.sequence) return;
    requestSequence.current = request.sequence;
    open(request.sourceId);
    // request is an explicit click. Data reloads must not replace unsaved inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const edit = (change: (draft: CastCorrectionDraft) => CastCorrectionDraft) => setEditing((state) => state ? { ...state, draft: change(state.draft) } : state);
  const editEntry = (id: string, patch: Partial<CastCorrectionEntry>) => edit((draft) => ({ ...draft, entries: draft.entries.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const editProduct = (id: string, patch: Partial<CastCorrectionProduct>) => edit((draft) => ({ ...draft, products: draft.products.map((row) => row.id === id ? { ...row, ...patch } : row) }));
  const toggleDeleted = (entry: CastCorrectionEntry) => {
    if (entry.deleted && !editing?.removedTargets?.[entry.id]) setNotice("出勤行を復元しました。保存済み削除の商品の配賦先は、商品明細で再指定してください。");
    setEditing((state) => {
      if (!state) return state;
      const removedTargets = { ...state.removedTargets };
      const restoreTargets = removedTargets[entry.id] || [];
      if (entry.deleted) delete removedTargets[entry.id];
      else removedTargets[entry.id] = state.draft.products.filter((product) => product.targets.includes(entry.id)).map((product) => product.id);
      return { ...state, removedTargets, draft: { ...state.draft,
        entries: !entry.originalPosCastId && !entry.deleted ? state.draft.entries.filter((row) => row.id !== entry.id)
          : state.draft.entries.map((row) => row.id === entry.id ? { ...row, deleted: !entry.deleted } : row),
        products: state.draft.products.map((product) => ({ ...product, targets: entry.deleted
          ? restoreTargets.includes(product.id) ? [...new Set([...product.targets, entry.id])] : product.targets
          : product.targets.filter((id) => id !== entry.id) })),
      } };
    });
  };
  const preview = useMemo(() => {
    if (!editing) return undefined;
    try {
      validateCastCorrectionDraft(editing.draft, data);
      const sealed = sealCastCorrectionDraft(editing.draft, data);
      const previewData = { ...data, castCorrections: [...(data.castCorrections || []).filter((row) => row.sourceClosingId !== editing.draft.sourceClosingId), {
        sourceClosingId: editing.draft.sourceClosingId, revision: editing.revision + 1, active: true, current: sealed,
        history: { ...(stored?.history || {}), [editing.revision + 1]: { revision: editing.revision + 1, active: true, draft: sealed, reason: "入力確認", createdAt: new Date().toISOString(), createdBy: user.uid } },
      }] };
      const corrected = applyCastCorrections(previewData);
      if (corrected.issues.length) return { error: corrected.issues.join("\n") };
      const affectedMonths = [...new Set([source!.businessDate.slice(0, 7), ...editing.draft.entries.map((entry) => entry.businessDate.slice(0, 7)), ...(stored?.current?.entries.map((entry) => entry.businessDate.slice(0, 7)) || [])])].sort();
      const months = affectedMonths.map((targetMonth) => ({ month: targetMonth, result: calculateMonthlyAccounting(previewData, targetMonth,
        data.adjustments.find((row) => row.month === targetMonth) || { month: targetMonth, withholdingByCast: {}, staffSalesAllowance: {}, staffBottleAllowance: {}, driverRemoteAllowance: {}, fixedExpenses: [], cardFee: 0 }, data.introducerEntryEvents) }));
      return { valid: true, months };
    } catch (error) { return { error: errorText(error) }; }
  }, [data, editing, source, stored?.history, user.uid]);
  const save = async () => {
    if (!editing || disabled || stale || !preview?.valid) return;
    if (!editing.reason.trim()) { setNotice("修正理由を入力してください。"); return; }
    if (!window.confirm("経理修正を保存しますか？\n報酬・紹介者支払・収支・帳票へ反映します。店舗送信原本と現金照合は変更しません。")) return;
    const saved = await run(() => saveCastCorrection(editing.draft, editing.draft.sourceClosingId, editing.revision, editing.reason, user), "キャスト日次の経理修正を保存しました。");
    if (saved) { setEditing(null); setNotice(""); }
  };
  const restore = async () => {
    if (!source || !stored?.active || disabled) return;
    if (!window.confirm("保存済みの最新の経理修正をすべて解除し、店舗原本へ戻しますか？\n未保存の入力も破棄します。修正履歴と店舗の支払実績は保持します。")) return;
    const reason = window.prompt("店舗原本へ戻す理由を入力してください。修正履歴は残ります（500文字以内）。");
    if (!reason?.trim()) return;
    if (await run(() => saveCastCorrection(null, source.id, stored.revision, reason, user), "経理修正を店舗原本へ戻しました。必要に応じて店舗へ差し戻してください。")) setEditing(null);
  };
  const masters = [...data.casts, ...data.archivedCasts];
  const selectMaster = (entry: CastCorrectionEntry, masterId: string) => {
    if (!source) return;
    const master = masters.find((row) => row.id === masterId);
    const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId && row.masterId === masterId);
    const saved = stored?.current?.entries.find((row) => row.id === entry.id && row.masterId === masterId && row.businessDate.slice(0, 7) === entry.businessDate.slice(0, 7));
    if (!master && !original && !saved) return;
    const kind = original?.kind === "trial" || original?.kind === "regular" ? original.kind : saved?.kind || (master?.status === "trial" ? "trial" : "regular");
    const changed = { ...entry, masterId, kind };
    editEntry(entry.id, { masterId, kind, ...castCorrectionPersonValues(changed, source, data), beautyAllowance: kind === "trial" ? 0 : entry.beautyAllowance });
  };
  return <div ref={panel} className="cast-correction-panel"><Card title="キャスト日次の編集" description="店舗送信原本を保持し、経理修正として保存します。日払い・立替・送迎控除・体入美容室の支払訂正は差戻しから行ってください。">
    <div className="row-actions"><Field label="元の営業日"><select aria-label="元の営業日" className="input" value={selection} disabled={busy} onChange={(event) => setSelection(event.target.value)}><option value="">選択してください</option>{choices.map((row) => <option key={row.id} value={row.id}>{row.businessDate}{data.castCorrections?.some((record) => record.sourceClosingId === row.id && record.active) ? "（経理修正あり）" : ""}</option>)}</select></Field><button className="button secondary" disabled={busy || !selection} onClick={() => open(selection)}>日次を開く</button></div>
    {notice && <div className="notice error top-gap" role="alert">{notice}</div>}
    {editing && source && <div className="top-gap">
      <div className="section-head"><h3>{source.businessDate}の店舗データをもとに編集</h3><button className="button secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("未保存の修正を破棄しますか？")) setEditing(null); }}>閉じる</button></div>
      {disabled && <div className="notice">処理中または関係する月が確定済みです。編集するには関係月の確定を解除してください。</div>}
      {stale && <div className="notice error">別の操作で元データまたは経理修正が更新されています。入力を控えて、営業日を開き直してください。</div>}
      <fieldset disabled={disabled || stale} className="correction-fields">
        {editing.draft.entries.map((entry) => {
          const cashReason = castCorrectionCashReason(source, entry);
          const original = source.casts.find((row) => row.posCastId === entry.originalPosCastId);
          return <details key={entry.id} className="correction-entry" open={!entry.deleted}><summary><strong>{entry.name || "追加するキャスト"}</strong>　{entry.businessDate}　{entry.deleted ? "削除予定" : `${entry.startTime}–${entry.endTime}`}</summary>
            {entry.deleted ? <button className="button secondary mini" onClick={() => toggleDeleted(entry)}>削除を取り消す</button> : <>
              {cashReason && <p className="muted">{cashReason}</p>}
              <div className="grid form-row">
                <Field label="出勤日"><select aria-label="出勤日" className="input" value={entry.targetClosingId} disabled={Boolean(cashReason)} onChange={(event) => { const day = approvedDates.find((row) => row.id === event.target.value); if (day) editEntry(entry.id, { targetClosingId: day.id, businessDate: day.businessDate, ...castCorrectionPersonValues({ ...entry, businessDate: day.businessDate }, source, data) }); }}>
                  {!approvedDates.some((day) => day.id === entry.targetClosingId) && <option value={entry.targetClosingId}>{entry.businessDate}（編集不可）</option>}
                  {approvedDates.map((day) => <option key={day.id} value={day.id}>{day.businessDate}</option>)}
                </select></Field>
                <Field label="キャスト"><select aria-label="キャスト" className="input" value={entry.masterId} disabled={Boolean(cashReason)} onChange={(event) => selectMaster(entry, event.target.value)}>
                  <option value={entry.masterId}>{entry.name || "選択してください"}（{entry.kind === "trial" ? "体入" : "在籍"}）</option>
                  {data.casts.filter((row) => row.id !== entry.masterId).map((row) => <option key={row.id} value={row.id}>{row.name}（{row.status === "trial" ? `体入 ${row.trialDate}` : "在籍・退店"}）</option>)}
                  {original && original.masterId !== entry.masterId && !data.casts.some((row) => row.id === original.masterId) && <option value={original.masterId}>{original.name}（原本のキャスト）</option>}
                </select></Field>
                <Field label="出勤時刻"><input className="input" type="time" value={entry.startTime} onChange={(event) => editEntry(entry.id, { startTime: event.target.value })} /></Field>
                <Field label="退勤時刻"><input className="input" type="time" value={entry.endTime} onChange={(event) => editEntry(entry.id, { endTime: event.target.value })} /></Field>
                <Field label="休憩（分）"><MoneyInput value={entry.breakMinutes} onChange={(value) => editEntry(entry.id, { breakMinutes: value })} /></Field>
                <Field label="勤務時間（自動）"><output>{entry.startTime && entry.endTime ? hoursBetweenQuarter(entry.startTime, entry.endTime, entry.breakMinutes) : "—"} 時間</output></Field>
                <Field label="本指名本数"><MoneyInput value={entry.honShimeiCount} onChange={(value) => editEntry(entry.id, { honShimeiCount: value })} /></Field>
                <Field label="場内指名本数"><MoneyInput value={entry.banaiShimeiCount} onChange={(value) => editEntry(entry.id, { banaiShimeiCount: value })} /></Field>
                <Field label="本指名売上"><MoneyInput value={entry.honShimeiSales} step={10} onChange={(value) => editEntry(entry.id, { honShimeiSales: value })} /></Field>
                <Field label="場内延長売上"><MoneyInput value={entry.jonaiExtensionSales} step={10} onChange={(value) => editEntry(entry.id, { jonaiExtensionSales: value })} /></Field>
                <Field label="美容室手当"><label className="check-row"><input type="checkbox" checked={entry.beautyAllowance === 500} disabled={entry.kind === "trial"} onChange={(event) => editEntry(entry.id, { beautyAllowance: event.target.checked ? 500 : 0 })} />500円{entry.kind === "trial" && "（体入支払は差戻しで訂正）"}</label></Field>
              </div>
              {original && <p className="muted">保持する実績：日払い {yen.format(original.dailyPayment)} / 立替 {yen.format(original.advancePayment)} / 送迎控除 {yen.format(original.transportFee)}</p>}
              <h4>同伴の内訳（本数・バックを自動計算）</h4>
              {entry.dohan.map((dohan, index) => <div className="row-actions" key={index}>
                <Field label="入店時刻"><input className="input" type="time" value={dohan.arrivalTime} onChange={(event) => editEntry(entry.id, { dohan: entry.dohan.map((row, i) => i === index ? { ...row, arrivalTime: event.target.value } : row) })} /></Field>
                <Field label="同伴本数"><MoneyInput value={dohan.quantity} onChange={(value) => editEntry(entry.id, { dohan: entry.dohan.map((row, i) => i === index ? { ...row, quantity: value } : row) })} /></Field>
                <label className="check-row"><input type="checkbox" checked={dohan.extended} onChange={(event) => editEntry(entry.id, { dohan: entry.dohan.map((row, i) => i === index ? { ...row, extended: event.target.checked } : row) })} />この同伴セットが延長</label>
                <button className="button danger mini" onClick={() => editEntry(entry.id, { dohan: entry.dohan.filter((_, i) => i !== index) })}>同伴を削除</button>
              </div>)}
              <div className="row-actions top-gap"><button className="button secondary mini" onClick={() => editEntry(entry.id, { dohan: [...entry.dohan, { arrivalTime: "", extended: false, quantity: 1 }] })}>同伴を追加</button><button className="button danger mini" disabled={Boolean(cashReason)} title={cashReason} onClick={() => { if (window.confirm(`${entry.name}の出勤行を削除しますか？共有商品の対象者からも外れ、残った対象者へ再配分されます。`)) toggleDeleted(entry); }}>出勤行を削除</button></div>
            </>}
          </details>;
        })}
        <button className="button secondary top-gap" onClick={() => edit((draft) => ({ ...draft, entries: [...draft.entries, { id: `added_${secureRandomUUID().replaceAll("-", "")}`, targetClosingId: source.id, businessDate: source.businessDate, masterId: "", name: "", kind: "regular", startTime: "", endTime: "", breakMinutes: 0, hourlyRate: 0, honShimeiCount: 0, banaiShimeiCount: 0, honShimeiSales: 0, jonaiExtensionSales: 0, beautyAllowance: 0, dohan: [], deleted: false }] }))}>出勤行を追加</button>
        <h3 className="top-gap">商品明細・均等配分</h3>
        <p className="muted">商品1件全体の金額・原価・数量を入力します。同じ商品は1行だけで管理し、選んだ全員のバックを再計算します。本指名・場内延長の売上欄は商品変更と別に確認してください。</p>
        {editing.draft.products.map((product) => {
          const targetCount = product.targets.length + product.externalTargetCount;
          const rate = product.kind === "castDrink" ? 0.1 : product.kind === "keepBottle" ? 0.15 : 0.25;
          const perBack = targetCount && (product.kind === "castDrink" || product.classification !== "excluded") ? splitItemBackPerTarget((product.unitPrice - (product.kind === "castDrink" ? 0 : product.unitCost)) * product.quantity, rate, targetCount) : 0;
          return <details className="correction-entry" key={product.id} open><summary><strong>{product.name || "新しい商品"}</strong>　{product.quantity}本/杯　1人分バック {yen.format(perBack)}</summary><div className="grid form-row">
            <Field label="銘柄・商品名"><input className="input" value={product.name} onChange={(event) => editProduct(product.id, { name: event.target.value })} /></Field>
            <Field label="商品区分"><select aria-label="商品区分" className="input" value={product.kind} onChange={(event) => editProduct(product.id, { kind: event.target.value as CastCorrectionProduct["kind"], ...(event.target.value === "castDrink" ? { unitCost: 0 } : {}) })}><option value="champagneWine">シャンパン・ワイン</option><option value="keepBottle">キープボトル</option><option value="castDrink">ドリンク</option></select></Field>
            <Field label="販売単価"><MoneyInput value={product.unitPrice} onChange={(value) => editProduct(product.id, { unitPrice: value })} /></Field>
            {product.kind !== "castDrink" && <Field label="原価単価"><MoneyInput value={product.unitCost} onChange={(value) => editProduct(product.id, { unitCost: value })} /></Field>}
            <Field label="数量"><MoneyInput value={product.quantity} onChange={(value) => editProduct(product.id, { quantity: value })} /></Field>
            {product.kind !== "castDrink" && <Field label="売上・バック対象区分"><select aria-label="売上・バック対象区分" className="input" value={product.classification} onChange={(event) => editProduct(product.id, { classification: event.target.value as CastCorrectionProduct["classification"] })}><option value="honShimei">本指名</option><option value="jonaiExtension">場内延長</option><option value="excluded">対象外</option></select></Field>}
          </div><div className="row-actions top-gap">{editing.draft.entries.filter((entry) => !entry.deleted).map((entry) => <label className="check-row" key={entry.id}><input type="checkbox" checked={product.targets.includes(entry.id)} onChange={(event) => editProduct(product.id, { targets: event.target.checked ? [...product.targets, entry.id] : product.targets.filter((id) => id !== entry.id) })} />{entry.name || "キャスト未選択"}（{entry.businessDate}）</label>)}</div>
          {product.externalTargetCount > 0 && <p className="muted">POS原本の派遣等 {product.externalTargetCount}人を含め、{targetCount}人で均等配分します。派遣の支払実績は変更しません。</p>}
          <button className="button danger mini top-gap" onClick={() => edit((draft) => ({ ...draft, products: draft.products.filter((row) => row.id !== product.id) }))}>商品を削除</button></details>;
        })}
        <button className="button secondary top-gap" onClick={() => edit((draft) => ({ ...draft, products: [...draft.products, { id: `product_${secureRandomUUID().replaceAll("-", "")}`, name: "", kind: "champagneWine", unitPrice: 0, unitCost: 0, quantity: 1, classification: "honShimei", targets: [], externalTargetCount: 0 }] }))}>商品を追加</button>
        <Field label="修正理由（必須・500文字以内）"><textarea className="input top-gap" maxLength={500} value={editing.reason} onChange={(event) => setEditing((state) => state ? { ...state, reason: event.target.value } : state)} /></Field>
        {preview?.error && <div className="notice error top-gap" role="alert">{preview.error}</div>}
        {preview?.months && <div className="top-gap"><h3>保存後の月次計算プレビュー</h3><Table headers={["対象月", "キャスト総支給", "紹介者支払", "月次収支"]}>{preview.months.map(({ month: targetMonth, result }) => <tr key={targetMonth}><td>{targetMonth}</td><td>{yen.format(result.balance.cast)}</td><td>{yen.format(result.balance.introducer)}</td><td>{yen.format(result.balance.profit)}</td></tr>)}</Table><p className="muted">保存前の試算です。店舗の現金支払実績と現金照合は変わりません。</p></div>}
        <div className="row-actions top-gap"><button className="button" disabled={!dirty || !editing.reason.trim() || !preview?.valid} onClick={() => void save()}>経理修正を保存</button></div>
      </fieldset>
      {stored?.active && <button className="button danger top-gap" disabled={disabled} onClick={() => void restore()}>経理修正を原本へ戻す</button>}
      {stored && <details className="top-gap"><summary>修正履歴（{stored.revision}件）</summary><Table headers={["版", "日時・操作者", "内容", "理由"]}>{Object.values(stored.history).sort((a, b) => b.revision - a.revision).map((event) => <tr key={event.revision}><td>{event.revision}</td><td>{new Date(event.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}<br /><small>{event.createdBy}</small></td><td>{event.active ? "経理修正" : "原本へ復元"}{event.draft && <details><summary>当時の入力を見る</summary><CorrectionHistoryInputs draft={event.draft} /></details>}</td><td className="wrap-cell">{event.reason}</td></tr>)}</Table></details>}
    </div>}
  </Card></div>;
}
