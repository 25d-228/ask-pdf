# PDF Extraction Libraries Analysis

An analysis of what pdf.js can and cannot extract, and what external tools exist to fill the gaps. Written for the ask-pdf VS Code extension, which needs to extract maximum structured content from academic PDFs (papers with figures, tables, formulas, multi-column layouts, captions, references).

---

## 1. What pdf.js already gives us

pdf.js exposes rich per-page data through several APIs. This is the baseline — everything listed here is already available in the extension's webview without any external dependency.

### Document-level

| API                    | Returns                                                              |
|------------------------|----------------------------------------------------------------------|
| `pdf.getMetadata()`    | `{ info: { Title, Author, Creator, Producer, CreationDate, ... } }`  |
| `pdf.getOutline()`     | `[{ title, dest, items: [...] }]` — TOC / bookmarks, nested         |
| `pdf.getPageLabels()`  | `string[] | null` — custom page numbering                            |
| `pdf.getPageMode()`    | `string` — UseOutlines, UseThumbs, FullScreen, etc.                  |
| `pdf.getMarkInfo()`    | `{ Marked, UserProperties, Suspects } | null`                        |
| `pdf.getAttachments()` | `{ name: { filename, content } } | null`                             |
| `pdf.numPages`         | Total page count                                                     |

### Page-level

| API                               | Returns                                                                     |
|------------------------------------|-----------------------------------------------------------------------------|
| `page.getViewport({ scale })`     | `{ width, height, rotation, transform }`                                    |
| `page.getTextContent(opts)`       | `{ items: TextItem[], styles: {} }` — see below                             |
| `page.getStructTree()`            | Structural tag tree (only if PDF is tagged — most are not)                   |
| `page.getAnnotations()`           | `[{ subtype, rect, url, dest, contents, ... }]`                             |
| `page.getOperatorList()`          | `{ fnArray: number[], argsArray: any[][] }` — every drawing command          |
| `page.streamTextContent(opts)`    | `ReadableStream<TextContent>` �� incremental version of getTextContent        |
| `page.render(params)`             | Renders to canvas or SVG                                                     |

### TextItem fields

Each item from `getTextContent()`:

| Field       | Type          | Description                                                |
|-------------|---------------|------------------------------------------------------------|
| `str`       | `string`      | The actual text                                            |
| `dir`       | `'ltr'|'rtl'` | Text direction                                             |
| `width`     | `number`      | Rendered width in PDF points                               |
| `height`    | `number`      | Font size in PDF points (0 for whitespace-only items)      |
| `transform` | `number[6]`   | Affine transform — `[4]` = x position, `[5]` = y position |
| `fontName`  | `string`      | Key into styles dict (internal ID like `g_d0_f1`)          |
| `hasEOL`    | `boolean`     | True if this item ends a line                              |

With `{ includeMarkedContent: true }`, items can also be `beginMarkedContent` / `endMarkedContent` structure tags (if the PDF is tagged).

### Styles dict

Keyed by `fontName`:

| Field        | Type      | Description                    |
|--------------|-----------|--------------------------------|
| `fontFamily` | `string`  | `'serif'`, `'sans-serif'`, `'monospace'` |
| `ascent`     | `number`  | Font ascent ratio              |
| `descent`    | `number`  | Font descent ratio             |
| `vertical`   | `boolean` | Vertical text mode             |

### Operator list — the raw drawing commands

The operator list is every drawing command the PDF renderer executes. The most relevant ops for content extraction:

**Image ops:**

| Op                            | Args                               | Description                          |
|-------------------------------|-------------------------------------|--------------------------------------|
| `paintImageXObject` (85)      | `[objId, width, height]`           | Reference to an image XObject. Pixel data via `page.objs.get(objId)` → `{ data: Uint8ClampedArray, width, height, kind }`. Kind: 1=GRAYSCALE, 2=RGB, 3=RGBA. |
| `paintInlineImageXObject` (86)| `[{ data, width, height, kind }]`  | Inline image — pixel data directly in args |
| `paintImageMaskXObject`       | `[...]`                            | Single-bit mask image                |
| `paintImageXObjectRepeat`     | `[...]`                            | Tiled/repeated image                 |

**Path/shape ops (for table/diagram detection):**

