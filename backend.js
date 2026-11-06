// Связь страниц расширения и YouTube с фоновым скриптом (словарь + модель).

export async function analyze(text) {
  const res = await chrome.runtime.sendMessage({ type: "analyze", text });
  if (!res) throw new Error("Фоновый скрипт не ответил");
  if (res.error) throw new Error(res.error);
  return res;
}

// Сегменты для строки субтитров (быстро, без полной статьи).
export async function segmentLine(text) {
  const res = await chrome.runtime.sendMessage({ type: "segment", text });
  return res || { ready: false, segs: [] };
}

export async function dictStatus() {
  return chrome.runtime.sendMessage({ type: "dict-status" });
}

export async function dictReload() {
  return chrome.runtime.sendMessage({ type: "dict-reload" });
}

/**
 * Запрос к модели через фон. kind: "translate" | "gloss" | "defs".
 * onPartial получает строку (translate) или Map (gloss/defs). Возвращает итог.
 */
export function llm(kind, args, onPartial, signal) {
  return new Promise((resolve, reject) => {
    const toResult = (v) => (kind === "translate" ? v : new Map(v));
    if (signal?.aborted) return reject(new DOMException("Отменено", "AbortError"));
    const port = chrome.runtime.connect({ name: "llm" });
    let finished = false;
    const finish = () => { finished = true; try { port.disconnect(); } catch {} };
    signal?.addEventListener("abort", () => {
      if (finished) return;
      finish();
      reject(new DOMException("Отменено", "AbortError"));
    });
    port.onMessage.addListener((msg) => {
      if (msg.partial !== undefined) onPartial?.(toResult(msg.partial));
      else if (msg.done) { finish(); resolve(toResult(msg.result)); }
      else if (msg.error) { finish(); reject(new Error(msg.error)); }
    });
    port.onDisconnect.addListener(() => {
      if (!finished) { finished = true; reject(new Error("Соединение с фоном прервано")); }
    });
    port.postMessage({ kind, args });
  });
}
