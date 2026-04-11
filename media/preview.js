const vscode = acquireVsCodeApi();

const container = document.getElementById('pdf-container');
const loadingEl = document.getElementById('loading');

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

async function renderPdf(data) {
  const pdfjsLib = await import(window.__pdfjsLibUrl);
  pdfjsLib.GlobalWorkerOptions.workerSrc = window.__pdfjsWorkerUrl;

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    showError(`Failed to load PDF: ${err && err.message ? err.message : String(err)}`);
    return;
  }

  window.__pdfTotalPages = pdf.numPages;

  if (loadingEl && loadingEl.parentNode) {
    loadingEl.parentNode.removeChild(loadingEl);
  }

  const scale = 1.5;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
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

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();
  }
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
  }
});

vscode.postMessage({ type: 'ready' });
