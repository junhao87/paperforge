import * as pdfjsLib from './vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
const $ = (id) => document.getElementById(id);
const PAGE_SCALE = 1.27;
const pdfAssetOptions = {
  cMapUrl: new URL('./vendor/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('./vendor/standard_fonts/', import.meta.url).href,
  wasmUrl: new URL('./vendor/wasm/', import.meta.url).href,
};

const state = {
  name: '', bytes: null, pdf: null, textPages: [], patchList: [], undoStack: [],
  selected: null, tool: 'edit', zoom: 1, renderId: 0, view: 'home',
  converter: 'pdf-word', busy: false,
};

const formatBytes = (n) => n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const svg = (name) => `<svg><use href="#ic-${name}"/></svg>`;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const clone = (o) => JSON.parse(JSON.stringify(o));
const safeFileName = (name) => name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
const newId = () => globalThis.crypto?.randomUUID?.() || `patch_${Date.now()}_${Math.random().toString(36).slice(2)}`;

let toastTimer;
function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.classList.remove('hidden');
  element.classList.toggle('error', error);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add('hidden'), error ? 6500 : 3600);
}

function downloadBlob(data, fileName) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function busy(value, message = '') {
  state.busy = value;
  document.querySelectorAll('button').forEach((button) => {
    if (button.dataset.busyLock === '1') button.disabled = value;
  });
  if (message) toast(message);
  $('topExport').disabled = !state.pdf || value;
  $('editorExport').disabled = !state.pdf || value;
}

function view(name) {
  state.view = name;
  $('welcome').classList.toggle('hidden', name !== 'home');
  $('editor').classList.toggle('hidden', name !== 'editor');
  $('converter').classList.toggle('hidden', name !== 'converter');
  $('breadcrumb').textContent = name === 'editor' ? 'PDF 编辑器' : name === 'converter' ? (state.converter === 'pdf-word' ? 'PDF 转 Word' : 'Word 转 PDF') : 'PDF 编辑器';
  for (const id of ['navEditor', 'navPdfWord', 'navWordPdf', 'navUrl']) $(id).classList.remove('active');
  $(name === 'converter' ? (state.converter === 'pdf-word' ? 'navPdfWord' : 'navWordPdf') : 'navEditor').classList.add('active');
}

function openFilePicker(type = 'pdf') {
  (type === 'docx' ? $('wordInput') : type === 'pdf-convert' ? $('convertPdfInput') : $('fileInput')).click();
}

function configureConverter(kind) {
  state.converter = kind;
  const isPdf = kind === 'pdf-word';
  $('converterTitle').textContent = isPdf ? 'PDF 转 Word' : 'Word 转 PDF';
  $('converterDescription').textContent = isPdf ? '提取 PDF 中的文字，生成可编辑的 Word 文档。' : '把 DOCX 的段落文字转换成 PDF，适合简单文档。';
  $('convertDropTitle').textContent = isPdf ? '上传 PDF 文件' : '上传 Word 文件';
  $('convertHelp').textContent = isPdf ? '支持可选择文字的 PDF · 不含 OCR' : '支持 .docx · 保留段落与基本标题';
  $('converterNotice').textContent = isPdf ? '这是文字提取，不是逐像素还原：多栏、表格、图片、扫描文字可能丢失或错位。' : '纯浏览器转换支持简单 DOCX。复杂表格、页眉页脚、图片及原始 Word 字体不会完整保留；专业级排版建议使用 LibreOffice 后端。';
  view('converter');
}

