import * as monaco from 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/+esm';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

const API_BASE = '/api/documents';

const init = () => {
  let hasEdited = false;
  let scrollBarSync = false;

  const localStorageScrollBarKey = 'scroll_bar_settings';
  const localStorageThemeKey = 'theme_settings';
  const confirmationMessage = 'Are you sure you want to reset? Your changes will be lost.';
  let mermaidRenderTimer = null;
  let mermaidRenderVersion = 0;

  // --- Document state ---
  let documents = [];           // { id, name, created_at, updated_at } — list from API
  let currentDocContent = '';   // loaded on demand
  let activeDocId = null;
  let autoSaveEnabled = true;
  let saveDebounceTimer = null;
  let isSaving = false;

  // --- Helpers ---

  const getHashId = () => {
    const h = window.location.hash;
    return h && h.startsWith('#doc_') ? h.slice(1) : null;
  };

  const setHashId = (id) => {
    window.location.hash = '#' + id;
  };

  const apiCall = async (url, options = {}) => {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  };

  const loadDocuments = async () => {
    try {
      documents = await apiCall(API_BASE);
    } catch (e) {
      console.error('Failed to load documents:', e);
      documents = [];
    }
  };

  const fetchDocContent = async (id) => {
    try {
      return await apiCall(`${API_BASE}/${id}`);
    } catch (e) {
      console.error('Failed to fetch document:', e);
      return null;
    }
  };

  const saveDocNow = async () => {
    if (!editor || !activeDocId || isSaving) return;
    const value = editor.getValue();
    if (value === currentDocContent) return;
    isSaving = true;
    try {
      await apiCall(`${API_BASE}/${activeDocId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: value })
      });
      currentDocContent = value;
      // update local metadata
      const doc = documents.find(d => d.id === activeDocId);
      if (doc) doc.updated_at = Date.now();
    } catch (e) {
      console.error('Save failed:', e);
    } finally {
      isSaving = false;
    }
  };

  const scheduleSave = () => {
    if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
    saveDebounceTimer = setTimeout(() => saveDocNow(), 800);
  };

  // --- Sidebar rendering ---

  const renderSidebar = () => {
    const list = document.querySelector('#sidebar-list');
    if (!list) return;

    if (documents.length === 0) {
      list.innerHTML = '<div class="sidebar-empty">No documents yet</div>';
      return;
    }

    list.innerHTML = '';
    documents.forEach((doc) => {
      const item = document.createElement('div');
      item.className = 'sidebar-item';
      if (doc.id === activeDocId) {
        item.classList.add('active');
      }
      item.dataset.docId = doc.id;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'sidebar-item-name';
      nameSpan.textContent = doc.name;

      const actions = document.createElement('span');
      actions.className = 'sidebar-item-actions';

      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✏️';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameDocument(doc.id);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '🗑️';
      deleteBtn.className = 'delete';
      deleteBtn.title = 'Delete';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteDocument(doc.id);
      });

      actions.appendChild(renameBtn);
      actions.appendChild(deleteBtn);
      item.appendChild(nameSpan);
      item.appendChild(actions);

      item.addEventListener('click', () => {
        if (doc.id !== activeDocId) {
          switchToDocument(doc.id);
        }
      });

      list.appendChild(item);
    });
  };

  // --- Document actions ---

  const switchToDocument = async (id) => {
    // Save current before switching
    await saveDocNow();

    const doc = await fetchDocContent(id);
    if (!doc) return;

    activeDocId = id;
    currentDocContent = doc.content || '';
    setHashId(id);

    autoSaveEnabled = false;
    if (editor) {
      editor.setValue(currentDocContent);
      editor.revealPosition({ lineNumber: 1, column: 1 });
    }
    hasEdited = false;
    autoSaveEnabled = true;
    renderSidebar();
    document.querySelectorAll('.column').forEach(el => el.scrollTo({ top: 0 }));
  };

  const createNewDocument = async () => {
    await saveDocNow();
    try {
      const doc = await apiCall(API_BASE, {
        method: 'POST',
        body: JSON.stringify({ name: 'Untitled', content: defaultInput })
      });
      await loadDocuments();
      activeDocId = doc.id;
      currentDocContent = doc.content || defaultInput;
      setHashId(doc.id);

      autoSaveEnabled = false;
      if (editor) {
        editor.setValue(currentDocContent);
        editor.revealPosition({ lineNumber: 1, column: 1 });
      }
      hasEdited = false;
      autoSaveEnabled = true;
      renderSidebar();
      document.querySelectorAll('.column').forEach(el => el.scrollTo({ top: 0 }));
    } catch (e) {
      console.error('Failed to create document:', e);
      window.alert('Failed to create new document.');
    }
  };

  const renameDocument = async (id) => {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    const newName = window.prompt('Rename document:', doc.name);
    if (newName !== null && newName.trim() !== '') {
      try {
        await apiCall(`${API_BASE}/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: newName.trim() })
        });
        doc.name = newName.trim();
        renderSidebar();
      } catch (e) {
        console.error('Rename failed:', e);
        window.alert('Failed to rename document.');
      }
    }
  };

  const deleteDocument = async (id) => {
    if (documents.length <= 1) {
      window.alert('Cannot delete the last document.');
      return;
    }
    const doc = documents.find(d => d.id === id);
    if (!doc) return;
    const confirmed = window.confirm(`Delete "${doc.name}"? This cannot be undone.`);
    if (!confirmed) return;
    try {
      await apiCall(`${API_BASE}/${id}`, { method: 'DELETE' });
      await loadDocuments();
      // If deleted doc was active, switch to the first remaining
      if (id === activeDocId && documents.length > 0) {
        activeDocId = null; // force switch
        await switchToDocument(documents[0].id);
        return;
      }
      renderSidebar();
    } catch (e) {
      console.error('Delete failed:', e);
      window.alert('Failed to delete document.');
    }
  };

  // --- Header: Save button ---

  const setupSaveButton = () => {
    const btn = document.querySelector('#save-button');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      await saveDocNow();
      btn.textContent = '✓ Saved!';
      btn.classList.add('saved');
      setTimeout(() => {
        btn.textContent = '💾 Save';
        btn.classList.remove('saved');
      }, 1000);
    });
  };

  // --- Sidebar header: + New button ---

  const setupNewDocButton = () => {
    const btn = document.querySelector('#sidebar-new-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      createNewDocument();
    });
  };

  // --- Mermaid helpers ---

  const escapeHtml = (value) => {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const createMarkedRenderer = () => {
    const renderer = new marked.Renderer();
    const renderCode = renderer.code.bind(renderer);

    renderer.code = (token) => {
      const lang = (token.lang || '').match(/^\S*/)?.[0].toLowerCase();
      if (lang !== 'mermaid') {
        return renderCode(token);
      }
      return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
    };

    return renderer;
  };

  const configureMermaid = (theme) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme
    });
  };

  const showMermaidError = (element, error) => {
    const message = error && error.message ? error.message : 'Unable to render Mermaid chart.';
    element.classList.add('mermaid-error');
    element.textContent = `Mermaid render error: ${message}`;
  };

  const getMermaidTheme = () => {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'default';
  };

  const renderMermaidDiagramsNow = async (theme = getMermaidTheme()) => {
    const outputElement = document.querySelector('#output');
    if (!outputElement) return;

    const version = ++mermaidRenderVersion;
    configureMermaid(theme);

    const elements = Array.from(outputElement.querySelectorAll('.mermaid'));
    for (const [index, element] of elements.entries()) {
      if (version !== mermaidRenderVersion) return;

      const source = element.dataset.mermaidSource || element.textContent;
      element.dataset.mermaidSource = source;
      element.classList.remove('mermaid-error');

      try {
        const renderId = `mermaid-${Date.now()}-${version}-${index}`;
        const { svg, bindFunctions } = await mermaid.render(renderId, source);
        if (version !== mermaidRenderVersion) return;
        element.innerHTML = svg;
        if (typeof bindFunctions === 'function') {
          bindFunctions(element);
        }
      } catch (error) {
        showMermaidError(element, error);
      }
    }
  };

  const scheduleMermaidRender = () => {
    if (mermaidRenderTimer) clearTimeout(mermaidRenderTimer);
    mermaidRenderTimer = setTimeout(() => {
      mermaidRenderTimer = null;
      renderMermaidDiagramsNow();
    }, 150);
  };

  const renderMermaidDiagrams = (theme) => {
    if (mermaidRenderTimer) {
      clearTimeout(mermaidRenderTimer);
      mermaidRenderTimer = null;
    }
    return renderMermaidDiagramsNow(theme);
  };

  const renderer = createMarkedRenderer();

  // --- Markdown render ---

  const convert = (markdown) => {
    const options = { headerIds: false, mangle: false, renderer };
    const html = marked.parse(markdown, options);
    const sanitized = DOMPurify.sanitize(html);
    document.querySelector('#output').innerHTML = sanitized;
    scheduleMermaidRender();
  };

  // --- Monaco editor ---

  let editor = null;

  const setupEditor = () => {
    editor = monaco.editor.create(document.querySelector('#editor'), {
      fontSize: 14,
      language: 'markdown',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      scrollbar: {
        vertical: 'visible',
        horizontal: 'visible'
      },
      wordWrap: 'on',
      hover: { enabled: false },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      folding: false
    });

    editor.onDidChangeModelContent(() => {
      const value = editor.getValue();
      const changed = value !== currentDocContent;
      if (changed) {
        hasEdited = true;
      }
      convert(value);
      if (autoSaveEnabled) {
        scheduleSave();
      }
    });

    editor.onDidScrollChange((e) => {
      if (!scrollBarSync) return;

      const scrollTop = e.scrollTop;
      const scrollHeight = e.scrollHeight;
      const height = editor.getLayoutInfo().height;

      const maxScrollTop = scrollHeight - height;
      const scrollRatio = scrollTop / maxScrollTop;

      const previewEl = document.querySelector('#preview');
      const targetY = (previewEl.scrollHeight - previewEl.clientHeight) * scrollRatio;
      previewEl.scrollTo(0, targetY);
    });

    return editor;
  };

  const presetValue = (value) => {
    editor.setValue(value);
    editor.revealPosition({ lineNumber: 1, column: 1 });
    editor.focus();
    hasEdited = false;
  };

  // --- Reset ---

  const reset = () => {
    const baseline = currentDocContent || defaultInput;
    const changed = editor.getValue() != baseline;
    if (hasEdited || changed) {
      const confirmed = window.confirm(confirmationMessage);
      if (!confirmed) return;
    }
    presetValue(baseline);
    document.querySelectorAll('.column').forEach((element) => {
      element.scrollTo({ top: 0 });
    });
  };

  const setupResetButton = () => {
    document.querySelector('#reset-button').addEventListener('click', (event) => {
      event.preventDefault();
      reset();
    });
  };

  // --- Copy ---

  const copyToClipboard = (text, successHandler, errorHandler) => {
    navigator.clipboard.writeText(text).then(
      () => { successHandler(); },
      () => { errorHandler(); }
    );
  };

  const notifyCopied = () => {
    const label = document.querySelector('#copy-button a');
    if (!label) return;
    label.innerHTML = 'Copied!';
    setTimeout(() => {
      label.innerHTML = 'Copy';
    }, 1000);
  };

  const setupCopyButton = () => {
    document.querySelector('#copy-button').addEventListener('click', (event) => {
      event.preventDefault();
      const value = editor.getValue();
      copyToClipboard(value, notifyCopied, () => {});
    });
  };

  // --- PDF Export ---

  const PREVIEW_CSS_LIGHT = 'css/github-markdown-light.css?v=1.11.0';
  const PREVIEW_CSS_DARK = 'css/github-markdown-dark_dimmed.css?v=1.11.0';

  let exportLightCssPromise = null;

  const getLightMarkdownCss = () => {
    if (exportLightCssPromise) return exportLightCssPromise;
    exportLightCssPromise = fetch(PREVIEW_CSS_LIGHT)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load export CSS: ${response.status}`);
        return response.text();
      })
      .catch((error) => {
        console.error('Failed to load light markdown CSS', error);
        return '';
      });
    return exportLightCssPromise;
  };

  const exportPreviewToPdf = () => {
    const previewElement = document.querySelector('#preview-wrapper');
    if (!previewElement) return;

    if (typeof window.html2pdf !== 'function') {
      window.alert('PDF export is not available yet. Please try again in a moment.');
      return;
    }

    const restoreDarkMermaid = getMermaidTheme() === 'dark';

    renderMermaidDiagrams('default').then(() => getLightMarkdownCss()).then((lightCss) => {
      const options = {
        margin: 10,
        filename: 'markdown-preview.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          onclone: (clonedDoc) => {
            clonedDoc.documentElement.setAttribute('data-theme', 'light');

            const markdownLink = clonedDoc.getElementById('gh-markdown-link');
            if (markdownLink) {
              markdownLink.setAttribute('href', PREVIEW_CSS_LIGHT);
            }

            if (lightCss) {
              const style = clonedDoc.createElement('style');
              style.id = 'export-light-css';
              style.textContent = `${lightCss}
#preview-wrapper, #output, body {
  background: #fff !important;
  color: #24292f !important;
}`;
              clonedDoc.head.appendChild(style);
            }

            const clonedPreview = clonedDoc.getElementById('preview-wrapper');
            if (clonedPreview) {
              clonedPreview.style.background = '#fff';
              clonedPreview.style.color = '#24292f';
              clonedPreview.style.width = '190mm';
              clonedPreview.style.maxWidth = '190mm';
            }

            const clonedOutput = clonedDoc.getElementById('output');
            if (clonedOutput) {
              clonedOutput.style.background = '#fff';
              clonedOutput.style.color = '#24292f';
              clonedOutput.style.width = '190mm';
              clonedOutput.style.maxWidth = '190mm';
            }
          }
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
      };

      window.html2pdf()
        .set(options)
        .from(previewElement)
        .save()
        .catch((error) => {
          console.error('Failed to export PDF', error);
        })
        .finally(() => {
          if (restoreDarkMermaid) {
            renderMermaidDiagrams();
          }
        });
    });
  };

  const setupExportButton = () => {
    const btn = document.querySelector('#export-button');
    if (!btn) return;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      exportPreviewToPdf();
    });
  };

  // --- Download .md ---

  const sanitizeFilename = (name) => {
    const base = (name || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
    return base || 'document';
  };

  const downloadMarkdown = () => {
    if (!editor) return;
    const value = editor.getValue();
    const activeDoc = documents.find(d => d.id === activeDocId);
    const baseName = activeDoc ? sanitizeFilename(activeDoc.name) : 'document';
    const filename = baseName.toLowerCase().endsWith('.md') ? baseName : `${baseName}.md`;

    const blob = new Blob([value], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const setupDownloadMdButton = () => {
    const btn = document.querySelector('#download-md-button');
    if (!btn) return;
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      downloadMarkdown();
    });
  };

  // --- Sync scroll ---

  const saveScrollBarSettings = (settings) => {
    try {
      localStorage.setItem(localStorageScrollBarKey, JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  };

  const loadScrollBarSettings = () => {
    try {
      return JSON.parse(localStorage.getItem(localStorageScrollBarKey)) || false;
    } catch (e) {
      return false;
    }
  };

  const initScrollBarSync = (settings) => {
    const checkbox = document.querySelector('#sync-scroll-checkbox');
    if (!checkbox) return;
    checkbox.checked = settings;
    scrollBarSync = settings;

    checkbox.addEventListener('change', (event) => {
      const checked = event.currentTarget.checked;
      scrollBarSync = checked;
      saveScrollBarSettings(checked);
    });
  };

  // --- Theme toggle ---

  const saveThemeSettings = (settings) => {
    try {
      localStorage.setItem(localStorageThemeKey, settings ? 'dark' : 'light');
    } catch (e) { /* ignore */ }
  };

  const loadThemeSettings = () => {
    try {
      const raw = localStorage.getItem(localStorageThemeKey);
      if (raw === 'dark') return true;
      if (raw === 'light') return false;
      return false;
    } catch (e) {
      return false;
    }
  };

  const setPreviewCss = (useDark) => {
    const link = document.getElementById('gh-markdown-link');
    if (!link) {
      const newLink = document.createElement('link');
      newLink.id = 'gh-markdown-link';
      newLink.rel = 'stylesheet';
      newLink.href = useDark ? PREVIEW_CSS_DARK : PREVIEW_CSS_LIGHT;
      document.head.appendChild(newLink);
      return;
    }
    const desired = useDark ? PREVIEW_CSS_DARK : PREVIEW_CSS_LIGHT;
    if (link.getAttribute('href') !== desired) {
      link.setAttribute('href', desired);
    }
  };

  const setTheme = (enabled) => {
    document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
  };

  const initThemeToggle = (settings) => {
    const checkbox = document.querySelector('#theme-checkbox');
    if (!checkbox) return;
    checkbox.checked = settings;
    setTheme(settings);

    if (monaco && monaco.editor && typeof monaco.editor.setTheme === 'function') {
      monaco.editor.setTheme(settings ? 'vs-dark' : 'vs');
    }
    setPreviewCss(settings);

    checkbox.addEventListener('change', (event) => {
      const checked = event.currentTarget.checked;
      setTheme(checked);
      saveThemeSettings(checked);
      setPreviewCss(checked);
      if (monaco && monaco.editor && typeof monaco.editor.setTheme === 'function') {
        monaco.editor.setTheme(checked ? 'vs-dark' : 'vs');
      }
      renderMermaidDiagrams();
    });
  };

  // --- Split divider ---

  const setupDivider = () => {
    let lastLeftRatio = 0.5;
    const divider = document.getElementById('split-divider');
    const leftPane = document.getElementById('edit');
    const rightPane = document.getElementById('preview');
    const container = document.getElementById('container');
    if (!divider || !leftPane || !rightPane || !container) return;

    let isDragging = false;

    divider.addEventListener('mouseenter', () => {
      divider.classList.add('hover');
    });

    divider.addEventListener('mouseleave', () => {
      if (!isDragging) {
        divider.classList.remove('hover');
      }
    });

    divider.addEventListener('mousedown', () => {
      isDragging = true;
      divider.classList.add('active');
      document.body.style.cursor = 'col-resize';
    });

    divider.addEventListener('dblclick', () => {
      const containerRect = container.getBoundingClientRect();
      const totalWidth = containerRect.width;
      const dividerWidth = divider.offsetWidth;
      const halfWidth = (totalWidth - dividerWidth) / 2;

      leftPane.style.width = halfWidth + 'px';
      rightPane.style.width = halfWidth + 'px';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      document.body.style.userSelect = 'none';
      const containerRect = container.getBoundingClientRect();
      const totalWidth = containerRect.width;
      const offsetX = e.clientX - containerRect.left;
      const dividerWidth = divider.offsetWidth;

      const minWidth = 100;
      const maxWidth = totalWidth - minWidth - dividerWidth;
      const leftWidth = Math.max(minWidth, Math.min(offsetX, maxWidth));
      leftPane.style.width = leftWidth + 'px';
      rightPane.style.width = (totalWidth - leftWidth - dividerWidth) + 'px';
      lastLeftRatio = leftWidth / (totalWidth - dividerWidth);
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        divider.classList.remove('active');
        divider.classList.remove('hover');
        document.body.style.cursor = 'default';
        document.body.style.userSelect = '';
      }
    });

    window.addEventListener('resize', () => {
      const containerRect = container.getBoundingClientRect();
      const totalWidth = containerRect.width;
      const dividerWidth = divider.offsetWidth;
      const availableWidth = totalWidth - dividerWidth;

      const newLeft = availableWidth * lastLeftRatio;
      const newRight = availableWidth * (1 - lastLeftRatio);

      leftPane.style.width = newLeft + 'px';
      rightPane.style.width = newRight + 'px';
    });
  };

  // --- Default template ---

  const defaultInput = `# Markdown syntax guide

