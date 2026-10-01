import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs/dist/exceljs.min.js";
import { buildBalanceExportReport, type BalanceExportInput, type BalanceExportReport } from "@/domain/balance-export";
import { createMonthlyBalanceWorkbook } from "./balance";

vi.mock("@/domain/balance-export", () => ({ buildBalanceExportReport: vi.fn() }));

const mockedBuild = vi.mocked(buildBalanceExportReport);
const input = {} as BalanceExportInput;
const months = [
  { month: "2026-09", lastDay: 30, monthlyRow: 33, offset: 0 },
  { month: "2026-12", lastDay: 31, monthlyRow: 34, offset: 1 },
];

function report(month: string, lastDay: number): BalanceExportReport {
  return {
    month, approvedDays: 2, castDailyAndAdvance: 3000, castTransport: 500,
    castWithholding: 123, castNet: 43877, employeeDaily: 1200, cardFee: 300,
    honShimeiSales: 180000, jonaiExtensionSales: 10000, additionalSales: 1234,
    monthlyExpenses: { introducerPayment: 6500, expenses: 9000 },
    cashFunding: {
      managedDays: 2, openingPersonalDebt: 10000, companyReplenishment: 20000,
      personalReplenishment: 30000, companyTransfer: 5000, personalRepayment: 15000,
      closingPersonalDebt: 25000, netCashMovement: 40000,
    },
    days: [
      {
        businessDate: `${month}-02`, cashSales: 100000, cardSales: 50000, totalSales: 150000,
        groups: 5, customers: 10, honShimeiCount: 3, jonaiCount: 4, dohanCount: 2, castCount: 4,
        castHourly: 11500, castSalesReward: 7000, dispatchCastCount: 2, dispatchCastPayment: 5000,
        employeeGross: 3500, introducerPayment: 0, expenses: 2000,
      },
      {
        businessDate: `${month}-${lastDay}`, cashSales: 20000, cardSales: 10000, totalSales: 30000,
        groups: 2, customers: 3, honShimeiCount: 1, jonaiCount: 2, dohanCount: 1, castCount: 2,
        castHourly: 18500, castSalesReward: 10500, dispatchCastCount: 1, dispatchCastPayment: 3000,
        employeeGross: 7000, introducerPayment: 0, expenses: 2000,
      },
    ],
  };
}

type Evaluated = number | string | boolean | Evaluated[];

/** この帳票が出力する式だけを評価する。ExcelJS の result は一切参照しない。 */
function formulaEvaluator(sheet: ExcelJS.Worksheet) {
  const memo = new Map<string, Evaluated>();
  const visiting = new Set<string>();
  const numeric = (value: Evaluated): number => {
    if (typeof value === "number") return value;
    if (value === "") return 0;
    throw new Error(`数値以外の演算対象: ${JSON.stringify(value)}`);
  };
  const sum = (values: Evaluated[]): number => values.reduce<number>((total, value) =>
    total + (Array.isArray(value) ? sum(value) : typeof value === "number" ? value : 0), 0);

  const evaluate = (address: string): Evaluated => {
    const cell = sheet.getCell(address.replaceAll("$", "")).master;
    if (memo.has(cell.address)) return memo.get(cell.address)!;
    if (visiting.has(cell.address)) throw new Error(`循環参照: ${cell.address}`);
    visiting.add(cell.address);
    let value: Evaluated;
    if (cell.type !== ExcelJS.ValueType.Formula) {
      if (cell.value === null || cell.value === undefined) value = "";
      else if (typeof cell.value === "number" || typeof cell.value === "string") value = cell.value;
      else throw new Error(`未対応のセル値: ${cell.address}`);
    } else {
      const expression = cell.formula;
      const tokens = expression.match(/"(?:[^"]|"")*"|\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?|[A-Z]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[-+*/(),=]/g) ?? [];
      if (tokens.join("") !== expression) throw new Error(`未対応の式: ${expression}`);
      let position = 0;
      const take = (expected: string) => {
        if (tokens[position++] !== expected) throw new Error(`${cell.address}: ${expected} が必要`);
      };
      const primary = (): Evaluated => {
        const token = tokens[position++];
        if (token === "-") return -numeric(primary());
        if (token === "+") return numeric(primary());
        if (token === "(") {
          const result = comparison();
          take(")");
          return result;
        }
        if (token?.startsWith('"')) return token.slice(1, -1).replaceAll('""', '"');
        if (/^\d/.test(token ?? "")) return Number(token);
        if (/^\$?[A-Z]+\$?\d/.test(token ?? "")) {
          const [start, end] = token.replaceAll("$", "").split(":");
          if (!end) return evaluate(start);
          const first = sheet.getCell(start);
          const last = sheet.getCell(end);
          const values: Evaluated[] = [];
          for (let row = Number(first.row); row <= Number(last.row); row += 1) {
            for (let column = Number(first.col); column <= Number(last.col); column += 1) {
              values.push(evaluate(sheet.getCell(row, column).address));
            }
          }
          return values;
        }
        if (["SUM", "IF", "OR"].includes(token)) {
          take("(");
          const args = [comparison()];
          while (tokens[position] === ",") {
            position += 1;
            args.push(comparison());
          }
          take(")");
          if (token === "SUM") return sum(args);
          if (token === "OR") return args.some(Boolean);
          return args[args[0] ? 1 : 2];
        }
        throw new Error(`${cell.address}: 未対応のトークン ${token}`);
      };
      const product = (): Evaluated => {
        let result = primary();
        while (tokens[position] === "*" || tokens[position] === "/") {
          const operator = tokens[position++];
          const right = numeric(primary());
          result = operator === "*" ? numeric(result) * right : numeric(result) / right;
        }
        return result;
      };
      const addition = (): Evaluated => {
        let result = product();
        while (tokens[position] === "+" || tokens[position] === "-") {
          const operator = tokens[position++];
          const right = numeric(product());
          result = operator === "+" ? numeric(result) + right : numeric(result) - right;
        }
        return result;
      };
      const comparison = (): Evaluated => {
        const left = addition();
        if (tokens[position] !== "=") return left;
        position += 1;
        return left === addition();
      };
      value = comparison();
      if (position !== tokens.length) throw new Error(`${cell.address}: 式の末尾を評価できません`);
    }
    visiting.delete(cell.address);
    memo.set(cell.address, value);
    return value;
  };
  return evaluate;
}

