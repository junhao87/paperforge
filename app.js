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
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});

// Keep physical PDF coordinates (points) independent of the screen size.
function viewportScale(page) {
  const naturalWidth = page.getViewport({ scale: 1 }).width;
  const area = $('canvasArea');
  const areaStyles = getComputedStyle(area);
  const usableWidth = area.clientWidth - parseFloat(areaStyles.paddingLeft || 0)
    - parseFloat(areaStyles.paddingRight || 0) - 10;
  const fit = window.matchMedia('(max-width: 900px)').matches
    ? Math.min(PAGE_SCALE, Math.max(.2, usableWidth / naturalWidth)) : PAGE_SCALE;
  return fit * state.zoom;
}

function pageScale(wrapper) {
  return Number(wrapper.dataset.scale) || PAGE_SCALE * state.zoom;
}

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
  const overlay = $('progressOverlay');
  if (overlay) {
    overlay.classList.toggle('hidden', !value);
    document.body.classList.toggle('processing-document', value);
    if (value && message) {
      $('progressTitle').textContent = /OCR|识别|扫描/.test(message) ? '正在识别 PDF 文字'
        : /Word|转换|版面/.test(message) ? '正在转换文档' : '正在处理文件';
      $('progressMessage').textContent = message;
    }
  }
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
  $('converterDescription').textContent = isPdf ? '支持原貌图像或固定坐标可编辑文字；复杂合同仍需检查字体与文字框。' : '先用浏览器版面引擎处理 Word；自动分页、特殊字体和复杂表格可能存在差异。';
  $('convertDropTitle').textContent = isPdf ? '上传 PDF 文件' : '上传 Word 文件';
  $('convertHelp').textContent = isPdf ? '支持数字 PDF 和扫描 PDF · 保真模式不需要 OCR' : '支持 .docx · 增强排版首次需要联网加载组件';
  $('pdfModeOptions').classList.toggle('hidden', !isPdf);
  $('converterNotice').textContent = isPdf ? '原貌保真：每页图片，最接近原件但文字不可编辑。固定版式可编辑：文字定位到原坐标，保留图形背景；更改长文本可能溢出，特殊字体或非白底可能略有偏差。' : '当前浏览器转换不能保证 Microsoft Word 的自动分页完全一致；若要求合同原排版一处不变，请在 Microsoft Word 中使用「文件 → 导出 → 创建 PDF」，并安装原字体。';
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
    const scale = viewportScale(page);
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrap';
    wrapper.dataset.page = index;
    wrapper.dataset.scale = String(scale);
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
    enableRegionSelection(wrapper, index, scale, canvas);
    if (index < 90) makeThumbnail(canvas, index);
    renderOcrHits(index);
    renderPatchesForPage(index);
    updatePageToolClass(wrapper);
    if (index % 5 === 4) await wait(0);
  }
  const sparse = sparsePages > 0;
  $('emptyTextWarning').classList.toggle('hidden', !sparse);
  if (sparse && !state.ocrPages.size && state.tool === 'edit') $('editorHint').textContent = `检测到 ${sparsePages} 页可能是扫描件：可点 OCR，或直接「框选改字」。签名无需 OCR。`;
}

function updatePageToolClass(wrapper) {
  wrapper.classList.toggle('adding', state.tool === 'add');
  wrapper.classList.toggle('signing', state.tool === 'sign');
  wrapper.classList.toggle('selecting-region', state.tool === 'region');
}

function enableRegionSelection(wrapper, pageIndex, scale, pdfCanvas) {
  let active = null;
  let preview = null;
  const local = (event) => {
    const rect = wrapper.getBoundingClientRect();
    return { x: clamp(event.clientX - rect.left, 0, rect.width),
      y: clamp(event.clientY - rect.top, 0, rect.height) };
  };
  wrapper.addEventListener('pointerdown', (event) => {
    if (state.tool !== 'region' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.target.closest('.patch-item')) return;
    event.preventDefault();
    const start = local(event);
    active = { ...start, pointerId: event.pointerId };
    preview = document.createElement('div');
    preview.className = 'selection-marquee';
    wrapper.append(preview);
    wrapper.setPointerCapture(event.pointerId);
  });
  wrapper.addEventListener('pointermove', (event) => {
    if (!active || event.pointerId !== active.pointerId || !preview) return;
    event.preventDefault();
    const point = local(event);
    Object.assign(preview.style, { left: `${Math.min(active.x, point.x)}px`, top: `${Math.min(active.y, point.y)}px`,
      width: `${Math.abs(active.x - point.x)}px`, height: `${Math.abs(active.y - point.y)}px` });
  });
  const finish = (event) => {
    if (!active || event.pointerId !== active.pointerId) return;
    event.preventDefault();
    const point = local(event);
    const x = Math.min(active.x, point.x), y = Math.min(active.y, point.y);
    const width = Math.abs(active.x - point.x), height = Math.abs(active.y - point.y);
    preview?.remove(); preview = null; active = null;
    if (width < 9 || height < 7) return toast('请按住并拖动，框住需要替换的整段文字。', true);
    const sampled = sampleTextStyle(pdfCanvas, x, y, width, height);
    selectHit({ kind: 'hit', fromManual: true, page: pageIndex, x: x / scale, y: y / scale,
      width: width / scale, height: height / scale, text: '',
      fontSize: clamp(height / scale * .74, 6, 72), fontFamily: 'Arial, "Noto Sans SC", sans-serif',
      color: sampled.color, background: sampled.background, bold: false, italic: false });
    setTool('edit');
    $('editText').focus({ preventScroll: true });
    toast('框选成功！在属性栏输入新文字，点「应用修改」。扫描件无需先 OCR。');
  };
  wrapper.addEventListener('pointerup', finish);
  wrapper.addEventListener('pointercancel', (event) => {
    if (active?.pointerId !== event.pointerId) return;
    preview?.remove(); preview = null; active = null;
  });
}

