import JSZip from "jszip";

export type ReceiptSheet = { name: string; cells: Record<string, string | number> };
export const RECEIPT_TEMPLATE_URL = "/templates/cast-receipt-v1.xlsx";

const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;
const editableCells = new Set(["B2", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G10"]);

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
export async function fillReceiptTemplate(template: ArrayBuffer | Uint8Array, sheets: ReceiptSheet[]) {
  if (!sheets.length) throw new Error("出力するキャスト報酬がありません。");
  const zip = await JSZip.loadAsync(template);
  const [sourceSheet, sheetRels, contentTypes, sharedStrings, sourceStyles] = await Promise.all([
    readPart(zip, "xl/worksheets/sheet1.xml"), readPart(zip, "xl/worksheets/_rels/sheet1.xml.rels"),
    readPart(zip, "[Content_Types].xml"), readPart(zip, "xl/sharedStrings.xml"), readPart(zip, "xl/styles.xml"),
  ]);
  if (!zip.file("xl/printerSettings/printerSettings1.bin") || !sourceSheet.includes('paperSize="281"')) {
    throw new Error("受領書テンプレートの印刷設定が正しくありません。");
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
  function fittedStyle(id: number, decimal: boolean, nameSize?: number) {
    const key = `${id}:${nameSize || ""}:${decimal}`;
    const previous = styleIds.get(key);
    if (previous !== undefined) return previous;
    const original = styles![id];
    if (!original) throw new Error("受領書テンプレートのセル書式が正しくありません。");
    let fitted = original.replace(/<alignment\b([^>]*)\/>/, (_match, attrs: string) =>
      `<alignment${attrs.replace(/ shrinkToFit="[^"]*"/g, "")} shrinkToFit="1"/>`);
    // 旧確定値に端数がある場合も、表示を整数へ丸めて保存金額を隠さない。
    if (decimal) fitted = fitted.replace(/numFmtId="\d+"/, 'numFmtId="164"');
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
  sheets.forEach((sheet, index) => {
    let xml = sourceSheet;
    for (const [address, value] of Object.entries(sheet.cells)) {
      if (!editableCells.has(address)) throw new Error("受領書の記入対象セルが正しくありません。");
      const pattern = new RegExp(`<c\\b([^>]*\\br="${address}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`, "g");
      let count = 0;
      xml = xml.replace(pattern, (_match, attributes: string) => {
        count += 1;
        const style = Number(attributes.match(/\bs="(\d+)"/)?.[1]);
        if (!Number.isInteger(style)) throw new Error("受領書のセル書式を読み込めません。");
        // B2の長い見出しは空のC:Fへ表示するため、縮小しない。
        let attrs = attributes.replace(/\s+t="[^"]*"/g, "");
        // 結合セルの縮小表示に対応しないビューアでも名前が欠けないよう文字数に合わせる。
        const nameUnits = address === "G10" && typeof value === "string"
          ? Array.from(value).reduce((sum, char) => sum + (/^[\x20-\x7E]$/.test(char) ? .6 : 1), 0) : 0;
        const nameSize = nameUnits > 4.3 ? Math.max(1, Math.floor(47 / nameUnits * 10) / 10) : undefined;
        if (address !== "B2") attrs = attrs.replace(/\bs="\d+"/, `s="${fittedStyle(style, typeof value === "number" && !Number.isInteger(value), nameSize)}"`);
        if (typeof value === "number") {
          if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("受領書の金額が正しくありません。");
          return `<c${attrs}><v>${value}</v></c>`;
        }
        return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
      });
      if (count !== 1) throw new Error("受領書テンプレートの記入欄を読み込めません。");
    }
    // コピーしたシートをグループ選択させず、Excelのシート識別子も重複させない。
    xml = xml.replace(/ xr:uid="[^"]*"/g, "");
    if (index > 0) xml = xml.replace(/ tabSelected="1"/g, "");
    stringReferences += (xml.match(/<c\b[^>]*\bt="s"/g) || []).length;
    zip.file(`xl/worksheets/sheet${index + 1}.xml`, xml);
    zip.file(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, sheetRels);
  });
  let outputStyles = sourceStyles.replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/,
    `<cellXfs count="${styles.length + addedStyles.length}">${originalXfs}${addedStyles.join("")}</cellXfs>`);
  outputStyles = outputStyles.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/,
    `<fonts count="${fonts.length + addedFonts.length}">${originalFonts}${addedFonts.join("")}</fonts>`);
  if ([...styleIds.keys()].some((key) => key.endsWith(":true"))) {
    outputStyles = outputStyles.replace(/(<styleSheet\b[^>]*>)/,
      '$1<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.###############;[Red]-#,##0.###############;0"/></numFmts>');
  }
  zip.file("xl/styles.xml", outputStyles);
  zip.file("xl/sharedStrings.xml", sharedStrings.replace(/(<sst\b[^>]*\bcount=")\d+("[^>]*>)/, `$1${stringReferences}$2`));
  zip.file("xl/workbook.xml", `${declaration}<workbook xmlns="${spreadsheetNs}" xmlns:r="${relationshipNs}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((name, i) => `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="sheet${i + 1}"/>`).join("")}</sheets><definedNames>${names.map((name, i) => `<definedName name="_xlnm.Print_Area" localSheetId="${i}">${escapeXml(`'${name.replace(/'/g, "''")}'!$A$1:$H$18`)}</definedName>`).join("")}</definedNames></workbook>`);
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
