import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const start = source.indexOf('function textPropertiesFromInputs()');
const end = source.indexOf('function snapshot()', start);
assert.ok(start >= 0 && end > start, 'live preview helpers must exist');

const values = {
  editText: { value: 'effective from 1/01/2027 to 31/12/2060' },
  fontSize: { value: '11.5' },
  fontFamily: { value: 'Arial' },
  fontColor: { value: '#111111' },
  backgroundColor: { value: '#ffffff' },
  fontBold: { checked: false },
  fontItalic: { checked: false },
};
const state = { selected: { kind: 'hit', fromOcr: true, page: 0, x: 14, y: 25,
  width: 180, height: 15, text: 'old text' }, patchList: [], preview: null, busy: false };
let renderCount = 0;
const context = { state, $: (id) => values[id], clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  renderPatches: () => { renderCount++; } };
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

vm.runInContext('updateLivePreview()', context);
assert.equal(state.preview.text, values.editText.value);
assert.equal(state.preview.id, '__live_preview');
assert.equal(state.preview.kind, 'replace');
assert.equal(state.patchList.length, 0, 'typing must not commit an edit');

state.patchList = [{ id: 'existing', kind: 'replace', page: 0, x: 14, y: 25,
  width: 180, height: 15, text: 'original replacement' }];
state.selected = { kind: 'patch', id: 'existing' };
values.editText.value = 'new replacement';
vm.runInContext('updateLivePreview()', context);
assert.equal(state.preview.id, 'existing');
assert.equal(state.preview.text, 'new replacement');
assert.equal(state.patchList[0].text, 'original replacement');
assert.equal(renderCount, 2);
console.log('Live text preview regression checks passed');