function renderOcrHits(pageIndex) {
  const wrapper = document.querySelector(`.page-wrap[data-page="${pageIndex}"]`);
  if (!wrapper) return;
  const hitLayer = wrapper.querySelector('.hit-layer');
  hitLayer.querySelectorAll('.ocr-hit').forEach((el) => el.remove());
  const scale = pageScale(wrapper);
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
let cachedOcrWorker;
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

async function getOcrWorker() {
  if (cachedOcrWorker) return cachedOcrWorker;
  const Tesseract = await loadTesseract();
  const logger = (event) => {
    if (!state.busy || !$('progressMessage')) return;
    const percent = Number.isFinite(event.progress) ? `${Math.round(event.progress * 100)}%` : '';
    const operation = /recogniz/i.test(event.status) ? '正在识别文字' : '正在加载 OCR 模型';
    $('progressMessage').textContent = `${operation}${percent ? ` · ${percent}` : ''}。首次载入可能需要较长时间…`;
  };
  try { cachedOcrWorker = await Tesseract.createWorker(['eng', 'chi_sim'], 1, { logger }); }
  catch (languageError) {
    console.warn('中英 OCR 模型加载失败，降级为英语', languageError);
    cachedOcrWorker = await Tesseract.createWorker('eng', 1, { logger });
  }
  return cachedOcrWorker;
}

// Tesseract 6 returns spatial details only when explicitly requested. Prefer
// line rectangles so they remain usable on narrow touch screens.
function mergeOcrWordsIntoLines(boxes) {
  const rows = [];
  const sorted = [...boxes].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  for (const box of sorted) {
    const center = box.y + box.h / 2;
    const row = rows.find((line) => Math.abs(line.center - center) < Math.max(5, Math.min(box.h, line.height) * .38));
    if (row) { row.items.push(box); row.center = (row.center * (row.items.length - 1) + center) / row.items.length; }
    else rows.push({ center, height: box.h, items: [box] });
  }
  const merged = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    let chunk = [];
    const flush = () => {
      if (!chunk.length) return;
      const x = Math.min(...chunk.map((a) => a.x)), y = Math.min(...chunk.map((a) => a.y));
      const x2 = Math.max(...chunk.map((a) => a.x + a.w));
      const y2 = Math.max(...chunk.map((a) => a.y + a.h));
      merged.push({ x, y, w: x2 - x, h: y2 - y, text: chunk.map((a) => a.text).join(' ') });
      chunk = [];
    };
    for (const box of row.items) {
      const last = chunk[chunk.length - 1];
      // Large horizontal gaps are independent fields, even on the same baseline.
      // Never let a distant label be repainted when only one value is edited.
      if (last && box.x - last.x - last.w > Math.max(8, box.h * .9)) flush();
      chunk.push(box);
    }
    flush();
  }
  return merged;
}

function ocrBoxes(result) {
  const data = result?.data || result || {};
  const words = [];
  const tsv = typeof data.tsv === 'string' ? data.tsv : '';
  const rows = tsv.trim().split(/\r?\n/);
  const headers = rows.shift()?.split('\t') || [];
  const index = Object.fromEntries(headers.map((key, i) => [key, i]));
  if (index.left !== undefined && index.text !== undefined) {
    for (const row of rows) {
      const parts = row.split('\t');
      if (Number(parts[index.level]) !== 5) continue;
      const text = (parts.slice(index.text).join('\t') || '').trim();
      const x = Number(parts[index.left]), y = Number(parts[index.top]);
      const w = Number(parts[index.width]), h = Number(parts[index.height]);
      const confidence = Number(parts[index.conf]);
      if (!text || !Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0 || confidence < 8) continue;
      words.push({ text, x, y, w, h, confidence,
        line: `${parts[index.page_num]}/${parts[index.block_num]}/${parts[index.par_num]}/${parts[index.line_num]}` });
    }
  }
  if (words.length) {
    const groups = new Map();
    for (const word of words) {
      if (!groups.has(word.line)) groups.set(word.line, []);
      groups.get(word.line).push(word);
    }
    const lines = [];
    for (const parts of groups.values()) {
      parts.sort((a, b) => a.x - b.x);
      let segment = [];
      const flush = () => {
        if (!segment.length) return;
        const x = Math.min(...segment.map((a) => a.x)), y = Math.min(...segment.map((a) => a.y));
        const endX = Math.max(...segment.map((a) => a.x + a.w));
        const endY = Math.max(...segment.map((a) => a.y + a.h));
        lines.push({ x, y, w: endX - x, h: endY - y,
          text: segment.map((a) => a.text).join(/^[\u3400-\u9fff]/u.test(segment[0].text) ? '' : ' ') });
        segment = [];
      };
      for (const word of parts) {
        const previous = segment[segment.length - 1];
        if (previous && word.x - previous.x - previous.w > Math.max(8, word.h * .9)) flush();
        segment.push(word);
      }
      flush();
    }
    return lines;
  }

  // Some Tesseract builds expose blocks or hOCR rather than TSV.
  const blockLines = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    // The 'blocks' tree often contains a large whole-line bbox as well as
    // precise word bboxes. Always descend to words; using the parent line box
    // is what accidentally selected 'as stakeholder' and 'Pay to landlord' together.
    if (node.lines?.length) return node.lines.forEach(walk);
    if (node.paragraphs?.length) return node.paragraphs.forEach(walk);
    if (node.blocks?.length) return node.blocks.forEach(walk);
    if (node.words?.length) return node.words.forEach(walk);
    const box = node.bbox;
    if (node.text?.trim() && box) blockLines.push({ text: node.text.trim(), x: box.x0, y: box.y0,
      w: box.x1 - box.x0, h: box.y1 - box.y0 });
  };
  walk(data.blocks || data.words || []);
  if (blockLines.length) return mergeOcrWordsIntoLines(blockLines);

  if (data.hocr) {
    const html = new DOMParser().parseFromString(data.hocr, 'text/html');
    const lines = [...html.querySelectorAll('.ocr_line, .ocrx_line')];
    return lines.map((node) => {
      const match = node.getAttribute('title')?.match(/bbox\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
      if (!match) return null;
      return { text: node.textContent?.trim(), x: +match[1], y: +match[2],
        w: +match[3] - +match[1], h: +match[4] - +match[2] };
    }).filter((b) => b?.text && b.w > 0 && b.h > 0);
  }
  return [];
}

function highContrastOcrCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const bins = new Uint32Array(256);
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = Math.round(pixels[i] * .299 + pixels[i + 1] * .587 + pixels[i + 2] * .114);
    bins[gray]++;
  }
  let lower = 0, upper = 255, total = canvas.width * canvas.height, cumulative = 0;
  while (lower < 255 && cumulative < total * .015) cumulative += bins[lower++];
  cumulative = 0;
  while (upper > lower && cumulative < total * .015) cumulative += bins[upper--];
  const delta = Math.max(1, upper - lower);
  for (let i = 0; i < pixels.length; i += 4) {
    const gray = pixels[i] * .299 + pixels[i + 1] * .587 + pixels[i + 2] * .114;
    // Contrast stretch preserves fine serifs better than a hard black/white threshold.
    const adjusted = clamp(Math.round((gray - lower) / delta * 255), 0, 255);
    pixels[i] = pixels[i + 1] = pixels[i + 2] = adjusted;
    pixels[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function nativeTextBoxes(page, content) {
  // Do not concatenate every fragment at the same Y coordinate. PDF forms
  // frequently have unrelated fields sharing a baseline but separated by
  // hundreds of pixels. Each PDF.js text item is an independent target.
  const viewport = page.getViewport({ scale: 1 });
  return content.items.filter((item) => item.str?.trim()).map((item) => {
    const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(matrix[2], matrix[3]);
    const style = content.styles?.[item.fontName] || {};
    const ascent = (typeof style.ascent === 'number' ? style.ascent : .82) * fontSize;
    return { text: item.str.trim(), x: matrix[4], y: matrix[5] - ascent,
      w: Math.max(5, item.width || item.str.length * fontSize * .48),
      h: Math.max(5, fontSize * 1.18) };
  });
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
  const button = $('ocrTool');
  button.disabled = true;
  busy(true, `OCR 第 ${pageIndex + 1} 页：正在初始化中英文识别引擎（首次使用需下载模型）…`);
  try {
    const worker = await getOcrWorker();
    busy(true, `OCR 第 ${pageIndex + 1} 页：正在渲染高清扫描图像…`);
    const pdfPage = await state.pdf.getPage(pageIndex + 1);
    const natural = pdfPage.getViewport({ scale: 1 });
    const maxPixels = window.matchMedia('(max-width: 900px)').matches ? 4_000_000 : 10_000_000;
    const upscale = Math.min(3, Math.sqrt(maxPixels / (natural.width * natural.height)));
    const viewport = pdfPage.getViewport({ scale: upscale });
    const ocrCanvas = document.createElement('canvas');
    ocrCanvas.width = Math.ceil(viewport.width);
    ocrCanvas.height = Math.ceil(viewport.height);
    const context = ocrCanvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, ocrCanvas.width, ocrCanvas.height);
    await pdfPage.render({ canvasContext: context, canvas: ocrCanvas, viewport,
      background: 'rgb(255,255,255)' }).promise;
    const outputs = { text: true, tsv: true, blocks: true, hocr: true };
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    busy(true, `OCR 第 ${pageIndex + 1} 页：正在定位中文、英文和数字的文字区域…`);
    let recognition = await worker.recognize(ocrCanvas, {}, outputs);
    let boxes = ocrBoxes(recognition);
    let sourceCanvas = ocrCanvas;
    if (!boxes.length) {
      busy(true, `普通 OCR 未识别到文字，正在尝试高对比度与稀疏文字模式（第 ${pageIndex + 1} 页）…`);
      sourceCanvas = highContrastOcrCanvas(ocrCanvas);
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      recognition = await worker.recognize(sourceCanvas, {}, outputs);
      boxes = ocrBoxes(recognition);
    }
    if (!boxes.length) {
      const content = state.textPages[pageIndex] || await pdfPage.getTextContent();
      const extracted = nativeTextBoxes(pdfPage, content);
      if (extracted.length) {
        boxes = extracted.map((box) => ({ ...box, x: box.x * upscale, y: box.y * upscale,
          w: box.w * upscale, h: box.h * upscale }));
      }
    }
    const hits = boxes.filter((b) => b.w > 2 && b.h > 2).map((box) => {
      const sampled = sampleTextStyle(ocrCanvas, box.x, box.y, box.w, box.h);
      return { kind: 'hit', fromOcr: true, page: pageIndex, text: box.text,
        x: box.x / ocrCanvas.width * natural.width, y: box.y / ocrCanvas.height * natural.height,
        width: box.w / ocrCanvas.width * natural.width, height: box.h / ocrCanvas.height * natural.height,
        fontSize: clamp(box.h / ocrCanvas.height * natural.height * .85, 6, 72),
        fontFamily: 'Arial, "Noto Sans SC", sans-serif', bold: false, italic: false,
        color: sampled.color, background: sampled.background };
    });
    if (!hits.length) return toast('两种 OCR 扫描模式均未定位到文字。可以使用「框选改字」直接修改扫描区域；签名不需要 OCR。', true);
    state.ocrPages.set(pageIndex, hits);
    renderOcrHits(pageIndex);
    if (state.ocrPages.size >= state.pdf.numPages) $('emptyTextWarning').classList.add('hidden');
    toast(`第 ${pageIndex + 1} 页文字定位完成：识别 ${hits.length} 个文字区域。点击文字修改；遗漏部分可用「框选改字」。`);
  } catch (error) {
    console.error(error);
    toast(`OCR 未完成：${error.message}。可直接使用「框选改字」或「手写签名」。`, true);
  } finally {
    button.disabled = false;
    busy(false);
  }
}

async function ocrSelectedRegion() {
  const selection = state.selected;
  if (!state.pdf || state.busy || selection?.kind !== 'hit') {
    return toast('请先点击「框选改字」，在 PDF 上框住一个单独的文字区域。', true);
  }
  if (!membership.guardUse()) return;
  busy(true, 'OCR 选区：正在载入文字识别引擎…');
  try {
    const worker = await getOcrWorker();
    const page = await state.pdf.getPage(selection.page + 1);
    const natural = page.getViewport({ scale: 1 });
    const zoom = Math.min(3.6, Math.sqrt(5_000_000 / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale: zoom });
    const x = clamp(Math.floor(selection.x * zoom) - 16, 0, viewport.width - 1);
    const y = clamp(Math.floor(selection.y * zoom) - 16, 0, viewport.height - 1);
    const w = clamp(Math.ceil(selection.width * zoom) + 32, 1, viewport.width - x);
    const h = clamp(Math.ceil(selection.height * zoom) + 32, 1, viewport.height - y);
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = Math.ceil(viewport.width);
    fullCanvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: fullCanvas.getContext('2d'), canvas: fullCanvas, viewport,
      background: 'rgb(255,255,255)' }).promise;
    const crop = document.createElement('canvas');
    crop.width = Math.round(w);
    crop.height = Math.round(h);
    crop.getContext('2d').drawImage(fullCanvas, x, y, w, h, 0, 0, crop.width, crop.height);
    busy(true, 'OCR 选区：正在识别所选文字，请稍候…');
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    let recognition = await worker.recognize(crop);
    if (!recognition.data.text?.trim()) {
      await worker.setParameters({ tessedit_pageseg_mode: '7' });
      recognition = await worker.recognize(highContrastOcrCanvas(crop));
    }
    const text = recognition.data.text?.trim().replace(/\s*\n\s*/g, ' ') || '';
    if (!text) return toast('选区 OCR 也没有识别结果。可以直接在编辑框输入你看到的文字。', true);
    $('editText').value = text;
    toast('已把选区识别结果填入编辑框。请校对后点击「应用修改」。');
  } catch (error) {
    console.error(error);
    toast(`选区 OCR 失败：${error.message}。请直接输入文字。`, true);
  } finally { busy(false); }
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
  $('regionTool').classList.toggle('selected', tool === 'region');
  $('signatureTool').classList.toggle('selected', tool === 'sign');
  document.querySelectorAll('.page-wrap').forEach(updatePageToolClass);
  $('editorHint').textContent = tool === 'add' ? '点击 PDF 页面添加文字'
    : tool === 'region' ? '按住鼠标或手指并拖动，框住扫描件上需要替换的旧文字'
      : tool === 'sign' ? '点击或轻触 PDF 页面放置手写签名，随后可拖动位置'
        : '点文字直接修改 · 扫描件可框选改字 · 手写签名无需 OCR';
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
  setPropertyDrawer(true);
  $('propertyStatus').textContent = hit.fromManual ? '手动框选区域' : hit.fromOcr ? 'OCR 识别文字' : '原有文字';
  $('deleteEdit').classList.add('hidden');
  $('eraseOriginal').classList.remove('hidden');
}

