"use client";

import { useMemo, useState } from "react";
import type { User } from "firebase/auth";
import type {
  CastKind, DailyCast, DailyClosing, DailyDriverWork, DailyExpense, DailyStaffWork, ExpenseCategory,
  PosClosingV3, WorkspaceData
} from "@/domain/gms";
import { buildDailyCasts, calculateCash, floorHundred, hoursBetweenQuarter, parsePosClosingV3, posCastReferences, rateForMonth } from "@/domain/gms";
import { submitClosing, withdrawClosing } from "@/lib/firebase/repository";
import { Card, Field, MoneyInput, StatusPill, Table, today, yen } from "./ui";

type Props = { data: WorkspaceData; user: User; busy: boolean; run: (action: () => Promise<unknown>, message: string) => Promise<boolean> };
type Stage = "json" | "details" | "cash" | "preview";

const expenseLabels: Record<ExpenseCategory, string> = {
  beautyTrial: "1. 体入キャスト美容室手当",
  introduction: "2. 紹介料",
  advertising: "2. 広告等",
  supplies: "3. 備品・消耗品他",
  entertainment: "4. 交際費・プレゼント等",
  liquor: "5. 酒代",
  transportOther: "6. 交通費・その他"
};

const closingLabels: Record<DailyClosing["status"], string> = {
  submitted: "経理確認待ち", returned: "差戻し", approved: "承認済み", withdrawn: "取下げ"
};

export function StoreWork(props: Props) {
  const [editing, setEditing] = useState<DailyClosing | null>(null);
  return <div className="grid"><DailyWorkflow key={editing?.id || "new"} {...props} initial={editing} onFinished={() => setEditing(null)} />
    <Card title="送信済みデータ" description="店舗データと現金照合プレビューを営業日ごとに保管します。"><Table headers={["営業日", "状態", "売上", "現金残額", "差額", "差戻し理由", "操作"]}>{props.data.closings.map((row) => <tr key={row.id}><td>{row.businessDate}</td><td><StatusPill tone={row.status === "approved" ? "good" : row.status === "returned" ? "danger" : row.status === "submitted" ? "warn" : "neutral"}>{closingLabels[row.status]}</StatusPill></td><td>{yen.format(row.sales.totalSales)}</td><td>{yen.format(row.cash.actualClosingCash)}</td><td className={row.cash.difference ? "text-danger" : "text-good"}>{yen.format(row.cash.difference)}</td><td className="wrap-cell">{row.returnReason || "—"}</td><td><div className="row-actions">{["returned", "withdrawn"].includes(row.status) && <button className="button secondary mini" onClick={() => setEditing(row)}>再編集</button>}{["submitted", "returned"].includes(row.status) && <button className="button secondary mini" onClick={() => { if (window.confirm(`${row.businessDate}の送信を取り下げますか？`)) void props.run(() => withdrawClosing(row.id, props.user), "送信を取り下げました。再編集できます。"); }}>取下げ</button>}<details><summary className="text-button">プレビュー</summary><div className="popover-preview"><DailyPreview closing={row} /></div></details></div></td></tr>)}</Table></Card>
  </div>;
}

