const vscode = acquireVsCodeApi();

const container = document.getElementById('pdf-container');
const loadingEl = document.getElementById('loading');

const BASE_SCALE = 1.5;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4.0;
const SCALE_STEP = 0.25;

let pdfjsLib = null;
let pdfDocument = null;
let currentScale = BASE_SCALE;
let renderToken = 0;

const zoomBar = document.createElement('div');
zoomBar.id = 'zoom-bar';
const zoomOutBtn = document.createElement('button');
zoomOutBtn.type = 'button';
zoomOutBtn.textContent = '\u2212';
zoomOutBtn.title = 'Zoom out';
const zoomLabel = document.createElement('span');
zoomLabel.className = 'zoom-label';
const zoomInBtn = document.createElement('button');
zoomInBtn.type = 'button';
zoomInBtn.textContent = '+';
zoomInBtn.title = 'Zoom in';
const zoomResetBtn = document.createElement('button');
zoomResetBtn.type = 'button';
zoomResetBtn.textContent = 'Reset';
zoomResetBtn.title = 'Reset zoom';
zoomBar.append(zoomOutBtn, zoomLabel, zoomInBtn, zoomResetBtn);
document.body.appendChild(zoomBar);

zoomBar.addEventListener('mousedown', (e) => {
  e.preventDefault();
});

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round((currentScale / BASE_SCALE) * 100)}%`;
}

function setScale(newScale) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
  if (Math.abs(clamped - currentScale) < 0.001) {
    return;
  }
  currentScale = clamped;
  updateZoomLabel();
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
  }
  hideBar();
  if (pdfDocument) {
    renderAllPages().catch((err) => {
      showError(`Failed to render PDF: ${err && err.message ? err.message : String(err)}`);
    });
  }
}

zoomOutBtn.addEventListener('click', () => setScale(currentScale - SCALE_STEP));
zoomInBtn.addEventListener('click', () => setScale(currentScale + SCALE_STEP));
zoomResetBtn.addEventListener('click', () => setScale(BASE_SCALE));
updateZoomLabel();

document.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) {
      return;
    }
    e.preventDefault();
    const delta = e.deltaY > 0 ? -SCALE_STEP : SCALE_STEP;
    setScale(currentScale + delta);
  },
  { passive: false }
);

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) {
    return;
  }
  if (e.key === '=' || e.key === '+') {
    e.preventDefault();
    setScale(currentScale + SCALE_STEP);
  } else if (e.key === '-') {
    e.preventDefault();
    setScale(currentScale - SCALE_STEP);
  } else if (e.key === '0') {
    e.preventDefault();
    setScale(BASE_SCALE);
  }
});

const askBar = document.createElement('div');
askBar.id = 'ask-bar';
askBar.dataset.enabled = 'true';
const claudeBtn = document.createElement('button');
claudeBtn.type = 'button';
claudeBtn.textContent = 'Claude';
askBar.appendChild(claudeBtn);
document.body.appendChild(askBar);

askBar.addEventListener('mousedown', (e) => {
  e.preventDefault();
});

function findPageElement(node) {
  let el = node && node.nodeType === 1 ? node : node && node.parentElement;
  while (el && !(el.classList && el.classList.contains('pdf-page'))) {
    el = el.parentElement;
  }
  return el;
}

function selectionPageRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null;
  }
  const text = sel.toString();
  if (!text.trim()) {
    return null;
  }
  const anchorPage = findPageElement(sel.anchorNode);
  const focusPage = findPageElement(sel.focusNode);
  if (!anchorPage || !focusPage) {
    return null;
  }
  const a = Number(anchorPage.dataset.page);
  const b = Number(focusPage.dataset.page);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }
  return { text, startPage: Math.min(a, b), endPage: Math.max(a, b) };
}

function hideBar() {
  askBar.style.display = 'none';
}

function updateBar() {
  if (askBar.dataset.enabled !== 'true') {
    hideBar();
    return;
  }
  const info = selectionPageRange();
  if (!info) {
    hideBar();
    return;
  }
  const sel = window.getSelection();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideBar();
    return;
  }
  askBar.style.display = 'block';
  const barWidth = askBar.offsetWidth;
  const barHeight = askBar.offsetHeight;
  const top = window.scrollY + rect.top - barHeight - 6;
  const centered = window.scrollX + rect.left + rect.width / 2 - barWidth / 2;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - barWidth - 4;
  askBar.style.top = `${Math.max(top, window.scrollY + 4)}px`;
  askBar.style.left = `${Math.max(window.scrollX + 4, Math.min(centered, maxLeft))}px`;
}

let selectionTimer = null;
function scheduleBarUpdate() {
  if (selectionTimer !== null) {
    clearTimeout(selectionTimer);
  }
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    updateBar();
  }, 100);
}

document.addEventListener('selectionchange', scheduleBarUpdate);
document.addEventListener('mouseup', scheduleBarUpdate);

claudeBtn.addEventListener('click', () => {
  const info = selectionPageRange();
  if (!info) {
    return;
  }
  vscode.postMessage({
    type: 'askClaude',
    text: info.text,
    startPage: info.startPage,
    endPage: info.endPage,
  });
  hideBar();
});

function showError(message) {
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'error';
  div.textContent = message;
  container.appendChild(div);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function renderAllPages() {
  if (!pdfDocument || !pdfjsLib) {
    return;
  }
  const token = ++renderToken;

  const prevHeight = document.documentElement.scrollHeight || 1;
  const scrollRatio = window.scrollY / prevHeight;

  container.innerHTML = '';

  const scale = currentScale;

  for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
    if (token !== renderToken) {
      return;
    }
    const page = await pdfDocument.getPage(pageNum);
    if (token !== renderToken) {
      return;
    }
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.dataset.page = String(pageNum);
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const ctx = canvas.getContext('2d');
    const transform = ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null;
    pageDiv.appendChild(canvas);

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
    pageDiv.appendChild(textLayerDiv);

    container.appendChild(pageDiv);

    const label = document.createElement('div');
    label.className = 'page-label';
    label.textContent = `Page ${pageNum}`;
    container.appendChild(label);

    await page.render({ canvasContext: ctx, viewport, transform }).promise;
    if (token !== renderToken) {
      return;
    }

    const textContent = await page.getTextContent();
    if (token !== renderToken) {
      return;
    }
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();
    if (token !== renderToken) {
      return;
    }
  }

  const newHeight = document.documentElement.scrollHeight;
  window.scrollTo(0, scrollRatio * newHeight);
}

async function renderPdf(data) {
  pdfjsLib = await import(window.__pdfjsLibUrl);
  pdfjsLib.GlobalWorkerOptions.workerSrc = window.__pdfjsWorkerUrl;

  try {
    pdfDocument = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    showError(`Failed to load PDF: ${err && err.message ? err.message : String(err)}`);
    return;
  }

  window.__pdfTotalPages = pdfDocument.numPages;

  if (loadingEl && loadingEl.parentNode) {
    loadingEl.parentNode.removeChild(loadingEl);
  }

  await renderAllPages();
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') {
    return;
  }
  if (msg.type === 'pdfData') {
    const bytes = base64ToUint8Array(msg.data);
    renderPdf(bytes).catch((err) => {
      showError(`Failed to render PDF: ${err && err.message ? err.message : String(err)}`);
    });
    return;
  }
  if (msg.type === 'updateShowFloatingButton') {
    askBar.dataset.enabled = msg.enabled ? 'true' : 'false';
    if (!msg.enabled) {
      hideBar();
    }
    return;
  }
});

vscode.postMessage({ type: 'ready' });
