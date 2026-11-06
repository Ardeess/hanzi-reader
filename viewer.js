import * as pdfjsLib from "./lib/pdf.min.mjs";
import { downloadDictionary, installFromBuffer, isHan } from "./dict.js";
import { getSettings, saveSettings, listModels } from "./translator.js";
import { createPopup, cleanSelection, hanCount, clearCaches } from "./popup-core.js";
import { dictStatus, dictReload, llm } from "./backend.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.mjs");

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

let dict = null;
let settings = null;

// ======================================================================
//  PDF
// ======================================================================
const state = {
  doc: null,
  key: "",
  scale: 1.4,
  pages: [],        // { num, div, rendered, rendering }
  observer: null,
  baseSize: null,   // размеры первой страницы при scale=1
};

async function openPdf(source, name) {
  $("emptyMsg").hidden = true;
  try {
    const task = pdfjsLib.getDocument({
      ...source,
      cMapUrl: chrome.runtime.getURL("lib/cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL("lib/standard_fonts/"),
      wasmUrl: chrome.runtime.getURL("lib/wasm/"),
      iccUrl: chrome.runtime.getURL("lib/iccs/"),
    });
    const doc = await task.promise;
    if (state.doc) state.doc.destroy();
    state.doc = doc;
    state.key = "pos:" + (doc.fingerprints?.[0] || name);
    document.title = `${name} — Hanzi PDF Reader`;
    $("docTitle").textContent = name;
    $("pageCount").textContent = doc.numPages;
    $("navGroup").hidden = false;
    $("emptyState").hidden = true;

    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    state.baseSize = { w: vp.width, h: vp.height };

    const saved = readPos();
    state.scale = saved?.scale || fitWidthScale();
    await buildPages(saved?.page || 1);
  } catch (err) {
    console.error(err);
    showEmptyError(`Не удалось открыть PDF: ${err.message || err}`);
  }
}

function showEmptyError(msg) {
  $("emptyState").hidden = false;
  $("pages").replaceChildren();
  $("navGroup").hidden = true;
  $("emptyMsg").textContent = msg;
  $("emptyMsg").hidden = false;
}

function fitWidthScale() {
  const avail = $("viewer").clientWidth - 48;
  const s = avail / state.baseSize.w;
  return Math.max(0.5, Math.min(3, Math.round(s * 20) / 20));
}

async function buildPages(goToPage = 1) {
  state.observer?.disconnect();
  const container = $("pages");
  container.replaceChildren();
  state.pages = [];
  const { w, h } = state.baseSize;
  for (let i = 1; i <= state.doc.numPages; i++) {
    const div = el("div", "page");
    div.dataset.num = i;
    div.style.width = `${Math.floor(w * state.scale)}px`;
    div.style.height = `${Math.floor(h * state.scale)}px`;
    div.append(el("div", "page-num", String(i)));
    container.append(div);
    state.pages.push({ num: i, div, rendered: false, rendering: null });
  }
  $("zoomLabel").textContent = `${Math.round(state.scale * 100)}%`;

  state.observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = state.pages[Number(e.target.dataset.num) - 1];
        if (e.isIntersecting) renderPage(p);
      }
    },
    { root: $("viewer"), rootMargin: "1200px 0px" }
  );
  state.pages.forEach((p) => state.observer.observe(p.div));
  scrollToPage(goToPage, false);
}

async function renderPage(p) {
  if (p.rendered || p.rendering) return;
  const scale = state.scale;
  p.rendering = (async () => {
    const page = await state.doc.getPage(p.num);
    if (scale !== state.scale) return;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    p.div.style.width = `${Math.floor(viewport.width)}px`;
    p.div.style.height = `${Math.floor(viewport.height)}px`;
    p.div.style.setProperty("--total-scale-factor", String(scale));

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    const ctx = canvas.getContext("2d");
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
    if (scale !== state.scale) return;

    const textDiv = el("div", "textLayer");
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true }),
      container: textDiv,
      viewport,
    });
    await textLayer.render();
    const end = el("div", "endOfContent");
    textDiv.append(end);
    textDiv.addEventListener("mousedown", () => textDiv.classList.add("selecting"));

    p.div.prepend(canvas, textDiv);
    p.rendered = true;
  })().catch((err) => console.error("render", p.num, err)).finally(() => {
    p.rendering = null;
  });
}

function currentPage() {
  const viewer = $("viewer");
  const mid = viewer.scrollTop + viewer.clientHeight * 0.35;
  for (const p of state.pages) {
    if (p.div.offsetTop + p.div.offsetHeight > mid) return p.num;
  }
  return state.pages.length || 1;
}

function scrollToPage(n, smooth = true) {
  const p = state.pages[Math.max(1, Math.min(n, state.pages.length)) - 1];
  if (!p) return;
  $("viewer").scrollTo({ top: p.div.offsetTop - 12, behavior: smooth ? "smooth" : "auto" });
  $("pageInput").value = p.num;
}