| Op                    | Args                              | Description                                     |
|-----------------------|-----------------------------------|-------------------------------------------------|
| `constructPath` (91)  | `[subOps[], coordArgs[]]`        | Packed path: moveTo (1), lineTo (2), curveTo (3), rect (5) |
| `stroke`              | —                                 | Stroke the current path                          |
| `fill` / `eoFill`    | —                                 | Fill the current path                            |

**Text ops** (handled by `getTextContent`, but also visible in the op list):

`beginText`, `endText`, `setFont`, `moveText`, `showText`, `showSpacedText`, etc.

### Annotations

Each annotation from `getAnnotations()`:

| Field      | Type       | Description                          |
|------------|------------|--------------------------------------|
| `subtype`  | `string`   | `'Link'`, `'Text'`, `'Widget'`, etc. |
| `rect`     | `number[]` | `[x1, y1, x2, y2]` bounding box     |
| `url`      | `string?`  | For Link annotations                 |
| `dest`     | `any?`     | Internal destination (named or array) |
| `contents` | `string?`  | Annotation body text                 |

---

## 2. What pdf.js cannot do

These are the gaps. pdf.js gives us raw positioned elements but no higher-level semantic understanding:

| Gap                              | Description                                                                |
|----------------------------------|----------------------------------------------------------------------------|
| **Table detection/extraction**   | Tables are just positioned text + lines. No API to identify or extract them. |
| **Column layout detection**      | Two-column academic papers produce interleaved text items. No column separation. |
| **Reading order**                | Text items are in rendering order, not reading order. For multi-column layouts, this is wrong. |
| **Figure/caption association**   | Images are operator list entries with no connection to nearby "Figure N:" captions. |
| **Formula/equation recognition** | Math is scattered glyphs in symbol fonts. No structure, no LaTeX output.   |
| **Paragraph grouping**           | Must be inferred from Y-position gaps. No paragraph concept in the API.    |
| **Section/heading hierarchy**    | Can only guess from font size (larger = heading). No semantic heading level. |
| **Bold/italic/superscript**      | Font names are internal IDs (`g_d0_f1`). `fontFamily` only tells serif/sans/mono, not weight or style. |
| **OCR for scanned PDFs**         | No OCR. Scanned pages produce zero text items.                             |
| **Semantic structure**           | `getStructTree()` returns null for most PDFs (only tagged PDFs have structure). |

---

## 3. Lightweight tools (no ML models)

These solve 1-2 gaps each. Small footprint, easy to install.

### Poppler utilities

A suite of CLI tools built on the Poppler PDF rendering library. The most relevant:

**`pdftotext -layout`** — Column-aware text extraction. Preserves spatial layout as plain text by placing characters at their approximate column positions. Handles two-column academic papers significantly better than naive pdf.js text concatenation.

**`pdftotext -bbox-layout`** — Outputs word-level bounding boxes in HTML format with position data, useful for downstream heuristics.

**`pdfimages`** — Extracts all embedded images to files in their native format (JPEG, PNG, TIFF, etc.) at original resolution. More reliable than decoding from pdf.js operator list via canvas, and preserves the original compression (no re-encoding quality loss).

**`pdftohtml -xml`** — Outputs positioned text with font info in XML. Sometimes catches things pdf.js misses with unusual font encodings (Type3 fonts, CID fonts).

| Property     | Value                                                   |
|--------------|---------------------------------------------------------|
| Install      | `brew install poppler` (macOS), `apt install poppler-utils` (Linux) |
| Size         | ~20 MB installed                                        |
| License      | GPL-2.0 (GPL-3.0 for some components)                  |
| Offline      | Yes                                                     |
| Fills gaps   | Column-aware text, reliable image extraction             |
| Doesn't fill | Tables, formulas, figure-caption association, section hierarchy |

### pdfplumber (Python)

Table detection and extraction using text-position + line/rect heuristics. Built on pdfminer.six. Returns tables as lists of lists.

The `Table` finder works by: (1) detecting horizontal and vertical line segments (from path drawing commands), (2) finding intersections to form a grid, (3) extracting text within each cell. The `table_settings` parameter allows tuning edge detection strategies (e.g., `snap_tolerance`, `join_tolerance`, `edge_min_length`).

Also exposes precise character-level bounding boxes, curve objects, and visual debugging (can render pages with detected table boundaries overlaid).

