import * as pdfjsLib from './vendor/pdf.min.mjs';
import { membership } from './membership.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const { PDFDocument, rgb } = window.PDFLib;
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
  converter: 'pdf-word', busy: false, ocrPages: new Map(), signatureData: null,
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
  if (!membership.guardUse()) return;
  (type === 'docx' ? $('wordInput') : type === 'pdf-convert' ? $('convertPdfInput') : $('fileInput')).click();
}

function configureConverter(kind) {
  if (!membership.guardUse()) return;
  state.converter = kind;
  const isPdf = kind === 'pdf-word';
  $('converterTitle').textContent = isPdf ? 'PDF 转 Word' : 'Word 转 PDF';
  $('converterDescription').textContent = isPdf ? '选择保留原版面或提取可编辑文字。' : '保留常见段落样式、字体大小和对齐；复杂 Word 仍有差异。';
  $('convertDropTitle').textContent = isPdf ? '上传 PDF 文件' : '上传 Word 文件';
  $('convertHelp').textContent = isPdf ? '支持数字 PDF 和扫描 PDF · 保真模式不需要 OCR' : '支持 .docx · 简单布局更准确';
  $('pdfModeOptions').classList.toggle('hidden', !isPdf);
  $('converterNotice').textContent = isPdf ? '保真模式：Word 每页为图片，视觉一致但文字无法编辑；可编辑模式：保留文字，复杂表格、图片和位置可能变化。' : '没有 Word / LibreOffice 排版引擎的纯浏览器转换不可能与 Word 逐页完全一致；复杂合同建议从原 DOCX 在 Word 中导出 PDF。';
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
  state.ocrPages = new Map();
  state.signatureData = null;
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
  if (!membership.guardUse()) return;
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
  if (!membership.guardUse()) return;
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
  let sparsePages = 0;
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
    const usefulItems = textContent.items.filter((item) => item.str?.trim()).length;
    if (usefulItems < 12) sparsePages++;
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
      const fallbackFamily = familyForPdf(style.fontFamily || item.fontName);
      let fontFamily = fallbackFamily;
      let originalFont;
      try {
        originalFont = page.commonObjs.get(item.fontName);
        if (originalFont?.loadedName) fontFamily = `"${originalFont.loadedName}", ${fallbackFamily}`;
      } catch { /* The PDF may use a font that cannot be exposed to canvas. */ }
      const sampled = sampleTextStyle(canvas, x, y, width, height);
      const fontTraits = `${item.fontName} ${style.fontFamily || ''} ${originalFont?.name || ''}`;
      hit.addEventListener('click', (event) => {
        event.stopPropagation();
        selectHit({ page: index, x: x / scale, y: y / scale, width: width / scale, height: height / scale, text: item.str, fontSize: fontHeight / scale, fontFamily,
          color: sampled.color, background: sampled.background, bold: Boolean(originalFont?.bold || /bold|black|heavy/i.test(fontTraits)),
          italic: Boolean(originalFont?.italic || /italic|oblique/i.test(fontTraits)), kind: 'hit' });
      });
      hitLayer.append(hit);
    }
    wrapper.addEventListener('click', (event) => {
      if (!['add', 'sign'].includes(state.tool)) return;
      const rect = wrapper.getBoundingClientRect();
      const x = clamp((event.clientX - rect.left) / scale, 0, viewport.width / scale - 5);
      const y = clamp((event.clientY - rect.top) / scale, 0, viewport.height / scale - 10);
      snapshot();
      if (state.tool === 'sign') {
        const signed = state.signatureData;
        if (!signed) return setTool('edit');
        const width = Math.min(170, viewport.width / scale - x);
        const height = width * signed.height / signed.width;
        const patch = { id: newId(), kind: 'signature', page: index, x, y: Math.min(y, viewport.height / scale - height), width, height, image: signed.image, ratio: signed.height / signed.width };
        state.patchList.push(patch);
        renderPatches();
        selectPatch(patch.id);
        setTool('edit');
        return toast('签名已放置，可拖动位置或调整大小；保存 PDF 时会一并导出。');
      }
      const patch = { id: newId(), kind: 'add', page: index, x, y, width: 95, height: 20, text: '输入新文字', fontSize: 14, fontFamily: 'Arial, "Noto Sans SC", sans-serif', color: '#242c3c', background: '#ffffff', bold: false, italic: false };
      state.patchList.push(patch);
      selectPatch(patch.id);
      renderPatches();
      $('editText').focus();
      $('editText').select();
      setTool('edit');
    });
    if (index < 90) makeThumbnail(canvas, index);
    renderOcrHits(index);
    renderPatchesForPage(index);
    if (index % 5 === 4) await wait(0);
  }
  const sparse = sparsePages > 0;
  $('emptyTextWarning').classList.toggle('hidden', !sparse);
  if (sparse && !state.ocrPages.size && state.tool === 'edit') $('editorHint').textContent = `检测到 ${sparsePages} 页文字层较少：扫描件请点「OCR 本页」，再点击识别到的文字区域进行修改。`;
}