function selectPatch(id) {
  const patch = state.patchList.find((item) => item.id === id);
  if (!patch) return;
  state.selected = { kind: 'patch', id };
  setPropertyDrawer(true);
  if (patch.kind === 'signature') {
    $('noSelection').classList.add('hidden');
    $('propertiesForm').classList.remove('hidden');
    $('textPropertyFields').classList.add('hidden');
    $('signaturePropertyFields').classList.remove('hidden');
    $('signatureWidth').value = Math.round(patch.width);
    $('signatureSizeValue').textContent = `${Math.round(patch.width)} pt`;
  } else if (patch.kind === 'erase') {
    $('noSelection').classList.add('hidden');
    $('propertiesForm').classList.remove('hidden');
    $('textPropertyFields').classList.add('hidden');
    $('signaturePropertyFields').classList.add('hidden');
  } else showProperties(patch);
  $('propertyStatus').textContent = patch.kind === 'signature' ? '手写签名' : patch.kind === 'erase' ? '原字已遮盖' : patch.kind === 'replace' ? '文字替换' : '新增文字';
  $('deleteEdit').classList.remove('hidden');
  $('eraseOriginal').classList.add('hidden');
  document.querySelectorAll('.patch-item').forEach((node) => node.classList.toggle('active', node.dataset.patch === id));
}

function clearSelection() {
  state.selected = null;
  setPropertyDrawer(false);
  $('noSelection').classList.remove('hidden');
  $('propertiesForm').classList.add('hidden');
  $('propertyStatus').textContent = '无选中项目';
  $('eraseOriginal').classList.add('hidden');
  document.querySelectorAll('.patch-item.active').forEach((node) => node.classList.remove('active'));
}

function setPropertyDrawer(expanded) {
  const panel = document.querySelector('.properties');
  if (!panel) return;
  panel.classList.toggle('is-expanded', Boolean(expanded));
  const toggle = $('propertiesToggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(Boolean(expanded)));
    toggle.textContent = expanded ? '收起 ↑' : '展开 ↓';
  }
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
  $('matchNote').textContent = item.fromManual ? '手动框选的旧文字将使用选定底色遮盖，再绘制新文字。请确认范围和字号；复杂背景可能留下色块。' : item.fromOcr ? 'OCR 文字请先校对。遮盖扫描图片上的旧文字可能留下背景痕迹。' : item.kind === 'hit' || item.kind === 'replace' ? '尽量匹配字体和颜色，但特殊字体及复杂背景不保证完全一致。原文字没有被安全删除。' : '可在页面上拖动文字位置。导出时新文字将绘制到 PDF 内。';
}

// A blank replacement hides the selected visible glyphs. This is not secure
// redaction: the original PDF bytes and searchable text can remain embedded.
function eraseOriginalText() {
  if (state.selected?.kind !== 'hit') return;
  snapshot();
  const patch = { ...state.selected, id: newId(), kind: 'erase', text: '' };
  state.patchList.push(patch);
  state.selected = { kind: 'patch', id: patch.id };
  renderPatches();
  selectPatch(patch.id);
  setPropertyDrawer(false);
  toast('已遮盖原有文字。此操作不是不可恢复的安全涂黑；请保存 PDF。');
}

function fittedTextMetrics(patch) {
  const measure = document.createElement('canvas').getContext('2d');
  const text = patch.text || '';
  let size = patch.fontSize || 12;
  const family = patch.fontFamily || 'Arial, sans-serif';
  if (patch.kind === 'replace') {
    // The exact same constrained size is used on screen and at export.
    const maxWidth = Math.max(4, patch.width - 1);
    const maxHeight = Math.max(4, patch.height * 1.12);
    measure.font = `${patch.italic ? 'italic ' : ''}${patch.bold ? '700 ' : ''}${size}px ${family}`;
    const measured = Math.max(1, measure.measureText(text).width + 2);
    size *= Math.min(1, maxWidth / measured, maxHeight / (size * 1.3));
  }
  return { fontSize: Math.max(1, size), family };
}

function snapshot() {
  state.undoStack.push(clone(state.patchList));
  if (state.undoStack.length > 25) state.undoStack.shift();
  $('undoTool').disabled = false;
}