## Headers

# This is a Heading h1
## This is a Heading h2
###### This is a Heading h6

## Emphasis

*This text will be italic*  
_This will also be italic_

**This text will be bold**  
__This will also be bold__

_You **can** combine them_

## Lists

### Unordered

* Item 1
* Item 2
* Item 2a
* Item 2b
    * Item 3a
    * Item 3b

### Ordered

1. Item 1
2. Item 2
3. Item 3
    1. Item 3a
    2. Item 3b

## Images

![This is an alt text.](/image/Markdown-mark.svg "This is a sample image.")

## Links

You may be using [Markdown Live Preview](https://markdownlivepreview.com/).

## Blockquotes

> Markdown is a lightweight markup language with plain-text-formatting syntax, created in 2004 by John Gruber with Aaron Swartz.
>
>> Markdown is often used to format readme files, for writing messages in online discussion forums, and to create rich text using a plain text editor.

## Tables

| Left columns  | Right columns |
| ------------- |:-------------:|
| left foo      | right foo     |
| left bar      | right bar     |
| left baz      | right baz     |

## Blocks of code

${'`'}${'`'}${'`'}
let message = 'Hello world';
alert(message);
${'`'}${'`'}${'`'}

## Mermaid diagrams
${'`'}${'`'}${'`'}mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Finish]
  B -->|No| D[Alternate]