function renderOcrHits(pageIndex) {
  const wrapper = document.querySelector(`.page-wrap[data-page="${pageIndex}"]`);
  if (!wrapper) return;
  const hitLayer = wrapper.querySelector('.hit-layer');
  hitLayer.querySelectorAll('.ocr-hit').forEach((el) => el.remove());
  const scale = PAGE_SCALE * state.zoom;
  for (const hit of state.ocrPages.get(pageIndex) || []) {
    const element = document.createElement('div');
    element.className = 'text-hit ocr-hit';
    element.style.left = `${hit.x * scale}px`;
    element.style.top = `${hit.y * scale}px`;
    element.style.width = `${hit.width * scale}px`;
    element.style.height = `${hit.height * scale}px`;
    element.title = `OCR：${hit.text}`;
    element.addEventListener('click', (event) => { event.stopPropagation(); selectHit(hit); });
    hitLayer.append(element);
  }
}

let tesseractLoader;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoader) return tesseractLoader;
  tesseractLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js';
    script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR 库加载失败'));
    script.onerror = () => reject(new Error('无法下载 OCR 引擎，请检查网络'));
    document.head.append(script);
  }).catch((error) => { tesseractLoader = null; throw error; });
  return tesseractLoader;
}

async function ocrVisiblePage() {
  if (!state.pdf || state.busy) return;
  if (!membership.guardUse()) return;
  const viewRect = $('canvasArea').getBoundingClientRect();
  const pages = [...document.querySelectorAll('.page-wrap')];
  const wrapper = pages.reduce((best, node) => {
    const rect = node.getBoundingClientRect();
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewRect.bottom) - Math.max(rect.top, viewRect.top));
    return visibleHeight > best.visible ? { node, visible: visibleHeight } : best;
  }, { node: pages[0], visible: -1 }).node;
  if (!wrapper) return;
  const pageIndex = Number(wrapper.dataset.page);
  const canvas = wrapper.querySelector('canvas.pdf-canvas');
  const button = $('ocrTool');
  button.disabled = true;
  busy(true, `OCR 正在识别第 ${pageIndex + 1} 页（首次需要下载语言模型）…`);
  let worker;
  try {
    const Tesseract = await loadTesseract();
    worker = await Tesseract.createWorker(['eng', 'chi_sim'], 1);
    const result = await worker.recognize(canvas, {}, { tsv: true });
    const tsv = result.data?.tsv || '';
    const lines = tsv.split(/\r?\n/).filter(Boolean);
    const headers = lines.shift()?.split('\t') || [];
    const col = (values, name) => values[headers.indexOf(name)];
    const normalizedWidth = wrapper.clientWidth / (PAGE_SCALE * state.zoom);
    const normalizedHeight = wrapper.clientHeight / (PAGE_SCALE * state.zoom);
    const hits = lines.map((line) => {
      const values = line.split('\t');
      const text = col(values, 'text')?.trim();
      const confidence = Number(col(values, 'conf'));
      const left = Number(col(values, 'left'));
      const top = Number(col(values, 'top'));
      const width = Number(col(values, 'width'));
      const height = Number(col(values, 'height'));
      if (Number(col(values, 'level')) !== 5 || !text || confidence < 28 || !width || !height) return null;
      const pixelStyle = sampleTextStyle(canvas, left / canvas.width * wrapper.clientWidth,
        top / canvas.height * wrapper.clientHeight, width / canvas.width * wrapper.clientWidth,
        height / canvas.height * wrapper.clientHeight);
      return { kind: 'hit', fromOcr: true, page: pageIndex,
        x: left / canvas.width * normalizedWidth, y: top / canvas.height * normalizedHeight,
        width: width / canvas.width * normalizedWidth, height: height / canvas.height * normalizedHeight,
        fontSize: clamp(height / canvas.height * normalizedHeight * .86, 6, 72),
        fontFamily: 'Arial, "Noto Sans SC", sans-serif', bold: false, italic: false,
        color: pixelStyle.color, background: pixelStyle.background, text };
    }).filter(Boolean);
    if (!hits.length) return toast('未检测到可识别的文字。可尝试更清晰的扫描件。', true);
    state.ocrPages.set(pageIndex, hits);
    renderOcrHits(pageIndex);
    if (state.ocrPages.size >= state.pdf.numPages) $('emptyTextWarning').classList.add('hidden');
    toast(`第 ${pageIndex + 1} 页 OCR 完成：识别 ${hits.length} 个文字区域，点击紫色区域进行校对和修改。`);
  } catch (error) {
    console.error(error);
    toast(`OCR 失败：${error.message}`, true);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    button.disabled = false;
    busy(false);
  }
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
  $('signatureTool').classList.toggle('selected', tool === 'sign');
  document.querySelectorAll('.page-wrap').forEach((el) => { el.classList.toggle('adding', tool === 'add'); el.classList.toggle('signing', tool === 'sign'); });
  $('editorHint').textContent = tool === 'add' ? '点击 PDF 空白位置，即可添加文字' : tool === 'sign' ? '点击 PDF 页面放置手写签名，之后可拖动和缩放' : '点击文字修改 · 扫描件先执行 OCR 本页 · 签名请选择「手写签名」';
}