async function openPdf(bytes, name) {
  if (bytes.byteLength > 60 * 1024 * 1024) throw new Error('当前 Beta 推荐使用小于 60MB 的 PDF。');
  const raw = new Uint8Array(bytes);
  const loadingTask = pdfjsLib.getDocument({ data: raw.slice(), useSystemFonts: true, ...pdfAssetOptions });
  const pdf = await loadingTask.promise;
  state.bytes = raw;
  state.pdf = pdf;
  state.name = name;
  state.patchList = [];
  state.undoStack = [];
  state.selected = null;
  state.textPages = [];
  state.zoom = 1;
  $('zoomValue').textContent = '100%';
  $('currentDocument').innerHTML = `<div class="doc-icon">${svg('file')}</div><div><strong title="${escapeAttr(name)}">${escapeHtml(name)}</strong><small>${pdf.numPages} 页 · ${formatBytes(raw.byteLength)}</small></div>`;
  $('pageCount').textContent = `${pdf.numPages} 页`;
  $('thumbCount').textContent = pdf.numPages;
  $('topExport').disabled = false;
  $('editorExport').disabled = false;
  view('editor');
  clearSelection();
  await renderPages();
  toast(`已打开 ${name} · 共 ${pdf.numPages} 页`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (v) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[v]));
}
const escapeAttr = escapeHtml;

async function loadPdfFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') return toast('请选择 PDF 文件。', true);
  try {
    busy(true, '正在读取并渲染 PDF…');
    await openPdf(await file.arrayBuffer(), file.name);
  } catch (error) {
    console.error(error);
    toast(`无法打开 PDF：${error.message || '文件损坏或加密'}`, true);
  } finally { busy(false); }
}

async function loadPdfUrl() {
  const url = $('urlInput').value.trim();
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('只支持 http / https 地址');
    $('modalOverlay').classList.add('hidden');
    busy(true, '正在获取 PDF URL…');
    const response = await fetch(parsed.toString());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    let name = decodeURIComponent(parsed.pathname.split('/').pop() || 'remote.pdf');
    if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
    await openPdf(data, name);
  } catch (error) {
    console.error(error);
    toast(`URL 打开失败：${error.message}。如果是跨域限制（CORS），请先下载文件再上传。`, true);
  } finally { busy(false); }
}

async function renderPages() {
  if (!state.pdf) return;
  const renderId = ++state.renderId;
  $('pageStack').replaceChildren();
  $('thumbs').replaceChildren();
  let foundText = 0;
  for (let index = 0; index < state.pdf.numPages; index++) {
    if (renderId !== state.renderId) return;
    const page = await state.pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: PAGE_SCALE * state.zoom });
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrap' + (state.tool === 'add' ? ' adding' : '');
    wrapper.dataset.page = index;
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(viewport.width * pixelRatio);
    canvas.height = Math.round(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrapper.append(canvas);
    const hitLayer = document.createElement('div');
    hitLayer.className = 'hit-layer';
    const patchLayer = document.createElement('div');
    patchLayer.className = 'patch-layer';
    wrapper.append(hitLayer, patchLayer);
    const indexLabel = document.createElement('div');
    indexLabel.className = 'page-index';
    indexLabel.textContent = `${index + 1} / ${state.pdf.numPages}`;
    wrapper.append(indexLabel);
    $('pageStack').append(wrapper);

    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, canvas, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] }).promise;
    if (renderId !== state.renderId) return;
    let textContent;
    try { textContent = await page.getTextContent(); } catch { textContent = { items: [], styles: {} }; }
    state.textPages[index] = textContent;
    const scale = PAGE_SCALE * state.zoom;
    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;
      foundText++;
      const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(matrix[2], matrix[3]);
      const style = textContent.styles[item.fontName] || {};
      const ascent = typeof style.ascent === 'number' ? style.ascent * fontHeight : fontHeight * .82;
      const x = matrix[4];
      const y = matrix[5] - ascent;
      const width = Math.max(4, (item.width || item.str.length * 5) * scale);
      const height = Math.max(5, fontHeight * 1.18);
      const hit = document.createElement('div');
      hit.className = 'text-hit';
      hit.title = `编辑：${item.str}`;
      hit.style.left = `${x}px`;
      hit.style.top = `${y}px`;
      hit.style.width = `${width}px`;
      hit.style.height = `${height}px`;
      const fontFamily = style.fontFamily || '';
      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        selectHit({ page: index, x: x / scale, y: y / scale, width: width / scale, height: height / scale, text: item.str, fontSize: fontHeight / scale, fontFamily, kind: 'hit' });
      });
      hitLayer.append(hit);
    }
    wrapper.addEventListener('click', (event) => {
      if (state.tool !== 'add') return;
      const rect = wrapper.getBoundingClientRect();
      const x = clamp((event.clientX - rect.left) / scale, 0, viewport.width / scale - 5);
      const y = clamp((event.clientY - rect.top) / scale, 0, viewport.height / scale - 10);
      snapshot();
      const patch = { id: newId(), kind: 'add', page: index, x, y, width: 95, height: 20, text: '输入新文字', fontSize: 14, fontFamily: 'Arial, "Noto Sans SC", sans-serif', color: '#242c3c', background: '#ffffff' };
      state.patchList.push(patch);
      selectPatch(patch.id);
      renderPatches();
      $('editText').focus();
      $('editText').select();
      setTool('edit');
    });
    if (index < 90) makeThumbnail(canvas, index);
    renderPatchesForPage(index);
    if (index % 5 === 4) await wait(0);
  }
  $('emptyTextWarning').classList.toggle('hidden', foundText > 0);
}