async function setScale(s) {
  if (!state.doc) return;
  const page = currentPage();
  state.scale = Math.max(0.4, Math.min(4, Math.round(s * 100) / 100));
  await buildPages(page);
  savePos();
}

function readPos() {
  try { return JSON.parse(localStorage.getItem(state.key) || "null"); } catch { return null; }
}
let saveTimer = 0;
function savePos() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(state.key, JSON.stringify({ page: currentPage(), scale: state.scale }));
    } catch { /* нет хранилища — не страшно */ }
  }, 400);
}

// ---------- Откуда открываем ----------
async function openFromFile(file) {
  const buf = await file.arrayBuffer();
  await openPdf({ data: new Uint8Array(buf) }, file.name);
}

async function openFromUrl(url) {
  const name = decodeURIComponent(url.split(/[\/\\]/).pop().split(/[?#]/)[0] || "document.pdf");
  if (url.startsWith("file:")) {
    const allowed = await new Promise((r) => chrome.extension.isAllowedFileSchemeAccess(r));
    if (!allowed) {
      showEmptyError(
        "Чтобы открывать локальные PDF по ссылке, включите «Разрешить доступ к URL файлов» " +
        "для расширения на странице chrome://extensions. Или просто перетащите файл сюда."
      );
      return;
    }
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    await openPdf({ data: new Uint8Array(buf) }, name);
  } catch (err) {
    showEmptyError(`Не удалось загрузить ${name}: ${err.message}`);
  }
}

// ======================================================================
//  Подсказка с переводом (общий модуль popup-core.js)
// ======================================================================
let popup = null;
let lastSelection = "";

function hideTooltip() {
  popup?.hide();
}

function uiZoom() {
  return settings?.uiScale || 1;
}

function applyUiScale() {
  const z = uiZoom();
  document.documentElement.style.setProperty("--ui-zoom", String(z));
  const inp = $("uiScale");
  if (inp) inp.value = z;
  const lbl = $("uiScaleLabel");
  if (lbl) lbl.textContent = `${Math.round(z * 100)}%`;
}

function onSelectionDone(ev) {
  if (!$("pages").contains(ev.target)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!$("pages").contains(range.commonAncestorContainer)) return;
    const text = cleanSelection(sel.toString());
    if (!text || hanCount(text) === 0) return;
    if (text === lastSelection && popup.isOpen()) return;
    lastSelection = text;
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    popup.show(text, rect);
  }, 10);
}

// ======================================================================
//  Словарь
// ======================================================================
async function setDictStatus() {
  const s = $("dictStatus");
  dict = await dictStatus().catch(() => null);
  if (!dict?.ready) dict = null;
  if (dict) {
    s.textContent = "";
    s.className = "status";
    $("dictInfo").textContent = `Установлен: ${dict.size.toLocaleString("ru-RU")} записей.`;
    $("dictDownload").textContent = "Обновить словарь";
  } else {
    s.textContent = "Словарь не установлен";
    s.className = "status warn";
    $("dictInfo").textContent = "Не установлен.";
  }
}

async function runDownload() {
  const bar = $("dictProgress");
  bar.hidden = false;
  bar.removeAttribute("value");
  $("dictInfo").textContent = "Скачиваю CC-CEDICT…";
  $("dictStatus").textContent = "Скачиваю словарь…";
  $("dictStatus").className = "status";
  try {
    await downloadDictionary((got, total) => {
      if (total) { bar.max = total; bar.value = got; }
    });
    await dictReload();
    await setDictStatus();
  } catch (err) {
    console.error(err);
    await setDictStatus();
    $("dictInfo").textContent =
      `Не удалось скачать (${err.message}). Скачайте файл вручную с mdbg.net (CC-CEDICT, .zip или .txt.gz) ` +
      `и нажмите «Загрузить файл…».`;
  } finally {
    bar.hidden = true;
  }
}

// ======================================================================
//  Настройки
// ======================================================================
function openSettings() {
  $("settings").hidden = false;
  fillModels();
}

async function fillModels() {
  const list = $("modelList");
  $("model").value = settings.model || "";
  try {
    const models = await listModels(settings);
    list.replaceChildren(...models.map((m) => new Option(m, m)));
  } catch {
    list.replaceChildren();
  }
}

function bindSettings() {
  $("llmEnabled").checked = settings.llmEnabled;
  $("endpoint").value = settings.endpoint;
  $("targetLang").value = settings.targetLang;
  $("apiKey").value = settings.apiKey;
  $("autoOpen").checked = settings.autoOpen;

  const update = async (patch) => {
    Object.assign(settings, patch);
    await saveSettings(patch);
    clearCaches();
  };
  $("llmEnabled").onchange = (e) => update({ llmEnabled: e.target.checked });
  $("endpoint").onchange = (e) => { update({ endpoint: e.target.value.trim() || "http://localhost:1234/v1" }); fillModels(); };
  $("targetLang").onchange = (e) => update({ targetLang: e.target.value.trim() || "русский" });
  $("apiKey").onchange = (e) => update({ apiKey: e.target.value.trim() });
  $("model").onchange = (e) => update({ model: e.target.value.trim() });
  $("autoOpen").onchange = (e) => update({ autoOpen: e.target.checked });
  for (const k of ["ytOverlay", "ytPinyin", "ytToneColors", "ytPauseOnSelect", "ytPauseOnHover"]) {
    $(k).checked = !!settings[k];
    $(k).onchange = (e) => update({ [k]: e.target.checked });
  }
  $("refreshModels").onclick = fillModels;

  const setUi = (v) => {
    const z = Math.max(0.8, Math.min(1.8, Math.round(v * 20) / 20));
    settings.uiScale = z;
    saveSettings({ uiScale: z });
    applyUiScale();
    hideTooltip();
  };
  $("uiScale").oninput = (e) => setUi(parseFloat(e.target.value));
  $("uiSmaller").onclick = () => setUi(uiZoom() - 0.1);
  $("uiBigger").onclick = () => setUi(uiZoom() + 0.1);

  $("testLlm").onclick = async () => {
    const out = $("llmTestResult");
    out.textContent = "Проверяю…";
    out.className = "muted small";
    try {
      const res = await llm("translate", { text: "你好，世界", mode: "phrase" }, null);
      out.textContent = `Работает: «${res}»`;
    } catch (err) {
      out.textContent = `Ошибка: ${err.message}`;
      out.className = "error small";
    }
  };

  $("dictDownload").onclick = runDownload;
  $("dictFile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("dictInfo").textContent = "Загружаю…";
    try {
      await installFromBuffer(await f.arrayBuffer());
      await dictReload();
      await setDictStatus();
    } catch (err) {
      $("dictInfo").textContent = `Ошибка: ${err.message}`;
    }
    e.target.value = "";
  };
  $("settingsBtn").onclick = () => ($("settings").hidden ? openSettings() : ($("settings").hidden = true));
  $("settingsClose").onclick = () => ($("settings").hidden = true);
  $("dictStatus").onclick = () => { if (!dict) openSettings(); };
}

// ======================================================================
//  События
// ======================================================================
function bindUi() {
  $("fileInput").onchange = (e) => {
    const f = e.target.files[0];
    if (f) openFromFile(f);
    e.target.value = "";
  };
  $("prevPage").onclick = () => scrollToPage(currentPage() - 1);
  $("nextPage").onclick = () => scrollToPage(currentPage() + 1);
  $("pageInput").onchange = (e) => scrollToPage(parseInt(e.target.value, 10) || 1);
  $("zoomIn").onclick = () => setScale(state.scale * 1.15);
  $("zoomOut").onclick = () => setScale(state.scale / 1.15);
  $("zoomLabel").onclick = () => setScale(fitWidthScale());

  $("viewer").addEventListener("scroll", () => {
    if (!state.doc) return;
    $("pageInput").value = currentPage();
    savePos();
    if (popup.isOpen()) hideTooltip();
  }, { passive: true });

  document.addEventListener("mouseup", (e) => {
    document.querySelectorAll(".textLayer.selecting").forEach((t) => t.classList.remove("selecting"));
    onSelectionDone(e);
  });
  document.addEventListener("mousedown", (e) => {
    if (popup.isOpen() && !popup.el.contains(e.target)) hideTooltip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideTooltip(); $("settings").hidden = true; }
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); setScale(state.scale * 1.15); }
    if ((e.ctrlKey || e.metaKey) && e.key === "-") { e.preventDefault(); setScale(state.scale / 1.15); }
  });

  // Перетаскивание файла
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("dropOverlay").hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dropOverlay").hidden = true;
    const f = [...e.dataTransfer.files].find((x) => /\.pdf$/i.test(x.name) || x.type === "application/pdf");
    if (f) openFromFile(f);
  });
}

// ======================================================================
//  Запуск
// ======================================================================
(async function init() {
  settings = await getSettings();
  popup = createPopup({
    container: document.body,
    getSettings: () => settings,
    onOpenSettings: () => openSettings(),
  });
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, v] of Object.entries(changes)) if (k in settings) settings[k] = v.newValue;
    if (changes.uiScale) applyUiScale();
  });
  applyUiScale();
  bindUi();
  bindSettings();

  if (location.hash === "#settings") openSettings();
  const fileParam = new URLSearchParams(location.search).get("file");
  if (fileParam) openFromUrl(fileParam);

  await setDictStatus();
  if (!dict) {
    const { dictAutoTried } = await chrome.storage.local.get("dictAutoTried");
    if (!dictAutoTried) {
      await chrome.storage.local.set({ dictAutoTried: true });
      runDownload();
    }
  }
})();