function applyEdit() {
  if (!state.selected) return;
  if (state.selected.kind === 'patch' && ['signature', 'erase'].includes(state.patchList.find((patch) => patch.id === state.selected.id)?.kind)) return;
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
  setPropertyDrawer(false);
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
  const scale = pageScale(wrap);
  for (const patch of state.patchList.filter((p) => p.page === pageIndex)) {
    const el = document.createElement('div');
    el.className = 'patch-item';
    if (state.selected?.id === patch.id) el.classList.add('active');
    el.dataset.patch = patch.id;
    el.style.left = `${patch.x * scale}px`;
    el.style.top = `${patch.y * scale}px`;
    el.style.minWidth = `${patch.kind === 'replace' || patch.kind === 'erase' ? patch.width * scale : 10}px`;
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
      const bounded = patch.kind === 'replace' || patch.kind === 'erase';
      if (bounded) {
        el.style.width = `${patch.width * scale}px`;
        el.style.height = `${patch.height * scale}px`;
        el.style.overflow = 'hidden';
        el.style.whiteSpace = 'nowrap';
      }
      el.style.backgroundColor = bounded ? patch.background : 'transparent';
      el.style.color = patch.color;
      const metrics = fittedTextMetrics(patch);
      el.style.font = `${patch.italic ? 'italic' : 'normal'} ${patch.bold ? '700' : '400'} ${metrics.fontSize * scale}px ${metrics.family}`;
      const text = document.createElement('span');
      text.textContent = patch.kind === 'erase' ? '' : patch.text;
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
  const saveSignature = () => {
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
    return true;
  };
  $('useSignature').onclick = () => {
    if (!saveSignature()) return;
    close(); setTool('sign');
    toast('已准备好签名。请在 PDF 上轻触或点击放置位置；不需要 OCR。');
  };
  $('placeSignatureNow').onclick = () => {
    if (!saveSignature()) return;
    const viewRect = $('canvasArea').getBoundingClientRect();
    const wraps = [...document.querySelectorAll('.page-wrap')];
    const wrap = wraps.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top < viewRect.bottom && rect.bottom > viewRect.top;
    }) || wraps[0];
    if (!wrap) return;
    const scale = pageScale(wrap);
    const pageWidth = wrap.clientWidth / scale, pageHeight = wrap.clientHeight / scale;
    const width = Math.min(170, pageWidth * .36);
    const height = width * state.signatureData.height / state.signatureData.width;
    const patch = { id: newId(), kind: 'signature', page: Number(wrap.dataset.page),
      x: pageWidth * .12, y: Math.min(pageHeight * .77, pageHeight - height - 10),
      width, height, image: state.signatureData.image, ratio: state.signatureData.height / state.signatureData.width };
    snapshot();
    state.patchList.push(patch);
    close(); setTool('edit'); renderPatches(); selectPatch(patch.id);
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('签名已直接放到本页。请拖动到正确位置，再点「保存 PDF」。');
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
      if (patch.kind === 'replace' || patch.kind === 'erase') {
        const hex = patch.background.replace('#', '');
        // Keep masking inside the selected field so adjacent labels survive.
        page.drawRectangle({ x: patch.x, y: pageHeight - patch.y - patch.height, width: patch.width, height: patch.height, color: rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255) });
      }
      if (patch.kind === 'erase') continue;
      const metrics = fittedTextMetrics(patch);
      const imageInfo = rasterizeText(patch.text, metrics.fontSize, patch.fontFamily, patch.color, patch.bold, patch.italic);
      const image = await pdf.embedPng(imageInfo.data);
      const fit = patch.kind === 'replace' ? Math.min(1, patch.width / imageInfo.width, patch.height / imageInfo.height) : 1;
      page.drawImage(image, { x: patch.x, y: pageHeight - patch.y - imageInfo.height * fit, width: imageInfo.width * fit, height: imageInfo.height * fit });
    }
    const result = await pdf.save();
    busy(false);
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

// Editable Word: retain the original page coordinate, text runs and vertical
// gaps instead of reflowing every extracted line into ordinary paragraphs.
function pdfLayoutLines(page, content) {
  const viewport = page.getViewport({ scale: 1 });
  const lines = [];
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontSize = clamp(Math.hypot(matrix[2], matrix[3]), 5, 56);
    const x = matrix[4];
    const y = matrix[5] - fontSize * .9;
    const existing = lines.find((line) => Math.abs(line.y - y) < Math.max(2.2, fontSize * .22));
    const run = { text: item.str, x, width: Math.max(0, item.width || 0),
      fontSize, fontName: item.fontName || '' };
    if (existing) {
      existing.parts.push(run);
      existing.x = Math.min(existing.x, x);
      existing.fontSize = Math.max(existing.fontSize, fontSize);
    } else lines.push({ x, y, fontSize, parts: [run] });
  }
  return lines.sort((a, b) => a.y - b.y).map((line) => {
    line.parts.sort((a, b) => a.x - b.x);
    return line;
  });
}

async function pdfToWord(file) {
  try {
    const mode = document.querySelector('input[name="pdfMode"]:checked')?.value || 'visual';
    busy(true, mode === 'visual' ? '正在逐页渲染 PDF，以原版面制作 Word…' : '正在提取 PDF 文字并生成可编辑 DOCX…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const input = await pdfjsLib.getDocument({ data: bytes, ...pdfAssetOptions }).promise;
    const result = mode === 'editable'
      ? await pdfToPositionedWord(input)
      : await pdfToVisualPageWord(input);
    busy(false);
    if (!await membership.authorizeExport('pdf_to_word')) return;
    downloadBlob(result.blob, `${safeFileName(file.name)}_${mode === 'visual' ? '原貌保真版' : '固定版式可编辑'}.docx`);
    toast(mode === 'visual' ? `已生成 ${result.pages} 页原貌 Word（每页图像；文字不可编辑）。`
      : `已生成 ${result.pages} 页、${result.chars} 个可编辑字符。文字固定位置，修改过长内容可能溢出。`);
  } catch (error) { console.error(error); toast(`PDF 转 Word 失败：${error.message}`, true); }
  finally { busy(false); }
}

async function pdfToVisualPageWord(input) {
  const docx = window.docx;
  const paragraphs = [];
  const frames = [];
  let widthPt, heightPt;
  for (let pageNumber = 1; pageNumber <= input.numPages; pageNumber++) {
    busy(true, `PDF → Word：正在渲染第 ${pageNumber} / ${input.numPages} 页（原貌保真）…`);
    const page = await input.getPage(pageNumber);
    const size = page.getViewport({ scale: 1 });
    if (pageNumber === 1) { widthPt = size.width; heightPt = size.height; }
    if (Math.abs(widthPt - size.width) > 1 || Math.abs(heightPt - size.height) > 1) {
      throw new Error('PDF 含不同纸张尺寸，当前模式只能按统一纸张输出。');
    }
    const viewport = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport,
      background: 'rgb(255,255,255)' }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .94));
    if (!blob) throw new Error('无法生成页面图像');
    const image = new Uint8Array(await blob.arrayBuffer());
    paragraphs.push(new docx.Paragraph({ children: [new docx.ImageRun({ type: 'jpg', data: image,
      transformation: { width: widthPt * 96 / 72, height: heightPt * 96 / 72 } })],
      spacing: { before: 0, after: 0 } }));
    frames.push({ x: 0, y: 0, w: widthPt, h: heightPt });
    if (pageNumber % 3 === 0) await wait(0);
  }
  return { blob: await packWordWithFrames(paragraphs, frames, widthPt, heightPt), pages: input.numPages };
}

