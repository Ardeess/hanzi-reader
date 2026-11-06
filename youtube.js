// Hanzi Reader на YouTube: свои субтитры поверх видео — их можно выделять,
// над словами показывается пиньин, при выделении открывается подсказка с переводом.
//
// Текст берётся из субтитров самого YouTube (они должны быть включены и быть китайскими),
// поэтому работают и обычные, и автоматические, и автопереведённые субтитры.

import { DEFAULT_SETTINGS } from "./translator.js";
import { createPopup, pinyinSpans, cleanSelection, hanCount, clearCaches, el } from "./popup-core.js";
import { segmentLine } from "./backend.js";
import { isHan } from "./dict.js";

const HIDE_CLASS = "hanzi-reader-hide-native";
let settings = { ...DEFAULT_SETTINGS };

// ---------- Стили на странице YouTube (скрыть родные субтитры) ----------
const pageStyle = document.createElement("style");
pageStyle.textContent = `
  html.${HIDE_CLASS} .ytp-caption-window-container { opacity: 0 !important; pointer-events: none !important; }
`;
document.documentElement.append(pageStyle);

// ---------- Shadow DOM ----------
const host = document.createElement("div");
host.id = "hanzi-reader-host";
host.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:60;";
const root = host.attachShadow({ mode: "open" });

async function loadCss(file) {
  const res = await fetch(chrome.runtime.getURL(file));
  return res.text();
}
const style = document.createElement("style");
Promise.all([loadCss("popup.css"), loadCss("yt.css")]).then(([a, b]) => { style.textContent = a + "\n" + b; });
root.append(style);

const subs = el("div", "subs");
subs.hidden = true;
const lines = el("div", "lines");
lines.style.display = "contents";
const ctrl = el("div", "ctrl");
const btnPinyin = el("button", null, "拼音");
btnPinyin.title = "Пиньин над субтитрами (Alt+P)";
const btnTones = el("button", null, "Тоны");
btnTones.title = "Цвет тонов";
const btnSmaller = el("button", null, "A−");
const btnBigger = el("button", null, "A+");
const btnOff = el("button", null, "✕");
btnOff.title = "Вернуть субтитры YouTube (Alt+H)";
ctrl.append(btnPinyin, btnTones, btnSmaller, btnBigger, btnOff);
subs.append(ctrl, lines);

const popupLayer = el("div");
popupLayer.style.pointerEvents = "auto";
root.append(subs, popupLayer);

const toastEl = el("div", "toast");
toastEl.hidden = true;
root.append(toastEl);
let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 1800);
}

// ---------- Видео и пауза ----------
let pausedByUs = false;

function player() {
  return document.querySelector("#movie_player");
}
function video() {
  return player()?.querySelector("video");
}
function pauseForStudy() {
  const v = video();
  if (v && !v.paused) {
    v.pause();
    pausedByUs = true;
  }
}
function resumeIfWePaused() {
  const v = video();
  if (pausedByUs && v && v.paused) v.play().catch(() => {});
  pausedByUs = false;
}

// ---------- Подсказка ----------
const popup = createPopup({
  container: popupLayer,
  getSettings: () => settings,
  onOpenSettings: () => chrome.runtime.sendMessage({ type: "open-settings" }),
  onHide: () => {
    root.getSelection?.()?.removeAllRanges();
    if (!(settings.ytPauseOnHover && hovering)) resumeIfWePaused();
    flushPending();
  },
});

// ---------- Чтение родных субтитров ----------
let shownText = "";
let pendingText = null;
let selecting = false;
let hovering = false;
let renderSeq = 0;

function readNativeCaptions() {
  const p = player();
  if (!p) return "";
  const lineEls = p.querySelectorAll(".ytp-caption-window-container .caption-visual-line");
  if (lineEls.length) {
    return [...lineEls]
      .map((l) => [...l.querySelectorAll(".ytp-caption-segment")].map((s) => s.textContent).join(""))
      .filter((t) => t.trim())
      .join("\n");
  }
  return [...p.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment")]
    .map((s) => s.textContent)
    .join("\n");
}

function frozen() {
  return selecting || popup.isOpen() || hasSelection();
}

function hasSelection() {
  const sel = root.getSelection?.();
  return !!(sel && !sel.isCollapsed && subs.contains(sel.anchorNode));
}

function flushPending() {
  if (pendingText !== null && !frozen()) {
    const t = pendingText;
    pendingText = null;
    renderSubs(t);
  }
}

async function renderSubs(text) {
  shownText = text;
  const seq = ++renderSeq;
  if (!text.trim()) {
    lines.replaceChildren();
    subs.hidden = true;
    return;
  }
  const parts = text.split("\n");
  const results = await Promise.all(parts.map((p) => segmentLine(p).catch(() => ({ ready: false, segs: [] }))));
  if (seq !== renderSeq) return;
  const frag = document.createDocumentFragment();
  parts.forEach((part, i) => {
    const line = el("div", "line");
    const r = results[i];
    if (r.ready && r.segs.length) {
      for (const s of r.segs) {
        if (s.pinyin && isHan(s.text[0])) {
          const rb = el("ruby");
          rb.append(s.text);
          const rt = el("rt");
          rt.append(pinyinSpans(s.pinyin));
          rb.append(rt);
          line.append(rb);
        } else {
          line.append(s.text);
        }
      }
    } else {
      line.append(part);
    }
    frag.append(line);
  });
  lines.replaceChildren(frag);
  subs.hidden = false;
}

function applyLook() {
  subs.classList.toggle("pinyin", !!settings.ytPinyin);
  subs.classList.toggle("tones", !!settings.ytToneColors);
  btnPinyin.classList.toggle("on", !!settings.ytPinyin);
  btnTones.classList.toggle("on", !!settings.ytToneColors);
  btnTones.hidden = !settings.ytPinyin;
  host.style.setProperty("--ui-zoom", String(settings.uiScale || 1));
  sizeSubs();
}

function sizeSubs() {
  const p = player();
  if (!p) return;
  const h = p.clientHeight || 360;
  const base = Math.max(16, Math.min(56, h * 0.052));
  subs.style.setProperty("--subs-font", `${base * (settings.ytSubSize || 1)}px`);
  // Над панелью управления плеера, когда она видна.
  const controlsShown = !p.classList.contains("ytp-autohide");
  subs.style.setProperty("--subs-bottom", controlsShown ? "70px" : "4%");
}

function tick() {
  const p = player();
  if (!p) return;
  if (host.parentElement !== p) p.append(host);
  sizeSubs();

  const text = readNativeCaptions();
  const active = settings.ytOverlay && hanCount(text) > 0;
  document.documentElement.classList.toggle(HIDE_CLASS, active || (settings.ytOverlay && frozen() && !!shownText));

  if (!active) {
    if (!frozen() && shownText) renderSubs("");
    return;
  }
  if (text === shownText) { pendingText = null; return; }
  if (frozen()) { pendingText = text; return; }
  renderSubs(text);
}

// ---------- События ----------
const stop = (e) => e.stopPropagation();
for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "pointerdown", "pointerup", "wheel"]) {
  subs.addEventListener(type, stop);
  popupLayer.addEventListener(type, stop);
}

