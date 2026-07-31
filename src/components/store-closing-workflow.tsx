"use client";

import { useMemo, useState } from "react";
import { calculateCastSales, hoursBetween } from "@/domain/closing-calculation";
import { parsePosClosing, previewRoster } from "@/domain/pos-import";
import type {
  IdentityResolution,
  ImportPreview,
  LocalLifecycleAction,
  MoneyRow,
  StoreClosingInput,
  WorkRow
} from "@/domain/types";
import type { WorkspaceData } from "@/lib/firebase/repository";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const expenseCategories = [
  ["beautyBack", "1 美容バック"],
  ["introducerAdvertising", "2 紹介料・広告等"],
  ["supplies", "3 備品・消耗品他"],
  ["entertainment", "4 交際費・プレゼント等"],
  ["liquor", "5 酒代"],
  ["transport", "6 交通費"]
] as const;

export function StoreClosingWorkflow({ data, loading, onSubmit }: {
  data: WorkspaceData;
  loading: boolean;
  onSubmit: (input: StoreClosingInput) => Promise<void>;
}) {
  const [started, setStarted] = useState(false);
  const [businessDate, setBusinessDate] = useState(today());
  const [actions, setActions] = useState<LocalLifecycleAction[]>([]);
  const [actionType, setActionType] = useState<LocalLifecycleAction["eventType"]>("entered");
  const [memberId, setMemberId] = useState("");
  const [trialName, setTrialName] = useState("");
  const [hourlyRate, setHourlyRate] = useState(0);
  const [introducerId, setIntroducerId] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [missingAcknowledged, setMissingAcknowledged] = useState(false);
  const [staffWork, setStaffWork] = useState<WorkRow[]>([]);
  const [staffId, setStaffId] = useState("");
  const [staffStart, setStaffStart] = useState("20:00");
  const [staffEnd, setStaffEnd] = useState("02:00");
  const [expenses, setExpenses] = useState<MoneyRow[]>([]);
  const [expenseCategory, setExpenseCategory] = useState(expenseCategories[0][0]);
  const [expenseAmount, setExpenseAmount] = useState(0);
  const [expenseNote, setExpenseNote] = useState("");
  const [auric, setAuric] = useState(0);
  const [deductions, setDeductions] = useState<MoneyRow[]>([]);
  const [deductionPerson, setDeductionPerson] = useState("");
  const [deductionType, setDeductionType] = useState<"dailyPayment" | "advancePayment">("dailyPayment");
  const [deductionAmount, setDeductionAmount] = useState(0);
  const [error, setError] = useState("");

  const activeCasts = data.casts.filter((row) => !row.deleted && row.status === "active");
  const trialCasts = data.casts.filter((row) => !row.deleted && row.status === "trial");
  const eligibleMembers = actionType === "entered" ? trialCasts : activeCasts;
  const referenced = useMemo(() => {
    if (!preview) return [];
    const rows = new Map<string, { sourceCastId: string; sourceName: string; eventType?: LocalLifecycleAction["eventType"] }>();
    preview.differences.filter((item) => item.kind !== "missing-local").forEach((item) => rows.set(item.sourceCastId, {
      sourceCastId: item.sourceCastId,
      sourceName: item.sourceName
    }));
    preview.closing.lifecycleEvents.forEach((event) => rows.set(event.castId, {
      sourceCastId: event.castId,
      sourceName: event.castName || rows.get(event.castId)?.sourceName || "",
      eventType: event.eventType
    }));
    return [...rows.values()];
  }, [preview]);
  const computedSales = useMemo(() => preview ? calculateCastSales(preview.closing) : [], [preview]);
  const availablePeople = useMemo(() => [
    ...data.casts.filter((row) => !row.deleted).map((row) => ({
      value: `cast|${row.id}|${row.name}|${row.status === "trial" ? "trial" : "cast"}`,
      label: `${row.name}（${statusLabel(row.status)}）`
    })),
    ...data.staff.filter((row) => row.status === "active").map((row) => ({
      value: `staff|${row.id}|${row.name}|staff`,
      label: `${row.name}（アルバイト）`
    })),
    ...actions.map((row) => ({
      value: `${row.eventType === "trial" ? "trial" : "cast"}|${row.id}|${row.name}|${row.eventType === "trial" ? "trial" : "cast"}`,
      label: `${row.name}（本日の${eventLabel(row.eventType)}）`
    }))
  ], [actions, data.casts, data.staff]);

  if (!started) {
    const alreadySubmitted = data.closings.some((row) =>
      row.businessDate === businessDate && row.status !== "superseded");
    return (
      <section className="card start-closing">
        <p className="eyebrow">店舗締め</p>
        <h2>今日の締め作業を開始する</h2>
        <p className="muted">入退店登録からJSON確認、経費・日払い入力までを順番に確認し、最後に経理へ送信します。</p>
        <div className="grid two">
          <div className="field"><label>営業日</label><input className="input" type="date" value={businessDate} onChange={(event) => setBusinessDate(event.target.value)} /></div>
          <div className="field"><label>既存データ</label><div className={`status-box ${alreadySubmitted ? "warning" : ""}`}>{alreadySubmitted ? "この営業日のデータがあります" : "未送信"}</div></div>
        </div>
        <button className="button" disabled={!businessDate || alreadySubmitted} onClick={() => setStarted(true)}>締め作業を開始</button>
      </section>
    );
  }

  const addLifecycle = () => {
    setError("");
    if (actionType === "trial") {
      if (!trialName.trim() || hourlyRate <= 0 || !introducerId) {
        setError("体入はキャスト名・時給・紹介者をすべて入力してください。");
        return;
      }
      setActions((rows) => [...rows, {
        id: `local_${crypto.randomUUID()}`,
        eventType: "trial",
        name: trialName.trim(),
        hourlyRate,
        introducerId,
        introducerName: data.introducers.find((row) => row.id === introducerId)?.name || ""
      }]);
      setTrialName("");
      setHourlyRate(0);
      setIntroducerId("");
      return;
    }
    const member = data.casts.find((row) => row.id === memberId);
    if (!member) {
      setError(`${eventLabel(actionType)}するキャストを選択してください。`);
      return;
    }
    if (actions.some((row) => row.memberId === member.id)) {
      setError("同じキャストに複数の入退店処理は登録できません。内容を確認してください。");
      return;
    }
    setActions((rows) => [...rows, {
      id: `local_${crypto.randomUUID()}`,
      eventType: actionType,
      memberId: member.id,
      name: member.name
    }]);
    setMemberId("");
  };

  const resolveOptions = (source: typeof referenced[number]) => {
    if (source.eventType) return actions.filter((row) => row.eventType === source.eventType);
    return [
      ...data.casts.filter((row) => !row.deleted).map((row) => ({
        id: row.id,
        name: row.name,
        eventType: row.status === "trial" ? "trial" as const : "entered" as const
      })),
      ...actions
    ];
  };
  const unresolved = referenced.filter((source) =>
    !resolveOptions(source).some((option) => option.id === resolutions[source.sourceCastId]));
  const blockingDifferences = preview?.differences.filter((item) =>
    item.blocking && item.kind !== "missing-local" && !resolutions[item.sourceCastId]) || [];
  const missingLocal = preview?.differences.filter((item) => item.kind === "missing-local" && item.blocking) || [];
  const canSubmit = Boolean(preview)
    && preview?.closing.businessDate === businessDate
    && unresolved.length === 0
    && blockingDifferences.length === 0
    && (missingLocal.length === 0 || missingAcknowledged);

  const submit = async () => {
    if (!preview || !canSubmit) return;
    const identityResolutions: IdentityResolution[] = referenced.map((source) => {
      const targetId = resolutions[source.sourceCastId];
      const target = [...actions, ...data.casts].find((row) => row.id === targetId);
      return {
        sourceCastId: source.sourceCastId,
        targetId,
        targetName: target?.name || source.sourceName || "名称未設定"
      };
    });
    const resolvedPreview: ImportPreview = {
      ...preview,
      differences: preview.differences.map((item) => ({
        ...item,
        blocking: item.kind === "missing-local" ? !missingAcknowledged : !resolutions[item.sourceCastId] && item.blocking
      })),
      blockingCount: 0
    };
    try {
      await onSubmit({
        preview: resolvedPreview,
        lifecycleActions: actions,
        identityResolutions,
        staffWork,
        expenses,
        auricLiquorAmount: auric,
        payrollDeductions: deductions
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="grid closing-workflow">
      <div className="workflow-head">
        <div><span className="pill good">作業中</span><strong>{businessDate}</strong></div>
        <button className="button secondary" onClick={() => setStarted(false)}>開始画面へ戻る</button>
      </div>
      {error && <div className="notice error">{error}</div>}

      <WizardSection number={1} title="入退店・体入キャスト登録">
        <div className="grid form-row">
          <div className="field"><label>処理</label><select className="input" value={actionType} onChange={(event) => {
            setActionType(event.target.value as LocalLifecycleAction["eventType"]);
            setMemberId("");
          }}>
            <option value="entered">入店</option><option value="departed">退店</option><option value="trial">体入</option>
          </select></div>
          {actionType === "trial" ? (
            <>
              <div className="field"><label>キャスト名</label><input className="input" value={trialName} onChange={(event) => setTrialName(event.target.value)} /></div>
              <div className="field"><label>時給</label><input className="input" type="number" min="1" value={hourlyRate || ""} onChange={(event) => setHourlyRate(Number(event.target.value))} /></div>
              <div className="field"><label>紹介者</label><select className="input" value={introducerId} onChange={(event) => setIntroducerId(event.target.value)}>
                <option value="">選択してください</option>
                {data.introducers.filter((row) => !row.deleted).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select></div>
            </>
          ) : (
            <div className="field"><label>{actionType === "entered" ? "体入キャストから選択" : "在籍キャストから選択"}</label>
              <select className="input" value={memberId} onChange={(event) => setMemberId(event.target.value)}>
                <option value="">選択してください</option>
                {eligibleMembers.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </div>
          )}
          <button className="button compact" onClick={addLifecycle}>登録</button>
        </div>
        <InlineTable headers={["処理", "キャスト", "時給", "紹介者", ""]} empty="本日の入退店・体入登録はありません。">
          {actions.map((row) => <tr key={row.id}>
            <td>{eventLabel(row.eventType)}</td><td>{row.name}</td><td>{row.hourlyRate ? yen.format(row.hourlyRate) : "—"}</td>
            <td>{data.introducers.find((item) => item.id === row.introducerId)?.name || "—"}</td>
            <td><button className="text-button danger-text" onClick={() => setActions((items) => items.filter((item) => item.id !== row.id))}>取消</button></td>
          </tr>)}
        </InlineTable>
      </WizardSection>

      <WizardSection number={2} title="POS JSONを取込">
        <input className="input" type="file" accept=".json,application/json" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          try {
            const parsed = parsePosClosing(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
            const next = previewRoster(parsed, data.casts);
            const eventBySource = new Map(parsed.lifecycleEvents.map((item) => [item.castId, item]));
            const linked = Object.fromEntries(next.differences
              .filter((item) => item.memberId && item.kind !== "missing-local")
              .map((item) => {
                const lifecycle = eventBySource.get(item.sourceCastId);
                if (!lifecycle) return [item.sourceCastId, item.memberId!];
                const action = actions.find((row) =>
                  row.eventType === lifecycle.eventType && row.memberId === item.memberId);
                return action ? [item.sourceCastId, action.id] : ["", ""];
              })
              .filter(([sourceCastId]) => sourceCastId));
            setPreview(next);
            setResolutions(linked);
            setMissingAcknowledged(false);
            setError(parsed.businessDate === businessDate ? "" : `JSONの営業日（${parsed.businessDate}）が締め日と一致しません。`);
          } catch (caught) {
            setPreview(null);
            setError(caught instanceof Error ? caught.message : String(caught));
          } finally {
            event.currentTarget.value = "";
          }
        }} />
        {preview && <div className="import-summary">
          <span><b>営業日</b>{preview.closing.businessDate}</span>
          <span><b>売上</b>{yen.format(preview.closing.sales.totalSales)}</span>
          <span><b>会計</b>{preview.closing.transactions.length}件</span>
          <span><b>チェックサム</b>{preview.closing.checksum}</span>
        </div>}
      </WizardSection>

      <WizardSection number={3} title="JSONと本日のキャスト登録を紐づけ">
        {!preview ? <p className="muted">先にJSONを取り込んでください。</p> : (
          <>
            {missingLocal.length > 0 && <div className="notice">
              JSONの完全在籍一覧にいないGMSキャストが{missingLocal.length}名います。自動退店はしません。
              <button className="button secondary inline-action" onClick={() => setMissingAcknowledged(true)}>
                {missingAcknowledged ? "確認済み" : "GMSの状態を維持して続行"}
              </button>
            </div>}
            <InlineTable headers={["JSON ID", "JSON名", "判定", "紐づけ先"]} empty="JSONにキャスト情報がありません。">
              {referenced.map((source) => {
                const options = resolveOptions(source);
                return <tr key={source.sourceCastId}>
                  <td>{source.sourceCastId}</td><td>{source.sourceName || "名称未設定"}</td>
                  <td>{source.eventType ? eventLabel(source.eventType) : "売上・勤務"}</td>
                  <td><select className="input table-input" value={resolutions[source.sourceCastId] || ""} onChange={(event) =>
                    setResolutions((rows) => ({ ...rows, [source.sourceCastId]: event.target.value }))}>
                    <option value="">選択してください</option>
                    {options.map((row) => <option key={row.id} value={row.id}>{row.name}{source.eventType ? `（本日の${eventLabel(row.eventType)}）` : ""}</option>)}
                  </select></td>
                </tr>;
              })}
            </InlineTable>
            {unresolved.length > 0 && <p className="validation-text">未紐づけ：{unresolved.length}件</p>}
          </>
        )}
      </WizardSection>

      <WizardSection number={4} title="キャスト売上・勤務時間を確認">
        {!preview ? <p className="muted">JSON取込後に自動計算します。</p> : (
          <div className="grid two">
            <InlineTable headers={["キャスト", "本指名売上", "場内延長売上", "合計"]} empty="売上配分はありません。">
              {computedSales.map((row) => <tr key={String(row.castId || row.posCastId)}>
                <td>{resolutions[String(row.castId || row.posCastId)]
                  ? [...actions, ...data.casts].find((item) => item.id === resolutions[String(row.castId || row.posCastId)])?.name || row.castName
                  : row.castName || row.name}</td>
                <td>{yen.format(row.honShimeiSales || 0)}</td><td>{yen.format(row.jonaiExtensionSales || 0)}</td><td>{yen.format(row.totalAttributedSales || 0)}</td>
              </tr>)}
            </InlineTable>
            <InlineTable headers={["キャスト", "入店", "退店", "勤務時間"]} empty="勤務データはありません。">
              {[...preview.closing.castWork, ...preview.closing.trialWork].map((row, index) => <tr key={`${row.castId || row.id}-${index}`}>
                <td>{row.castName || row.name}</td><td>{row.startTime || "—"}</td><td>{row.endTime || "—"}</td><td>{row.hours}時間</td>
              </tr>)}
            </InlineTable>
          </div>
        )}
      </WizardSection>

      <WizardSection number={5} title="アルバイト勤務時間">
        <div className="grid form-row">
          <div className="field"><label>アルバイト</label><select className="input" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
            <option value="">選択してください</option>
            {data.staff.filter((row) => row.status === "active").map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select></div>
          <div className="field"><label>出勤</label><input className="input" type="time" value={staffStart} onChange={(event) => setStaffStart(event.target.value)} /></div>
          <div className="field"><label>退勤</label><input className="input" type="time" value={staffEnd} onChange={(event) => setStaffEnd(event.target.value)} /></div>
          <button className="button compact" onClick={() => {
            const staff = data.staff.find((row) => row.id === staffId);
            if (!staff) return setError("アルバイトを選択してください。");
            const hours = hoursBetween(staffStart, staffEnd);
            setStaffWork((rows) => [...rows.filter((row) => row.staffId !== staff.id), {
              id: staff.id, staffId: staff.id, name: staff.name, staffName: staff.name,
              startTime: staffStart, endTime: staffEnd, hours, payType: staff.payType, payAmount: staff.payAmount
            }]);
            setStaffId("");
          }}>追加</button>
        </div>
        <InlineTable headers={["名前", "出勤", "退勤", "時間", ""]} empty="勤務入力はありません。">
          {staffWork.map((row) => <tr key={row.staffId}><td>{row.staffName}</td><td>{row.startTime}</td><td>{row.endTime}</td><td>{row.hours}時間</td>
            <td><button className="text-button danger-text" onClick={() => setStaffWork((items) => items.filter((item) => item.staffId !== row.staffId))}>取消</button></td></tr>)}
        </InlineTable>
      </WizardSection>

      <WizardSection number={6} title="経費">
        <div className="grid form-row">
          <div className="field"><label>勘定科目</label><select className="input" value={expenseCategory} onChange={(event) => setExpenseCategory(event.target.value as typeof expenseCategory)}>
            {expenseCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></div>
          <div className="field"><label>金額</label><input className="input" type="number" min="0" value={expenseAmount || ""} onChange={(event) => setExpenseAmount(Number(event.target.value))} /></div>
          <div className="field"><label>備考</label><input className="input" value={expenseNote} onChange={(event) => setExpenseNote(event.target.value)} /></div>
          <button className="button compact" onClick={() => {
            if (expenseAmount <= 0) return setError("経費金額を入力してください。");
            setExpenses((rows) => [...rows, { id: crypto.randomUUID(), category: expenseCategory, amount: expenseAmount, note: expenseNote.trim() }]);
            setExpenseAmount(0); setExpenseNote("");
          }}>追加</button>
        </div>
        <InlineTable headers={["勘定科目", "金額", "備考", ""]} empty="経費入力はありません。">
          {expenses.map((row) => <tr key={row.id}><td>{expenseCategories.find(([value]) => value === row.category)?.[1]}</td><td>{yen.format(row.amount)}</td><td>{row.note || "—"}</td>
            <td><button className="text-button danger-text" onClick={() => setExpenses((items) => items.filter((item) => item.id !== row.id))}>取消</button></td></tr>)}
        </InlineTable>
      </WizardSection>

      <WizardSection number={7} title="オーリック酒代">
        <div className="field short-field"><label>本日のオーリック酒代</label><input className="input" type="number" min="0" value={auric || ""} onChange={(event) => setAuric(Number(event.target.value))} /></div>
      </WizardSection>

      <WizardSection number={8} title="日払い・立替金">
        <div className="grid form-row">
          <div className="field"><label>対象者</label><select className="input" value={deductionPerson} onChange={(event) => setDeductionPerson(event.target.value)}>
            <option value="">選択してください</option>{availablePeople.map((row) => <option key={row.value} value={row.value}>{row.label}</option>)}
          </select></div>
          <div className="field"><label>区分</label><select className="input" value={deductionType} onChange={(event) => setDeductionType(event.target.value as typeof deductionType)}>
            <option value="dailyPayment">日払い</option><option value="advancePayment">立替金</option>
          </select></div>
          <div className="field"><label>金額</label><input className="input" type="number" min="0" value={deductionAmount || ""} onChange={(event) => setDeductionAmount(Number(event.target.value))} /></div>
          <button className="button compact" onClick={() => {
            if (!deductionPerson || deductionAmount <= 0) return setError("対象者と金額を入力してください。");
            const [source, personId, personName, personType] = deductionPerson.split("|");
            setDeductions((rows) => [...rows, {
              id: crypto.randomUUID(), type: deductionType, amount: deductionAmount,
              personId, personName, personType: personType as MoneyRow["personType"], note: source
            }]);
            setDeductionPerson(""); setDeductionAmount(0);
          }}>追加</button>
        </div>
        <InlineTable headers={["対象者", "区分", "金額", ""]} empty="日払い・立替金はありません。">
          {deductions.map((row) => <tr key={row.id}><td>{row.personName}</td><td>{row.type === "dailyPayment" ? "日払い" : "立替金"}</td><td>{yen.format(row.amount)}</td>
            <td><button className="text-button danger-text" onClick={() => setDeductions((items) => items.filter((item) => item.id !== row.id))}>取消</button></td></tr>)}
        </InlineTable>
      </WizardSection>

      <WizardSection number={9} title="確定・経理へ送信">
        <div className="grid metrics">
          <Summary label="売上" value={yen.format(preview?.closing.sales.totalSales || 0)} />
          <Summary label="店舗入力経費" value={yen.format(expenses.reduce((sum, row) => sum + row.amount, 0))} />
          <Summary label="オーリック酒代" value={yen.format(auric)} />
          <Summary label="日払い・立替" value={yen.format(deductions.reduce((sum, row) => sum + row.amount, 0))} />
        </div>
        {!canSubmit && <div className="validation-panel">
          {!preview && <span>JSONが未取込です。</span>}
          {preview && preview.closing.businessDate !== businessDate && <span>営業日が一致しません。</span>}
          {unresolved.length > 0 && <span>キャストの未紐づけが{unresolved.length}件あります。</span>}
          {missingLocal.length > 0 && !missingAcknowledged && <span>JSONにいない在籍キャストの扱いが未確認です。</span>}
        </div>}
        <button className="button submit-closing" disabled={!canSubmit || loading} onClick={submit}>
          {loading ? "経理へ送信中…" : "内容を確定して経理へ送信"}
        </button>
        <p className="muted">送信後は店舗側で上書きせず、訂正JSONと経理側の確認を通して修正します。</p>
      </WizardSection>
    </div>
  );
}

function WizardSection({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return <section className="card wizard-section"><div className="wizard-title"><span>{String(number).padStart(2, "0")}</span><h2>{title}</h2></div><div className="wizard-body">{children}</div></section>;
}

function InlineTable({ headers, empty, children }: { headers: string[]; empty: string; children: React.ReactNode }) {
  const rows = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return <div className="table-wrap"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
    <tbody>{rows.length ? children : <tr><td colSpan={headers.length}>{empty}</td></tr>}</tbody></table></div>;
}

function Summary({ label, value }: { label: string; value: string }) {
  return <div className="summary-cell"><span>{label}</span><strong>{value}</strong></div>;
}

function eventLabel(value: LocalLifecycleAction["eventType"]) {
  return { entered: "入店", departed: "退店", trial: "体入" }[value];
}

function statusLabel(value: string) {
  return { active: "在籍", departed: "退店", trial: "体入" }[value] || value;
}