function familyForPdf(name = '') {
  return /Times|Serif|Song|Ming/i.test(name) ? 'Georgia, "Noto Serif SC", serif' : /Courier|Mono/i.test(name) ? '"Courier New", monospace' : 'Arial, "Noto Sans SC", sans-serif';
}

function sampleTextStyle(canvas, x, y, width, height) {
  const ratio = canvas.width / (canvas.clientWidth || canvas.width);
  const left = clamp(Math.floor(x * ratio), 0, canvas.width - 1);
  const top = clamp(Math.floor(y * ratio), 0, canvas.height - 1);
  const w = Math.min(canvas.width - left, Math.max(1, Math.round(width * ratio)));
  const h = Math.min(canvas.height - top, Math.max(1, Math.round(height * ratio)));
  const { data } = canvas.getContext('2d').getImageData(left, top, w, h);
  const counts = new Map();
  const jump = Math.max(1, Math.floor(Math.sqrt((w * h) / 1200)));
  for (let py = 0; py < h; py += jump) for (let px = 0; px < w; px += jump) {
    const i = (py * w + px) * 4;
    if (data[i + 3] < 200) continue;
    const rgb = [data[i], data[i + 1], data[i + 2]];
    const key = rgb.map((v) => Math.round(v / 16) * 16).join(',');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { color: '#222222', background: '#ffffff' };
  const bg = sorted[0][0].split(',').map(Number);
  const distance = (color) => Math.hypot(color[0] - bg[0], color[1] - bg[1], color[2] - bg[2]);
  const fgEntry = sorted.slice(1).filter(([key]) => distance(key.split(',').map(Number)) > 65).sort((a, b) => b[1] - a[1])[0];
  const fg = fgEntry ? fgEntry[0].split(',').map(Number) : [34, 34, 34];
  const hex = (color) => '#' + color.map((value) => clamp(value, 0, 255).toString(16).padStart(2, '0')).join('');
  return { color: hex(fg), background: hex(bg) };
}

function selectHit(hit) {
  state.selected = hit;
  showProperties(hit);
  $('propertyStatus').textContent = hit.fromOcr ? 'OCR 识别文字' : '原有文字';
  $('deleteEdit').classList.add('hidden');
}

function selectPatch(id) {
  const patch = state.patchList.find((item) => item.id === id);
  if (!patch) return;
  state.selected = { kind: 'patch', id };
  if (patch.kind === 'signature') {
    $('noSelection').classList.add('hidden');
    $('propertiesForm').classList.remove('hidden');
    $('textPropertyFields').classList.add('hidden');
    $('signaturePropertyFields').classList.remove('hidden');
    $('signatureWidth').value = Math.round(patch.width);
    $('signatureSizeValue').textContent = `${Math.round(patch.width)} pt`;
  } else showProperties(patch);
  $('propertyStatus').textContent = patch.kind === 'signature' ? '手写签名' : patch.kind === 'replace' ? '文字替换' : '新增文字';
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
  $('textPropertyFields').classList.remove('hidden');
  $('signaturePropertyFields').classList.add('hidden');
  $('editText').value = item.text;
  $('fontSize').value = (item.fontSize || 12).toFixed(1).replace(/\.0$/, '');
  const selector = $('fontFamily');
  selector.querySelectorAll('option[data-detected]').forEach((option) => option.remove());
  const selectedFamily = item.fontFamily || 'Arial, "Noto Sans SC", sans-serif';
  if (![...selector.options].some((opt) => opt.value === selectedFamily)) {
    const detected = new Option('检测到的 PDF 字体（近似）', selectedFamily);
    detected.dataset.detected = '1';
    selector.prepend(detected);
  }
  selector.value = selectedFamily;
  $('fontBold').checked = Boolean(item.bold);
  $('fontItalic').checked = Boolean(item.italic);
  $('fontColor').value = item.color || '#222222';
  $('backgroundColor').value = item.background || '#ffffff';
  $('matchNote').textContent = item.fromOcr ? 'OCR 位置为自动识别，文字需校对。覆盖扫描图片上的旧文字可能留下背景痕迹。' : item.kind === 'hit' || item.kind === 'replace' ? '尽量匹配检测到的字体和颜色，但特殊字体及复杂背景不保证完全一致。原文字没有被安全删除。' : '可在页面上拖动文字位置。导出时新文字将绘制到 PDF 内。';
}

function snapshot() {
  state.undoStack.push(clone(state.patchList));
  if (state.undoStack.length > 25) state.undoStack.shift();
  $('undoTool').disabled = false;
}

function applyEdit() {
  if (!state.selected) return;
  if (state.selected.kind === 'patch' && state.patchList.find((patch) => patch.id === state.selected.id)?.kind === 'signature') return;
  const text = $('editText').value;
  const fontSize = clamp(Number($('fontSize').value) || 12, 5, 96);
  const props = { text, fontSize, fontFamily: $('fontFamily').value, color: $('fontColor').value, background: $('backgroundColor').value, bold: $('fontBold').checked, italic: $('fontItalic').checked };
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
    if (patch.kind === 'signature') {
      el.classList.add('signature-patch');
      el.style.width = `${patch.width * scale}px`;
      el.style.height = `${patch.height * scale}px`;
      const img = document.createElement('img');
      img.src = patch.image;
      img.alt = '手写签名';
      el.append(img);
    } else {
      el.style.backgroundColor = patch.kind === 'replace' ? patch.background : 'transparent';
      el.style.color = patch.color;
      el.style.font = `${patch.italic ? 'italic' : 'normal'} ${patch.bold ? '700' : '400'} ${patch.fontSize * scale}px ${patch.fontFamily}`;
      const text = document.createElement('span');
      text.textContent = patch.text;
      el.append(text);
    }
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

function rasterizeText(text, size, family, color, bold = false, italic = false) {
  const factor = 3;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${italic ? 'italic' : 'normal'} ${bold ? '700' : '400'} ${size * factor}px ${family}`;
  const widthPt = Math.max(2, ctx.measureText(text).width / factor + 3);
  const heightPt = size * 1.42;
  canvas.width = Math.ceil(widthPt * factor);
  canvas.height = Math.ceil(heightPt * factor);
  ctx.font = `${italic ? 'italic' : 'normal'} ${bold ? '700' : '400'} ${size * factor}px ${family}`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(text, factor, Math.round(size * factor * .1));
  return { data: canvas.toDataURL('image/png'), width: widthPt, height: heightPt };
}

function setupSignaturePad() {
  const canvas = $('signatureCanvas');
  const ctx = canvas.getContext('2d');
  let last = null;
  let hasInk = false;
  const coordinates = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width,
      y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  };
  const clear = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); hasInk = false; last = null; };
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    last = coordinates(event); hasInk = true;
    ctx.fillStyle = '#171d30'; ctx.beginPath(); ctx.arc(last.x, last.y, 1.8, 0, Math.PI * 2); ctx.fill();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!last) return;
    event.preventDefault(); const next = coordinates(event);
    ctx.beginPath(); ctx.strokeStyle = '#171d30'; ctx.lineWidth = 3.5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.moveTo(last.x, last.y); ctx.lineTo(next.x, next.y); ctx.stroke();
    last = next;
  });
  const finish = () => { last = null; };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  $('clearSignature').onclick = clear;
  $('signatureTool').onclick = () => { if (!state.pdf) return; clear(); $('signatureOverlay').classList.remove('hidden'); };
  const close = () => $('signatureOverlay').classList.add('hidden');
  $('closeSignature').onclick = close;
  $('signatureOverlay').onclick = (event) => { if (event.target === $('signatureOverlay')) close(); };
  $('useSignature').onclick = () => {
    if (!hasInk) return toast('请先在签名板上手写签名。', true);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      if (image.data[(y * canvas.width + x) * 4 + 3] < 24) continue;
      minX = Math.min(x, minX); maxX = Math.max(x, maxX);
      minY = Math.min(y, minY); maxY = Math.max(y, maxY);
    }
    const padding = 8;
    minX = Math.max(0, minX - padding); minY = Math.max(0, minY - padding);
    const width = Math.min(canvas.width - minX, maxX - minX + padding * 2);
    const height = Math.min(canvas.height - minY, maxY - minY + padding * 2);
    const cropped = document.createElement('canvas'); cropped.width = width; cropped.height = height;
    cropped.getContext('2d').drawImage(canvas, minX, minY, width, height, 0, 0, width, height);
    state.signatureData = { image: cropped.toDataURL('image/png'), width, height };
    close(); setTool('sign');
    toast('已准备好签名。请点击文档需要签名的位置。');
  };
  $('signatureWidth').oninput = (event) => {
    const patch = state.patchList.find((p) => p.id === state.selected?.id && p.kind === 'signature');
    if (!patch) return;
    const width = Number(event.target.value);
    if (width < 20) return;
    if (!patch._resizing) { snapshot(); patch._resizing = true; }
    patch.width = width; patch.height = width * patch.ratio;
    $('signatureSizeValue').textContent = `${width} pt`;
    renderPatches();
  };
  $('signatureWidth').addEventListener('change', () => {
    const patch = state.patchList.find((p) => p.id === state.selected?.id);
    if (patch) delete patch._resizing;
  });
}

async function exportPdf() {
  if (!state.bytes || state.busy) return;
  if (!membership.guardUse()) return;
  try {
    busy(true, '正在生成编辑后的 PDF…');
    const pdf = await PDFDocument.load(state.bytes.slice(), { updateMetadata: false });
    for (const patch of state.patchList) {
      const page = pdf.getPage(patch.page);
      const pageHeight = page.getHeight();
      if (patch.kind === 'signature') {
        const png = await pdf.embedPng(patch.image);
        page.drawImage(png, { x: patch.x, y: pageHeight - patch.y - patch.height, width: patch.width, height: patch.height });
        continue;
      }
      if (patch.kind === 'replace') {
        const hex = patch.background.replace('#', '');
        page.drawRectangle({ x: patch.x - .75, y: pageHeight - patch.y - patch.height - 1.5, width: patch.width + 1.5, height: patch.height + 2.5, color: rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255) });
      }
      const imageInfo = rasterizeText(patch.text, patch.fontSize, patch.fontFamily, patch.color, patch.bold, patch.italic);
      const image = await pdf.embedPng(imageInfo.data);
      page.drawImage(image, { x: patch.x, y: pageHeight - patch.y - imageInfo.height, width: imageInfo.width, height: imageInfo.height });
    }
    const result = await pdf.save();
    if (!await membership.authorizeExport('pdf_edit')) return;
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
    const mode = document.querySelector('input[name="pdfMode"]:checked')?.value || 'visual';
    busy(true, mode === 'visual' ? '正在逐页渲染 PDF，以原版面制作 Word…' : '正在提取 PDF 文字并生成可编辑 DOCX…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const input = await pdfjsLib.getDocument({ data: bytes, ...pdfAssetOptions }).promise;
    const paragraphs = [];
    let chars = 0;
    let pdfWidth = 595.28, pdfHeight = 841.89;
    for (let i = 1; i <= input.numPages; i++) {
      const page = await input.getPage(i);
      if (mode === 'visual') {
        const size = page.getViewport({ scale: 1 });
        if (i === 1) { pdfWidth = size.width; pdfHeight = size.height; }
        const renderViewport = page.getViewport({ scale: 1.65 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(renderViewport.width); canvas.height = Math.round(renderViewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: renderViewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .91));
        if (!blob) throw new Error('无法生成文档页面图像');
        const image = new Uint8Array(await blob.arrayBuffer());
        const viewWidthPx = (pdfWidth - 11) * 96 / 72;
        const viewHeightPx = viewWidthPx * size.height / size.width;
        paragraphs.push(new window.docx.Paragraph({
          children: [new window.docx.ImageRun({ type: 'jpg', data: image, transformation: { width: viewWidthPx, height: viewHeightPx } })],
          spacing: { before: 0, after: 0 }, pageBreakBefore: i > 1,
        }));
        continue;
      }
      const content = await page.getTextContent();
      const lines = groupTextLines(content.items);
      if (i > 1) paragraphs.push(new window.docx.Paragraph({ text: '', pageBreakBefore: true }));
      for (const line of lines) {
        chars += line.length;
        paragraphs.push(new window.docx.Paragraph({ children: [new window.docx.TextRun({ text: line, size: 22 })], spacing: { after: 80 } }));
      }
    }
    if (mode !== 'visual' && !chars) throw new Error('未检测到可复制的文字。请选择「保真模式」保留扫描 PDF 的页面外观。');
    const wordDoc = new window.docx.Document({ sections: [{ properties: mode === 'visual' ? {
      page: { size: { width: Math.round(pdfWidth * 20), height: Math.round(pdfHeight * 20) },
        margin: { left: 90, right: 90, top: 90, bottom: 90 } },
    } : {}, children: paragraphs }] });
    const blob = await window.docx.Packer.toBlob(wordDoc);
    if (!await membership.authorizeExport('pdf_to_word')) return;
    downloadBlob(blob, `${safeFileName(file.name)}_${mode === 'visual' ? '保真版' : '文字可编辑版'}.docx`);
    toast(mode === 'visual' ? `已生成 ${input.numPages} 页版面保真 Word（内容为图片，不可直接修改文字）。` : `Word 文档已导出 · 提取 ${chars} 个字符，复杂排版可能改变。`);
  } catch (error) { console.error(error); toast(`PDF 转 Word 失败：${error.message}`, true); }
  finally { busy(false); }
}

function wordChildren(node, localName) {
  return node ? [...node.children].filter((el) => el.localName === localName) : [];
}

function wordFirst(node, localName) {
  return node?.getElementsByTagNameNS('*', localName)[0] || null;
}

function wordAttr(node, name, fallback = '') {
  return node?.getAttribute('w:' + name) ?? node?.getAttribute(name) ?? fallback;
}

function extractWordParagraph(node) {
  const props = wordChildren(node, 'pPr')[0];
  const style = wordAttr(wordFirst(props, 'pStyle'), 'val');
  const heading = /Heading|Title|标题/i.test(style);
  const alignment = wordAttr(wordFirst(props, 'jc'), 'val', 'left');
  const spacing = wordFirst(props, 'spacing');
  const indent = wordFirst(props, 'ind');
  const runs = [];
  let pageBreak = false;
  for (const child of [...node.children]) {
    if (child.localName !== 'r') continue;
    if ([...child.getElementsByTagNameNS('*', 'br')].some((br) => wordAttr(br, 'type') === 'page')) pageBreak = true;
    const rpr = wordChildren(child, 'rPr')[0];
    const rawText = [...child.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join('');
    const tabs = child.getElementsByTagNameNS('*', 'tab').length;
    const text = rawText + (tabs ? '    '.repeat(tabs) : '');
    if (!text) continue;
    const font = wordFirst(rpr, 'rFonts');
    const fontName = wordAttr(font, 'ascii') || wordAttr(font, 'eastAsia');
    const fontSizeHalfPoints = Number(wordAttr(wordFirst(rpr, 'sz'), 'val'));
    const rawColor = wordAttr(wordFirst(rpr, 'color'), 'val');
    const color = /^[a-f\d]{6}$/i.test(rawColor) ? '#' + rawColor : '#222222';
    const bold = Boolean(wordFirst(rpr, 'b'));
    const italic = Boolean(wordFirst(rpr, 'i'));
    runs.push({ text, fontSize: fontSizeHalfPoints > 0 ? fontSizeHalfPoints / 2 : heading ? 17 : 11,
      family: fontName ? `"${fontName.replace(/["\\]/g, '')}", Arial, "Noto Sans SC", sans-serif` : 'Arial, "Noto Sans SC", sans-serif', color, bold, italic });
  }
  return { runs, alignment, heading, pageBreak: pageBreak || Boolean(wordFirst(props, 'pageBreakBefore')),
    indent: Number(wordAttr(indent, 'left')) / 20 || 0,
    after: Number(wordAttr(spacing, 'after')) / 20 || (heading ? 8 : 4),
    before: Number(wordAttr(spacing, 'before')) / 20 || 0 };
}

