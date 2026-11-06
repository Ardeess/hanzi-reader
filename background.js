// Hanzi Reader — фоновый скрипт.
// • Клик по значку открывает читалку PDF.
// • PDF, открытые в Chrome, перенаправляются в читалку (если включено).
// • Здесь живут словарь CC-CEDICT и запросы к модели: ими пользуются и читалка, и YouTube.

import { loadDictionary, resetDictionary } from "./dict.js";
import { getSettings, translate, glossWords, translateDefs, resetModelCache } from "./translator.js";

const VIEWER = chrome.runtime.getURL("viewer.html");

function viewerUrl(fileUrl) {
  return fileUrl ? `${VIEWER}?file=${encodeURIComponent(fileUrl)}` : VIEWER;
}

function looksLikePdf(url) {
  if (!url || url.startsWith(VIEWER)) return false;
  if (!/^(https?|file):/i.test(url)) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: VIEWER }));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "open-link", title: "Открыть PDF в Hanzi Reader", contexts: ["link"] });
    chrome.contextMenus.create({ id: "open-page", title: "Открыть эту страницу в Hanzi Reader", contexts: ["page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "open-link" ? info.linkUrl : info.pageUrl;
  if (!url) return;
  if (info.menuItemId === "open-page" && tab?.id != null) chrome.tabs.update(tab.id, { url: viewerUrl(url) });
  else chrome.tabs.create({ url: viewerUrl(url) });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  const url = changeInfo.url;
  if (!looksLikePdf(url)) return;
  const { autoOpen = true } = await chrome.storage.local.get("autoOpen");
  if (autoOpen) chrome.tabs.update(tabId, { url: viewerUrl(url) });
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.endpoint || changes.model || changes.apiKey) resetModelCache();
});

// ---------- Словарь ----------
const slim = (e) => ({ trad: e.trad, simp: e.simp, pinyin: e.pinyin, defs: e.defs });
const segCache = new Map();

async function handle(msg) {
  if (msg.type === "open-settings") {
    chrome.tabs.create({ url: VIEWER + "#settings" });
    return { ok: true };
  }
  if (msg.type === "dict-status") {
    const d = await loadDictionary();
    return { ready: !!d, size: d?.size || 0 };
  }
  if (msg.type === "dict-reload") {
    resetDictionary();
    segCache.clear();
    const d = await loadDictionary();
    return { ready: !!d, size: d?.size || 0 };
  }
  if (msg.type === "analyze") {
    const d = await loadDictionary();
    if (!d) return { ready: false, exact: [], segs: [] };
    return {
      ready: true,
      exact: d.lookup(msg.text).map(slim),
      segs: d.segment(msg.text).map((s) => ({ text: s.text, entries: s.entries.slice(0, 6).map(slim) })),
    };
  }
  if (msg.type === "segment") {
    // Для строк субтитров: только первое чтение каждого слова.
    if (segCache.has(msg.text)) return segCache.get(msg.text);
    const d = await loadDictionary();
    if (!d) return { ready: false, segs: [] };
    const res = {
      ready: true,
      segs: d.segment(msg.text).map((s) => ({ text: s.text, pinyin: s.entries[0]?.pinyin || "" })),
    };
    if (segCache.size > 500) segCache.clear();
    segCache.set(msg.text, res);
    return res;
  }
  return { error: "Неизвестный запрос" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

// ---------- Модель (потоково через порт) ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "llm") return;
  const ac = new AbortController();
  port.onDisconnect.addListener(() => ac.abort());
  const send = (m) => { try { port.postMessage(m); } catch { /* порт уже закрыт */ } };

  port.onMessage.addListener(async ({ kind, args }) => {
    try {
      const settings = await getSettings();
      let result;
      if (kind === "translate") {
        result = await translate(args.text, args.mode, settings, (p) => send({ partial: p }), ac.signal);
      } else if (kind === "gloss") {
        const m = await glossWords(args.words, args.sentence, settings, (p) => send({ partial: [...p] }), ac.signal);
        result = [...m];
      } else if (kind === "defs") {
        const m = await translateDefs(args.word, args.items, settings, (p) => send({ partial: [...p] }), ac.signal);
        result = [...m];
      } else {
        throw new Error("Неизвестный тип запроса");
      }
      send({ done: true, result });
    } catch (err) {
      if (err.name !== "AbortError") send({ error: String(err.message || err) });
    }
  });
});
