// Словарь CC-CEDICT: загрузка, хранение в IndexedDB, поиск и сегментация.
// CC-CEDICT распространяется по лицензии CC BY-SA 4.0 (https://cc-cedict.org).

export const CEDICT_URL =
  "https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz";

const DB_NAME = "hanzi-reader";
const STORE = "kv";
const KEY = "cedict-text";

// ---------- IndexedDB ----------
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE).objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Распаковка ----------
async function gunzip(buf) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

// Минимальная распаковка ZIP: берём первый файл архива (deflate или store).
async function unzipFirst(buf) {
  const dv = new DataView(buf);
  // Ищем запись центрального каталога, там надёжные размеры.
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Не похоже на ZIP-архив");
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (dv.getUint32(cdOffset, true) !== 0x02014b50) throw new Error("Повреждённый ZIP");
  const method = dv.getUint16(cdOffset + 10, true);
  const compSize = dv.getUint32(cdOffset + 20, true);
  const localOffset = dv.getUint32(cdOffset + 42, true);
  const nameLen = dv.getUint16(localOffset + 26, true);
  const extraLen = dv.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + compSize);
  if (method === 0) return new TextDecoder().decode(data);
  if (method !== 8) throw new Error("Неподдерживаемое сжатие ZIP");
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Response(stream).text();
}

export async function bufferToText(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (b[0] === 0x1f && b[1] === 0x8b) return gunzip(buf);
  if (b[0] === 0x50 && b[1] === 0x4b) return unzipFirst(buf);
  return new TextDecoder().decode(buf);
}

// ---------- Пиньин: цифры → тоновые знаки ----------
const TONES = {
  a: "āáǎàa", e: "ēéěèe", i: "īíǐìi", o: "ōóǒòo", u: "ūúǔùu", ü: "ǖǘǚǜü",
};
function syllableToMarks(syl) {
  const m = syl.match(/^([a-zü:]+)([1-5])$/i);
  if (!m) return syl.replace(/u:/gi, "ü");
  let [, base, tone] = m;
  base = base.replace(/u:/g, "ü").replace(/U:/g, "Ü");
  const t = Number(tone) - 1;
  if (t === 4) return base;
  const lower = base.toLowerCase();
  let idx = -1;
  if (lower.includes("a")) idx = lower.indexOf("a");
  else if (lower.includes("e")) idx = lower.indexOf("e");
  else if (lower.includes("ou")) idx = lower.indexOf("o");
  else {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ("iouü".includes(lower[i])) { idx = i; break; }
    }
  }
  if (idx < 0) return base;
  const ch = lower[idx];
  let marked = TONES[ch][t];
  if (base[idx] !== ch) marked = marked.toUpperCase();
  return base.slice(0, idx) + marked + base.slice(idx + 1);
}
export function numberedToMarks(pinyin) {
  return pinyin.split(/\s+/).map(syllableToMarks).join(" ");
}

// ---------- Словарь ----------
export class Dictionary {
  constructor() {
    this.map = new Map(); // слово → [{trad, simp, pinyin, defs}]
    this.maxLen = 1;
    this.size = 0;
  }

  static parse(text) {
    const d = new Dictionary();
    const re = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;
    for (const line of text.split("\n")) {
      if (!line || line[0] === "#") continue;
      const m = line.match(re);
      if (!m) continue;
      const [, trad, simp, py, defs] = m;
      const entry = { trad, simp, pinyin: py, defs: defs.split("/").filter(Boolean) };
      d.#add(simp, entry);
      if (trad !== simp) d.#add(trad, entry);
      d.size++;
    }
    return d;
  }

  #add(word, entry) {
    const list = this.map.get(word);
    if (list) list.push(entry);
    else this.map.set(word, [entry]);
    if (word.length > this.maxLen) this.maxLen = word.length;
  }

  lookup(word) {
    const list = this.map.get(word);
    if (!list) return [];
    // Сначала обычные слова, потом имена собственные (пиньин с заглавной).
    return [...list].sort((a, b) => isProper(a) - isProper(b));
  }

  // Прямой поиск максимального совпадения — простая и быстрая сегментация.
  segment(text) {
    const out = [];
    const chars = Array.from(text);
    const cap = Math.min(this.maxLen, 10);
    let i = 0;
    while (i < chars.length) {
      if (!isHan(chars[i])) {
        let j = i;
        while (j < chars.length && !isHan(chars[j])) j++;
        out.push({ text: chars.slice(i, j).join(""), entries: [] });
        i = j;
        continue;
      }
      let found = null;
      for (let len = Math.min(cap, chars.length - i); len >= 1; len--) {
        const w = chars.slice(i, i + len).join("");
        if (this.map.has(w)) { found = w; break; }
      }
      const w = found || chars[i];
      out.push({ text: w, entries: this.lookup(w) });
      i += Array.from(w).length;
    }
    return out;
  }

  // Пиньин для произвольного текста (по сегментам).
  pinyinOf(text) {
    return this.segment(text).map((s) =>
      s.entries.length ? numberedToMarks(s.entries[0].pinyin) : s.text.trim()
    );
  }
}

function isProper(e) {
  return /^[A-Z]/.test(e.pinyin) ? 1 : 0;
}

export function isHan(ch) {
  return /\p{Script=Han}/u.test(ch);
}

// ---------- Загрузка ----------
let cached = null;
let loading = null;

export function resetDictionary() {
  cached = null;
  loading = null;
}

export async function loadDictionary() {
  if (cached) return cached;
  if (!loading) {
    loading = (async () => {
      const text = await idbGet(KEY);
      if (!text) return null;
      cached = Dictionary.parse(text);
      return cached;
    })().finally(() => { loading = null; });
  }
  return loading;
}

export async function installFromBuffer(buf) {
  const text = await bufferToText(buf);
  const dict = Dictionary.parse(text);
  if (dict.size < 10) throw new Error("В файле не найдено записей CC-CEDICT");
  await idbSet(KEY, text);
  cached = dict;
  return dict;
}

export async function downloadDictionary(onProgress) {
  const res = await fetch(CEDICT_URL);
  if (!res.ok) throw new Error(`Сервер словаря ответил ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const buf = await new Blob(chunks).arrayBuffer();
  return installFromBuffer(buf);
}