function wordWrapRuns(runs, maxWidth, measure) {
  const lines = [];
  let line = [], lineWidth = 0;
  for (const run of runs) {
    measure.font = `${run.italic ? 'italic ' : ''}${run.bold ? 'bold ' : ''}${run.fontSize}px ${run.family}`;
    for (const char of run.text) {
      const width = measure.measureText(char).width;
      if (lineWidth + width > maxWidth && lineWidth > 0) { lines.push(line); line = []; lineWidth = 0; }
      const existing = line[line.length - 1];
      if (existing?.style === run) { existing.text += char; existing.width += width; }
      else line.push({ style: run, text: char, width });
      lineWidth += width;
    }
  }
  lines.push(line);
  return lines;
}

async function wordToPdf(file) {
  try {
    busy(true, '正在读取 Word 布局、文字属性和表格…');
    const archive = await window.JSZip.loadAsync(await file.arrayBuffer());
    const wordXml = archive.file('word/document.xml');
    if (!wordXml) throw new Error('不是有效的 DOCX 文件');
    const dom = new DOMParser().parseFromString(await wordXml.async('string'), 'application/xml');
    if (dom.querySelector('parsererror')) throw new Error('DOCX XML 无法解析');
    const body = wordFirst(dom, 'body');
    const sect = wordFirst(body, 'sectPr');
    const pageSize = wordFirst(sect, 'pgSz');
    const margins = wordFirst(sect, 'pgMar');
    const width = (Number(wordAttr(pageSize, 'w')) || 11906) / 20;
    const height = (Number(wordAttr(pageSize, 'h')) || 16838) / 20;
    const left = Math.max(20, (Number(wordAttr(margins, 'left')) || 900) / 20);
    const right = Math.max(20, (Number(wordAttr(margins, 'right')) || 900) / 20);
    const top = Math.max(20, (Number(wordAttr(margins, 'top')) || 1000) / 20);
    const bottom = Math.max(20, (Number(wordAttr(margins, 'bottom')) || 900) / 20);
    const pdf = await PDFDocument.create();
    let page = pdf.addPage([width, height]);
    let cursorY = height - top;
    let count = 0;
    const measure = document.createElement('canvas').getContext('2d');
    const newPage = () => { page = pdf.addPage([width, height]); cursorY = height - top; };
    const renderParagraph = async (para, x = left, available = width - left - right) => {
      if (para.pageBreak && cursorY < height - top - 8) newPage();
      cursorY -= Math.max(0, para.before);
      const maxWidth = Math.max(20, available - para.indent);
      const lines = wordWrapRuns(para.runs, maxWidth, measure);
      for (const pieces of lines) {
        const lineHeight = Math.max(12, ...pieces.map((p) => p.style.fontSize * 1.48));
        if (cursorY - lineHeight < bottom) newPage();
        const visualWidth = pieces.reduce((sum, p) => sum + p.width, 0);
        let cursorX = x + para.indent;
        if (para.alignment === 'center') cursorX += (maxWidth - visualWidth) / 2;
        else if (para.alignment === 'right') cursorX += maxWidth - visualWidth;
        for (const part of pieces) {
          const s = part.style;
          const raster = rasterizeText(part.text, s.fontSize, s.family, s.color, s.bold, s.italic);
          const image = await pdf.embedPng(raster.data);
          page.drawImage(image, { x: cursorX, y: cursorY - raster.height, width: raster.width, height: raster.height });
          cursorX += part.width;
          count += part.text.length;
        }
        cursorY -= lineHeight;
      }
      cursorY -= para.after;
    };
    for (const block of [...body.children]) {
      if (block.localName === 'p') {
        await renderParagraph(extractWordParagraph(block));
      } else if (block.localName === 'tbl') {
        const rows = wordChildren(block, 'tr');
        for (const row of rows) {
          const cells = wordChildren(row, 'tc');
          if (!cells.length) continue;
          const cellWidth = (width - left - right) / cells.length;
          const parsed = cells.map((cell) => wordChildren(cell, 'p').map(extractWordParagraph));
          const lineGroups = parsed.map((paragraphs) => paragraphs.flatMap((p) => wordWrapRuns(p.runs, cellWidth - 12, measure)));
          const rowHeight = Math.max(25, ...lineGroups.map((lines) => lines.reduce((sum, line) => sum + Math.max(12, ...line.map((part) => part.style.fontSize * 1.45)), 8)));
          if (cursorY - rowHeight < bottom) newPage();
          for (let c = 0; c < cells.length; c++) {
            const x = left + cellWidth * c;
            page.drawRectangle({ x, y: cursorY - rowHeight, width: cellWidth, height: rowHeight, borderWidth: .5, borderColor: rgb(.73, .76, .82) });
            let rowCursor = cursorY - 5;
            for (const line of lineGroups[c]) {
              const lineHeight = Math.max(12, ...line.map((part) => part.style.fontSize * 1.45));
              let position = x + 6;
              for (const part of line) {
                const s = part.style;
                const raster = rasterizeText(part.text, s.fontSize, s.family, s.color, s.bold, s.italic);
                const image = await pdf.embedPng(raster.data);
                page.drawImage(image, { x: position, y: rowCursor - raster.height, width: raster.width, height: raster.height });
                position += part.width;
                count += part.text.length;
              }
              rowCursor -= lineHeight;
            }
          }
          cursorY -= rowHeight;
        }
        cursorY -= 7;
      }
    }
    if (!count) throw new Error('DOCX 没有可识别的文字');
    const result = await pdf.save();
    if (!await membership.authorizeExport('word_to_pdf')) return;
    downloadBlob(new Blob([result], { type: 'application/pdf' }), `${safeFileName(file.name)}.pdf`);
    toast(`Word 已转换为 ${pdf.getPageCount()} 页 PDF（基本段落样式与表格）；复杂布局仍需 Word 原生引擎。`);
  } catch (error) { console.error(error); toast(`Word 转 PDF 失败：${error.message}`, true); }
  finally { busy(false); }
}