| Property     | Value                                            |
|--------------|--------------------------------------------------|
| Install      | `pip install pdfplumber`                         |
| Size         | ~5 MB with deps                                  |
| License      | MIT                                              |
| Offline      | Yes                                              |
| Fills gaps   | Table detection and extraction                   |
| Doesn't fill | Columns, formulas, figure-caption, OCR           |
| Limitations  | Struggles with borderless tables and complex merged cells common in IEEE/ACM papers |

### pdfminer.six (Python)

Full layout analysis engine. The only lightweight Python library with a proper spatial grouping algorithm. Groups characters into words, words into lines, lines into text boxes, text boxes into layout groups. Exposes a hierarchy of layout objects:

- `LTTextBoxHorizontal` — a text block (roughly a paragraph or column segment)
- `LTTextLineHorizontal` — a single line of text within a box
- `LTFigure` — a figure region (usually an embedded form XObject)
- `LTLine`, `LTRect`, `LTCurve` — vector drawing elements with bounding boxes

The `LAParams` object controls grouping thresholds:

| Parameter       | What it controls                                |
|-----------------|-------------------------------------------------|
| `line_margin`   | Max gap between lines in the same text box      |
| `word_margin`   | Max gap between characters in the same word     |
| `char_margin`   | Max gap between characters on the same line     |
| `boxes_flow`    | How strongly to prefer top-to-bottom ordering vs. left-to-right (-1 to +1) |

Setting `boxes_flow=None` disables layout analysis entirely (fastest). Setting it to a value between 0 and 1 balances column detection. For two-column papers, `boxes_flow=0.5` is a reasonable starting point.

| Property     | Value                                                    |
|--------------|----------------------------------------------------------|
| Install      | `pip install pdfminer.six`                               |
| Size         | ~2 MB                                                    |
| License      | MIT                                                      |
| Offline      | Yes                                                      |
| Fills gaps   | Reading order, column detection, paragraph grouping       |
| Doesn't fill | Tables, formulas, figure-caption, bold/italic, OCR        |
| Limitations  | Tuning LAParams for every paper is impractical; defaults are OK but not great for all layouts |

### PyMuPDF / fitz (Python)

Python binding for MuPDF. Fastest Python PDF library (C engine). Goes beyond pdf.js in several ways:

**`page.get_text("dict")`** — Returns spans with:
- Exact font name (real name, not internal ID)
- Font size, color
- Flags: bold, italic, superscript, subscript, monospace, serif
- Character-level bounding boxes

This is the clearest advantage over pdf.js, which only exposes `fontFamily: 'serif'|'sans-serif'|'monospace'` with no weight/style information.

**`page.get_text("blocks")`** — Groups text into paragraph-level blocks with bounding boxes. Each block is a tuple `(x0, y0, x1, y1, text, block_no, type)`.

**`page.find_tables()`** — Table detection added in 2023. Uses a lattice + text-position approach. Returns `Table` objects with cell-level data. Newer and less battle-tested than pdfplumber but improving.

**`page.get_images()`** — Returns list of `(xref, smask, width, height, bpc, colorspace, ...)` for each embedded image. Images can be extracted via `pdf.extract_image(xref)`.

**`page.get_drawings()`** — Returns vector path data (lines, curves, rects) with colors and line widths.

| Property     | Value                                                       |
|--------------|-------------------------------------------------------------|
| Install      | `pip install PyMuPDF`                                       |
| Size         | ~30 MB wheel                                                |
| License      | **AGPL-3.0** (commercial license from Artifex)              |
| Offline      | Yes                                                         |
| Fills gaps   | Bold/italic/super/subscript detection, paragraph blocks, tables, image metadata |
| Doesn't fill | Column layout (blocks are per-column but not ordered), formulas, figure-caption |
| Limitations  | AGPL license is restrictive. `find_tables()` is newer than pdfplumber's equivalent. |

### MuPDF CLI (mutool)

The command-line interface to the same MuPDF engine that PyMuPDF wraps.

**`mutool draw -F stext+json`** — Outputs structured text blocks as JSON with bounding boxes. Each page is an array of blocks, each block has lines, each line has spans with font info. This is the most useful output for programmatic consumption from Node.js (no Python needed):

```json
{
  "blocks": [
    {
      "type": "text",
      "bbox": [72, 540, 540, 560],
      "lines": [
        {
          "bbox": [72, 540, 540, 555],
          "spans": [
            {
              "font": "NimbusRomNo9L-Regu",
              "size": 10.909,
              "flags": 0,
              "color": 0,
              "text": "Large language models are..."
            }
          ]
        }
      ]
    }
  ]
}
```