// In editable mode, reconstruct text as page-anchored Word frames. Unlike
// ordinary Word paragraphs, independent frames do not reflow the rest of a
// fixed-layout contract when a preceding line wraps. The page image preserves
// drawings and tables; native PDF text is removed from the image and added
// back as editable Word text. Very intricate backgrounds still need review.
async function pdfToPositionedWord(input) {
  const paragraphs = [];
  const frames = [];
  let chars = 0;
  let widthPt = 595.28, heightPt = 841.89;
  const docx = window.docx;
  for (let pageNumber = 1; pageNumber <= input.numPages; pageNumber++) {
    busy(true, `PDF → Word：第 ${pageNumber} / ${input.numPages} 页，重建文字定位…`);
    const page = await input.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    if (pageNumber === 1) { widthPt = natural.width; heightPt = natural.height; }
    if (Math.abs(widthPt - natural.width) > 1 || Math.abs(heightPt - natural.height) > 1) {
      throw new Error('此 PDF 含不同纸张尺寸。固定版式可编辑模式暂不支持混合尺寸，请使用保真模式。');
    }
    const content = await page.getTextContent();
    // One anchored Word frame per PDF text fragment. The old algorithm joined
    // separate labels sharing one baseline into a single unspaced paragraph,
    // causing large shifts in contracts and tables.
    const textItems = content.items.filter((item) => item.str?.trim());

    const scale = Math.min(1.8, Math.sqrt(5_000_000 / (natural.width * natural.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, canvas, viewport,
      background: 'rgb(255,255,255)' }).promise;
    for (const item of content.items) {
      if (!item.str?.trim()) continue;
      const matrix = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(matrix[2], matrix[3]);
      const fontStyle = content.styles[item.fontName] || {};
      const ascent = (typeof fontStyle.ascent === 'number' ? fontStyle.ascent : .82) * height;
      const x = matrix[4];
      const y = matrix[5] - ascent;
      const w = Math.max(2, item.width * scale);
      if (x + w < 0 || y + height < 0 || x > canvas.width || y > canvas.height) continue;
      const sampled = sampleTextStyle(canvas, clamp(x, 0, canvas.width - 1),
        clamp(y, 0, canvas.height - 1), w, height);
      context.fillStyle = sampled.background;
      // A small inset keeps box borders and underlines outside the glyph area.
      context.fillRect(x - .5, y + height * .06, w + 1, height * .89);
    }
    const imageBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .94));
    if (!imageBlob) throw new Error('页面背景处理失败');
    const imageData = new Uint8Array(await imageBlob.arrayBuffer());
    paragraphs.push(new docx.Paragraph({
      children: [new docx.ImageRun({ type: 'jpg', data: imageData,
        transformation: { width: widthPt * 96 / 72, height: heightPt * 96 / 72 } })],
      spacing: { before: 0, after: 0 },
    }));
    frames.push({ x: 0, y: 0, w: widthPt, h: heightPt });
    for (const item of textItems) {
      const transform = pdfjsLib.Util.transform(natural.transform, item.transform);
      const fontSize = clamp(Math.hypot(transform[2], transform[3]), 5, 56);
      const style = content.styles?.[item.fontName] || {};
      const ascent = (typeof style.ascent === 'number' ? style.ascent : .82) * fontSize;
      const x = Math.max(0, transform[4]);
      const y = Math.max(0, transform[5] - ascent);
      const width = Math.max(9, item.width || item.str.length * fontSize * .48);
      chars += item.str.length;
      const familyName = style.fontFamily || item.fontName || '';
      paragraphs.push(new docx.Paragraph({ children: [new docx.TextRun({
        text: item.str, size: Math.round(fontSize * 2),
        font: familyForPdf(familyName).includes('Georgia') ? 'Times New Roman' : 'Arial',
        bold: /bold|black|heavy/i.test(familyName),
        italics: /italic|oblique/i.test(familyName),
      })], spacing: { before: 0, after: 0, line: Math.round(fontSize * 1.16 * 20), lineRule: 'exact' } }));
      // The small buffer accommodates Word's different font metrics without
      // allowing unrelated text farther right to join this edit box.
      frames.push({ x, y, w: Math.min(widthPt - x, width + Math.max(5, fontSize * .65)),
        h: Math.max(13, fontSize * 1.75) });
    }
    if (pageNumber % 2 === 0) await wait(0);
  }
  if (!chars) throw new Error('此文件是纯扫描图像，没有可编辑文字层。请先在 PDF 编辑器用 OCR/框选改字，或选择原貌保真模式。');
  return { blob: await packWordWithFrames(paragraphs, frames, widthPt, heightPt),
    pages: input.numPages, chars };
}

