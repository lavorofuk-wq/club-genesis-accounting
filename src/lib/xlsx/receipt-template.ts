import JSZip from "jszip";
import receiptLayouts from "./receipt-layouts.json";
import { addStatementAllowancePages, type StatementAllowance } from "./statement-allowance-pages";

export type ReceiptSheet = { template: "hourlyAndBack" | "salesReward"; name: string; cells: Record<string, string | number>; statementCells: Record<string, string | number>; statementAllowances?: StatementAllowance[] };
export type ReceiptDocument = "receipt" | "statement";
export const RECEIPT_TEMPLATE_URL = "/templates/cast-receipt-v3.xlsx";

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const layouts = {
  hourlyAndBack: { ...receiptLayouts.hourlyAndBack, nameCell: "G10", cells: new Set(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G10"]) },
  salesReward: { ...receiptLayouts.salesReward, nameCell: "G9", cells: new Set(["B2", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G9"]) },
} as const;
const statementCells = new Set(["D3", "F4", "E5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "B15", "F15", "F18", "F19", "F20", "F21", "F22", "F25", "F26"]);

/** 元様式のセル名から、個別帳票の行高を保持した出力行へ対応付ける。 */
export function receiptCellAddress(template: ReceiptSheet["template"], section: ReceiptDocument, address: string) {
  const layout = layouts[template];
  const match = /^([A-K])(\d+)$/.exec(address);
  if (!layout || !match) throw new Error("受領書・明細書の記入対象セルが正しくありません。");
  const row = (section === "receipt" ? layout.receiptRows : layout.statementRows)[Number(match[2]) - 1];
  if (!row) throw new Error("受領書・明細書の記入対象行が正しくありません。");
  return `${match[1]}${row}`;
}

/** 固定テンプレートから片方だけを残す。非表示や印刷範囲外に別帳票の値を残さない。 */
function separateTemplate(xml: string, kind: ReceiptSheet["template"], document: ReceiptDocument) {
  const layout = layouts[kind];
  const printArea = document === "receipt" ? layout.receiptPrintArea : layout.statementPrintArea;
  const lastRow = Number(printArea.match(/\$(\d+)$/)![1]);
  const offset = document === "receipt" ? 0 : layout.statementColumnOffset;
  const firstCol = offset + 1;
  const lastCol = document === "receipt" ? 8 : offset + 11;
  const colNumber = (col: string) => col.charCodeAt(0) - 64;
  const shiftCol = (col: string) => String.fromCharCode(col.charCodeAt(0) - offset);
  const inColumns = (col: string) => col.length === 1 && colNumber(col) >= firstCol && colNumber(col) <= lastCol;
  // この固定様式にない依存オブジェクトは、移動して壊す前に停止する。
  if (/<(?:f|drawing|hyperlinks|conditionalFormatting|dataValidations|tableParts)\b/.test(xml)) throw new Error("帳票テンプレートに分割できない項目があります。");
  xml = xml.replace(/<cols>[\s\S]*?<\/cols>/, (columns) => `<cols>${(columns.match(/<col\b[^>]*\/>/g) || []).flatMap((col) => {
    const min = Math.max(firstCol, Number(col.match(/\bmin="(\d+)"/)?.[1]));
    const max = Math.min(lastCol, Number(col.match(/\bmax="(\d+)"/)?.[1]));
    return min <= max ? [col.replace(/\bmin="\d+"/, `min="${min - offset}"`).replace(/\bmax="\d+"/, `max="${max - offset}"`)] : [];
  }).join("")}</cols>`);
  xml = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, (data) => `<sheetData>${(data.match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) || []).flatMap((row) => {
    const rowNumber = Number(row.match(/\br="(\d+)"/)?.[1]);
    if (!rowNumber || rowNumber > lastRow) return [];
    const cells = (row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).flatMap((cell) => {
      const address = cell.match(/\br="([A-Z]+)(\d+)"/);
      if (!address || !inColumns(address[1])) return [];
      return [cell.replace(/\br="[A-Z]+\d+"/, `r="${shiftCol(address[1])}${address[2]}"`)];
    });
    const start = row.match(/^<row\b[^>]*>/)![0].replace(/\s+spans="[^"]*"/g, "").replace(/\/>$/, ">");
    return [`${start}${cells.join("")}</row>`];
  }).join("")}</sheetData>`);
  xml = xml.replace(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/, (merges) => {
    const kept = [...merges.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"[^>]*\/>/g)].flatMap((match) => {
      const [, left, top, right, bottom] = match;
      if (!inColumns(left) && !inColumns(right)) return [];
      if (!inColumns(left) || !inColumns(right) || Number(bottom) > lastRow) throw new Error("帳票テンプレートの結合範囲が正しくありません。");
      return [`<mergeCell ref="${shiftCol(left)}${top}:${shiftCol(right)}${bottom}"/>`];
    });
    return kept.length ? `<mergeCells count="${kept.length}">${kept.join("")}</mergeCells>` : "";
  });
  return xml.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${printArea.replace(/\$/g, "")}"/>`)
    .replace(/<selection\b[^>]*\/>/g, '<selection activeCell="A1" sqref="A1"/>');
}

function escapeXml(value: string) {
  if (invalidXml.test(value) || /[\uD800-\uDFFF]/u.test(value)) throw new Error("キャスト名に使用できない文字が含まれています。");
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sheetNames(sheets: ReceiptSheet[]) {
  const used = new Set<string>();
  return sheets.map(({ name }) => {
    const base = name.replace(/[\\/*?:\[\]\u0000-\u001F]/g, " ").trim().replace(/^'+|'+$/g, "") || "キャスト";
    // UTF-16の途中でサロゲートペアを切らない。Excelの31文字制限と大文字小文字の同名判定に合わせる。
    const truncate = (value: string, max: number) => Array.from(value).reduce((text, char) => text.length + char.length <= max ? text + char : text, "").replace(/'+$/g, "");
    let suffix = "";
    let result = truncate(base, 31);
    for (let count = 2; used.has(result.toLowerCase()) || result.toLowerCase() === "history"; count += 1) {
      suffix = ` (${count})`;
      result = `${truncate(base, 31 - suffix.length)}${suffix}`;
    }
    used.add(result.toLowerCase());
    return result;
  });
}

async function readPart(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) throw new Error("受領書テンプレートを読み込めません。画面を更新して再度お試しください。");
  return file.async("string");
}

/** プリンター固有の用紙設定を失わないよう、固定テンプレートのOOXMLへ値だけを差し込む。 */
export async function fillReceiptTemplate(template: ArrayBuffer | Uint8Array, sheets: ReceiptSheet[], document: ReceiptDocument) {
  if (document !== "receipt" && document !== "statement") throw new Error("出力する帳票を選択してください。");
  if (!sheets.length) throw new Error("出力するキャスト報酬がありません。");
  const zip = await JSZip.loadAsync(template);
  // 出力中にsheet1/sheet2を上書きする前に、両様式とそれぞれのプリンター参照を退避する。
  const [sources, contentTypes, sharedStrings, sourceStyles] = await Promise.all([
    Promise.all([1, 2].map(async (index) => {
      const [sheet, rels] = await Promise.all([
        readPart(zip, `xl/worksheets/sheet${index}.xml`), readPart(zip, `xl/worksheets/_rels/sheet${index}.xml.rels`),
      ]);
      if (!zip.file(`xl/printerSettings/printerSettings${index}.bin`) || !sheet.includes('paperSize="281"')
        || !sheet.includes('fitToWidth="1"') || !sheet.includes('fitToHeight="1"') || !sheet.includes('fitToPage="1"')) {
        throw new Error("受領書テンプレートの印刷設定が正しくありません。");
      }
      return { sheet, rels };
    })), readPart(zip, "[Content_Types].xml"), readPart(zip, "xl/sharedStrings.xml"), readPart(zip, "xl/styles.xml"),
  ]);
  for (const index of [1, 2]) {
    zip.remove(`xl/worksheets/sheet${index}.xml`);
    zip.remove(`xl/worksheets/_rels/sheet${index}.xml.rels`);
  }
  const names = sheetNames(sheets);
  const originalXfs = sourceStyles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1];
  const styles = originalXfs?.match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g);
  const originalFonts = sourceStyles.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/)?.[1];
  const fonts = originalFonts?.match(/<font>[\s\S]*?<\/font>/g);
  if (!styles?.length || !fonts?.length) throw new Error("受領書テンプレートの書式を読み込めません。");
  const addedStyles: string[] = [];
  const addedFonts: string[] = [];
  const styleIds = new Map<string, number>();
  const decimalFormatId = Math.max(163, ...Array.from(sourceStyles.matchAll(/<numFmt\b[^>]*\bnumFmtId="(\d+)"/g), (match) => Number(match[1]))) + 1;
  function fittedStyle(id: number, decimal: boolean, nameSize?: number) {
    const key = `${id}:${nameSize || ""}:${decimal}`;
    const previous = styleIds.get(key);
    if (previous !== undefined) return previous;
    const original = styles![id];
    if (!original) throw new Error("受領書テンプレートのセル書式が正しくありません。");
    let fitted = original.replace(/<alignment\b([^>]*)\/>/, (_match, attrs: string) =>
      `<alignment${attrs.replace(/ shrinkToFit="[^"]*"/g, "")} shrinkToFit="1"/>`);
    // 旧確定値に端数がある場合も、表示を整数へ丸めて保存金額を隠さない。
    if (decimal) fitted = fitted.replace(/numFmtId="\d+"/, `numFmtId="${decimalFormatId}"`);
    else if (fitted.includes('numFmtId="176"')) fitted = fitted.replace('numFmtId="176"', 'numFmtId="3"');
    if (nameSize) {
      const fontId = Number(original.match(/fontId="(\d+)"/)?.[1]);
      const resized = fonts![fontId].replace(/<sz val="[^"]*"\/>/, `<sz val="${nameSize}"/>`);
      fitted = fitted.replace(/fontId="\d+"/, `fontId="${fonts!.length + addedFonts.length}"`);
      addedFonts.push(resized);
    }
    const next = styles!.length + addedStyles.length;
    addedStyles.push(fitted);
    styleIds.set(key, next);
    return next;
  }
  let stringReferences = 0;
  const printAreas: string[][] = [];
  function allowanceStyle(id: number, kind: "label" | "amount", plain: boolean, decimal = false) {
    const key = `allowance:${id}:${kind}:${plain}:${decimal}`;
    const previous = styleIds.get(key);
    if (previous !== undefined) return previous;
    let result = styles![id];
    if (!result) throw new Error("明細書テンプレートの手当書式が正しくありません。");
    if (plain) result = result.replace(/fillId="\d+"/, 'fillId="0"').replace(/borderId="\d+"/, 'borderId="0"');
    if (kind === "amount") result = result.replace(/numFmtId="\d+"/, `numFmtId="${decimal ? decimalFormatId : 3}"`);
    result = result.replace(/<alignment\b[^>]*\/>/, kind === "label"
      ? '<alignment horizontal="left" vertical="top" wrapText="1" shrinkToFit="0"/>'
      : '<alignment horizontal="right" vertical="center" shrinkToFit="1"/>');
    const next = styles!.length + addedStyles.length;
    addedStyles.push(result); styleIds.set(key, next);
    return next;
  }
  const sourceStrings = sharedStrings.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || [];
  const usedStrings = new Map<number, number>();
  sheets.forEach((sheet, index) => {
    const layout = layouts[sheet.template];
    if (!layout) throw new Error("受領書の報酬方式が正しくありません。");
    const source = sources[layout.source - 1];
    let xml = separateTemplate(source.sheet, sheet.template, document);
    const entries = Object.entries(document === "receipt" ? sheet.cells : sheet.statementCells)
      .map(([logical, value]) => ({ section: document, logical, value }));
    for (const { section, logical, value } of entries) {
      if (!(section === "receipt" ? layout.cells.has(logical) : statementCells.has(logical) || logical === "B11" && sheet.template === "salesReward")) throw new Error("受領書・明細書の記入対象セルが正しくありません。");
      const address = receiptCellAddress(sheet.template, section, logical);
      const pattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`, "g");
      let count = 0;
      xml = xml.replace(pattern, (_match, attributes: string) => {
        count += 1;
        const style = Number(attributes.match(/\bs="(\d+)"/)?.[1]);
        if (!Number.isInteger(style)) throw new Error("受領書のセル書式を読み込めません。");
        let attrs = attributes.replace(/\s+t="[^"]*"/g, "");
        // 結合セルの縮小表示に対応しないビューアでも名前が欠けないよう文字数に合わせる。
        const textWidth = section === "receipt" && logical === layout.nameCell ? 47
          : section === "statement" && logical === "F4" ? 62
          : section === "statement" && logical === "E5" ? 100
          : section === "statement" && logical === "F8" ? 88 : 0;
        const nameUnits = textWidth && typeof value === "string"
          ? Array.from(value).reduce((sum, char) => sum + (/^[\x20-\x7E]$/.test(char) ? .6 : 1), 0) : 0;
        const nameSize = nameUnits * 11 > textWidth ? Math.max(1, Math.floor(textWidth / nameUnits * 10) / 10) : undefined;
        attrs = attrs.replace(/\bs="\d+"/, `s="${fittedStyle(style, typeof value === "number" && !Number.isInteger(value), nameSize)}"`);
        if (typeof value === "number") {
          if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("受領書の金額が正しくありません。");
          return `<c${attrs}><v>${value}</v></c>`;
        }
        return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      });
      if (count !== 1) throw new Error("受領書テンプレートの記入欄を読み込めません。");
    }
    if (document === "statement" && sheet.statementAllowances !== undefined) {
      const result = addStatementAllowancePages(xml, layout, sheet.statementAllowances, allowanceStyle, (id) => {
        const fontId = Number(styles![id]?.match(/fontId="(\d+)"/)?.[1]);
        const size = Number(fonts![fontId]?.match(/<sz val="([\d.]+)"/)?.[1]);
        if (!Number.isFinite(size) || size <= 0) throw new Error("明細書テンプレートの文字サイズが正しくありません。");
        return size;
      });
      xml = result.xml; printAreas.push(result.printAreas);
    } else printAreas.push([document === "receipt" ? layout.receiptPrintArea : layout.statementPrintArea]);
    // コピーしたシートをグループ選択させず、Excelのシート識別子も重複させない。
    xml = xml.replace(/ xr:uid="[^"]*"/g, "");
    if (index > 0) xml = xml.replace(/ tabSelected="1"/g, "");
    xml = xml.replace(/<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<\/c>/g, (cell) => {
      const id = Number(cell.match(/<v>(\d+)<\/v>/)?.[1]);
      if (!sourceStrings[id]) throw new Error("帳票テンプレートの文字列が正しくありません。");
      if (!usedStrings.has(id)) usedStrings.set(id, usedStrings.size);
      stringReferences += 1;
      return cell.replace(/<v>\d+<\/v>/, `<v>${usedStrings.get(id)}</v>`);
    });
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, xml);
    zip.file(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, source.rels);
  });
  let outputStyles = sourceStyles.replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/,
    `<cellXfs count="${styles.length + addedStyles.length}">${originalXfs}${addedStyles.join("")}</cellXfs>`);
  outputStyles = outputStyles.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/,
    `<fonts count="${fonts.length + addedFonts.length}">${originalFonts}${addedFonts.join("")}</fonts>`);
  if ([...styleIds.keys()].some((key) => key.endsWith(":true"))) {
    const format = `<numFmt numFmtId="${decimalFormatId}" formatCode="#,##0.###############;[Red]-#,##0.###############;0"/>`;
    outputStyles = /<numFmts\b/.test(outputStyles)
      ? outputStyles.replace(/<numFmts\b[^>]*>([\s\S]*?)<\/numFmts>/, (_match, content: string) => `<numFmts count="${(content.match(/<numFmt\b/g) || []).length + 1}">${content}${format}</numFmts>`)
      : outputStyles.replace(/(<styleSheet\b[^>]*>)/, `$1<numFmts count="1">${format}</numFmts>`);
  }
  zip.file("xl/styles.xml", outputStyles);
  zip.file("xl/sharedStrings.xml", `${declaration}<sst xmlns="${spreadsheetNs}" count="${stringReferences}" uniqueCount="${usedStrings.size}">${[...usedStrings.keys()].map((id) => sourceStrings[id]).join("")}</sst>`);
  zip.file("xl/workbook.xml", `${declaration}<workbook xmlns="${spreadsheetNs}" xmlns:r="${relationshipNs}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="sheet${i + 1}"/>`).join("")}</sheets><definedNames>${names.map((name, i) => `<definedName name="_xlnm.Print_Area" localSheetId="${i}">${escapeXml(printAreas[i].map((area) => `'${name.replace(/'/g, "''")}'!${area}`).join(","))}</definedName>`).join("")}</definedNames></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `${declaration}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${relationshipNs}/styles" Target="styles.xml"/><Relationship Id="theme" Type="${relationshipNs}/theme" Target="theme/theme1.xml"/><Relationship Id="strings" Type="${relationshipNs}/sharedStrings" Target="sharedStrings.xml"/>${names.map((_, i) => `<Relationship Id="sheet${i + 1}" Type="${relationshipNs}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  zip.file("[Content_Types].xml", contentTypes.replace(/<Override\b[^>]*PartName="\/xl\/worksheets\/sheet\d+\.xml"[^>]*\/>/g, "")
    .replace("</Types>", `${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export function downloadReceiptFile(bytes: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // ダウンロード開始前にURLを破棄しない（iPad/Safariを含む）。
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