Font flags are a bitmask: bit 0 = superscript, bit 1 = italic, bit 2 = serif, bit 3 = monospace, bit 4 = bold.

**`mutool convert -F html`** — Produces HTML with positioned text and inline images.

**`mutool extract`** — Extracts embedded images and fonts.

| Property     | Value                                                 |
|--------------|-------------------------------------------------------|
| Install      | `brew install mupdf-tools` (macOS), `apt install mupdf-tools` (Linux) |
| Size         | ~10 MB installed                                      |
| License      | **AGPL-3.0** (commercial license from Artifex)        |
| Offline      | Yes                                                   |
| Fills gaps   | Structured text with font flags (bold/italic/super/sub), paragraph blocks |
| Doesn't fill | Tables, formulas, figure-caption, columns              |
| Advantage    | **No Python needed** — can call directly from Node.js via `child_process` |

---

## 4. ML-based tools (solve most gaps at once)

These tools use trained models to understand document layout. They are heavy (1-2 GB) but produce dramatically better output for academic papers.

### Marker

Converts PDF to clean Markdown. Uses a pipeline: PDF rendering → layout detection (fine-tuned detection model) → OCR (optional, via Surya) → text cleaning and formatting.

**Output quality for academic papers:**

- Body text with correct reading order (two-column → single stream)
- Headings detected and formatted as `#` / `##` / `###`
- Bold, italic preserved
- Tables formatted as Markdown pipe tables
- Images extracted and referenced as `![](image_path)`
- **Equations converted to LaTeX** (inline and display) — this is unique among the tools
- Figure/table captions preserved near their images
- Code blocks detected and fenced
- Footnotes and headers/footers stripped

Example output for an equation-heavy passage:

```markdown
## 3 Loss Function

A standard cross-entropy loss over a sequence of tokens $x_1, \ldots, x_T$ is:

$$\mathcal{L}(\theta) = -\frac{1}{T} \sum_{t=1}^{T} \log p_\theta(x_t \mid x_{<t})$$

Minimizing $\mathcal{L}$ over the training distribution is equivalent to maximum likelihood estimation of the model parameters $\theta$.
```

**Invocation from Node.js:**

```ts
import { execFile } from 'child_process';
execFile('marker_single', [pdfPath, outputDir], (err, stdout) => {
  // outputDir contains: paper.md, paper_images/*, paper_meta.json
});
```

`marker_single` outputs a Markdown file, an images directory, and a metadata JSON. The metadata includes page boundaries.

| Property     | Value                                                   |
|--------------|---------------------------------------------------------|
| Install      | `pip install marker-pdf` (downloads ~2 GB of models on first run) |
| Requires     | Python 3.10+, PyTorch                                   |
| License      | **GPL-3.0** (commercial license available from the author) |
| Offline      | Yes, fully local after model download                    |
| Speed        | ~5-15 sec/page on CPU, ~1-3 sec/page with GPU           |
| Fills gaps   | All of them: columns, tables, figures, captions, formulas, headings, bold/italic |
| Limitations  | GPL license. Heavy deps. Can struggle with unusual layouts (non-Western, vertical text). |

### Docling (IBM Research)

Full document understanding pipeline. Layout segmentation → table structure recognition → reading order → text extraction. Outputs a `DoclingDocument` object convertible to Markdown, JSON, or DocTags.

**What sets it apart:**

- **Table structure recognition** is best-in-class among these tools. Uses a custom TableFormer model that handles merged cells, spanning headers, multi-line cells, and borderless tables.
- Layout detection classifies regions as: title, section heading, text, table, figure, formula, list item, code, page header, page footer, caption, footnote.
- Reading order is explicitly modeled (not just top-to-bottom).

**Invocation from Node.js:**

```ts
// CLI
execFile('docling', [pdfPath, '--output', outputDir], ...);

// Or via Python subprocess
execFile('python', ['-c', `
from docling.document_converter import DocumentConverter
result = DocumentConverter().convert("${pdfPath}")
print(result.document.export_to_markdown())
`], ...);
```