${'`'}${'`'}${'`'}

## Inline code

This web site is using ${'`'}markedjs/marked${'`'}.
`;

  // --- Monaco web worker stub ---

  self.MonacoEnvironment = {
    getWorker(_, label) {
      return new Proxy({}, { get: () => () => {} });
    }
  };

  // --- Bootstrap ---

  (async () => {
    await loadDocuments();

    // If no documents, create a default one
    if (documents.length === 0) {
      try {
        const doc = await apiCall(API_BASE, {
          method: 'POST',
          body: JSON.stringify({ name: 'Welcome', content: defaultInput })
        });
        documents = [doc];
        activeDocId = doc.id;
        currentDocContent = doc.content || defaultInput;
        setHashId(doc.id);
      } catch (e) {
        console.error('Failed to create default document:', e);
        documents = [];
        return;
      }
    } else {
      // Pick active doc from URL hash or first doc
      const hashId = getHashId();
      const found = hashId ? documents.find(d => d.id === hashId) : null;
      const targetId = found ? found.id : documents[0].id;
      const doc = await fetchDocContent(targetId);
      if (doc) {
        activeDocId = targetId;
        currentDocContent = doc.content || '';
        setHashId(targetId);
      }
    }

    // Init editor
    editor = setupEditor();

    // Load content into editor
    autoSaveEnabled = false;
    if (currentDocContent) {
      editor.setValue(currentDocContent);
    } else {
      presetValue(defaultInput);
    }
    editor.revealPosition({ lineNumber: 1, column: 1 });
    autoSaveEnabled = true;

    // Render sidebar
    renderSidebar();

    // Wire up UI
    setupNewDocButton();
    setupSaveButton();
    setupResetButton();
    setupCopyButton();
    setupExportButton();
    setupDownloadMdButton();

    // Sync scroll
    initScrollBarSync(loadScrollBarSettings());

    // Theme
    initThemeToggle(loadThemeSettings());

    // Split divider
    setupDivider();

    // React to URL hash changes (e.g. back/forward)
    window.addEventListener('hashchange', () => {
      const hashId = getHashId();
      if (hashId && hashId !== activeDocId && documents.some(d => d.id === hashId)) {
        switchToDocument(hashId);
      }
    });
  })();
};

window.addEventListener('load', () => {
  init();
});
