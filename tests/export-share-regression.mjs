import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = app.indexOf('function fileMimeType(');
const end = app.indexOf('function busy(', start);
assert.ok(start !== -1 && end > start, 'export helper functions exist');

const elements = new Map();
const getElement = (id) => {
  if (!elements.has(id)) {
    const classes = new Set(['hidden']);
    elements.set(id, {
      textContent: '',
      focus() { this.focused = true; },
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); },
        contains(value) { return classes.has(value); },
      },
    });
  }
  return elements.get(id);
};

class TestFile extends Blob {
  constructor(parts, name, options) {
    super(parts, options);
    this.name = name;
  }
}

const downloaded = [];
let shared = null;
let canShare = true;
const navigatorMock = {
  canShare({ files }) { return canShare && files.length === 1 && files[0] instanceof TestFile; },
  share(payload) { shared = payload; return Promise.resolve(); },
};
const context = {
  state: { lastExport: null },
  $: getElement,
  Blob,
  File: TestFile,
  navigator: navigatorMock,
  formatBytes: (n) => `${n} bytes`,
  setTimeout: () => 0,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  document: {
    body: { append() {} },
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        download: '', href: '',
        click() { downloaded.push(this.download); },
        remove() {},
      };
    },
  },
};
runInNewContext(`${app.slice(start, end)}\nthis.exports = {downloadBlob, shareExportFile, closeExportComplete};`, context);
const { downloadBlob, shareExportFile, closeExportComplete } = context.exports;

const pdf = new Blob(['example-pdf'], { type: 'application/pdf' });
downloadBlob(pdf, 'contract_edited.pdf');
assert.deepEqual(downloaded, ['contract_edited.pdf']);
assert.equal(context.state.lastExport.fileName, 'contract_edited.pdf');
assert.equal(getElement('exportCompleteOverlay').classList.contains('hidden'), false);
assert.equal(getElement('exportCompleteFileMeta').textContent, 'PDF 文档 · 11 bytes');

shareExportFile('WhatsApp');
assert.equal(shared.files[0].name, 'contract_edited.pdf');
assert.equal(shared.files[0].type, 'application/pdf');

const docx = new Blob(['example-word'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
downloadBlob(docx, 'contract_固定版式可编辑.docx');
assert.equal(context.state.lastExport.fileName, 'contract_固定版式可编辑.docx');
assert.equal(getElement('exportCompleteFileMeta').textContent, 'Word 文档 · 12 bytes');
shareExportFile('Telegram');
assert.equal(shared.files[0].type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

downloadBlob(docx, 'contract_固定版式可编辑.docx', { showCompletion: false });
assert.equal(downloaded.length, 3, 'repeat download does not create another export');

canShare = false;
shareExportFile('微信');
assert.equal(getElement('exportShareStatus').classList.contains('hidden'), false);
assert.match(getElement('exportShareStatus').textContent, /附加文件/);
closeExportComplete();
assert.equal(getElement('exportCompleteOverlay').classList.contains('hidden'), true);

console.log('Export completion and file-sharing regression: passed');