function DailyWorkflow({ data, user, busy, run, initial, onFinished }: Props & { initial: DailyClosing | null; onFinished: () => void }) {
  const [stage, setStage] = useState<Stage>(initial ? "details" : "json");
  const [pos, setPos] = useState<PosClosingV3 | null>(initial?.posSnapshot || null);
  const [mapping, setMapping] = useState<Record<string, string>>(() => initial ? Object.fromEntries(initial.casts.map((row) => [row.posCastId, row.masterId || "dispatch"])) : {});
  const [specialCosts, setSpecialCosts] = useState<Record<string, number>>(() => initial ? Object.fromEntries(initial.casts.flatMap((row) => row.bottles.filter((bottle) => bottle.specialCost).map((bottle) => [bottle.itemId, bottle.costAmount * Math.max(1, posTargetCount(initial.posSnapshot, bottle.itemId)) / Math.max(1, bottle.quantity)]))) : {});
  const [castRows, setCastRows] = useState<DailyCast[]>(initial?.casts || []);
  const [staffWork, setStaffWork] = useState<DailyStaffWork[]>(initial?.staffWork || []);
  const [staffId, setStaffId] = useState("");
  const [staffStart, setStaffStart] = useState("20:00");
  const [staffEnd, setStaffEnd] = useState("02:00");
  const [drivers, setDrivers] = useState<string[]>(initial?.drivers.map((row) => row.driverId) || []);
  const [expenses, setExpenses] = useState<DailyExpense[]>(initial?.expenses || []);
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("supplies");
  const [expensePayee, setExpensePayee] = useState("");
  const [expensePersonId, setExpensePersonId] = useState("");
  const [expenseAmount, setExpenseAmount] = useState(0);
  const [dispatchStaffPayment, setDispatchStaffPayment] = useState(initial?.dispatchStaffPayment || 0);
  const [dispatchCastPayment, setDispatchCastPayment] = useState(initial?.dispatchCastPayment || 0);
  const [dispatchFee, setDispatchFee] = useState(initial?.dispatchFee || 0);
  const [liquorDeliveryAmount, setLiquorDeliveryAmount] = useState(initial?.liquorDeliveryAmount || 0);
  const [actualCash, setActualCash] = useState(initial?.cash.actualClosingCash || 0);
  const [error, setError] = useState("");
  const references = useMemo(() => pos ? posCastReferences(pos) : [], [pos]);
  const missingBottles = useMemo(() => pos ? pos.transactions.flatMap((tx) => tx.items).filter((item) => ["champagneWine", "keepBottle"].includes(item.category) && item.price * item.quantity > 0 && !data.liquor.some((row) => row.kind === item.category && row.name === item.label && row.salePrice === item.price)) : [], [data.liquor, pos]);
  const month = pos?.businessDate.slice(0, 7) || "";

  const candidates = (kind: CastKind, name: string) => kind === "dispatch" ? [] : data.casts.filter((row) => row.status === (kind === "trial" ? "trial" : "active") && row.name === name);
  const mappingComplete = references.every((source) => source.kind === "dispatch" ? mapping[source.id] === "dispatch" : Boolean(mapping[source.id]));
  const costsComplete = missingBottles.every((item) => specialCosts[item.itemId] >= 0 && Object.hasOwn(specialCosts, item.itemId));

  const hydrateMapping = (closing: PosClosingV3) => {
    const auto: Record<string, string> = {};
    posCastReferences(closing).forEach((source) => {
      if (source.kind === "dispatch") auto[source.id] = "dispatch";
      else {
        const matches = data.casts.filter((row) => row.status === (source.kind === "trial" ? "trial" : "active") && row.name === source.name);
        if (matches.length === 1) auto[source.id] = matches[0].id;
      }
    });
    setMapping(auto);
  };

  const createRows = () => {
    if (!pos || !mappingComplete || !costsComplete) return;
    const details = Object.fromEntries(references.map((source) => {
      if (mapping[source.id] === "dispatch") return [source.id, { masterId: "", name: source.name, kind: "dispatch" as const, hourlyRate: 0 }];
      const cast = data.casts.find((row) => row.id === mapping[source.id]);
      const introducer = data.introducers.find((row) => row.id === cast?.introducerId);
      return [source.id, {
        masterId: cast?.id || "", name: cast?.name || source.name, kind: source.kind,
        hourlyRate: source.kind === "trial" ? cast?.trialHourlyRate || 0 : rateForMonth(cast?.hourlyRates || {}, month),
        introducer: introducer ? { id: introducer.id, name: introducer.name, feeType: introducer.feeType, attendanceAdvisoryFee: cast?.attendanceAdvisoryFee || 0, entryAdvisoryFee: cast?.entryAdvisoryFee || 0 } : undefined
      }];
    }));
    setCastRows(buildDailyCasts(pos, details, data.liquor, specialCosts));
    setStage("details"); setError("");
  };

  const updateCast = (posId: string, patch: Partial<DailyCast>) => setCastRows((rows) => rows.map((row) => row.posCastId === posId ? { ...row, ...patch } : row));
  const addStaff = () => {
    const staff = data.staff.find((row) => row.id === staffId);
    if (!staff) return setError("スタッフを選択してください。");
    const hours = hoursBetweenQuarter(staffStart, staffEnd);
    const rate = staff.status === "trial" ? staff.trialHourlyRate || 0 : staff.hourlyRate || 0;
    const dailyPayment = staff.status === "trial" ? floorHundred(rate * hours) : 0;
    setStaffWork((rows) => [...rows.filter((row) => row.staffId !== staff.id), { staffId: staff.id, name: staff.name, kind: staff.status === "trial" ? "trial" : "regular", startTime: staffStart, endTime: staffEnd, hours, hourlyRate: rate, dailyPayment }]);
    setStaffId(""); setError("");
  };
  const addExpense = () => {
    const trial = castRows.find((row) => row.posCastId === expensePersonId && row.kind === "trial");
    const payee = expenseCategory === "beautyTrial" ? trial?.name || "" : expensePayee.trim();
    if (!payee || expenseAmount <= 0) return setError("経費の支払先と金額を入力してください。");
    setExpenses((rows) => [...rows, { id: crypto.randomUUID(), category: expenseCategory, payee, amount: expenseAmount, personId: trial?.masterId, personName: trial?.name }]);
    setExpensePayee(""); setExpensePersonId(""); setExpenseAmount(0); setError("");
  };
  const expenseTotal = expenses.reduce((sum, row) => sum + row.amount, 0);
  const regularDailyPayments = castRows.filter((row) => row.kind === "regular").reduce((sum, row) => sum + row.dailyPayment, 0);
  const trialDailyPayments = castRows.filter((row) => row.kind === "trial").reduce((sum, row) => sum + row.dailyPayment, 0);
  const staffDailyPayments = staffWork.reduce((sum, row) => sum + row.dailyPayment, 0);
  const cash = pos ? calculateCash({ sales: pos.sales, cashFloat: data.cashFloat, expenses: expenseTotal, regularDailyPayments, trialDailyPayments, staffDailyPayments, dispatchCastPayment, dispatchStaffPayment, dispatchFee, actualClosingCash: actualCash }) : null;
  const driverRows: DailyDriverWork[] = drivers.map((id) => data.drivers.find((row) => row.id === id)).filter(Boolean).map((row) => ({ driverId: row!.id, name: row!.name, dailyRate: row!.dailyRate }));

  const submit = async () => {
    if (!pos || !cash) return;
    const value: DailyClosing = {
      id: initial?.id || `daily_${pos.businessDate.replaceAll("-", "")}`,
      businessDate: pos.businessDate, status: "submitted", submissionId: pos.submissionId, checksum: pos.checksum,
      sales: pos.sales, customers: pos.customers, nominations: pos.nominations, casts: castRows, staffWork, drivers: driverRows, expenses,
      staffDailyPaymentTotal: staffWork.reduce((sum, row) => sum + row.dailyPayment, 0), dispatchStaffPayment, dispatchCastPayment, dispatchFee,
      liquorDeliveryAmount, cash, posSnapshot: pos, updatedAt: new Date().toISOString()
    };
    const saved = await run(() => submitClosing(value, user), `${pos.businessDate}のデータを経理へ送信しました。`);
    if (saved) { setStage("json"); setPos(null); setCastRows([]); onFinished(); }
  };

  return <Card title={initial ? `${initial.businessDate} 再編集` : "当日営業データ作成"} description="POS JSONの照合から現金実在高まで順番に確認します。" action={initial ? <button className="button secondary" onClick={onFinished}>再編集を終了</button> : null}>
    <div className="stepper">{(["json", "details", "cash", "preview"] as Stage[]).map((value, index) => <span key={value} className={stage === value ? "active" : ""}><b>{index + 1}</b>{["JSON取込", "店舗データ", "現金照合", "送信確認"][index]}</span>)}</div>
    {error && <div className="notice error">{error}</div>}
    {stage === "json" && <div className="stack section-pad">
      <Field label="POS営業終了JSON（schemaVersion 3）"><input className="input" type="file" accept=".json,application/json" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const parsed = await parsePosClosingV3(JSON.parse((await file.text()).replace(/^\uFEFF/, ""))); setPos(parsed); hydrateMapping(parsed); setSpecialCosts({}); setCastRows([]); setError(""); } catch (caught) { setPos(null); setError(caught instanceof Error ? caught.message : String(caught)); } finally { event.currentTarget.value = ""; } }} /></Field>
      {pos && <><div className="summary-strip"><span><small>営業日</small><strong>{pos.businessDate}</strong></span><span><small>総売上</small><strong>{yen.format(pos.sales.totalSales)}</strong></span><span><small>会計</small><strong>{pos.transactions.length}件</strong></span><span><small>勤務</small><strong>{pos.castWork.length}名</strong></span></div>
        <h3>キャストデータ照合</h3><Table headers={["POS名", "区分", "GMSデータ", "状態"]}>{references.map((source) => { const options = candidates(source.kind, source.name); return <tr key={source.id}><td>{source.name}</td><td>{source.kind === "regular" ? "在籍" : source.kind === "trial" ? "体入" : "派遣"}</td><td>{source.kind === "dispatch" ? <select className="input table-input" value={mapping[source.id] || ""} onChange={(e) => setMapping({ ...mapping, [source.id]: e.target.value })}><option value="">選択</option><option value="dispatch">派遣キャストとして処理</option></select> : <select className="input table-input" value={mapping[source.id] || ""} onChange={(e) => setMapping({ ...mapping, [source.id]: e.target.value })}><option value="">一致するデータを選択</option>{options.map((row) => <option key={row.id} value={row.id}>{row.name}（{row.trialDate || row.hiredAt}）</option>)}</select>}</td><td>{mapping[source.id] ? <StatusPill tone="good">照合済み</StatusPill> : <StatusPill tone="danger">未照合</StatusPill>}</td></tr>; })}</Table>
        {missingBottles.length > 0 && <><h3>酒代原価未登録</h3><div className="notice error">マスタ未登録のボトルがあります。共通フォームへ登録するか、今回のみの特別原価を入力してください。</div><Table headers={["区分", "ボトル", "販売額", "今回のみの原価"]}>{missingBottles.map((item) => <tr key={item.itemId}><td>{item.category === "champagneWine" ? "シャンパン・ワイン" : "キープボトル"}</td><td>{item.label}</td><td>{yen.format(item.price * item.quantity)}</td><td><MoneyInput value={specialCosts[item.itemId] || 0} onChange={(value) => setSpecialCosts({ ...specialCosts, [item.itemId]: value })} /></td></tr>)}</Table></>}
        <button className="button wide-button" disabled={!mappingComplete || !costsComplete} onClick={createRows}>照合を確定して店舗データ作成へ</button></>}
    </div>}
    {stage === "details" && pos && <div className="stack section-pad">
      <h3>キャスト出勤・売上・手当控除</h3><Table headers={["キャスト", "勤務", "本指名", "場内", "同伴", "本指名売上", "場内延長売上", "ボトル/ドリンク", "美容室", "日払い", "立替", "送迎"]}>{castRows.map((row) => <tr key={row.posCastId}><td><strong>{row.name}</strong><br /><small>{row.kind === "trial" ? "体入" : "在籍"}</small></td><td>{row.startTime}–{row.endTime}<br />{row.hours}時間</td><td>{row.honShimeiCount}本</td><td>{row.banaiShimeiCount}本</td><td>{row.dohanCount}本</td><td><MoneyInput value={row.honShimeiSales} onChange={(value) => updateCast(row.posCastId, { honShimeiSales: floorHundred(value) })} /></td><td><MoneyInput value={row.jonaiExtensionSales} onChange={(value) => updateCast(row.posCastId, { jonaiExtensionSales: floorHundred(value) })} /></td><td>{row.bottles.length}本 / {yen.format(row.drinkSales)}<br /><small>原価 {yen.format(row.liquorCost)}</small></td><td><label className="check-row"><input type="checkbox" checked={row.beautyAllowance === 500} disabled={row.kind === "trial"} onChange={(e) => updateCast(row.posCastId, { beautyAllowance: e.target.checked ? 500 : 0 })} />500円</label></td><td><MoneyInput value={row.dailyPayment} onChange={(value) => updateCast(row.posCastId, { dailyPayment: value })} /></td><td><MoneyInput value={row.advancePayment} onChange={(value) => updateCast(row.posCastId, { advancePayment: value })} /></td><td><input className="input money-input" type="number" min="0" step="500" value={row.transportFee || ""} onChange={(e) => updateCast(row.posCastId, { transportFee: Math.floor(Number(e.target.value) / 500) * 500 })} /></td></tr>)}</Table>
      <h3>スタッフ勤務・日払い</h3><div className="grid form-row"><Field label="スタッフ"><select className="input" value={staffId} onChange={(e) => setStaffId(e.target.value)}><option value="">選択</option>{data.staff.filter((row) => row.status !== "departed").map((row) => <option key={row.id} value={row.id}>{row.name}（{row.status === "trial" ? "体入" : "在籍"}）</option>)}</select></Field><Field label="出勤"><input className="input" type="time" value={staffStart} onChange={(e) => setStaffStart(e.target.value)} /></Field><Field label="退勤"><input className="input" type="time" value={staffEnd} onChange={(e) => setStaffEnd(e.target.value)} /></Field><button className="button compact" onClick={addStaff}>追加</button></div><Table headers={["スタッフ", "区分", "出勤", "退勤", "勤務", "時給", "日払い", "操作"]}>{staffWork.map((row) => <tr key={row.staffId}><td>{row.name}</td><td>{row.kind === "trial" ? "体入" : "在籍"}</td><td>{row.startTime}</td><td>{row.endTime}</td><td>{row.hours}時間</td><td>{yen.format(row.hourlyRate)}</td><td><MoneyInput value={row.dailyPayment} onChange={(value) => setStaffWork((rows) => rows.map((item) => item.staffId === row.staffId ? { ...item, dailyPayment: value } : item))} /></td><td><button className="button danger mini" onClick={() => setStaffWork((rows) => rows.filter((item) => item.staffId !== row.staffId))}>削除</button></td></tr>)}</Table>
      <h3>送迎ドライバー</h3><div className="check-grid">{data.drivers.filter((row) => row.status === "active").map((row) => <label className="select-card" key={row.id}><input type="checkbox" checked={drivers.includes(row.id)} onChange={(e) => setDrivers(e.target.checked ? [...drivers, row.id] : drivers.filter((id) => id !== row.id))} /><span>{row.name}<small>日給 {yen.format(row.dailyRate)}</small></span></label>)}</div>
      <h3>当日経費</h3><div className="grid form-row expense-row"><Field label="勘定科目"><select className="input" value={expenseCategory} onChange={(e) => { setExpenseCategory(e.target.value as ExpenseCategory); setExpensePayee(""); setExpensePersonId(""); }}>{Object.entries(expenseLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>{expenseCategory === "beautyTrial" ? <Field label="対象の体入キャスト"><select className="input" value={expensePersonId} onChange={(e) => setExpensePersonId(e.target.value)}><option value="">選択</option>{castRows.filter((row) => row.kind === "trial").map((row) => <option key={row.posCastId} value={row.posCastId}>{row.name}</option>)}</select></Field> : <Field label="支払先"><input className="input" value={expensePayee} onChange={(e) => setExpensePayee(e.target.value)} /></Field>}<Field label="金額"><MoneyInput value={expenseAmount} onChange={setExpenseAmount} /></Field><button className="button compact" onClick={addExpense}>追加</button></div><Table headers={["勘定科目", "支払先", "金額", "操作"]}>{expenses.map((row) => <tr key={row.id}><td>{expenseLabels[row.category]}</td><td>{row.payee}</td><td>{yen.format(row.amount)}</td><td><button className="button danger mini" onClick={() => setExpenses((rows) => rows.filter((item) => item.id !== row.id))}>削除</button></td></tr>)}</Table><div className="right-total">経費総計 <strong>{yen.format(expenseTotal)}</strong></div>
      <h3>派遣・納品書</h3><div className="grid four"><Field label="派遣スタッフ支払"><MoneyInput value={dispatchStaffPayment} onChange={setDispatchStaffPayment} /></Field><Field label="派遣キャスト支払"><MoneyInput value={dispatchCastPayment} onChange={setDispatchCastPayment} /></Field><Field label="派遣手数料"><MoneyInput value={dispatchFee} onChange={setDispatchFee} /></Field><Field label="酒代納品書分"><MoneyInput value={liquorDeliveryAmount} onChange={setLiquorDeliveryAmount} /></Field></div>
      <div className="actions spread"><button className="button secondary" onClick={() => setStage("json")}>JSON照合へ戻る</button><button className="button" onClick={() => setStage("cash")}>店舗データを確認して現金照合へ</button></div>
    </div>}
    {stage === "cash" && pos && cash && <div className="stack section-pad"><h3>当日現金照合</h3><div className="grid metrics"><Metric label="現金売上" value={cash.cashSales} /><Metric label="カード売上" value={cash.cardSales} /><Metric label="当日合計売上" value={cash.totalSales} /><Metric label="つり銭" value={cash.cashFloat} /></div><Table headers={["計算項目", "金額"]}><tr><td>経費総計</td><td>{yen.format(expenseTotal)}</td></tr><tr><td>在籍キャスト日払い</td><td>{yen.format(regularDailyPayments)}</td></tr><tr><td>体入キャスト即日支払い</td><td>{yen.format(trialDailyPayments)}</td></tr><tr><td>スタッフ日払い</td><td>{yen.format(staffDailyPayments)}</td></tr><tr><td>派遣キャスト支払い</td><td>{yen.format(dispatchCastPayment)}</td></tr><tr><td>派遣スタッフ支払い</td><td>{yen.format(dispatchStaffPayment)}</td></tr><tr><td>派遣手数料</td><td>{yen.format(dispatchFee)}</td></tr><tr className="total-row"><td>経費・日払い・派遣支払い・手数料 合計</td><td>{yen.format(cash.expenseAndPaymentTotal)}</td></tr><tr><td>現金売上＋つり銭</td><td>{yen.format(cash.cashSales + cash.cashFloat)}</td></tr><tr><td><strong>営業終了時点の計算上現金残額</strong></td><td><strong>{yen.format(cash.expectedClosingCash)}</strong></td></tr><tr><td>つり銭を除いた現金利益額</td><td>{yen.format(cash.cashProfit)}</td></tr></Table><Field label="営業終了時点の現金実在高"><MoneyInput value={actualCash} onChange={setActualCash} step={1} /></Field><div className={`reconciliation-result ${cash.difference === 0 ? "match" : "mismatch"}`}><span>照合差額</span><strong>{yen.format(cash.difference)}</strong><small>{cash.difference === 0 ? "現金が一致しました" : "差額を記録したまま送信できます。入力内容を再確認してください"}</small></div><div className="actions spread"><button className="button secondary" onClick={() => setStage("details")}>店舗データへ戻る</button><button className="button" onClick={() => setStage("preview")}>現金照合内容を確認して送信確認へ</button></div></div>}
    {stage === "preview" && pos && cash && <div className="stack section-pad"><DailyPreview closing={{ id: initial?.id || "preview", businessDate: pos.businessDate, status: "submitted", submissionId: pos.submissionId, checksum: pos.checksum, sales: pos.sales, customers: pos.customers, nominations: pos.nominations, casts: castRows, staffWork, drivers: driverRows, expenses, staffDailyPaymentTotal: staffWork.reduce((sum, row) => sum + row.dailyPayment, 0), dispatchStaffPayment, dispatchCastPayment, dispatchFee, liquorDeliveryAmount, cash, posSnapshot: pos, updatedAt: new Date().toISOString() }} /><div className="actions spread"><button className="button secondary" onClick={() => setStage("cash")}>現金照合へ戻る</button><button className="button submit-button" disabled={busy} onClick={() => void submit()}>{busy ? "送信中…" : "確認済み・経理へ送信"}</button></div></div>}
  </Card>;
}

function DailyPreview({ closing }: { closing: DailyClosing }) {
  return <div className="preview-sheet"><header><div><p className="eyebrow">営業日次データ</p><h2>{closing.businessDate}</h2></div><StatusPill tone={closing.status === "approved" ? "good" : "warn"}>{closingLabels[closing.status]}</StatusPill></header><div className="grid metrics"><Metric label="総売上" value={closing.sales.totalSales} /><Metric label="現金売上" value={closing.sales.cashSales} /><Metric label="カード売上" value={closing.sales.cardSales} /><Metric label="経費総計" value={closing.expenses.reduce((sum, row) => sum + row.amount, 0)} /></div><h3>キャスト</h3><Table headers={["名前", "勤務", "本指名売上", "場内延長売上", "酒代原価", "日払い・立替・送迎"]}>{closing.casts.map((row) => <tr key={row.posCastId}><td>{row.name}</td><td>{row.hours}時間</td><td>{yen.format(row.honShimeiSales)}</td><td>{yen.format(row.jonaiExtensionSales)}</td><td>{yen.format(row.liquorCost)}</td><td>{yen.format(row.dailyPayment + row.advancePayment + row.transportFee)}</td></tr>)}</Table><h3>現金照合</h3><div className="summary-strip"><span><small>支払合計</small><strong>{yen.format(closing.cash.expenseAndPaymentTotal)}</strong></span><span><small>計算上残額</small><strong>{yen.format(closing.cash.expectedClosingCash)}</strong></span><span><small>実在高</small><strong>{yen.format(closing.cash.actualClosingCash)}</strong></span><span><small>差額</small><strong>{yen.format(closing.cash.difference)}</strong></span></div></div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="metric-card"><small>{label}</small><strong>{yen.format(value)}</strong></div>; }
function posTargetCount(pos: PosClosingV3, itemId: string) { return pos.transactions.flatMap((row) => row.items).find((row) => row.itemId === itemId)?.backTargetCastIds.length || 1; }