async function packWordWithFrames(paragraphs, frames, widthPt, heightPt) {
  const docx = window.docx;
  const pageProps = { type: docx.SectionType.NEXT_PAGE, page: {
    size: { width: Math.round(widthPt * 20), height: Math.round(heightPt * 20) },
    margin: { left: 0, right: 0, top: 0, bottom: 0 },
  } };
  // Anchored paragraphs do not advance the Word body's pagination. An
  // ordinary break paragraph adds a blank page in some Word viewers. Give
  // each source PDF page its own next-page DOCX section instead.
  const groups = [];
  for (let index = 0; index < frames.length; index++) {
    const rect = frames[index];
    if (rect && rect.x === 0 && rect.y === 0 &&
        Math.abs(rect.w - widthPt) < .1 && Math.abs(rect.h - heightPt) < .1) {
      groups.push([]);
    }
    if (!groups.length) throw new Error('Word 逐页定位缺少背景起点');
    groups[groups.length - 1].push(paragraphs[index]);
  }
  const wordDoc = new docx.Document({ sections: groups.map((children) => ({ properties: pageProps, children })) });
  const originalBlob = await docx.Packer.toBlob(wordDoc);
  const archive = await window.JSZip.loadAsync(originalBlob);
  const xmlFile = archive.file('word/document.xml');
  if (!xmlFile) throw new Error('无法写入 Word 页面位置');
  const dom = new DOMParser().parseFromString(await xmlFile.async('string'), 'application/xml');
  const wordNs = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = dom.getElementsByTagNameNS(wordNs, 'body')[0];
  const nodes = [...body.children].filter((el) => el.localName === 'p' && !(
    el.getElementsByTagNameNS(wordNs, 'sectPr').length &&
    !el.getElementsByTagNameNS(wordNs, 'r').length));
  if (nodes.length !== frames.length) throw new Error('Word 版面锚点数量不一致');
  for (let index = 0; index < nodes.length; index++) {
    const pos = frames[index];
    if (!pos) continue;
    const paragraph = nodes[index];
    let properties = [...paragraph.children].find((el) => el.localName === 'pPr');
    if (!properties) {
      properties = dom.createElementNS(wordNs, 'w:pPr');
      paragraph.insertBefore(properties, paragraph.firstChild);
    }
    const frame = dom.createElementNS(wordNs, 'w:framePr');
    for (const [name, value] of Object.entries({ x: Math.round(pos.x * 20), y: Math.round(pos.y * 20),
      w: Math.round(pos.w * 20), h: Math.round(pos.h * 20),
      hAnchor: 'page', vAnchor: 'page', wrap: 'none' })) {
      frame.setAttributeNS(wordNs, `w:${name}`, String(value));
    }
    properties.insertBefore(frame, properties.firstChild);
  }
  archive.file('word/document.xml', new XMLSerializer().serializeToString(dom));
  return archive.generateAsync({ type: 'blob', compression: 'DEFLATE' });
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

let docxPreviewLoader;
let htmlCanvasLoader;
function externalLibrary(src, isReady) {
  if (isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.onload = () => isReady() ? resolve() : reject(new Error('转换排版引擎加载不完整'));
    script.onerror = () => reject(new Error('在线增强排版组件暂不可用'));
    document.head.append(script);
  });
}

async function loadDocxPreview() {
  if (!docxPreviewLoader) docxPreviewLoader = (async () => {
    // Both libraries use the global name `docx`; keep the existing DOCX writer.
    const writer = window.docx;
    try {
      await externalLibrary('https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/dist/docx-preview.min.js',
        () => window.docx?.renderAsync && window.docx !== writer);
      return window.docx;
    } finally { window.docx = writer; }
  })().catch((error) => { docxPreviewLoader = null; throw error; });
  return docxPreviewLoader;
}

async function loadHtmlCanvas() {
  if (!htmlCanvasLoader) htmlCanvasLoader = externalLibrary(
    'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    () => typeof window.html2canvas === 'function'
  ).catch((error) => { htmlCanvasLoader = null; throw error; });
  await htmlCanvasLoader;
}

async function wordPageDefinition(arrayBuffer) {
  const zip = await window.JSZip.loadAsync(arrayBuffer.slice(0));
  const xml = zip.file('word/document.xml');
  if (!xml) throw new Error('DOCX 缺少页面定义');
  const dom = new DOMParser().parseFromString(await xml.async('string'), 'text/xml');
  const pages = [...dom.getElementsByTagNameNS('*', 'pgSz')];
  const size = pages[pages.length - 1];
  const widthTwips = Number(wordAttr(size, 'w')) || 11906;
  const heightTwips = Number(wordAttr(size, 'h')) || 16838;
  const paragraphs = [...dom.getElementsByTagNameNS('*', 'p')];
  const starts = paragraphs.filter((p) => {
    const props = wordChildren(p, 'pPr')[0];
    return Boolean(wordFirst(props, 'pageBreakBefore')) ||
      [...p.getElementsByTagNameNS('*', 'br')].some((b) => wordAttr(b, 'type') === 'page');
  }).length;
  return { widthPx: widthTwips / 15, heightPx: heightTwips / 15, explicitBreaks: starts };
}

