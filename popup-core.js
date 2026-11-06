// Общая всплывающая подсказка (пиньин, перевод, словарь) — для читалки PDF и для YouTube.
// Словарь и модель живут в фоновом скрипте, сюда приходят готовые данные через backend.js.

import { numberedToMarks, isHan } from "./dict.js";
import { analyze, llm } from "./backend.js";

const MAX_ENTRIES = 6;
const MAX_DEFS = 8;

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function pinyinSpans(numbered) {
  const frag = document.createDocumentFragment();
  numbered.split(/\s+/).forEach((syl, i) => {
    if (i) frag.append(" ");
    const tone = (syl.match(/([1-5])$/) || [, "5"])[1];
    frag.append(el("span", "t" + tone, numberedToMarks(syl)));
  });
  return frag;
}

export function cleanSelection(text) {
  return text
    .replace(/­/g, "")
    .replace(/\s*\n\s*/g, "")
    .replace(/(\p{Script=Han}|[，。！？、；：“”‘’（）《》])\s+(?=\p{Script=Han}|[，。！？、；：“”‘’（）《》])/gu, "$1")
    .trim();
}

export function hanCount(s) {
  let n = 0;
  for (const ch of s) if (isHan(ch)) n++;
  return n;
}

// Кэши общие для всех подсказок на странице.
const trCache = new Map();
const glossCache = new Map();
const defsCache = new Map();

export function clearCaches() {
  trCache.clear();
  glossCache.clear();
  defsCache.clear();
}

/**
 * opts:
 *   container    — куда вставить подсказку (document.body или shadow root)
 *   getSettings  — () => текущие настройки
 *   onOpenSettings — () => открыть настройки (ссылка «Словарь не установлен»)
 *   onHide       — () => вызывается при закрытии
 */
