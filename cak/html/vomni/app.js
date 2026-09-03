const DB_NAME = "vomni-library";
const DB_VERSION = 1;
const LATIN_INDEX = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const KANA_INDEX = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん".split("");
const SMALL_KANA = { "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "っ": "つ", "ゎ": "わ", "ゕ": "か", "ゖ": "け" };

const state = {
  db: null,
  libraries: new Map(),
  activeId: "english",
  selectedId: null,
  query: "",
  status: "all",
  pos: "all",
  tag: "all",
  sort: "az",
  index: "all",
  visibleLimit: 120,
  connectedHandle: null,
  saveTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("dictionaries")) db.createObjectStore("dictionaries", { keyPath: "dictionary.id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function dbRequest(storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getAllLibraries = () => dbRequest("dictionaries", "readonly", (store) => store.getAll());
const putLibrary = (library) => dbRequest("dictionaries", "readwrite", (store) => store.put(library));
const getMeta = (key) => dbRequest("meta", "readonly", (store) => store.get(key));
const putMeta = (key, value) => dbRequest("meta", "readwrite", (store) => store.put(value, key));

async function loadInitialData() {
  state.db = await openDatabase();
  let libraries = await getAllLibraries();
  if (!libraries.length) {
    if (!Array.isArray(window.VOMNI_SEED)) throw new Error("示例词库缺失");
    libraries = window.VOMNI_SEED;
    await Promise.all(libraries.map(putLibrary));
  }
  libraries.forEach((library) => state.libraries.set(library.dictionary.id, normalizeLibrary(library)));
  const lastDictionary = await getMeta("lastDictionary");
  if (lastDictionary && state.libraries.has(lastDictionary)) state.activeId = lastDictionary;
  try { state.connectedHandle = await getMeta("connectedFileHandle"); } catch { state.connectedHandle = null; }
}

function normalizeLibrary(library) {
  const dictionary = {
    id: library.dictionary?.id || `dictionary-${Date.now()}`,
    name: library.dictionary?.name || library.dictionary?.nativeName || "未命名词典",
    nativeName: library.dictionary?.nativeName || library.dictionary?.name || "未命名词典",
    language: library.dictionary?.language || "und",
    capabilities: library.dictionary?.capabilities || ["definition", "partOfSpeech", "tags", "status"],
  };
  const entries = (library.entries || []).map((entry, index) => ({
    id: entry.id || `${dictionary.id}-${crypto.randomUUID?.() || `${Date.now()}-${index}`}`,
    term: String(entry.term || ""),
    reading: String(entry.reading || ""),
    definition: String(entry.definition || ""),
    partOfSpeech: String(entry.partOfSpeech || ""),
    stressRanges: Array.isArray(entry.stressRanges) ? entry.stressRanges : [],
    ruby: Array.isArray(entry.ruby) ? entry.ruby : [],
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    status: {
      mastered: Boolean(entry.status?.mastered),
      favorite: Boolean(entry.status?.favorite),
      difficult: Boolean(entry.status?.difficult),
    },
    notes: String(entry.notes || ""),
    source: entry.source || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || null,
  })).filter((entry) => entry.term);
  return { schemaVersion: 1, dictionary, entries };
}

function activeLibrary() { return state.libraries.get(state.activeId); }
function capabilities() { return new Set(activeLibrary()?.dictionary.capabilities || []); }
function escapeHtml(value = "") { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }

function renderTerm(entry, language) {
  if (entry.ruby?.length && entry.ruby.map((segment) => segment.text).join("") === entry.term) {
    return entry.ruby.map((segment) => segment.reading
      ? `<ruby>${escapeHtml(segment.text)}<rt>${escapeHtml(segment.reading)}</rt></ruby>`
      : escapeHtml(segment.text)).join("");
  }
  if (language === "ja" && entry.reading) return `<ruby>${escapeHtml(entry.term)}<rt>${escapeHtml(entry.reading)}</rt></ruby>`;
  if (entry.stressRanges?.length) {
    const ranges = [...entry.stressRanges].sort((a, b) => a.start - b.start);
    let cursor = 0;
    return ranges.map((range) => {
      const before = escapeHtml(entry.term.slice(cursor, range.start));
      const stress = `<span class="stress">${escapeHtml(entry.term.slice(range.start, range.end))}</span>`;
      cursor = range.end;
      return before + stress;
    }).join("") + escapeHtml(entry.term.slice(cursor));
  }
  return escapeHtml(entry.term);
}

function posLabel(value) {
  return ({ noun: "名词", other: "非名词", verb: "动词", adjective: "形容词", adverb: "副词", phrase: "短语", "other-custom": "其他" })[value] || "未标记";
}

function allTags(entries) {
  return [...new Set(entries.flatMap((entry) => entry.tags))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function toHiragana(value = "") {
  return String(value).normalize("NFKC").replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

function kanaIndexKey(value = "") {
  const first = [...toHiragana(value).trim()][0];
  if (!first || !/[ぁ-ゖ]/.test(first)) return "other";
  const plain = first.normalize("NFD").replace(/[\u3099\u309a]/g, "").normalize("NFC");
  return SMALL_KANA[plain] || plain;
}

function entryIndexKey(entry, dictionary) {
  if (dictionary.language === "ja") return kanaIndexKey(entry.reading);
  if (dictionary.language === "en") {
    const first = entry.term.trim().charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : "other";
  }
  const first = [...(entry.reading || entry.term).trim()][0];
  return first ? first.toLocaleUpperCase(dictionary.language) : "other";
}

function entrySortKey(entry, dictionary) {
  if (dictionary.language === "ja") {
    const reading = toHiragana(entry.reading).trim();
    return kanaIndexKey(reading) === "other" ? { unknown: 1, text: entry.term } : { unknown: 0, text: reading };
  }
  const first = entryIndexKey(entry, dictionary);
  return { unknown: first === "other" ? 1 : 0, text: entry.term };
}

function filteredEntries() {
  const library = activeLibrary();
  if (!library) return [];
  const query = state.query.trim().toLocaleLowerCase(library.dictionary.language);
  const result = library.entries.filter((entry) => {
    if (query && ![entry.term, entry.reading, entry.definition, entry.notes, ...entry.tags].join("\n").toLocaleLowerCase(library.dictionary.language).includes(query)) return false;
    if (state.status === "learning" && entry.status.mastered) return false;
    if (state.status === "mastered" && !entry.status.mastered) return false;
    if (state.status === "favorite" && !entry.status.favorite) return false;
    if (state.status === "difficult" && !entry.status.difficult) return false;
    if (state.pos === "unset" && entry.partOfSpeech) return false;
    if (state.pos !== "all" && state.pos !== "unset" && entry.partOfSpeech !== state.pos) return false;
    if (state.tag !== "all" && !entry.tags.includes(state.tag)) return false;
    if (state.index !== "all" && entryIndexKey(entry, library.dictionary) !== state.index) return false;
    return true;
  });
  const collator = new Intl.Collator(library.dictionary.language === "ja" ? "ja" : library.dictionary.language, { usage: "sort", sensitivity: "base", numeric: true });
  const compareAlphabetically = (a, b) => {
    const aKey = entrySortKey(a, library.dictionary);
    const bKey = entrySortKey(b, library.dictionary);
    return aKey.unknown - bKey.unknown || collator.compare(aKey.text, bKey.text) || collator.compare(a.term, b.term);
  };
  return result.sort((a, b) => {
    if (state.sort === "za") {
      const aKey = entrySortKey(a, library.dictionary);
      const bKey = entrySortKey(b, library.dictionary);
      return aKey.unknown - bKey.unknown || collator.compare(bKey.text, aKey.text) || collator.compare(b.term, a.term);
    }
    if (state.sort === "updated") return String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || compareAlphabetically(a, b);
    if (state.sort === "unmastered") return Number(a.status.mastered) - Number(b.status.mastered) || compareAlphabetically(a, b);
    return compareAlphabetically(a, b);
  });
}

function renderQuickIndex() {
  const library = activeLibrary();
  const dictionary = library.dictionary;
  const available = new Set(library.entries.map((entry) => entryIndexKey(entry, dictionary)));
  const keys = dictionary.language === "en"
    ? LATIN_INDEX
    : dictionary.language === "ja"
      ? KANA_INDEX
      : [...available].filter((key) => key !== "other").sort((a, b) => a.localeCompare(b, dictionary.language));
  if (state.index !== "all" && !available.has(state.index)) state.index = "all";
  const buttons = [
    { key: "all", label: "全部", available: true },
    ...keys.map((key) => ({ key, label: key, available: available.has(key) })),
    { key: "other", label: "#", available: available.has("other") },
  ];
  $("#quickIndex").innerHTML = buttons.map((item) => `<button type="button" data-index="${escapeHtml(item.key)}" class="${state.index === item.key ? "active" : ""}" ${item.available ? "" : "disabled"} aria-label="${item.key === "other" ? "无法确定首音" : `${item.label} 开头`}">${escapeHtml(item.label)}</button>`).join("");
}

function renderDictionaryTabs() {
  $("#dictionaryTabs").innerHTML = [...state.libraries.values()].map((library) => `
    <button class="dictionary-tab ${library.dictionary.id === state.activeId ? "active" : ""}" type="button" data-dictionary="${escapeHtml(library.dictionary.id)}">
      ${escapeHtml(library.dictionary.name)} <small>${library.entries.length}</small>
    </button>`).join("");
}

function renderSidebar() {
  const library = activeLibrary();
  const entries = library.entries;
  const mastered = entries.filter((entry) => entry.status.mastered).length;
  const favorite = entries.filter((entry) => entry.status.favorite).length;
  const difficult = entries.filter((entry) => entry.status.difficult).length;
  const percent = entries.length ? Math.round(mastered / entries.length * 100) : 0;
  $("#progressPercent").textContent = `${percent}%`;
  $("#progressBar").style.width = `${percent}%`;
  $("#progressText").textContent = `${mastered} / ${entries.length} 个词条已掌握`;
  $("#countAll").textContent = entries.length;
  $("#countLearning").textContent = entries.length - mastered;
  $("#countMastered").textContent = mastered;
  $("#countFavorite").textContent = favorite;
  $("#countDifficult").textContent = difficult;
  $$("#statusFilters button").forEach((button) => button.classList.toggle("active", button.dataset.status === state.status));
  $$("#posFilters button").forEach((button) => button.classList.toggle("active", button.dataset.pos === state.pos));
  $("#posFilterSection").hidden = !capabilities().has("partOfSpeech");
  const tags = allTags(entries);
  if (state.tag !== "all" && !tags.includes(state.tag)) state.tag = "all";
  $("#tagFilter").innerHTML = `<option value="all">全部标签</option>${tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("")}`;
  $("#tagFilter").value = state.tag;
}

function renderList() {
  const library = activeLibrary();
  renderQuickIndex();
  const entries = filteredEntries();
  const shown = entries.slice(0, state.visibleLimit);
  const indexTitle = state.index === "other" ? "首音未确定" : `${state.index} 开头`;
  const title = state.query
    ? `“${state.query}”的结果`
    : state.index !== "all"
      ? indexTitle
      : ({ all: "全部词条", learning: "学习中", mastered: "已掌握", favorite: "已收藏", difficult: "需复习" })[state.status];
  $("#dictionaryKicker").textContent = `${library.dictionary.nativeName || library.dictionary.name}词典`;
  $("#listTitle").textContent = title;
  $("#resultCount").textContent = `${entries.length} 条`;
  $("#emptyState").hidden = entries.length > 0;
  $("#loadMoreButton").hidden = shown.length >= entries.length;
  $("#loadMoreButton").textContent = `再显示 ${Math.min(120, entries.length - shown.length)} 条`;
  $("#entryList").innerHTML = shown.map((entry) => {
    const tags = entry.tags.slice(0, 3).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
    return `<article class="entry-card ${entry.id === state.selectedId ? "selected" : ""}" data-entry-id="${escapeHtml(entry.id)}" tabindex="0" role="button" aria-label="编辑 ${escapeHtml(entry.term)}">
      <div class="entry-word"><strong lang="${escapeHtml(library.dictionary.language)}">${renderTerm(entry, library.dictionary.language)}</strong><small>${escapeHtml(posLabel(entry.partOfSpeech))}${entry.reading && library.dictionary.language !== "ja" ? ` · ${escapeHtml(entry.reading)}` : ""}</small></div>
      <div class="entry-definition">${entry.definition ? escapeHtml(entry.definition) : `<span class="placeholder">尚未添加释义</span>`}${tags ? `<div>${tags}</div>` : ""}</div>
      <div class="entry-status" aria-label="学习状态">
        ${entry.status.favorite ? `<span class="status-icon favorite active" title="已收藏">☆</span>` : ""}
        ${entry.status.difficult ? `<span class="status-icon difficult active" title="需复习">!</span>` : ""}
        <label title="${entry.status.mastered ? "标记为学习中" : "标记为已掌握"}" aria-label="切换掌握状态"><input class="sr-only quick-master" type="checkbox" data-quick-master="${escapeHtml(entry.id)}" ${entry.status.mastered ? "checked" : ""}><span class="status-icon mastered ${entry.status.mastered ? "active" : ""}">✓</span></label>
      </div>
    </article>`;
  }).join("");
}

function renderAll() {
  renderDictionaryTabs();
  renderSidebar();
  renderList();
}

function switchDictionary(id) {
  if (!state.libraries.has(id)) return;
  state.activeId = id;
  state.selectedId = null;
  state.tag = "all";
  state.index = "all";
  state.visibleLimit = 120;
  putMeta("lastDictionary", id);
  closeEditor();
  renderAll();
}

function findEntry(id) { return activeLibrary()?.entries.find((entry) => entry.id === id); }

function stressText(entry) {
  return (entry.stressRanges || []).map((range) => entry.term.slice(range.start, range.end)).join(" · ");
}

function openEditor(entry = null) {
  const isNew = !entry;
  const caps = capabilities();
  const draft = entry || { id: "", term: "", reading: "", definition: "", partOfSpeech: "", tags: [], notes: "", stressRanges: [], status: {} };
  state.selectedId = entry?.id || null;
  $("#editorEmpty").hidden = true;
  $("#entryForm").hidden = false;
  $("#editorMode").textContent = isNew ? "新建词条" : "编辑词条";
  $("#editorTitle").textContent = isNew ? "写下一个新词" : draft.term;
  $("#entryId").value = draft.id;
  $("#termInput").value = draft.term;
  $("#readingInput").value = draft.reading;
  $("#stressInput").value = stressText(draft);
  $("#posInput").value = draft.partOfSpeech;
  $("#definitionInput").value = draft.definition;
  $("#tagsInput").value = draft.tags.join(", ");
  $("#notesInput").value = draft.notes;
  $("#masteredInput").checked = Boolean(draft.status.mastered);
  $("#favoriteInput").checked = Boolean(draft.status.favorite);
  $("#difficultInput").checked = Boolean(draft.status.difficult);
  $("#readingField").hidden = !caps.has("furigana");
  $("#stressField").hidden = !caps.has("stress");
  $("#posField").hidden = !caps.has("partOfSpeech");
  $("#deleteEntryButton").hidden = isNew;
  $("#formMessage").textContent = "";
  $("#editorPanel").classList.add("open");
  renderList();
  setTimeout(() => $("#termInput").focus(), 50);
}

function closeEditor() {
  state.selectedId = null;
  $("#entryForm").hidden = true;
  $("#editorEmpty").hidden = false;
  $("#editorPanel").classList.remove("open");
  if (activeLibrary()) renderList();
}

function setSaving(saving) {
  $("#saveState").classList.toggle("saving", saving);
  $("#saveState").lastChild.textContent = saving ? " 正在保存…" : " 本机已保存";
}

async function persistActive(message = "已保存") {
  setSaving(true);
  await putLibrary(activeLibrary());
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => writeConnectedBackup(), 450);
  setSaving(false);
  if (message) toast(message);
}

function backupPayload() {
  return {
    schemaVersion: 1,
    app: "vomni",
    exportedAt: new Date().toISOString(),
    dictionaries: [...state.libraries.values()],
  };
}

async function writeConnectedBackup() {
  if (!state.connectedHandle) return;
  try {
    const permission = await state.connectedHandle.queryPermission?.({ mode: "readwrite" });
    if (permission !== "granted") return;
    const writable = await state.connectedHandle.createWritable();
    await writable.write(JSON.stringify(backupPayload(), null, 2) + "\n");
    await writable.close();
  } catch (error) {
    console.warn("Automatic file backup failed", error);
  }
}

function applyNounCapitalization(term, pos) {
  if (pos !== "noun") return term;
  const index = [...term].findIndex((char) => /[A-Za-z]/.test(char));
  return index < 0 ? term : term.slice(0, index) + term[index].toUpperCase() + term.slice(index + 1);
}

function buildStressRanges(term, stress) {
  const pieces = stress.split(/[·,，]/).map((item) => item.trim()).filter(Boolean);
  const ranges = [];
  let cursor = 0;
  for (const piece of pieces) {
    const start = term.toLocaleLowerCase().indexOf(piece.toLocaleLowerCase(), cursor);
    if (start < 0) throw new Error(`“${piece}”不在词条中`);
    ranges.push({ start, end: start + piece.length });
    cursor = start + piece.length;
  }
  return ranges;
}

async function saveEntry(event) {
  event.preventDefault();
  const library = activeLibrary();
  const caps = capabilities();
  const existingId = $("#entryId").value;
  const existing = existingId ? findEntry(existingId) : null;
  let term = $("#termInput").value.trim();
  const partOfSpeech = caps.has("partOfSpeech") ? $("#posInput").value : "";
  term = applyNounCapitalization(term, partOfSpeech);
  if (!term) return;
  let stressRanges = [];
  try { if (caps.has("stress")) stressRanges = buildStressRanges(term, $("#stressInput").value); }
  catch (error) { $("#formMessage").textContent = error.message; return; }
  const reading = caps.has("furigana") ? $("#readingInput").value.trim() : "";
  const now = new Date().toISOString();
  const entry = {
    ...(existing || {}),
    id: existing?.id || `${library.dictionary.id}-${crypto.randomUUID?.() || Date.now()}`,
    term,
    reading,
    definition: $("#definitionInput").value.trim(),
    partOfSpeech,
    stressRanges,
    ruby: reading ? [{ text: term, reading }] : [],
    tags: $("#tagsInput").value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    status: { mastered: $("#masteredInput").checked, favorite: $("#favoriteInput").checked, difficult: $("#difficultInput").checked },
    notes: $("#notesInput").value.trim(),
    source: existing?.source || null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (existing) Object.assign(existing, entry); else library.entries.unshift(entry);
  state.selectedId = entry.id;
  await persistActive(existing ? "词条已更新" : "词条已添加");
  renderAll();
  openEditor(entry);
}

async function deleteEntry() {
  const id = $("#entryId").value;
  const entry = findEntry(id);
  if (!entry || !confirm(`确定删除“${entry.term}”吗？此操作会在下一份备份中同步。`)) return;
  const library = activeLibrary();
  library.entries = library.entries.filter((item) => item.id !== id);
  await persistActive("词条已删除");
  closeEditor();
  renderAll();
}

async function toggleMastered(id, checked) {
  const entry = findEntry(id);
  if (!entry) return;
  entry.status.mastered = checked;
  entry.updatedAt = new Date().toISOString();
  await persistActive(checked ? "已标记为掌握" : "已放回学习中");
  renderAll();
  if (state.selectedId === id) openEditor(entry);
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFiles(files) {
  let imported = 0;
  for (const file of files) {
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data.dictionaries) ? data.dictionaries : [data];
      for (const raw of incoming) {
        if (!raw.dictionary || !Array.isArray(raw.entries)) throw new Error("文件不是 vomni 词库格式");
        const library = normalizeLibrary(raw);
        const current = state.libraries.get(library.dictionary.id);
        if (current && !confirm(`导入会替换“${current.dictionary.name}”的现有内容。继续吗？`)) continue;
        state.libraries.set(library.dictionary.id, library);
        await putLibrary(library);
        state.activeId = library.dictionary.id;
        imported += 1;
      }
    } catch (error) { toast(`${file.name}：${error.message}`); }
  }
  if (imported) { closeEditor(); renderAll(); toast(`已导入 ${imported} 个词典`); }
}

async function connectBackupFile() {
  if (!window.showSaveFilePicker) {
    toast("当前浏览器不支持自动写入文件；请使用“导出全部备份”");
    return;
  }
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: "vomni-backup.json", types: [{ description: "vomni JSON 备份", accept: { "application/json": [".json"] } }] });
    state.connectedHandle = handle;
    await putMeta("connectedFileHandle", handle);
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(backupPayload(), null, 2) + "\n");
    await writable.close();
    toast("已连接备份文件，今后的改动会自动写入");
  } catch (error) { if (error.name !== "AbortError") toast(`连接失败：${error.message}`); }
}

function createDictionary(event) {
  event.preventDefault();
  const name = $("#dictionaryNameInput").value.trim();
  const language = $("#dictionaryLanguageInput").value.trim().toLowerCase();
  if (!name || !language) return;
  let id = language.replace(/[^a-z0-9-]/g, "-") || `dictionary-${Date.now()}`;
  if (state.libraries.has(id)) id = `${id}-${Date.now().toString().slice(-5)}`;
  const selected = $$("#dictionaryForm .capability-grid input:checked").map((input) => input.value);
  const library = normalizeLibrary({ schemaVersion: 1, dictionary: { id, name, nativeName: name, language, capabilities: selected }, entries: [] });
  state.libraries.set(id, library);
  putLibrary(library);
  $("#dictionaryDialog").close();
  $("#dictionaryForm").reset();
  switchDictionary(id);
  toast(`“${name}”词典已创建`);
}

function toast(message) {
  const item = document.createElement("div");
  item.className = "toast";
  item.textContent = message;
  $("#toastRegion").append(item);
  setTimeout(() => item.remove(), 3200);
}

function positionDataMenu() {
  const button = $("#dataMenuButton");
  const menu = $("#dataMenu");
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 7}px`;
  menu.style.left = `${Math.max(10, rect.right - 260)}px`;
}

function resetFilters() {
  state.query = ""; state.status = "all"; state.pos = "all"; state.tag = "all"; state.index = "all"; state.visibleLimit = 120;
  $("#searchInput").value = "";
  renderAll();
}

function attachEvents() {
  $("#dictionaryTabs").addEventListener("click", (event) => { const button = event.target.closest("[data-dictionary]"); if (button) switchDictionary(button.dataset.dictionary); });
  $("#statusFilters").addEventListener("click", (event) => { const button = event.target.closest("[data-status]"); if (!button) return; state.status = button.dataset.status; state.visibleLimit = 120; renderAll(); });
  $("#posFilters").addEventListener("click", (event) => { const button = event.target.closest("[data-pos]"); if (!button) return; state.pos = button.dataset.pos; state.visibleLimit = 120; renderAll(); });
  $("#tagFilter").addEventListener("change", (event) => { state.tag = event.target.value; state.visibleLimit = 120; renderAll(); });
  $("#quickIndex").addEventListener("click", (event) => {
    const button = event.target.closest("[data-index]");
    if (!button || button.disabled) return;
    state.index = button.dataset.index;
    state.visibleLimit = 120;
    renderList();
    $("#entryList").scrollIntoView({ block: "start", behavior: "smooth" });
  });
  $("#sortSelect").addEventListener("change", (event) => { state.sort = event.target.value; renderList(); });
  $("#searchInput").addEventListener("input", (event) => { state.query = event.target.value; state.visibleLimit = 120; renderList(); });
  $("#entryList").addEventListener("click", (event) => {
    if (event.target.closest("label")) return;
    const card = event.target.closest("[data-entry-id]"); if (card) openEditor(findEntry(card.dataset.entryId));
  });
  $("#entryList").addEventListener("change", (event) => {
    const check = event.target.closest(".quick-master");
    if (check) toggleMastered(check.dataset.quickMaster, check.checked);
  });
  $("#entryList").addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("label")) { event.preventDefault(); openEditor(findEntry(event.target.closest("[data-entry-id]")?.dataset.entryId)); } });
  $("#addEntryButton").addEventListener("click", () => openEditor());
  $("#emptyState").addEventListener("click", (event) => { if (event.target.closest("[data-action='add-entry']")) openEditor(); });
  $("#entryForm").addEventListener("submit", saveEntry);
  $("#deleteEntryButton").addEventListener("click", deleteEntry);
  $("#closeEditorButton").addEventListener("click", closeEditor);
  $("#loadMoreButton").addEventListener("click", () => { state.visibleLimit += 120; renderList(); });
  $("#resetFiltersButton").addEventListener("click", resetFilters);
  $("#homeButton").addEventListener("click", resetFilters);
  $("#addDictionaryButton").addEventListener("click", () => $("#dictionaryDialog").showModal());
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $("#dictionaryDialog").close()));
  $("#dictionaryForm").addEventListener("submit", createDictionary);
  $("#dataMenuButton").addEventListener("click", (event) => { event.stopPropagation(); const menu = $("#dataMenu"); menu.hidden = !menu.hidden; if (!menu.hidden) positionDataMenu(); });
  document.addEventListener("click", (event) => { if (!event.target.closest("#dataMenu") && !event.target.closest("#dataMenuButton")) $("#dataMenu").hidden = true; });
  $("#openFilesButton").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (event) => { importFiles([...event.target.files]); event.target.value = ""; });
  $("#exportCurrentButton").addEventListener("click", () => { const library = activeLibrary(); downloadJson(`${library.dictionary.id}.json`, library); $("#dataMenu").hidden = true; });
  $("#exportAllButton").addEventListener("click", () => { downloadJson("vomni-backup.json", backupPayload()); $("#dataMenu").hidden = true; });
  $("#connectFileButton").addEventListener("click", () => { connectBackupFile(); $("#dataMenu").hidden = true; });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); $("#searchInput").focus(); }
    if (event.key === "Escape") { $("#dataMenu").hidden = true; closeEditor(); }
  });
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const safeExecute = (fn) => async (input) => fn(input && typeof input === "object" ? input : {});
  try {
    context.registerTool({
      name: "search_vocabulary",
      title: "搜索 vomni 词条",
      description: "在当前词典中搜索词条、读音、释义和标签，不修改数据。",
      inputSchema: { type: "object", properties: { query: { type: "string" }, dictionaryId: { type: "string" } }, required: ["query"], additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: safeExecute(({ query, dictionaryId }) => {
        const library = state.libraries.get(dictionaryId || state.activeId);
        if (!library || typeof query !== "string") throw new Error("词典或搜索词无效");
        const q = query.toLocaleLowerCase(library.dictionary.language);
        return library.entries.filter((entry) => [entry.term, entry.reading, entry.definition, ...entry.tags].join(" ").toLocaleLowerCase(library.dictionary.language).includes(q)).slice(0, 20).map(({ id, term, reading, definition, status }) => ({ id, term, reading, definition, status }));
      }),
    });
    context.registerTool({
      name: "add_vocabulary_entry",
      title: "添加 vomni 词条",
      description: "向指定词典添加一个新词条，并同步更新页面与本机数据。",
      inputSchema: { type: "object", properties: { dictionaryId: { type: "string" }, term: { type: "string" }, reading: { type: "string" }, definition: { type: "string" }, partOfSpeech: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["dictionaryId", "term"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: safeExecute(async ({ dictionaryId, term, reading = "", definition = "", partOfSpeech = "", tags = [] }) => {
        const library = state.libraries.get(dictionaryId);
        if (!library || typeof term !== "string" || !term.trim()) throw new Error("词典或词条无效");
        const now = new Date().toISOString();
        const entry = normalizeLibrary({ dictionary: library.dictionary, entries: [{ id: `${dictionaryId}-${crypto.randomUUID?.() || Date.now()}`, term: term.trim(), reading, definition, partOfSpeech, tags, createdAt: now, updatedAt: now }] }).entries[0];
        library.entries.unshift(entry);
        await putLibrary(library);
        if (state.activeId === dictionaryId) renderAll();
        return { id: entry.id, term: entry.term, dictionaryId };
      }),
    });
  } catch (error) { console.warn("WebMCP tools unavailable", error); }
}

async function init() {
  attachEvents();
  try {
    await loadInitialData();
    renderAll();
    registerWebMcpTools();
    $("#app").setAttribute("aria-busy", "false");
  } catch (error) {
    console.error(error);
    $("#app").setAttribute("aria-busy", "false");
    $("#entryList").innerHTML = `<div class="empty-state"><span>!</span><h2>词库暂时无法读取</h2><p>${escapeHtml(error.message)}。请通过本地网页服务器或 GitHub Pages 打开，或从“数据”菜单导入 JSON。</p></div>`;
    toast("未能载入初始词库");
  }
}

init();