| Property     | Value                                                    |
|--------------|----------------------------------------------------------|
| Install      | `pip install docling` (downloads ~2 GB of models)        |
| Requires     | Python 3.10+, PyTorch                                    |
| License      | **MIT**                                                  |
| Offline      | Yes                                                      |
| Speed        | ~5-10 sec/page on CPU                                    |
| Fills gaps   | Layout, tables (best), figures, headings, reading order, bold/italic |
| Limitations  | Formula-to-LaTeX is partial (detects formulas but doesn't always produce LaTeX). Newer project (less battle-tested than GROBID). |

### GROBID

The gold standard for academic paper structure extraction. Used in production by Semantic Scholar, HAL, CORE, and others. Parses papers into TEI-XML (Text Encoding Initiative — a scholarly standard).

**What sets it apart:**

- **Full academic paper structure:** title, authors with affiliations, abstract, section hierarchy with numbering, body text, references (parsed into structured fields: author, title, journal, year, DOI, pages), figures with captions, tables with captions, equations, headers, footers, footnotes.
- **Reference parsing** is the strongest of any tool. Each citation is resolved to structured fields, not just raw text.
- **Speed:** Uses CRF (Conditional Random Field) models, not deep learning. Processes an entire paper in 2-5 seconds on CPU. No GPU needed.
- **Mature and stable:** 10+ years of development, Apache-2.0 license.

**Output format:** TEI-XML. Example (abbreviated):

```xml
<TEI>
  <teiHeader>
    <titleStmt><title>Analogical Reasoning on Narratives</title></titleStmt>
    <sourceDesc>
      <biblStruct>
        <analytic>
          <author><persName><forename>First</forename><surname>Author</surname></persName>
            <affiliation>University of Example</affiliation>
          </author>
        </analytic>
      </biblStruct>
    </sourceDesc>
  </teiHeader>
  <text>
    <body>
      <div><head>1 Introduction</head>
        <p>Analogical reasoning is a core cognitive...</p>
      </div>
      <div><head>2 Related Work</head>
        <p>Prior work on narrative understanding <ref target="#b12">(Smith et al., 2023)</ref>...</p>
      </div>
    </body>
    <back>
      <listBibl>
        <biblStruct xml:id="b12">
          <analytic>
            <title>Understanding narratives through analogy</title>
            <author><persName><surname>Smith</surname></persName></author>
          </analytic>
          <monogr><title>ACL 2023</title><imprint><date>2023</date></imprint></monogr>
        </biblStruct>
      </listBibl>
    </back>
  </text>
</TEI>
```

**Invocation from Node.js:**

GROBID runs as a local REST server. Call it with HTTP from Node.js:

```ts
import { createReadStream } from 'fs';
import FormData from 'form-data';

const form = new FormData();
form.append('input', createReadStream(pdfPath));
form.append('consolidateHeader', '1');
form.append('consolidateCitations', '1');

const response = await fetch('http://localhost:8070/api/processFulltextDocument', {
  method: 'POST',
  body: form,
});
const teiXml = await response.text();
```

| Property     | Value                                                   |
|--------------|---------------------------------------------------------|
| Install      | `docker pull grobid/grobid:latest` (~1 GB) or local Java build |
| Requires     | Docker (recommended) or Java 11+/Gradle                 |
| License      | **Apache-2.0**                                           |
| Offline      | Yes (local server)                                       |
| Speed        | ~2-5 sec per **paper** (not per page)                    |
| Fills gaps   | Section hierarchy, authors/affiliations, references (parsed), figure/table captions, reading order |
| Limitations  | Table cell-level extraction is weak (identifies tables but doesn't parse cell structure). Formula-to-LaTeX is partial. Output is XML, not Markdown (needs conversion). |

### Nougat (Meta Research)

End-to-end vision model for academic PDFs. Renders each page to an image, then uses a Transformer encoder-decoder (Donut architecture) to produce structured Markdown with LaTeX math. Essentially "OCR for academic papers" — it reads the visual layout, not the PDF structure.

**What sets it apart:**

- **Best math/equation output.** Produces full LaTeX for inline and display math, including complex multi-line equations, matrices, and aligned environments.
- Works on **scanned PDFs** (since it operates on rendered images, not text extraction).
- Produces clean Markdown output directly.

**Limitations are significant:**

- **Very slow on CPU** (~30-60 seconds per page). Practical only with a GPU (~2-5 sec/page).
- **Can hallucinate** — if the model is unsure, it may generate plausible-sounding but incorrect text, especially on non-standard layouts.
- **Non-commercial model weights** — the code is MIT but the trained model weights are CC-BY-NC.
- No table structure detection (outputs tables as visual approximations in text).

| Property     | Value                                                   |
|--------------|---------------------------------------------------------|
| Install      | `pip install nougat-ocr` (~1.5 GB model download)       |
| Requires     | Python 3.10+, PyTorch, GPU strongly recommended          |
| License      | MIT code, **CC-BY-NC model weights**                     |
| Offline      | Yes                                                      |
| Speed        | ~30-60 sec/page CPU, ~2-5 sec/page GPU                  |
| Fills gaps   | Equations → LaTeX (best), scanned PDF OCR, reading order |
| Limitations  | Slow without GPU. Can hallucinate. Non-commercial weights. Weak on tables. |

### Surya

OCR + layout detection + reading order + table recognition. A collection of models that can be used independently or together. By the same author as Marker (Marker uses Surya internally).

| Property     | Value                                             |
|--------------|---------------------------------------------------|
| Install      | `pip install surya-ocr` (~500 MB models)          |
| License      | MIT (models included)                             |
| Speed        | ~3-8 sec/page on CPU                              |
| Fills gaps   | OCR, layout detection, reading order, table detection |
| Use case     | Useful as individual components if you don't want the full Marker pipeline |

### Other ML tools

**unstructured** (`pip install unstructured`) — High-level library combining pdfminer, Tesseract, Detectron2, and other backends. Extracts elements classified by type (Title, NarrativeText, Table, Image, etc.). MIT licensed. Very heavy with all ML deps (~2+ GB). Good for document processing pipelines, overkill for a single-file VS Code extension.

**LayoutParser** — Layout detection using Detectron2 object detection models. Apache-2.0. Largely superseded by Surya and Docling. Still useful if you only need bounding boxes for layout regions.

---

## 5. Comparison matrix

What each tool extracts for a typical academic paper:

| Content type               | pdf.js  | + pdfplumber | + pdfminer | + PyMuPDF | Marker    | Docling   | GROBID     | Nougat    |
|----------------------------|---------|-------------|------------|-----------|-----------|-----------|------------|-----------|
| Body text                  | Raw items | Same       | Grouped    | Blocks    | Clean     | Clean     | Structured | Clean     |
| Two-column layout          | Broken  | Broken      | OK         | Partial   | Correct   | Correct   | Correct    | Correct   |
| Reading order              | Wrong   | Wrong       | OK         | Partial   | Correct   | Correct   | Correct    | Correct   |
| Section headings           | Font heuristic | Same  | Same       | Same      | `## H`    | Classified | Full hierarchy | `## H` |
| Bold / italic              | No      | No          | No         | **Yes**   | Yes       | Yes       | Yes        | Yes       |
| Superscript / subscript    | No      | No          | No         | **Yes**   | Yes       | Partial   | Partial    | Yes       |
| Tables → structured        | No      | **Yes**     | No         | Yes       | Yes       | **Best**  | Weak       | No        |
| Figures / images           | Raw px  | Same        | Same       | Metadata  | Extracted | Detected  | Captioned  | No        |
| Figure captions            | No      | No          | No         | No        | Yes       | Yes       | **Yes**    | Partial   |
| Equations → LaTeX          | No      | No          | No         | No        | **Yes**   | Partial   | Partial    | **Best**  |
| References (parsed fields) | No      | No          | No         | No        | No        | No        | **Best**   | No        |
| Authors / affiliations     | No      | No          | No         | No        | No        | No        | **Yes**    | No        |
| Abstract identification    | No      | No          | No         | No        | No        | No        | **Yes**    | No        |
| Scanned PDF (OCR)          | No      | No          | No         | No        | Yes       | Yes       | No         | **Yes**   |

## 6. Practical recommendations for ask-pdf

### Deployment constraints

A VS Code extension cannot bundle 2 GB of PyTorch models. Any ML tool must be **user-installed** and **optional**. The extension should work without it (degraded but functional) and produce better output when it detects the tool is available.

### Recommended tiered architecture

**Tier 0 — Always available (pdf.js only, zero deps):**
Custom heuristics on pdf.js raw data. Text clustering by position, heading detection by font size, code detection by monospace font, image extraction from operator list via canvas. Basic table detection from grid-aligned text + path segments. This is the fallback when no external tool is installed.

**Tier 1 — Lightweight enhancement (poppler CLI):**
If `pdftotext` is on PATH (common on macOS/Linux, installable via `brew install poppler`):
- Use `pdftotext -layout` for column-aware text extraction
- Use `pdfimages` for reliable native-format image extraction
These are small, fast, widely available, and solve the two biggest quality gaps (columns and images) with minimal friction.

**Tier 2 — Full extraction (Marker or Docling):**
If `marker_single` or `docling` is on PATH (user installs via pip):
- Use as the primary extraction backend
- Produces high-quality Markdown with tables, figures, equations, and correct reading order
- Falls back to Tier 0/1 if not available

| Tier | Dependencies       | Columns | Tables   | Images   | Equations | Speed      |
|------|--------------------|---------|----------|----------|-----------|------------|
| 0    | None (pdf.js only) | Heuristic | Heuristic | Canvas decode | No    | Instant    |
| 1    | poppler CLI        | Good    | Heuristic | Native   | No        | < 1 sec    |
| 2    | Marker or Docling  | Correct | Good/Best | Extracted | LaTeX    | 5-15 sec/page |

### Marker vs. Docling for Tier 2

| Criterion         | Marker          | Docling         |
|-------------------|-----------------|-----------------|
| License           | GPL-3.0         | **MIT**         |
| Markdown output   | **Direct**      | Direct          |
| Table quality     | Good            | **Best**        |
| Equation → LaTeX  | **Yes**         | Partial         |
| Speed (CPU)       | ~5-15 sec/page  | ~5-10 sec/page  |
| Maturity          | 2+ years        | ~1 year         |
| Page boundary info| In metadata     | In document model |

For an MIT-licensed extension, **Docling** is the safer choice (MIT license, best tables). For maximum extraction quality on math-heavy papers, **Marker** produces better equation output but requires GPL-3.0 compliance or a commercial license.

### GROBID as a complement

GROBID fills a unique niche: **structured metadata** (authors, affiliations, parsed references). If the extension ever needs to answer "who wrote this paper?" or "what is reference [12]?", GROBID is the only tool that reliably extracts this. It could run alongside Marker/Docling rather than replacing it. The Docker deployment and REST API make it easy to call from Node.js. Apache-2.0 license is the cleanest of all the ML tools.

---

## 7. How modern AI handles PDFs (and what it means for ask-pdf)

### The dominant approach: render-to-image + text extraction

Every major AI system that handles PDFs well uses the same core pipeline: **render each page to an image and extract text, then give the model both.** The model sees the visual layout (figures, tables, equations, colors, spatial relationships) through vision, and also gets the extracted text for precise quoting and search.

| System                   | Pipeline                                                     | Text extraction | Vision on pages |
|--------------------------|--------------------------------------------------------------|-----------------|-----------------|
| **Claude (Anthropic)**   | PDF → render pages to images + extract text → model sees both | Yes             | **Yes**         |
| **GPT-4o (OpenAI)**      | PDF → render pages to images (vision path, since late 2024)  | Via Code Interpreter | **Yes**    |
| **Gemini (Google)**      | PDF → native multimodal ingestion, pages as images           | Yes             | **Yes**         |
| **NotebookLM (Google)**  | Same as Gemini — render + index                              | Yes             | **Yes**         |
| **Jenni AI**             | Text extraction + GROBID for citations (no vision)           | Yes             | No              |
| **Elicit / S2**          | GROBID + text extraction pipeline                            | Yes             | No              |

The vision-based tools (Claude, GPT-4o, Gemini) dramatically outperform text-only tools at understanding figures, tables, equations, and complex layouts — because they literally look at the page instead of trying to reconstruct meaning from positioned glyphs.

### How Claude specifically handles PDFs

When a PDF is sent to Claude via the API (as a `document` content block) or read by Claude Code (via the Read tool), the processing is:

1. **Each page is rendered to an image** — Claude sees the visual layout.
2. **Text is extracted programmatically** from each page — Claude gets searchable text.
3. **Both are presented to the model** — vision handles figures/tables/equations, text handles precise quoting.

**API format:**

```json
{
  "type": "document",
  "source": {
    "type": "base64",
    "media_type": "application/pdf",
    "data": "<base64-encoded PDF bytes>"
  }
}
```

Three delivery methods: base64 inline, URL reference, or file ID (via the Files API for large documents).

**Token costs:** ~1,500-3,000 tokens per page (text + image combined). A 20-page paper costs ~30K-60K tokens of context.

**Claude Code's Read tool:** Reads PDFs natively with a **20-page-per-call limit** (specify page ranges for longer documents). Under the hood, it sends the PDF bytes to the API as a `document` content block.

**What is preserved:** Visual layout, figures, charts, tables (as images), equations, colors, fonts, spatial relationships, text content.

**What is lost:** Hyperlinks, bookmarks/outline, annotations, embedded metadata, structure tags, selectable text semantics (text is re-extracted, not preserved from the PDF's internal structure).

### The key insight for ask-pdf

Claude already knows how to understand PDFs — it renders pages to images and reads them with vision. The ask-pdf extension doesn't need to solve figure detection, table extraction, or equation recognition from scratch. It needs to **present the PDF content in a form that Claude Code can consume through its existing tools**.

Claude Code's Read tool can:
- Read text files (`.md`, `.txt`) and present text to the model
- Read image files (`.png`, `.jpg`) and present them visually to the model
- Read PDF files directly (up to 20 pages per call, ~1,500-3,000 tokens/page)

This means the sidecar strategy should follow the same dual-channel approach that Claude's own PDF pipeline uses: **extracted text for search/reference + rendered page images for visual understanding**.

### Render-to-image approach: tradeoffs

| Advantage                                        | Disadvantage                               |
|--------------------------------------------------|--------------------------------------------|
| Preserves figures, charts, tables, equations     | Higher token cost (~1,500-3,000/page)      |
| Handles scanned/image-only PDFs                  | Slower than text-only                      |
| No dependency on PDF internal structure           | Cannot search/index image content directly |
| No heuristics needed for tables/figures          | Multi-page documents get expensive fast    |
| Same approach as Claude's own PDF handling        | Requires vision-capable model              |

### Revised sidecar strategy for ask-pdf

Instead of trying to reconstruct tables and equations from positioned text items (error-prone, never as good as the original), the sidecar should combine:

1. **Extracted text** — for searchability, line-number references, and cheap text context. pdf.js `getTextContent()` is sufficient here. This is what Claude Code reads when it opens the sidecar file.

2. **Rendered page images** — for visual understanding of figures, tables, equations, and layout. pdf.js already renders pages to canvas in the webview; these can be saved as PNGs. When Claude Code needs to understand a figure or table, it reads the page image.

The sidecar format becomes:

```markdown
<!-- PDF: /abs/path/to/paper.pdf -->
<!-- Pages: 12 -->

## Page 1

![Page 1](paper.pdf.pages/page-01.png)

Large language models are statistical machines that map sequences
of tokens to probability distributions over the next token...

## Page 2

![Page 2](paper.pdf.pages/page-02.png)

| *Table and figure content is visible in the page image above.* |
```

Each `## Page N` section has:
- A reference to the rendered page image (Claude reads this when it needs visual understanding)
- The extracted text below (for search, quoting, line-number references)

When Claude Code processes this:
- Reading the `.md` file gives it all the text, organized by page, with line numbers it can reference
- Reading a page image (when it encounters the `![Page N]` reference or when it needs visual context) gives it the same visual understanding as Claude's native PDF pipeline
- The page images are only read on demand — Claude Code doesn't read all 20 images at once

This approach:
- **Requires zero external dependencies** — pdf.js already renders pages to canvas
- **Preserves everything** — text for search, images for visual understanding
- **Matches Claude's own pipeline** — text + vision on rendered pages
- **No heuristics needed** for tables, figures, or equations — Claude's vision handles them
- **Works with the existing MCP integration** — sidecar path + line numbers in all payloads

The Tier 1 (poppler) and Tier 2 (Marker/Docling) enhancements from section 6 are still valuable as optional upgrades — they produce cleaner text extraction and explicit LaTeX equations. But the base tier becomes much more capable by including page images.

### Comparison: sidecar approaches

| Approach                       | Tables | Figures | Equations | Dependencies | Complexity |
|--------------------------------|--------|---------|-----------|--------------|------------|
| Text-only sidecar (heuristics) | Weak   | Names only | No     | None         | High (heuristic code) |
| Text + page images sidecar     | **Via vision** | **Via vision** | **Via vision** | None | **Low** (render to PNG) |
| Text + Marker/Docling          | Good/Best | Extracted | LaTeX  | Python + PyTorch | Medium (subprocess) |
| Direct PDF via Claude API      | **Best** | **Best** | **Best** | API key + tokens | None (but expensive) |

The text + page images approach hits the best tradeoff: zero dependencies, low complexity, and Claude's own vision handles the hard parts. It's the same strategy Claude uses internally, just pre-processed locally.
