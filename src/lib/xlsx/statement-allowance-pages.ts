export type StatementAllowance = { label: string; amount: number };
type Line = { label: string; amount?: number };
type Layout = { statementRows: readonly number[]; statementPrintArea: string };
type Style = (id: number, kind: "label" | "amount", plain: boolean, decimal?: boolean) => number;
const cellPattern = /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
const rowPattern = /<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g;
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/u;
const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 元の文字列を削らず、明示改行も残して固定行高の枠へ分割する。 */
export function statementAllowanceLines(label: string, capacity: number): string[] {
  const lines: string[] = [];
  let text = "", units = 0;
  for (const { segment } of new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(label)) {
    if (/^[\r\n]+$/.test(segment)) { lines.push(text + segment); text = ""; units = 0; continue; }
    const size = /[^\u0000-\uFFFF]/u.test(segment) ? 2 : 1;
    if (text && units + size > capacity) { lines.push(text); text = ""; units = 0; }
    text += segment; units += size;
  }
  if (text) lines.push(text);
  return lines.length ? lines : [""];
}

function cell(xml: string, address: string) {
  const result = (xml.match(cellPattern) || []).find((item) => item.match(/\br="([A-Z]+\d+)"/)?.[1] === address);
  if (!result) throw new Error("明細書テンプレートの手当欄を読み込めません。");
  return result;
}
function styleId(xml: string, address: string) {
  const id = Number(cell(xml, address).match(/\bs="(\d+)"/)?.[1]);
  if (!Number.isInteger(id)) throw new Error("明細書テンプレートの手当書式が正しくありません。");
  return id;
}
function replaceCell(xml: string, address: string, value: string | number | undefined, style?: number) {
  let count = 0;
  const result = xml.replace(cellPattern, (item) => {
    if (item.match(/\br="([A-Z]+\d+)"/)?.[1] !== address) return item;
    count += 1;
    let attrs = item.match(/^<c\b([^>]*?)(?:\/>|>)/)![1].replace(/\s+t="[^"]*"/g, "");
    if (style !== undefined) attrs = attrs.replace(/\bs="\d+"/, `s="${style}"`);
    if (value === undefined) return `<c${attrs}/>`;
    return typeof value === "number" ? `<c${attrs}><v>${value}</v></c>`
      : `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  });
  if (count !== 1) throw new Error("明細書テンプレートの手当欄が重複または欠損しています。");
  return result;
}
function sheetData(xml: string) { return xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/)![1]; }
function mergeRanges(xml: string) { return [...xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+:[A-Z]+\d+)"[^>]*\/>/g)].map((match) => match[1]); }
function withMerges(xml: string, ranges: string[]) {
  return xml.replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/, `<mergeCells count="${ranges.length}">${ranges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`);
}
const offsetAddress = (value: string, offset: number) => value.replace(/([A-Z]+)(\d+)/g, (_match, col: string, row: string) => col + (Number(row) + offset));

/** 1頁目の寸法と印刷設定には触れず、同寸法の離散印刷領域だけを足す。 */
export function addStatementAllowancePages(xml: string, layout: Layout, allowances: StatementAllowance[], style: Style, fontSize: (id: number) => number) {
  if (!Array.isArray(allowances) || allowances.some((item) => !item || typeof item.label !== "string"
    || !item.label.trim() || item.label.length > 100 || invalidXml.test(item.label)
    || !Number.isFinite(item.amount) || item.amount < 0 || item.amount > Number.MAX_SAFE_INTEGER)) {
    throw new Error("明細書の手当名目・金額が正しくありません。");
  }
  const row = (logical: number) => layout.statementRows[logical - 1];
  const address = (col: string, logical: number) => col + row(logical);
  const labelStyle = styleId(xml, address("B", 16));
  const amountStyle = styleId(xml, address("F", 16));
  const labelWidth = [2, 3, 4, 5].reduce((sum, column) => {
    const spec = (xml.match(/<col\b[^>]*\/>/g) || []).find((col) => Number(col.match(/\bmin="(\d+)"/)?.[1]) <= column && Number(col.match(/\bmax="(\d+)"/)?.[1]) >= column);
    const width = Number(spec?.match(/\bwidth="([\d.]+)"/)?.[1]);
    if (!Number.isFinite(width)) throw new Error("明細書テンプレートの列幅を確認できません。");
    return sum + Math.floor((256 * width + Math.floor(128 / 7)) / 256 * 7) * .75;
  }, 0);
  const capacity = Math.max(1, Math.floor((labelWidth - 6) / fontSize(labelStyle)));
  const items: Line[][] = allowances.map(({ label, amount }) => statementAllowanceLines(label, capacity)
    .map((line, index) => ({ label: line, ...(index === 0 ? { amount } : {}) })));
  const pages: Line[][] = [[]];
  let page = 0;
  for (const item of items) {
    const limit = page === 0 ? 2 : 20;
    if (pages[page].length + item.length > limit) { pages.push([]); page += 1; }
    // 改行が多い1名目も省略せず有限個の続き頁へ分ける。
    for (const line of item) {
      if (pages[page].length === (page === 0 ? 2 : 20)) { pages.push([]); page += 1; }
      pages[page].push(line);
    }
  }
  const pageRows = Number(layout.statementPrintArea.match(/\$(\d+)$/)![1]);
  if (pages.length * (pageRows + 1) - 1 > 1048576) throw new Error("明細書の手当件数がExcelの行数上限を超えています。");
  const original = xml;
  const put = (source: string, logical: number, value?: Line, plain = false) => {
    source = replaceCell(source, address("B", logical), value?.label, style(labelStyle, "label", plain));
    source = replaceCell(source, address("F", logical), value?.amount, style(amountStyle, "amount", plain, value?.amount !== undefined && !Number.isInteger(value.amount)));
    // 1頁目の単位欄は元の書式（右罫線を含む）を保持する。
    return replaceCell(source, address("J", logical), value?.amount !== undefined ? "円" : undefined, plain ? style(labelStyle, "label", true) : undefined);
  };
  xml = put(put(xml, 16, pages[0][0]), 17, pages[0][1]);
  if (pages.length === 1) return { xml, printAreas: [layout.statementPrintArea] };

  // 続き頁の本人・月の見出しだけを残し、給与・控除などの数値とラベルは再転記しない。
  let continuation = original.replace(cellPattern, (item) => {
    const match = item.match(/\br="([A-Z]+)(\d+)"/)!;
    const r = Number(match[2]);
    if (r < row(6) || r >= row(28)) return item;
    return `<c r="${match[1]}${r}" s="${style(labelStyle, "label", true)}"/>`;
  });
  let continuationMerges = mergeRanges(continuation).filter((range) => {
    const [top, bottom] = range.match(/\d+/g)!.map(Number);
    return bottom < row(6) || top >= row(28);
  });
  for (let logical = 6; logical <= 26; logical += 1) {
    const top = row(logical), bottom = row(logical + 1) - 1;
    continuationMerges.push(`B${top}:E${bottom}`, `F${top}:I${bottom}`);
    // 元の物理行が細分化されている段でも単位を論理行全体の高さで表示する。
    if (bottom > top) continuationMerges.push(`J${top}:J${bottom}`);
  }
  continuationMerges.push(`B${row(27)}:J${row(27)}`);
  continuation = withMerges(continuation, continuationMerges);
  continuation = replaceCell(continuation, address("B", 2), "手当明細書");
  continuation = put(continuation, 6, { label: "手当名目" }, true);
  continuation = replaceCell(continuation, address("F", 6), "月合計", style(labelStyle, "label", true));
  const mainMerges = [...mergeRanges(xml), `B${row(27)}:J${row(27)}`];
  xml = withMerges(xml, mainMerges);
  xml = replaceCell(xml, address("B", 27), `手当明細は次頁へ  1/${pages.length}`, style(labelStyle, "label", true));
  const dataParts = [sheetData(xml)], ranges = [...mainMerges], printAreas = [layout.statementPrintArea];
  for (let i = 1; i < pages.length; i += 1) {
    let next = continuation;
    for (let logical = 7; logical <= 26; logical += 1) next = put(next, logical, pages[i][logical - 7], true);
    next = replaceCell(next, address("B", 27), `${i + 1}/${pages.length}`, style(labelStyle, "label", true));
    const offset = i * (pageRows + 1);
    dataParts.push(sheetData(next).replace(rowPattern, (entry) => entry
      .replace(/\br="(\d+)"/, (_match, n: string) => `r="${Number(n) + offset}"`)
      .replace(/\br="([A-Z]+\d+)"/g, (_match, value: string) => `r="${offsetAddress(value, offset)}"`)));
    ranges.push(...continuationMerges.map((range) => offsetAddress(range, offset)));
    printAreas.push(`$A$${offset + 1}:$K$${offset + pageRows}`);
  }
  xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${dataParts.join("")}</sheetData>`);
  xml = withMerges(xml, ranges).replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:K${(pages.length - 1) * (pageRows + 1) + pageRows}"/>`);
  return { xml, printAreas };
}