async function processConverterFile(file) {
  if (!file || state.busy) return;
  if (!membership.guardUse()) return;
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
  if (!membership.guardUse()) return;
  $('modalOverlay').classList.remove('hidden');
  $('urlInput').focus();
}

function init() {
  setupSignaturePad();
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
  $('ocrTool').onclick = ocrVisiblePage;
  $('applyEdit').onclick = applyEdit;
  $('deleteEdit').onclick = deleteSelectedPatch;
  $('undoTool').onclick = undo;
  $('zoomIn').onclick = async () => { state.zoom = clamp(Math.round((state.zoom + .2) * 10) / 10, .5, 2.2); $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`; await renderPages(); };
  $('zoomOut').onclick = async () => { state.zoom = clamp(Math.round((state.zoom - .2) * 10) / 10, .5, 2.2); $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`; await renderPages(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('modalOverlay').classList.add('hidden'); $('signatureOverlay').classList.add('hidden'); clearSelection(); setTool('edit'); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); undo(); }
  });
  attachDrop($('dropzone'), loadPdfFile);
  attachDrop($('convertDrop'), processConverterFile);
  for (const id of ['topOpen', 'topExport', 'editorExport', 'applyEdit', 'deleteEdit', 'zoomIn', 'zoomOut', 'signatureTool']) $(id).dataset.busyLock = '1';
}

init();
membership.init();