function makeThumbnail(pageCanvas, index) {
  const thumbCanvas = document.createElement('canvas');
  const thumbScale = Math.min(1, 112 / pageCanvas.width);
  thumbCanvas.width = Math.max(1, Math.round(pageCanvas.width * thumbScale));
  thumbCanvas.height = Math.max(1, Math.round(pageCanvas.height * thumbScale));
  thumbCanvas.getContext('2d').drawImage(pageCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const button = document.createElement('button');
  button.className = 'thumb-item' + (index === 0 ? ' active' : '');
  button.append(thumbCanvas, document.createTextNode(`第 ${index + 1} 页`));
  button.addEventListener('click', () => {
    document.querySelectorAll('.thumb-item').forEach((el) => el.classList.remove('active'));
    button.classList.add('active');
    document.querySelector(`.page-wrap[data-page="${index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('thumbs').append(button);
}

function setTool(tool) {
  state.tool = tool;
  $('selectTool').classList.toggle('selected', tool === 'edit');
  $('addTool').classList.toggle('selected', tool === 'add');
  document.querySelectorAll('.page-wrap').forEach((el) => el.classList.toggle('adding', tool === 'add'));
  $('editorHint').textContent = tool === 'add' ? '现在点击 PDF 空白位置，即可添加文字' : '点击 PDF 上的文字即可修改 · 选择「添加文字」后点击页面可插入新文字';
}

function familyForPdf(name = '') {
  return /Times|Serif|Song|Ming/i.test(name) ? 'Georgia, "Noto Serif SC", serif' : /Courier|Mono/i.test(name) ? '"Courier New", monospace' : 'Arial, "Noto Sans SC", sans-serif';
}

function selectHit(hit) {
  state.selected = hit;
  showProperties({ ...hit, fontFamily: familyForPdf(hit.fontFamily), color: '#222222', background: '#ffffff' });
  $('propertyStatus').textContent = '原有文字';
  $('deleteEdit').classList.add('hidden');
}

function selectPatch(id) {
  const patch = state.patchList.find((item) => item.id === id);
  if (!patch) return;
  state.selected = { kind: 'patch', id };
  showProperties(patch);
  $('propertyStatus').textContent = patch.kind === 'replace' ? '文字替换' : '新增文字';
  $('deleteEdit').classList.remove('hidden');
  document.querySelectorAll('.patch-item').forEach((node) => node.classList.toggle('active', node.dataset.patch === id));
}

function clearSelection() {
  state.selected = null;
  $('noSelection').classList.remove('hidden');
  $('propertiesForm').classList.add('hidden');
  $('propertyStatus').textContent = '无选中项目';
  document.querySelectorAll('.patch-item.active').forEach((node) => node.classList.remove('active'));
}

function showProperties(item) {
  $('noSelection').classList.add('hidden');
  $('propertiesForm').classList.remove('hidden');
  $('editText').value = item.text;
  $('fontSize').value = (item.fontSize || 12).toFixed(1).replace(/\.0$/, '');
  $('fontFamily').value = item.fontFamily || 'Arial, "Noto Sans SC", sans-serif';
  if (!$('fontFamily').value) $('fontFamily').selectedIndex = 0;
  $('fontColor').value = item.color || '#222222';
  $('backgroundColor').value = item.background || '#ffffff';
  $('matchNote').textContent = item.kind === 'hit' || item.kind === 'replace' ? '通过遮盖原文字并绘制新字来保留页面其它内容。特殊字体、复杂背景不会完全一致。' : '可在页面上拖动文字位置。导出时新文字将绘制到 PDF 内。';
}

function snapshot() {
  state.undoStack.push(clone(state.patchList));
  if (state.undoStack.length > 25) state.undoStack.shift();
  $('undoTool').disabled = false;
}

function applyEdit() {
  if (!state.selected) return;
  const text = $('editText').value;
  const fontSize = clamp(Number($('fontSize').value) || 12, 5, 96);
  const props = { text, fontSize, fontFamily: $('fontFamily').value, color: $('fontColor').value, background: $('backgroundColor').value };
  if (!text.trim()) return toast('请输入要显示的文字。', true);
  snapshot();
  if (state.selected.kind === 'patch') {
    const patch = state.patchList.find((p) => p.id === state.selected.id);
    if (patch) Object.assign(patch, props);
  } else {
    const patch = { ...state.selected, ...props, kind: 'replace', id: newId() };
    state.patchList.push(patch);
    state.selected = { kind: 'patch', id: patch.id };
  }
  renderPatches();
  if (state.selected.kind === 'patch') selectPatch(state.selected.id);
  toast('修改已应用。点击「保存 PDF」导出文件。');
}

function deleteSelectedPatch() {
  if (state.selected?.kind !== 'patch') return;
  snapshot();
  state.patchList = state.patchList.filter((p) => p.id !== state.selected.id);
  clearSelection();
  renderPatches();
  toast('已移除该编辑');
}

function undo() {
  if (!state.undoStack.length) return;
  state.patchList = state.undoStack.pop();
  $('undoTool').disabled = state.undoStack.length === 0;
  clearSelection();
  renderPatches();
  toast('已撤销上一步');
}

function renderPatches() {
  document.querySelectorAll('.page-wrap').forEach((wrap) => renderPatchesForPage(Number(wrap.dataset.page)));
}

function renderPatchesForPage(pageIndex) {
  const wrap = document.querySelector(`.page-wrap[data-page="${pageIndex}"]`);
  if (!wrap) return;
  const layer = wrap.querySelector('.patch-layer');
  layer.replaceChildren();
  const scale = PAGE_SCALE * state.zoom;
  for (const patch of state.patchList.filter((p) => p.page === pageIndex)) {
    const el = document.createElement('div');
    el.className = 'patch-item';
    if (state.selected?.id === patch.id) el.classList.add('active');
    el.dataset.patch = patch.id;
    el.style.left = `${patch.x * scale}px`;
    el.style.top = `${patch.y * scale}px`;
    el.style.minWidth = `${patch.kind === 'replace' ? patch.width * scale : 10}px`;
    el.style.minHeight = `${patch.height * scale}px`;
    el.style.backgroundColor = patch.kind === 'replace' ? patch.background : 'transparent';
    el.style.color = patch.color;
    el.style.font = `${patch.fontSize * scale}px ${patch.fontFamily}`;
    const text = document.createElement('span');
    text.textContent = patch.text;
    el.append(text);
    el.addEventListener('click', (e) => { e.stopPropagation(); selectPatch(patch.id); });
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const initialX = event.clientX;
      const initialY = event.clientY;
      const x = patch.x;
      const y = patch.y;
      let moved = false;
      el.setPointerCapture(event.pointerId);
      const move = (e) => {
        if (Math.abs(e.clientX - initialX) + Math.abs(e.clientY - initialY) > 3 && !moved) { snapshot(); moved = true; }
        if (!moved) return;
        const pageWidth = wrap.clientWidth / scale;
        const pageHeight = wrap.clientHeight / scale;
        patch.x = clamp(x + (e.clientX - initialX) / scale, 0, pageWidth - 5);
        patch.y = clamp(y + (e.clientY - initialY) / scale, 0, pageHeight - 5);
        el.style.left = `${patch.x * scale}px`;
        el.style.top = `${patch.y * scale}px`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    layer.append(el);
  }
}

function rasterizeText(text, size, family, color) {
  const factor = 3;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${size * factor}px ${family}`;
  const widthPt = Math.max(2, ctx.measureText(text).width / factor + 3);
  const heightPt = size * 1.42;
  canvas.width = Math.ceil(widthPt * factor);
  canvas.height = Math.ceil(heightPt * factor);
  ctx.font = `${size * factor}px ${family}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(text, factor, Math.round(size * factor * .1));
  return { data: canvas.toDataURL('image/png'), width: widthPt, height: heightPt };
}

async function exportPdf() {
  if (!state.bytes || state.busy) return;
  try {
    busy(true, '正在生成编辑后的 PDF…');
    const pdf = await PDFDocument.load(state.bytes.slice(), { updateMetadata: false });
    for (const patch of state.patchList) {
      const page = pdf.getPage(patch.page);
      const pageHeight = page.getHeight();
      if (patch.kind === 'replace') {
        const hex = patch.background.replace('#', '');
        page.drawRectangle({ x: patch.x - .75, y: pageHeight - patch.y - patch.height - 1.5, width: patch.width + 1.5, height: patch.height + 2.5, color: rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255) });
      }
      const imageInfo = rasterizeText(patch.text, patch.fontSize, patch.fontFamily, patch.color);
      const image = await pdf.embedPng(imageInfo.data);
      page.drawImage(image, { x: patch.x, y: pageHeight - patch.y - imageInfo.height, width: imageInfo.width, height: imageInfo.height });
    }
    const result = await pdf.save();
    downloadBlob(new Blob([result], { type: 'application/pdf' }), `${safeFileName(state.name)}_edited.pdf`);
    toast(`PDF 已导出${state.patchList.length ? `（包含 ${state.patchList.length} 处修改）` : ''}`);
  } catch (error) { console.error(error); toast(`导出失败：${error.message}`, true); }
  finally { busy(false); }
}

function groupTextLines(items) {
  const positions = items.filter((item) => item.str && item.str.trim()).map((item) => ({ text: item.str, x: item.transform[4], y: item.transform[5] }));
  const lines = [];
  for (const item of positions) {
    const line = lines.find((existing) => Math.abs(existing.y - item.y) < 3);
    if (line) line.parts.push(item);
    else lines.push({ y: item.y, parts: [item] });
  }
  return lines.sort((a, b) => b.y - a.y).map((line) => line.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' '));
}

async function pdfToWord(file) {
  try {
    busy(true, '正在提取 PDF 文字并生成 DOCX…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const input = await pdfjsLib.getDocument({ data: bytes, ...pdfAssetOptions }).promise;
    const paragraphs = [];
    let chars = 0;
    for (let i = 1; i <= input.numPages; i++) {
      const page = await input.getPage(i);
      const content = await page.getTextContent();
      const lines = groupTextLines(content.items);
      if (i > 1) paragraphs.push(new window.docx.Paragraph({ text: '', pageBreakBefore: true }));
      for (const line of lines) {
        chars += line.length;
        paragraphs.push(new window.docx.Paragraph({ children: [new window.docx.TextRun({ text: line, size: 22 })], spacing: { after: 80 } }));
      }
    }
    if (!chars) throw new Error('未检测到可复制的文字。扫描版 PDF 需要 OCR，这一版尚未提供。');
    const wordDoc = new window.docx.Document({ sections: [{ properties: {}, children: paragraphs }] });
    const blob = await window.docx.Packer.toBlob(wordDoc);
    downloadBlob(blob, `${safeFileName(file.name)}.docx`);
    toast(`Word 文档已导出 · 提取 ${chars} 个字符`);
  } catch (error) { console.error(error); toast(`PDF 转 Word 失败：${error.message}`, true); }
  finally { busy(false); }
}

function parseDocxParagraphs(xmlString) {
  const dom = new DOMParser().parseFromString(xmlString, 'application/xml');
  if (dom.querySelector('parsererror')) throw new Error('DOCX XML 无法解析');
  const paragraphs = Array.from(dom.getElementsByTagNameNS('*', 'p'));
  return paragraphs.map((node) => {
    const text = Array.from(node.getElementsByTagNameNS('*', 't')).map((span) => span.textContent).join('');
    const styleNode = node.getElementsByTagNameNS('*', 'pStyle')[0];
    const style = styleNode?.getAttribute('w:val') || styleNode?.getAttribute('val') || '';
    return { text, heading: /Heading|Title|标题/i.test(style) };
  });
}

async function wordToPdf(file) {
  try {
    busy(true, '正在转换 DOCX 段落…');
    const archive = await window.JSZip.loadAsync(await file.arrayBuffer());
    const wordXml = archive.file('word/document.xml');
    if (!wordXml) throw new Error('不是有效的 DOCX 文件');
    const paragraphs = parseDocxParagraphs(await wordXml.async('string'));
    const pdf = await PDFDocument.create();
    const width = 595.28, height = 841.89, left = 47, top = 55, bottom = 50;
    let page = pdf.addPage([width, height]);
    let cursorY = height - top;
    let count = 0;
    const measure = document.createElement('canvas').getContext('2d');
    for (const para of paragraphs) {
      const size = para.heading ? 17 : 11;
      const family = para.heading ? 'bold 17px Arial, "Noto Sans SC", sans-serif' : '11px Arial, "Noto Sans SC", sans-serif';
      measure.font = family;
      const maxWidth = width - left * 2;
      const tokens = Array.from(para.text || '');
      const lines = [];
      let line = '';
      for (const ch of tokens) {
        if (measure.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch; }
        else line += ch;
      }
      if (line) lines.push(line);
      if (!lines.length) lines.push('');
      const step = size * 1.5;
      for (const row of lines) {
        if (cursorY - step < bottom) { page = pdf.addPage([width, height]); cursorY = height - top; }
        if (row) {
          const raster = rasterizeText(row, size, 'Arial, "Noto Sans SC", sans-serif', '#222222');
          const image = await pdf.embedPng(raster.data);
          page.drawImage(image, { x: left, y: cursorY - raster.height, width: raster.width, height: raster.height });
          count += row.length;
        }
        cursorY -= step;
      }
      cursorY -= para.heading ? 10 : 5;
    }
    if (!count) throw new Error('DOCX 没有可识别的文字');
    downloadBlob(new Blob([await pdf.save()], { type: 'application/pdf' }), `${safeFileName(file.name)}.pdf`);
    toast(`Word 已转换为 ${pdf.getPageCount()} 页 PDF（简化排版）`);
  } catch (error) { console.error(error); toast(`Word 转 PDF 失败：${error.message}`, true); }
  finally { busy(false); }
}

async function processConverterFile(file) {
  if (!file || state.busy) return;
  const isPdf = state.converter === 'pdf-word';
  if (!(file.name.toLowerCase().endsWith(isPdf ? '.pdf' : '.docx'))) return toast(`请选择 ${isPdf ? '.pdf' : '.docx'} 文件。`, true);
  if (file.size > 45 * 1024 * 1024) return toast('转换文件请小于 45MB。', true);
  if (isPdf) await pdfToWord(file);
  else await wordToPdf(file);
}

function attachDrop(target, handler) {
  target.addEventListener('dragover', (event) => { event.preventDefault(); target.classList.add('dragging'); });
  target.addEventListener('dragleave', () => target.classList.remove('dragging'));
  target.addEventListener('drop', (event) => { event.preventDefault(); target.classList.remove('dragging'); handler(event.dataTransfer.files[0]); });
}

function showUrlModal() {
  $('modalOverlay').classList.remove('hidden');
  $('urlInput').focus();
}

function init() {
  const converterPdfInput = document.createElement('input');
  converterPdfInput.type = 'file';
  converterPdfInput.accept = '.pdf,application/pdf';
  converterPdfInput.hidden = true;
  converterPdfInput.id = 'convertPdfInput';
  converterPdfInput.onchange = async (event) => { await processConverterFile(event.target.files[0]); event.target.value = ''; };
  document.body.append(converterPdfInput);
  $('topOpen').onclick = () => openFilePicker();
  $('topExport').onclick = exportPdf;
  $('editorExport').onclick = exportPdf;
  $('navEditor').onclick = () => view(state.pdf ? 'editor' : 'home');
  $('navPdfWord').onclick = () => configureConverter('pdf-word');
  $('navWordPdf').onclick = () => configureConverter('word-pdf');
  $('navUrl').onclick = showUrlModal;
  $('quickUrl').onclick = showUrlModal;
  $('quickPdfWord').onclick = () => configureConverter('pdf-word');
  $('quickWordPdf').onclick = () => configureConverter('word-pdf');
  $('closeModal').onclick = () => $('modalOverlay').classList.add('hidden');
  $('modalOverlay').onclick = (event) => { if (event.target === $('modalOverlay')) $('modalOverlay').classList.add('hidden'); };
  $('loadUrl').onclick = loadPdfUrl;
  $('urlInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadPdfUrl(); });
  $('heroUpload').onclick = (event) => { event.stopPropagation(); openFilePicker(); };
  $('dropzone').onclick = () => openFilePicker();
  $('dropzone').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); } };
  $('fileInput').onchange = async (event) => { await loadPdfFile(event.target.files[0]); event.target.value = ''; };
  $('wordInput').onchange = async (event) => { await processConverterFile(event.target.files[0]); event.target.value = ''; };
  $('convertDrop').onclick = () => openFilePicker(state.converter === 'pdf-word' ? 'pdf-convert' : 'docx');
  $('convertChoose').onclick = (event) => { event.stopPropagation(); openFilePicker(state.converter === 'pdf-word' ? 'pdf-convert' : 'docx'); };
  $('convertDrop').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(state.converter === 'pdf-word' ? 'pdf-convert' : 'docx'); } };
  $('selectTool').onclick = () => setTool('edit');
  $('addTool').onclick = () => setTool('add');
  $('applyEdit').onclick = applyEdit;
  $('deleteEdit').onclick = deleteSelectedPatch;
  $('undoTool').onclick = undo;
  $('zoomIn').onclick = async () => { state.zoom = clamp(Math.round((state.zoom + .2) * 10) / 10, .5, 2.2); $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`; await renderPages(); };
  $('zoomOut').onclick = async () => { state.zoom = clamp(Math.round((state.zoom - .2) * 10) / 10, .5, 2.2); $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`; await renderPages(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('modalOverlay').classList.add('hidden'); clearSelection(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); undo(); }
  });
  attachDrop($('dropzone'), loadPdfFile);
  attachDrop($('convertDrop'), processConverterFile);
  for (const id of ['topOpen', 'topExport', 'editorExport', 'applyEdit', 'deleteEdit', 'zoomIn', 'zoomOut']) $(id).dataset.busyLock = '1';
}

init();
