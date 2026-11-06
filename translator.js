// Перевод через локальную модель (LM Studio) или любой OpenAI-совместимый сервер.

export const DEFAULT_SETTINGS = {
  llmEnabled: true,
  endpoint: "http://localhost:1234/v1",
  model: "",       // пусто — взять первую загруженную модель
  apiKey: "",      // для LM Studio не нужен
  targetLang: "русский",
  autoOpen: true,
  uiScale: 1,      // размер интерфейса (панель, подсказка, настройки)
  // YouTube
  ytOverlay: true,     // показывать свои субтитры вместо субтитров YouTube
  ytPinyin: true,      // пиньин над субтитрами
  ytToneColors: true,  // цвет тонов в пиньине
  ytPauseOnSelect: true, // пауза при выделении, продолжение после закрытия подсказки
  ytPauseOnHover: false, // пауза, пока курсор над субтитрами
  ytSubSize: 1,        // размер субтитров
};

export async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

function base(endpoint) {
  return endpoint.replace(/\/+$/, "");
}

function headers(settings) {
  const h = { "Content-Type": "application/json" };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

let modelCache = null;

export async function listModels(settings) {
  const res = await fetch(`${base(settings.endpoint)}/models`, { headers: headers(settings) });
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
}

async function resolveModel(settings) {
  if (settings.model) return settings.model;
  if (modelCache) return modelCache;
  const models = await listModels(settings);
  if (!models.length) throw new Error("В LM Studio не загружена ни одна модель");
  modelCache = models[0];
  return modelCache;
}

export function resetModelCache() {
  modelCache = null;
}

function buildMessages(text, mode, lang) {
  if (mode === "word") {
    return [
      {
        role: "system",
        content:
          `Ты — словарь для изучающих китайский язык. ` +
          `Дай краткий перевод китайского слова на ${lang} язык: 1–4 основных значения через точку с запятой. ` +
          `Без пиньиня, без пояснений, без кавычек.`,
      },
      { role: "user", content: text },
    ];
  }
  return [
    {
      role: "system",
      content:
        `Ты — переводчик с китайского на ${lang} язык. ` +
        `Переведи текст точно и естественно. Выведи только перевод, без пиньиня и комментариев.`,
    },
    { role: "user", content: text },
  ];
}

/**
 * Потоковый перевод. onChunk вызывается с накопленным текстом.
 * Возвращает итоговый текст. signal — AbortSignal для отмены.
 */
export async function translate(text, mode, settings, onChunk, signal) {
  return chat(buildMessages(text, mode, settings.targetLang), mode === "word" ? 120 : 1500,
    settings, onChunk, signal);
}

/**
 * Краткий перевод каждого слова в контексте предложения.
 * onPartial получает Map(слово → перевод) по мере поступления строк.
 */
export async function glossWords(words, sentence, settings, onPartial, signal) {
  const lang = settings.targetLang;
  const messages = [
    {
      role: "system",
      content:
        `Ты — словарь для изучающих китайский язык. Тебе дают предложение и список слов из него. ` +
        `Для каждого слова дай краткий перевод на ${lang} язык (1–4 слова) именно в значении, ` +
        `в котором оно употреблено в этом предложении. Для служебных частиц кратко укажи функцию ` +
        `(например: «частица принадлежности»). Формат ответа — по одной строке на слово, ` +
        `строго «слово = перевод», в том же порядке, без нумерации и без пиньиня.`,
    },
    { role: "user", content: `Предложение: ${sentence}\nСлова:\n${words.join("\n")}` },
  ];
  const parse = (text) => {
    const map = new Map();
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(?:[-*•\d.)]+\s*)?([^=:：\s]+)\s*[=:：—-]+\s*(.+?)\s*$/);
      if (m && words.includes(m[1])) map.set(m[1], m[2].replace(/^[«"']|[»"']$/g, ""));
    }
    return map;
  };
  const full = await chat(messages, 60 + words.length * 30, settings,
    (partial) => onPartial?.(parse(partial)), signal);
  return parse(full);
}

/**
 * Перевод словарных значений CC-CEDICT (англ.) на язык пользователя.
 * items — [{id: "1.2", text: "good"}]; onPartial получает Map(id → перевод).
 */
export async function translateDefs(word, items, settings, onPartial, signal) {
  const lang = settings.targetLang;
  const messages = [
    {
      role: "system",
      content:
        `Ты переводишь статьи китайско-английского словаря на ${lang} язык для изучающих китайский. ` +
        `Тебе дают китайское слово и пронумерованные английские значения. Переведи каждое значение ` +
        `кратко и точно, как в словаре, учитывая, что это значение именно этого китайского слова. ` +
        `Пояснения в скобках тоже переведи. Формат — по строке на значение, строго «номер = перевод», ` +
        `с теми же номерами и в том же порядке, без пиньиня и комментариев.`,
    },
    { role: "user", content: `Слово: ${word}\n${items.map((i) => `${i.id} = ${i.text}`).join("\n")}` },
  ];
  const parse = (text) => {
    const map = new Map();
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\d+\.\d+)\s*[=:：—-]+\s*(.+?)\s*$/);
      if (m) map.set(m[1], m[2]);
    }
    return map;
  };
  const full = await chat(messages, 80 + items.length * 40, settings,
    (partial) => onPartial?.(parse(partial)), signal);
  return parse(full);
}

async function chat(messages, maxTokens, settings, onChunk, signal) {
  const model = await resolveModel(settings);
  const res = await fetch(`${base(settings.endpoint)}/chat/completions`, {
    method: "POST",
    headers: headers(settings),
    signal,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Сервер ответил ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content ?? "";
        if (delta) {
          out += delta;
          onChunk?.(cleanup(out));
        }
      } catch {
        /* неполная строка — пропускаем */
      }
    }
  }
  return cleanup(out);
}

// Убираем «размышления» reasoning-моделей и лишние пробелы.
function cleanup(s) {
  return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
}