async function renderDocxToPdf(file) {
  busy(true, 'Word → PDF：正在加载文档排版组件…');
  const preview = await loadDocxPreview();
  await loadHtmlCanvas();
  const sourceBytes = await file.arrayBuffer();
  const documentPage = await wordPageDefinition(sourceBytes);
  const host = document.createElement('div');
  host.className = 'docx-render-host';
  // html2canvas cannot safely capture a document placed thousands of pixels
  // outside the viewport (a frequent cause of completely white exports).
  // Keep the capture stage in the viewport and beneath the processing modal.
  // A negative stacking level can also cause the renderer to omit its content.
  host.style.cssText = 'position:fixed;left:0;top:0;width:max-content;z-index:70;pointer-events:none;isolation:isolate';
  document.body.append(host);
  try {
    busy(true, 'Word → PDF：正在还原 DOCX 样式、表格及图片…');
    await preview.renderAsync(sourceBytes.slice(0), host, null, {
      inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: false,
      renderHeaders: true, renderFooters: true, renderComments: false,
    });
    await document.fonts.ready;
    await Promise.all([...host.querySelectorAll('img')].map((img) => img.complete ? Promise.resolve()
      : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4500); })));
    const sections = [...host.querySelectorAll('section.docx')];
    if (!sections.length) throw new Error('未能读取 Word 页面');
    // An explicit Word page break is a mandatory page boundary. If the HTML
    // renderer ignored it, we must not silently produce a merged-page PDF.
    if (documentPage.explicitBreaks > 0 && sections.length < documentPage.explicitBreaks + 1) {
      throw new Error(`原 Word 有 ${documentPage.explicitBreaks + 1} 个明确分页区域，但浏览器仅还原 ${sections.length} 页。为避免合并原文页，已取消转换；可使用 Word 的「另存为 PDF」保留完全一致的分页。`);
    }
    const pdf = await PDFDocument.create();
    for (let index = 0; index < sections.length; index++) {
      const element = sections[index];
      if (element.clientWidth < 10 || element.clientHeight < 10) throw new Error('页面没有有效尺寸');
      // Read the physical page size from the DOCX (w:pgSz). Using a section's
      // scrollHeight as its page size previously swallowed the following page.
      const pageCssHeight = Math.max(120, documentPage.heightPx * element.clientWidth / documentPage.widthPx);
      const contentHeight = Math.max(element.scrollHeight, element.clientHeight);
      // When docx-preview has already made explicit page sections, each
      // section is exactly one paper sheet, even when child overflow is noisy.
      const paginatedSections = documentPage.explicitBreaks > 0 || sections.length > 1;
      const sectionsToPrint = paginatedSections ? 1 : Math.max(1, Math.ceil((contentHeight - 3) / pageCssHeight));
      if (sectionsToPrint > 120) throw new Error('Word 内容超出可转换页数');
      for (let slice = 0; slice < sectionsToPrint; slice++) {
        busy(true, `Word → PDF：正在绘制第 ${index + 1} 个章节 · 第 ${slice + 1} / ${sectionsToPrint} 页…`);
        const yOffset = slice * pageCssHeight;
        const sliceHeight = pageCssHeight;
        // Prevent content from neighboring Word pages painting over the page
        // snapshot. Keep layout dimensions unchanged except the clip region.
        if (paginatedSections) {
          element.style.overflow = 'hidden';
          element.style.height = `${pageCssHeight}px`;
        }
        const canvas = await window.html2canvas(element, {
          scale: Math.min(1.6, Math.max(1.1, 1280 / element.clientWidth)),
          x: 0, y: yOffset, width: element.clientWidth,
          height: sliceHeight, backgroundColor: '#ffffff', useCORS: false, logging: false,
          scrollX: 0, scrollY: 0,
          windowWidth: Math.max(window.innerWidth, element.scrollWidth + 16),
          windowHeight: Math.max(window.innerHeight, Math.ceil(pageCssHeight) + 16),
        });
        if (!canvas.width || !canvas.height) throw new Error('Word 页面截图为空');
        // Fail closed: don't charge an export or download an empty document.
        const check = document.createElement('canvas');
        check.width = 100; check.height = 100;
        check.getContext('2d').drawImage(canvas, 0, 0, 100, 100);
        const pixels = check.getContext('2d').getImageData(0, 0, 100, 100).data;
        let ink = 0;
        for (let j = 0; j < pixels.length; j += 4) {
          if (Math.min(pixels[j], pixels[j + 1], pixels[j + 2]) < 238) ink++;
        }
        if (ink < 3 && (element.innerText?.trim() || element.querySelector('img,svg,canvas'))) {
          throw new Error(`第 ${index + 1} 个章节第 ${slice + 1} 页渲染为空白。已取消导出以避免生成丢字文件。`);
        }
        const jpg = await pdf.embedJpg(canvas.toDataURL('image/jpeg', .92));
        const pageWidth = element.clientWidth * .75, pageHeight = pageCssHeight * .75;
        const target = pdf.addPage([pageWidth, pageHeight]);
        target.drawImage(jpg, { x: 0, y: pageHeight - sliceHeight * .75,
          width: pageWidth, height: sliceHeight * .75 });
      }
    }
    if (!pdf.getPageCount()) throw new Error('没有可导出的 Word 页面');
    return { bytes: await pdf.save(), pages: pdf.getPageCount() };
  } finally { host.remove(); }
}

async function wordToPdf(file) {
  busy(true, '正在用增强版面引擎处理 Word（首次需要下载组件）…');
  try {
    const result = await renderDocxToPdf(file);
    busy(false);
    if (!await membership.authorizeExport('word_to_pdf')) return;
    downloadBlob(new Blob([result.bytes], { type: 'application/pdf' }), `${safeFileName(file.name)}.pdf`);
    toast(`已生成 ${result.pages} 页 PDF。新版尝试保留段落、表格与页眉页脚；复杂 Word 仍建议用原软件导出。`);
  } catch (error) {
    console.error('Word 版面处理失败', error);
    toast(`Word 转 PDF 未导出：${error.message}。已停止低保真回退，避免交付空白或严重走版文件。`, true);
  } finally { busy(false); }
}

async function legacyWordToPdf(file) {
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
  const installButton = document.createElement('button');
  installButton.id = 'installApp';
  installButton.className = 'install-app-btn';
  installButton.type = 'button';
  installButton.textContent = '安装 App';
  installButton.onclick = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      installPrompt = null;
    } else {
      toast(/iPad|iPhone|iPod/.test(navigator.userAgent)
        ? 'iPhone / iPad：请在 Safari 点击「分享」→「添加到主屏幕」。'
        : '请在 Chrome / Edge 浏览器菜单选择「安装应用」或「添加到主屏幕」。');
    }
  };
  document.querySelector('.top-actions').insertBefore(installButton, $('accountBtn'));
  const eraseButton = document.createElement('button');
  eraseButton.id = 'eraseOriginal';
  eraseButton.type = 'button';
  eraseButton.className = 'delete-btn hidden';
  eraseButton.textContent = '仅删除原有文字（遮盖）';
  eraseButton.title = '遮盖选中原字，不会永久删除 PDF 底层文本；需要安全涂黑请使用专业脱敏工具。';
  $('applyEdit').insertAdjacentElement('afterend', eraseButton);
  const drawerButton = document.createElement('button');
  drawerButton.id = 'propertiesToggle';
  drawerButton.type = 'button';
  drawerButton.className = 'properties-toggle';
  drawerButton.textContent = '展开 ↓';
  drawerButton.setAttribute('aria-controls', 'propertiesForm');
  drawerButton.setAttribute('aria-expanded', 'false');
  drawerButton.onclick = () => setPropertyDrawer(!document.querySelector('.properties').classList.contains('is-expanded'));
  document.querySelector('.property-top').append(drawerButton);
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
  $('regionTool').onclick = () => setTool('region');
  $('ocrTool').onclick = ocrVisiblePage;
  $('ocrSelectionTool').onclick = ocrSelectedRegion;
  $('applyEdit').onclick = applyEdit;
  $('eraseOriginal').onclick = eraseOriginalText;
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
  for (const id of ['topOpen', 'topExport', 'editorExport', 'applyEdit', 'eraseOriginal', 'deleteEdit', 'zoomIn', 'zoomOut', 'signatureTool']) $(id).dataset.busyLock = '1';
}

init();
membership.init();
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js')
    .catch((error) => console.warn('离线 App 缓存暂不可用', error)));
}
