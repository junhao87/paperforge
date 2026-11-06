import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Preserve the exact bounding boxes from the real scanned rent-offer sample:
// 'as stakeholder.' is on the left while 'Pay to landlord' is far right.
const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const ocr = src.slice(src.indexOf('function mergeOcrWordsIntoLines'), src.indexOf('function highContrastOcrCanvas'));
const tsv = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t13\t1\t3\t2\t298\t632\t25\t17\t96\tas',
  '5\t1\t13\t1\t3\t3\t332\t625\t153\t25\t95\tstakeholder.',
  '5\t1\t13\t1\t3\t4\t1149\t633\t58\t34\t96\tPay',
  '5\t1\t13\t1\t3\t5\t1218\t633\t22\t30\t95\tto',
  '5\t1\t13\t1\t3\t6\t1258\t633\t122\t27\t96\tlandlord',
].join('\n');
const context = { DOMParser: class {} };
vm.runInNewContext(`${ocr}\nthis.ocrBoxes = ocrBoxes;`, context);
const result = context.ocrBoxes({ data: { tsv } });
assert.equal(result.length, 2, 'Unrelated text regions on one OCR line must be separate edit targets');
assert.match(result[0].text, /stakeholder/);
assert.match(result[1].text, /Pay to landlord/);
assert.ok(result[0].x + result[0].w < result[1].x);

const blocks = { blocks: [{ paragraphs: [{ lines: [{ words: [
  { text: 'as', bbox: { x0: 298, y0: 632, x1: 323, y1: 649 } },
  { text: 'stakeholder.', bbox: { x0: 332, y0: 625, x1: 485, y1: 650 } },
  { text: 'Pay', bbox: { x0: 1149, y0: 633, x1: 1207, y1: 667 } },
  { text: 'to', bbox: { x0: 1218, y0: 633, x1: 1240, y1: 663 } },
  { text: 'landlord', bbox: { x0: 1258, y0: 633, x1: 1380, y1: 660 } },
] }] }] }] };
assert.equal(context.ocrBoxes({ data: blocks }).length, 2,
  'Tesseract blocks should resolve to individual words, not parent-line rectangles');

const native = src.slice(src.indexOf('function nativeTextBoxes'), src.indexOf('async function ocrVisiblePage'));
const nativeContext = {
  pdfjsLib: { Util: { transform: (_vp, itemTransform) => itemTransform } },
};
vm.runInNewContext(`${native}\nthis.nativeTextBoxes = nativeTextBoxes;`, nativeContext);
const digital = nativeContext.nativeTextBoxes({ getViewport: () => ({ transform: [] }) }, {
  styles: {},
  items: [
    { str: 'as stakeholder.', transform: [10, 0, 0, 10, 40, 300], width: 90, fontName: 'F1' },
    { str: 'Pay to landlord', transform: [10, 0, 0, 10, 410, 300], width: 100, fontName: 'F2' },
  ],
});
assert.equal(digital.length, 2, 'Separate native PDF text items must not merge into one field');
assert.equal(digital[1].text, 'Pay to landlord');
assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /id="progressOverlay"/);
assert.doesNotMatch(src.slice(src.indexOf('async function renderDocxToPdf'),
  src.indexOf('async function wordToPdf')), /left:-15000px/);
console.log('OCR bounding-box regression checks passed');