function formulaCells(sheet: ExcelJS.Worksheet): ExcelJS.Cell[] {
  const cells: ExcelJS.Cell[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.type === ExcelJS.ValueType.Formula && cell.master.address === cell.address) cells.push(cell);
  }));
  return cells;
}

function expectCachedResults(sheet: ExcelJS.Worksheet) {
  const evaluate = formulaEvaluator(sheet);
  const cells = formulaCells(sheet);
  expect(cells.length).toBeGreaterThan(40);
  for (const cell of cells) {
    const actual = evaluate(cell.address);
    if (typeof cell.result === "number") expect(actual, `${cell.address}: ${cell.formula}`).toBeCloseTo(cell.result, 8);
    else expect(actual, `${cell.address}: ${cell.formula}`).toBe(cell.result);
  }
}

async function restoredSheet(month: string, lastDay: number) {
  mockedBuild.mockReturnValue(report(month, lastDay));
  const original = createMonthlyBalanceWorkbook(input, "数式依存関係の検証");
  expectCachedResults(original.worksheets[0]);
  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await original.xlsx.writeBuffer());
  expectCachedResults(restored.worksheets[0]);
  return restored.worksheets[0];
}

beforeEach(() => vi.resetAllMocks());

describe.each(months)("収支XLSXの参照式再計算（$lastDay 日月）", ({ month, lastDay, monthlyRow, offset }) => {
  const lower = (column: string, row: number) => `${column}${row + offset}`;

  it("保存・再読込後も全数式のキャッシュが参照値と一致し、月額変更が集計と利益・現金へ伝わる", async () => {
    const sheet = await restoredSheet(month, lastDay);
    expect(sheet.getCell(`A${lastDay + 2}`).value).toBe(lastDay);
    expect(sheet.getCell(`A${monthlyRow}`).value).toBeNull();
    expect(sheet.getCell(lower("A", 34)).value).toBe("平均");
    expect(sheet.getCell(lower("A", 35)).value).toBe("合計");
    expect(sheet.pageSetup.printArea).toBe(`A1:W${46 + offset}`);
    const original = formulaEvaluator(sheet);
    expect(original(lower("U", 37))).toBe(85500);
    expect(original(lower("V", 35))).toBe(94500);
    expect(original(lower("M", 38))).toBe(75300);
    expect(original(lower("D", 44))).toBe(191234);

    // 紹介料 +300 円、経費 +700 円。キャッシュを書き換えず参照だけで再計算する。
    sheet.getCell(`S${monthlyRow}`).value = 6800;
    sheet.getCell(`T${monthlyRow}`).value = 9700;
    const updated = formulaEvaluator(sheet);
    const expected = [
      [`V${monthlyRow}`, -16500],
      [lower("S", 35), 6800], [lower("S", 34), 3400],
      [lower("T", 35), 13700], [lower("T", 34), 6850],
      [lower("U", 37), 86500], [lower("V", 35), 93500], [lower("V", 34), 46750],
      [lower("M", 38), 74300], [lower("V", 38), 33500], [lower("V", 39), 93500],
      [lower("U", 43), 6800], [lower("U", 44), 50800],
    ] as const;
    for (const [address, amount] of expected) expect(updated(address), address).toBe(amount);
    for (const address of [lower("U", 34), lower("U", 35), lower("F", 40)]) {
      expect(updated(address), address).toBeCloseTo(13700 / 180000, 12);
    }
    // 月額を日別や給与へ配り直さない。人数平均・給与比・追加売上もそのまま。
    for (const address of [
      "V4", `V${lastDay + 2}`, lower("C", 35), lower("M", 35), lower("N", 35), lower("P", 35),
      lower("R", 35), lower("L", 34), lower("Q", 34), lower("F", 37), lower("M", 37),
      lower("W", 36), lower("U", 41), lower("D", 44),
    ]) expect(updated(address), address).toBe(original(address));
    expect(sheet.getCell(lower("V", 35)).result).toBe(94500);
  });

  it("カード入金の前期・後期のどちらを変更しても現状現金残高だけを増やす", async () => {
    const sheet = await restoredSheet(month, lastDay);
    const before = formulaEvaluator(sheet);
    const baseline = new Map(formulaCells(sheet).map((cell) => [cell.address, before(cell.address)]));
    for (const [column, amount, increase] of [["J", 40000, 40000], ["O", 20000, 60000]] as const) {
      const deposit = sheet.getCell(lower(column, 42));
      expect(deposit.protection.locked).toBe(false);
      deposit.value = amount;
      const updated = formulaEvaluator(sheet);
      for (const [address, previous] of baseline) {
        const expected = address === lower("M", 38) ? Number(previous) + increase : previous;
        expect(updated(address), `${column} 入金後の ${address}`).toBe(expected);
      }
    }
    expect(sheet.getCell(lower("M", 38)).result).toBe(75300);
  });
});