subs.addEventListener("mousedown", (e) => {
  if (ctrl.contains(e.target)) return;
  selecting = true;
  if (settings.ytPauseOnSelect) pauseForStudy();
});

subs.addEventListener("mouseup", (e) => {
  if (ctrl.contains(e.target)) return;
  setTimeout(() => {
    selecting = false;
    const sel = root.getSelection?.();
    const raw = sel && !sel.isCollapsed ? sel.toString() : "";
    const text = cleanSelection(raw.replace(/\n/g, ""));
    if (!text || hanCount(text) === 0) {
      // Просто щёлкнули без выделения — продолжаем видео.
      if (!popup.isOpen() && !(settings.ytPauseOnHover && hovering)) resumeIfWePaused();
      flushPending();
      return;
    }
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    popup.show(text, rect);
  }, 10);
});

subs.addEventListener("mouseenter", () => {
  hovering = true;
  if (settings.ytPauseOnHover) pauseForStudy();
});
subs.addEventListener("mouseleave", () => {
  hovering = false;
  if (settings.ytPauseOnHover && !popup.isOpen() && !selecting) resumeIfWePaused();
});

// Закрытие подсказки щелчком мимо неё.
document.addEventListener("mousedown", (e) => {
  if (!popup.isOpen()) return;
  const path = e.composedPath();
  if (path.includes(popup.el)) return;
  popup.hide();
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popup.isOpen()) {
    e.stopPropagation();
    e.preventDefault();
    popup.hide();
    return;
  }
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
  if (e.altKey && e.code === "KeyP") {
    e.preventDefault();
    save({ ytPinyin: !settings.ytPinyin });
    toast(settings.ytPinyin ? "Пиньин: вкл" : "Пиньин: выкл");
  } else if (e.altKey && e.code === "KeyH") {
    e.preventDefault();
    save({ ytOverlay: !settings.ytOverlay });
    toast(settings.ytOverlay ? "Субтитры Hanzi Reader: вкл" : "Субтитры YouTube");
  }
}, true);

// Пока открыта подсказка, клавиши не должны управлять плеером (пробел, стрелки и т.п.).
popupLayer.addEventListener("keydown", stop);

btnPinyin.onclick = () => save({ ytPinyin: !settings.ytPinyin });
btnTones.onclick = () => save({ ytToneColors: !settings.ytToneColors });
btnSmaller.onclick = () => save({ ytSubSize: Math.max(0.6, Math.round((settings.ytSubSize - 0.1) * 10) / 10) });
btnBigger.onclick = () => save({ ytSubSize: Math.min(2.2, Math.round((settings.ytSubSize + 0.1) * 10) / 10) });
btnOff.onclick = () => {
  save({ ytOverlay: false });
  toast("Субтитры YouTube. Вернуть: Alt+H");
};

function save(patch) {
  Object.assign(settings, patch);
  chrome.storage.local.set(patch);
  applyLook();
  if ("ytOverlay" in patch && !patch.ytOverlay) {
    popup.hide();
    renderSubs("");
    document.documentElement.classList.remove(HIDE_CLASS);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  let touched = false;
  for (const [k, v] of Object.entries(changes)) {
    if (k in DEFAULT_SETTINGS) { settings[k] = v.newValue ?? DEFAULT_SETTINGS[k]; touched = true; }
  }
  if (changes.endpoint || changes.model || changes.targetLang || changes.llmEnabled) clearCaches();
  if (touched) applyLook();
});

// ---------- Запуск ----------
(async () => {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  settings = { ...DEFAULT_SETTINGS, ...stored };
  applyLook();
  setInterval(tick, 150);
})();
