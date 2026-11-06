// Загрузчик для YouTube: основной код — ES-модуль youtube.js.
(async () => {
  try {
    await import(chrome.runtime.getURL("youtube.js"));
  } catch (err) {
    console.error("[Hanzi Reader] не удалось запустить на YouTube:", err);
  }
})();