export function createPopup(opts) {
  const popup = el("div", "popup");
  popup.hidden = true;
  popup.setAttribute("role", "dialog");
  opts.container.append(popup);

  const aborts = new Set();
  let showId = 0;
  const S = () => opts.getSettings();

  function track(ac) {
    aborts.add(ac);
    return ac;
  }

  function hide() {
    const wasOpen = !popup.hidden;
    popup.hidden = true;
    showId++;
    aborts.forEach((a) => a.abort());
    aborts.clear();
    if (wasOpen) opts.onHide?.();
  }

  // ---------- Позиционирование ----------
  function place(rect) {
    const z = S().uiScale || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    popup.style.width = `${Math.min(440, (vw - 24) / z)}px`;
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.style.bottom = "auto";
    popup.style.maxHeight = "";
    popup.hidden = false;
    const pw = popup.offsetWidth * z;
    const ph = Math.max(popup.offsetHeight * z, 260 * z);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - pw / 2), vw - pw - 12);
    const below = vh - rect.bottom - 22;
    const above = rect.top - 22;
    popup.style.left = `${left / z}px`;
    if (below >= ph || below >= above) {
      popup.style.top = `${(rect.bottom + 10) / z}px`;
      popup.style.maxHeight = `${Math.max(160, below) / z}px`;
    } else {
      popup.style.top = "auto";
      popup.style.bottom = `${(vh - rect.top + 10) / z}px`;
      popup.style.maxHeight = `${Math.max(160, above) / z}px`;
    }
  }

  // ---------- Блоки ----------
  function noDictNote() {
    const p = el("p", "muted small");
    p.append("Словарь не установлен — пиньин и значения недоступны. ");
    const a = el("a", null, "Открыть настройки");
    a.href = "#";
    a.onclick = (ev) => { ev.preventDefault(); opts.onOpenSettings?.(); };
    p.append(a);
    return p;
  }

  function translationBlock(text, mode) {
    const box = el("div");
    if (!S().llmEnabled) return box;
    box.append(el("div", "label", mode === "word" ? "Перевод (ИИ)" : "Перевод"));
    const tr = el("div", "tr pending", "Перевожу…");
    box.append(tr);

    const key = mode + "|" + text;
    if (trCache.has(key)) {
      tr.textContent = trCache.get(key);
      tr.classList.remove("pending");
      return box;
    }
    const ac = track(new AbortController());
    llm("translate", { text, mode }, (partial) => {
      tr.classList.remove("pending");
      tr.textContent = partial;
    }, ac.signal)
      .then((full) => {
        tr.classList.remove("pending");
        tr.textContent = full || "—";
        if (full) trCache.set(key, full);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        tr.className = "tr err";
        tr.textContent =
          `Нет связи с моделью (${err.message}). Проверьте, что в LM Studio запущен сервер ` +
          `и загружена модель, или отключите перевод в настройках.`;
      });
    return box;
  }

  function dictEntriesBlock(entries, word) {
    const shown = entries.slice(0, MAX_ENTRIES);
    const items = [];
    shown.forEach((e, i) =>
      e.defs.slice(0, MAX_DEFS).forEach((d, j) => items.push({ id: `${i + 1}.${j + 1}`, text: d }))
    );
    const key = `${word}|${items.map((x) => x.text).join("/")}`;

    const wrap = el("div");
    const head = el("div", "label");
    const list = el("div");
    wrap.append(head, list);

    const st = {
      ru: defsCache.get(key) || new Map(),
      state: defsCache.has(key) ? "done" : "idle",
      english: !S().llmEnabled,
      error: "",
    };

    const draw = () => {
      const llmOn = S().llmEnabled;
      const showRu = !st.english && st.ru.size > 0;
      head.replaceChildren(document.createTextNode(st.english || !llmOn ? "Словарь (англ.)" : "Словарь"));
      if (llmOn) {
        const t = el("a", "lang-toggle", st.english ? "по-русски" : "EN");
        t.href = "#";
        t.title = st.english ? "Показать перевод значений" : "Показать оригинал CC-CEDICT на английском";
        t.onclick = (ev) => { ev.preventDefault(); st.english = !st.english; draw(); start(); };
        head.append(t);
      }
      if (st.state === "loading" && !st.english) head.append(el("span", "muted", "  перевожу…"));

      list.replaceChildren();
      shown.forEach((e, i) => {
        const box = el("div", "entry");
        const py = el("div", "entry-py");
        py.append(pinyinSpans(e.pinyin));
        if (e.trad !== e.simp) py.append(el("span", "muted", `  ${e.simp} / ${e.trad}`));
        const ol = el("ol", "defs");
        e.defs.slice(0, MAX_DEFS).forEach((d, j) => {
          const ru = showRu ? st.ru.get(`${i + 1}.${j + 1}`) : null;
          const li = el("li", ru || st.english || st.state !== "loading" ? null : "muted", ru || d);
          if (ru) li.title = d;
          ol.append(li);
        });
        box.append(py, ol);
        list.append(box);
      });
      if (st.state === "error" && !st.english) {
        list.append(el("p", "err small", `Не удалось перевести значения (${st.error}).`));
      }
    };

    const start = () => {
      if (st.english || !S().llmEnabled || st.state === "loading" || st.state === "done" || !items.length) return;
      st.state = "loading";
      draw();
      const ac = track(new AbortController());
      llm("defs", { word, items }, (m) => {
        if (m.size) { st.ru = m; draw(); }
      }, ac.signal)
        .then((m) => {
          st.ru = m;
          st.state = "done";
          if (m.size) defsCache.set(key, m);
          draw();
        })
        .catch((err) => {
          if (err.name === "AbortError") { st.state = "idle"; return; }
          st.state = "error";
          st.error = err.message;
          draw();
        });
    };

    draw();
    start();
    return wrap;
  }

  function makeGloss(sentence, segs) {
    const words = [...new Set(segs.filter((s) => isHan(s.text[0])).map((s) => s.text))];
    const cached = glossCache.get(sentence);
    const g = {
      map: cached || new Map(),
      state: cached ? "done" : "idle",
      error: "",
      subs: new Set(),
      notify() { g.subs.forEach((fn) => fn()); },
      start() {
        if (!S().llmEnabled || g.state === "loading" || g.state === "done" || !words.length) return;
        g.state = "loading";
        g.notify();
        const ac = track(new AbortController());
        llm("gloss", { words, sentence }, (m) => {
          if (m.size) { g.map = m; g.notify(); }
        }, ac.signal)
          .then((m) => {
            g.map = m;
            g.state = "done";
            if (m.size) glossCache.set(sentence, m);
            g.notify();
          })
          .catch((err) => {
            if (err.name === "AbortError") { g.state = "idle"; return; }
            g.state = "error";
            g.error = err.message;
            g.notify();
          });
      },
    };
    return g;
  }

  function wordsList(segs, gloss) {
    const ul = el("ul", "words");
    const draw = () => {
      ul.replaceChildren();
      for (const s of segs) {
        if (!s.entries.length && !isHan(s.text[0])) continue;
        const li = el("li");
        li.append(el("span", "w", s.text));
        if (s.entries.length) {
          const p = el("span", "p");
          p.append(pinyinSpans(s.entries[0].pinyin));
          li.append(p);
        }
        const ru = gloss?.map.get(s.text);
        if (ru) li.append(el("span", "ru", ru));
        else if (gloss?.state === "loading") li.append(el("span", "d", "…"));
        else if (s.entries.length) li.append(el("span", "d", s.entries[0].defs.slice(0, 3).join("; ")));
        else li.append(el("span", "d", "нет в словаре"));
        ul.append(li);
      }
      if (gloss?.state === "error") {
        ul.append(el("li", "err small", `Не удалось перевести слова (${gloss.error}). Показаны значения из словаря.`));
      } else if (gloss && !S().llmEnabled) {
        ul.append(el("li", "muted small", "Перевод через модель отключён — показаны значения из словаря (англ.)."));
      }
    };
    draw();
    gloss?.subs.add(draw);
    return ul;
  }

  function renderWord(text, a) {
    const entries = a.exact;
    const head = el("div", "head");
    head.append(el("span", "hz", text));
    if (entries[0] && entries[0].trad !== entries[0].simp) {
      const other = text === entries[0].simp ? entries[0].trad : entries[0].simp;
      head.append(el("span", "hz-trad", other));
    }
    const py = el("span", "py");
    if (entries.length) {
      const readings = [...new Set(entries.map((e) => e.pinyin.toLowerCase()))];
      readings.slice(0, 3).forEach((r, i) => {
        if (i) py.append(el("span", "muted", " · "));
        py.append(pinyinSpans(r));
      });
    } else if (a.ready) {
      a.segs.forEach((s, i) => {
        if (i) py.append(" ");
        if (s.entries.length) py.append(pinyinSpans(s.entries[0].pinyin));
        else py.append(s.text);
      });
    }
    head.append(py);

    const body = [head, translationBlock(text, "word")];
    if (!a.ready) body.push(noDictNote());
    else if (entries.length) body.push(dictEntriesBlock(entries, text));
    else body.push(el("div", "label", "По частям"), wordsList(a.segs));
    return body;
  }

  function renderPhrase(text, a) {
    const body = [];
    const segs = a.segs;
    const gloss = a.ready ? makeGloss(text, segs) : null;

    if (a.ready) {
      const line = el("div", "ruby-line");
      const detail = el("div", "seg-detail");
      detail.hidden = true;
      let shown = null;
      let defsFor = null;
      let defsBlock = null;
      const drawDetail = () => {
        if (!shown) return;
        const h = el("div", "head");
        h.append(el("span", "hz", shown.text));
        const py = el("span", "py");
        py.append(pinyinSpans(shown.entries[0].pinyin));
        h.append(py);
        const parts = [h];
        const ru = gloss.map.get(shown.text);
        if (ru) parts.push(el("div", "tr", ru));
        else if (gloss.state === "loading") parts.push(el("div", "tr pending", "Перевожу…"));
        if (defsFor !== shown) {
          defsFor = shown;
          defsBlock = dictEntriesBlock(shown.entries, shown.text);
        }
        parts.push(defsBlock);
        detail.replaceChildren(...parts);
      };
      gloss.subs.add(drawDetail);

      for (const s of segs) {
        if (s.entries.length) {
          const r = el("ruby");
          r.append(s.text);
          const rt = el("rt");
          rt.append(pinyinSpans(s.entries[0].pinyin));
          r.append(rt);
          r.onclick = () => {
            line.querySelectorAll("ruby.active").forEach((x) => x.classList.remove("active"));
            if (shown === s && !detail.hidden) {
              detail.hidden = true;
              shown = null;
              return;
            }
            r.classList.add("active");
            shown = s;
            drawDetail();
            detail.hidden = false;
            gloss.start();
          };
          line.append(r);
        } else {
          line.append(el("span", null, s.text));
        }
      }
      body.push(line, detail);
    } else {
      body.push(el("div", "ruby-line", text), noDictNote());
    }

    body.push(translationBlock(text, "phrase"));

    if (a.ready) {
      const det = el("details");
      det.append(el("summary", null, "Разбор по словам"), wordsList(segs, gloss));
      det.addEventListener("toggle", () => { if (det.open) gloss.start(); });
      body.push(det);
    }
    return body;
  }

  async function show(rawText, rect) {
    const text = rawText.slice(0, 2000);
    const id = ++showId;
    aborts.forEach((x) => x.abort());
    aborts.clear();
    let a;
    try {
      a = await analyze(text);
    } catch (err) {
      a = { ready: false, exact: [], segs: [], error: err.message };
    }
    if (id !== showId) return; // за это время выделили другое

    const close = el("button", "close", "✕");
    close.title = "Закрыть (Esc)";
    close.onclick = hide;

    const n = hanCount(text);
    const isWord =
      n === Array.from(text).length &&
      (n <= 2 || (n <= 6 && a.exact.length > 0) || (!a.ready && n <= 4));

    popup.replaceChildren(close, ...(isWord ? renderWord(text, a) : renderPhrase(text, a)));
    popup.scrollTop = 0;
    place(rect);
  }

  return {
    el: popup,
    show,
    hide,
    isOpen: () => !popup.hidden,
  };
}
