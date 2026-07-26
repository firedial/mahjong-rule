const PARAM_V = "v";               // URL query key: version
const PARAM_R = "r";               // URL query key: ruleset (value string)
const PARAM_MODE = "mode";         // URL query key: "ro" => readonly (閲覧専用)
const versionUrl = v => `rules/v${v.split(".")[0]}/v${v}.json`;
const PLACEHOLDER = "-";           // marks unselected / non-applicable in value string

/* ================= runtime state ================= */
let DATA = null;                   // the loaded ruleset { version, rules, categories }
let CURRENT_VERSION = null;
const selections = {};             // fullId -> value
const flagged = new Set();         // fullIds marked 要確認
const nodeIndex = {};              // fullId -> meta
let orderedAnswerable = [];        // answerable node metas, in document order (defines value-string positions)
let activeCategory = null;         // null => category screen; id => that category's rules
let sortMode = "status";           // "status" (未選択→要確認→選択済み) | "id" (定義順)
let screen = "home";               // "home" | "categories" (activeCategory refines the latter)
let readonly = false;              // 閲覧専用モード

const root = document.getElementById("ruleRoot");
const noticeEl = document.getElementById("notice");
const homeScreen = document.getElementById("homeScreen");
const stickyHead = document.getElementById("stickyHead");
const meterBar = document.getElementById("meterBar");
const subnav = document.getElementById("subnav");
const homeCornerBtn = document.getElementById("homeCornerBtn");
const catScreen = document.getElementById("catScreen");
const ruleScreen = document.getElementById("ruleScreen");
const catGrid = document.getElementById("catGrid");
const catHeading = document.getElementById("catHeading");

/* ================= helpers ================= */
function showNotice(html, kind) {
  noticeEl.hidden = false;
  noticeEl.className = "notice" + (kind ? " " + kind : "");
  noticeEl.innerHTML = html;
}
function hideNotice() { noticeEl.hidden = true; }

/* ================= index build ================= */
function indexTree(nodes, parentPath) {
  nodes.forEach(node => {
    const fullId = parentPath ? parentPath + "-" + node.id : node.id;
    nodeIndex[fullId] = {
      node, fullId, parentPath,
      relId: node.id,
      isGroup: !node.options || node.options.length === 0
    };
    if (node.children && node.children.length) indexTree(node.children, fullId);
  });
}
// answerable nodes in document (depth-first) order — defines value-string positions
function buildOrder(nodes, parentPath) {
  nodes.forEach(node => {
    const fullId = parentPath ? parentPath + "-" + node.id : node.id;
    const meta = nodeIndex[fullId];
    if (!meta.isGroup) orderedAnswerable.push(meta);
    if (node.children && node.children.length) buildOrder(node.children, fullId);
  });
}

/* ================= visibility ================= */
// Evaluate a single rule's OWN condition (not counting ancestors).
function ownCondition(meta) {
  const n = meta.node;
  if (n.showWhen) {
    const parentVal = selections[meta.parentPath];
    if (!parentVal || !n.showWhen.includes(parentVal)) return false;
  }
  return true;
}

// A node is ENABLED when its own condition passes AND every ancestor is enabled.
function gateState(meta) {
  if (meta.parentPath && nodeIndex[meta.parentPath]) {
    if (!gateState(nodeIndex[meta.parentPath])) return false;
  }
  return ownCondition(meta);
}
function isEnabled(meta) { return gateState(meta); }
function isVisible(meta) { return isEnabled(meta); }

/* ================= URL encode / decode =================
   Format:  ?v=<version>&r=<valuestring>
   valuestring: one char per answerable node in orderedAnswerable order.
     - selected            -> option value (lowercase, e.g. 'a')
     - selected + 要確認    -> same value UPPERCASED (e.g. 'A')
     - unselected/hidden    -> PLACEHOLDER ('-')
   Option values are always lowercase, so uppercase unambiguously marks 要確認.
*/
function encodeValueString() {
  return orderedAnswerable.map(meta => {
    const v = selections[meta.fullId];
    if (v == null || !meta.node.options.some(o => o.value === v)) return PLACEHOLDER;
    return flagged.has(meta.fullId) ? v.toUpperCase() : v;
  }).join("");
}
// Run-length compress the value string for the URL: a run of N placeholders ('-')
// becomes "-N" (a single '-' stays "-"). Option values are letters, so digits are
// unambiguous. Shortens sparse selections dramatically (773 dashes -> "-773").
function compressRuns(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] === PLACEHOLDER) {
      let j = i; while (j < s.length && s[j] === PLACEHOLDER) j++;
      const run = j - i;
      out += run === 1 ? PLACEHOLDER : PLACEHOLDER + run;
      i = j;
    } else { out += s[i]; i++; }
  }
  return out;
}
function expandRuns(s) {
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] === PLACEHOLDER) {
      let j = i + 1, num = "";
      while (j < s.length && s[j] >= "0" && s[j] <= "9") { num += s[j]; j++; }
      out += num ? PLACEHOLDER.repeat(parseInt(num, 10)) : PLACEHOLDER;
      i = j;
    } else { out += s[i]; i++; }
  }
  return out;
}
function applyValueString(str) {
  for (let i = 0; i < orderedAnswerable.length && i < str.length; i++) {
    const ch = str[i];
    if (ch === PLACEHOLDER) continue;
    const meta = orderedAnswerable[i];
    const isFlag = ch !== ch.toLowerCase();   // uppercase => 要確認
    const val = ch.toLowerCase();
    if (meta.node.options.some(o => o.value === val)) {
      selections[meta.fullId] = val;
      if (isFlag) flagged.add(meta.fullId);
    }
  }
  // flags on unselected/hidden items are cleaned up by render()
}
function parseParam() {
  // returns { version, valueString, readonly } or null
  const q = new URLSearchParams(location.search);
  const version = q.get(PARAM_V) == null ? null : q.get(PARAM_V).split(".").slice(0, 2).join(".");
  const rawR = q.get(PARAM_R) || "";
  const valueString = rawR ? expandRuns(rawR) : "";
  const readonly = q.get(PARAM_MODE) === "ro";
  if (version == null && !valueString && !readonly) return null;
  return { version: version || "", valueString, readonly };
}
// buildQuery(forceReadonly): omit arg to reflect the current mode; pass true for share links.
function buildQuery(forceReadonly) {
  const ro = (forceReadonly === undefined) ? readonly : forceReadonly;
  let q = "?" + PARAM_V + "=" + CURRENT_VERSION + "&" + PARAM_R + "=" + compressRuns(encodeValueString());
  if (ro) q += "&" + PARAM_MODE + "=ro";
  return q;
}
function baseHref() {
  return location.origin === "null"
    ? location.href.split(/[?#]/)[0]
    : location.origin + location.pathname;
}
// Share links are always readonly (閲覧専用).
function currentShareUrl() {
  return baseHref() + buildQuery(true);
}
function syncUrlBar() {
  try {
    history.replaceState({ screen, activeCategory }, "", location.pathname + buildQuery());
  } catch (e) { /* file:// may block; ignore */ }
}

/* ================= render ================= */
// status rank for sorting: 未選択(0) → 要確認(1) → 選択済み(2)
const STATUS_RANK = { todo: 0, check: 1, done: 2 };
// aggregate status of a top-level rule = the "least done" of its visible answerable descendants
function topRuleStatusRank(topRule) {
  const metas = answerableUnder(topRule).filter(m => isVisible(m));
  if (!metas.length) return 3;                 // nothing to answer (rare) — sort last
  return Math.min(...metas.map(m => STATUS_RANK[statusOf(m.fullId)]));
}
function answerableUnder(topRule) {
  const out = [];
  const walk = (nodes, pp) => nodes.forEach(n => {
    const f = pp ? pp + "-" + n.id : n.id;
    if (!nodeIndex[f].isGroup) out.push(nodeIndex[f]);
    if (n.children) walk(n.children, f);
  });
  walk([topRule], topRule.category);
  return out;
}

function render() {
  // drop 要確認 flags on items that are no longer selected or no longer visible
  for (const id of [...flagged]) {
    const meta = nodeIndex[id];
    if (!meta || selections[id] == null || !isVisible(meta)) flagged.delete(id);
  }

  const footerBar = document.getElementById("footerBar");

  if (screen === "home") {
    homeScreen.hidden = false;
    stickyHead.hidden = true;
    footerBar.hidden = true;
    catScreen.hidden = true;
    ruleScreen.hidden = true;
    try {
      const hasSelections = Object.keys(selections).length > 0;
      const url = hasSelections ? location.pathname + buildQuery() : location.pathname;
      history.replaceState({ screen: "home", activeCategory: null }, "", url);
    } catch (e) { }
    return;
  }

  homeScreen.hidden = true;
  stickyHead.hidden = false;
  const modeToggle = document.getElementById("modeToggle");
  if (activeCategory == null) {
    // category list: subnav hidden, mode toggle + home button top-right, footer only 共有
    catScreen.hidden = false;
    ruleScreen.hidden = true;
    subnav.hidden = true;
    homeCornerBtn.hidden = false;
    modeToggle.hidden = false;
    modeToggle.querySelectorAll(".mode-opt").forEach(b =>
      b.classList.toggle("is-active", b.dataset.mode === (readonly ? "ro" : "rw")));
    footerBar.hidden = false;
    document.getElementById("footerBackBtn").hidden = true;
  } else {
    // rules screen: subnav (heading + sort) shown, footer has カテゴリ一覧 back
    catScreen.hidden = true;
    ruleScreen.hidden = false;
    subnav.hidden = false;
    homeCornerBtn.hidden = true;
    modeToggle.hidden = true;
    footerBar.hidden = false;
    document.getElementById("footerBackBtn").hidden = false;
    renderRules();
  }
  if (activeCategory == null) renderCategoryGrid();
  updateMeter();
  syncUrlBar();
}

function catStats(catId) {
  let done = 0, check = 0, todo = 0;
  DATA.rules.filter(r => r.category === catId).forEach(top => {
    answerableUnder(top).filter(m => isVisible(m)).forEach(m => {
      const s = statusOf(m.fullId);
      if (s === "done") done++; else if (s === "check") check++; else todo++;
    });
  });
  return { done, check, todo, total: done + check + todo };
}

function renderCategoryGrid() {
  catGrid.innerHTML = "";
  const cats = DATA.categories || [];
  cats.forEach(cat => {
    const st = catStats(cat.id);
    const complete = st.total > 0 && st.todo === 0 && st.check === 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-card";
    btn.dataset.complete = complete ? "true" : "false";
    btn.innerHTML =
      `<span class="cat-arrow">→</span>
       <span class="cat-name"></span>
       <span class="cat-stats">
         <span class="cat-done"><i class="dot dot-done"></i>選択 <b>${st.done}</b></span>
         <span class="cat-check"><i class="dot dot-check"></i>確認 <b>${st.check}</b></span>
         <span class="cat-todo"><i class="dot dot-todo"></i>未選 <b>${st.todo}</b></span>
       </span>`;
    btn.querySelector(".cat-name").textContent = cat.label;
    btn.addEventListener("click", () => navigate("categories", cat.id));
    catGrid.appendChild(btn);
  });
}

let ruleOrderCache = [];   // fixed top-rule order for the current category view

function computeRuleOrder() {
  let tops = DATA.rules.filter(r => r.category === activeCategory);
  if (sortMode === "status") {
    tops = tops
      .map(r => ({ r, rank: topRuleStatusRank(r) }))
      .sort((a, b) => a.rank - b.rank || Number(a.r.order) - Number(b.r.order))
      .map(x => x.r);
  } else {
    tops = [...tops].sort((a, b) => Number(a.order) - Number(b.order));
  }
  ruleOrderCache = tops;
}

function renderRules() {
  const cat = (DATA.categories || []).find(c => c.id === activeCategory);
  catHeading.textContent = cat ? cat.label : "";
  root.innerHTML = "";
  ruleOrderCache.forEach(r => renderNode(r, r.category, 0, root));
}
function deselect(fullId) {
  delete selections[fullId];
  flagged.delete(fullId);   // 未選択に要確認は付かない
}
function statusOf(fullId) {
  if (selections[fullId] == null) return "todo";       // 未選択
  return flagged.has(fullId) ? "check" : "done";        // 要確認 / 選択済み
}
function renderNode(node, parentPath, depth, container) {
  const fullId = parentPath ? parentPath + "-" + node.id : node.id;
  const meta = nodeIndex[fullId];
  const enabled = gateState(meta);
  const interactive = enabled && !readonly;   // readonly disables editing but not visibility

  const card = document.createElement("section");
  card.className = "rule" + (meta.isGroup ? " is-group" : " answerable") + (enabled ? "" : " is-disabled");
  card.dataset.depth = depth;

  const head = document.createElement("div");
  head.className = "rule-head";
  head.innerHTML = `<span class="rule-id"></span><span class="rule-title"></span>`;
  head.querySelector(".rule-id").textContent = fullId.replace(/^\d+-/, "");
  head.querySelector(".rule-title").textContent = node.title;

  if (!meta.isGroup) {
    card.dataset.status = enabled ? statusOf(fullId) : "disabled";
    const flagBtn = document.createElement("button");
    flagBtn.className = "flag-btn";
    flagBtn.type = "button";
    flagBtn.textContent = "要確認";
    flagBtn.disabled = !interactive;
    // in readonly, hide the flag toggle unless it's actually flagged (keep it as a static mark)
    if (readonly && !flagged.has(fullId)) flagBtn.hidden = true;
    flagBtn.setAttribute("aria-pressed", flagged.has(fullId) ? "true" : "false");
    flagBtn.addEventListener("click", () => {
      if (!interactive) return;
      if (flagged.has(fullId)) flagged.delete(fullId);
      else flagged.add(fullId);
      render();
    });
    head.appendChild(flagBtn);
  }
  card.appendChild(head);

  // metadata / note (from v2): show 別名・意味 etc. compactly
  if (node.meta || node.note) {
    const info = document.createElement("div");
    info.className = "rule-info";
    const bits = [];
    if (node.meta) {
      const m = node.meta;
      if (m.alias) bits.push(`別名：${asText(m.alias)}`);
      if (m.meaning) bits.push(asText(m.meaning));
      if (m.content) bits.push(asText(m.content));
      if (m.condition) bits.push(`条件：${asText(m.condition)}`);
    }
    if (node.note) bits.push(asText(node.note));
    info.textContent = bits.join(" ／ ");
    if (bits.length) card.appendChild(info);
  }

  if (!meta.isGroup) {
    const body = document.createElement("div");
    body.className = "rule-body";
    node.options.forEach(opt => {
      const lab = document.createElement("label");
      lab.className = "opt";
      const checked = selections[fullId] === opt.value;
      lab.innerHTML =
        `<input type="radio" tabindex="-1" name="r-${fullId}" value="${opt.value}" ${checked ? "checked" : ""} ${interactive ? "" : "disabled"}>
         <span class="box">${opt.value}</span><span class="label"></span>`;
      lab.querySelector(".label").textContent = Array.isArray(opt.label) ? opt.label.join("\n") : opt.label;
      lab.setAttribute("role", "radio");
      lab.setAttribute("aria-checked", checked ? "true" : "false");

      if (interactive) {
        lab.tabIndex = 0;
        const toggle = () => {
          if (selections[fullId] === opt.value) deselect(fullId);
          else selections[fullId] = opt.value;
          render();
        };
        lab.addEventListener("click", e => { e.preventDefault(); toggle(); });
        lab.addEventListener("keydown", e => {
          if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
        });
      } else {
        lab.setAttribute("aria-disabled", "true");
        if (readonly) lab.classList.add("readonly-opt");
      }
      if (readonly && !checked && selections[fullId]) return;
      body.appendChild(lab);
    });
    card.appendChild(body);
  }
  if (readonly && !meta.isGroup && !enabled) return;
  container.appendChild(card);

  if (node.children && node.children.length) {
    node.children.forEach(c => renderNode(c, fullId, depth + 1, container));
  }
}
// meta/note values may be a string or an array of strings
function asText(v) { return Array.isArray(v) ? v.join(" ／ ") : v; }

/* ================= meter ================= */
function visibleAnswerable() {
  return orderedAnswerable.filter(m => isVisible(m));
}
function updateMeter() {
  const vis = visibleAnswerable();
  let done = 0, check = 0, todo = 0;
  vis.forEach(m => {
    const s = statusOf(m.fullId);
    if (s === "done") done++; else if (s === "check") check++; else todo++;
  });
  document.getElementById("doneCount").textContent = done;
  document.getElementById("checkCount").textContent = check;
  document.getElementById("todoCount").textContent = todo;
  const totalEl = document.getElementById("totalCount");
  if (totalEl) totalEl.textContent = vis.length;
}

/* ================= share text ================= */
function buildShareText() {
  const lines = ["【採用ルール】", `（バージョン ${CURRENT_VERSION}）`, ""];
  function walk(nodes, parentPath, depth) {
    nodes.forEach(node => {
      const fullId = parentPath ? parentPath + "-" + node.id : node.id;
      const meta = nodeIndex[fullId];
      if (!isEnabled(meta)) return;   // grayed-out (unmet condition) rules are omitted
      const indent = "  ".repeat(depth);
      if (meta.isGroup) {
        lines.push(`${indent}■ ${fullId} ${node.title}`);
      } else {
        const val = selections[fullId];
        const opt = node.options.find(o => o.value === val);
        const mark = flagged.has(fullId) ? " 【要確認】" : "";
        lines.push(`${indent}${fullId} ${node.title}`);
        lines.push(`${indent}   → ${opt ? opt.label : "（未選択）"}${mark}`);
      }
      if (node.children) walk(node.children, fullId, depth + 1);
    });
  }
  (DATA.categories || [{ id: null, label: "" }]).forEach(cat => {
    const inCat = DATA.rules.filter(r => r.category === cat.id);
    if (!inCat.length) return;
    lines.push(`◆ ${cat.label}`);
    walk(inCat, cat.id, 0);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/* ================= events ================= */
const sheet = document.getElementById("sheet");
document.getElementById("shareBtn").addEventListener("click", () => {
  const url = currentShareUrl();
  document.getElementById("shareText").value = buildShareText();
  document.getElementById("shareUrl").value = url;
  renderQr(url);
  sheet.classList.add("open");
});
// Render a QR code (byte mode, EC level L for capacity) for the given URL.
function renderQr(url) {
  const box = document.getElementById("qrCode");
  if (!box) return;
  try {
    const qr = qrcode(0, "Q");   // typeNumber 0 = auto-fit; Q = balanced error correction
    qr.addData(url);
    qr.make();
    // cellSize/margin chosen so the SVG scales cleanly; CSS fixes the display size
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
    box.dataset.error = "";
  } catch (e) {
    box.innerHTML = "";
    box.dataset.error = "QRコードを生成できませんでした";
    box.textContent = "QRコードを生成できませんでした";
  }
}
async function copyValue(el, msgEl) {
  try { await navigator.clipboard.writeText(el.value); }
  catch { el.select(); document.execCommand("copy"); }
  msgEl.classList.add("show");
  setTimeout(() => msgEl.classList.remove("show"), 1600);
}
document.getElementById("copyUrlBtn").addEventListener("click", () =>
  copyValue(document.getElementById("shareUrl"), document.getElementById("copiedUrlMsg")));
document.getElementById("copyBtn").addEventListener("click", () =>
  copyValue(document.getElementById("shareText"), document.getElementById("copiedMsg")));
function closeSheet() { sheet.classList.remove("open"); }
document.getElementById("closeSheet").addEventListener("click", closeSheet);
document.getElementById("closeSheet2").addEventListener("click", closeSheet);
sheet.addEventListener("click", e => { if (e.target === sheet) closeSheet(); });
function navigate(newScreen, newCategory) {
  screen = newScreen;
  activeCategory = newCategory;
  if (newCategory != null) computeRuleOrder();
  try {
    const url = screen === "home" ? location.pathname : location.pathname + buildQuery();
    history.pushState({ screen, activeCategory }, "", url);
  } catch (e) { }
  render();
}

window.addEventListener("popstate", e => {
  const state = e.state;
  screen = state ? state.screen : "home";
  activeCategory = state ? state.activeCategory : null;
  if (activeCategory != null) computeRuleOrder();
  render();
});

// footer back (rules screen only): return to category list
document.getElementById("footerBackBtn").addEventListener("click", () => {
  history.back();
});
// top-right button on the category list: back to the top (entry) screen
document.getElementById("homeCornerBtn").addEventListener("click", () => {
  navigate("home", null);
});
// readonly / writable toggle (category list). Reflected into the URL via syncUrlBar().
document.querySelectorAll("#modeToggle .mode-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    readonly = (btn.dataset.mode === "ro");
    render();
  });
});
// top-screen preset choices
// TODO: fill in real preset value strings for 一般ルール / 雀魂ルール.
const PRESETS = {
  "new": "",   // 新規作成 — すべて未選択
  "ippan": "",   // 一般ルール — TODO: プリセットの値列を設定
  "jantama": ""    // 雀魂ルール — TODO: プリセットの値列を設定
};
document.querySelectorAll(".home-card").forEach(card => {
  card.addEventListener("click", () => {
    const preset = card.dataset.preset;
    const valueString = PRESETS[preset] || "";
    // clear current state, then apply the preset's value string
    for (const k in selections) delete selections[k];
    flagged.clear();
    if (valueString) applyValueString(valueString);
    readonly = false;            // presets open in editable mode
    navigate("categories", null);
  });
});
// sort mode toggle
document.querySelectorAll(".sort-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    sortMode = btn.dataset.sort;
    document.querySelectorAll(".sort-opt").forEach(b =>
      b.classList.toggle("is-active", b === btn));
    if (activeCategory != null) { computeRuleOrder(); renderRules(); }
  });
});

/* ================= boot ================= */
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} (${res.status})`);
  return res.json();
}
function finalize(data, requested, versionForBadge, noticeHtml) {
  DATA = data;
  CURRENT_VERSION = DATA.version || versionForBadge;
  // Each top-level rule's full id begins with its category (e.g. "8-15").
  DATA.rules.forEach(r => indexTree([r], r.category));
  DATA.rules.forEach(r => buildOrder([r], r.category));

  if (requested && requested.valueString) applyValueString(requested.valueString);
  readonly = !!(requested && requested.readonly);

  // Entry point: a URL carrying params (shared link / preset) skips the top screen;
  // a bare visit starts at the top (entry) screen.
  screen = (requested && (requested.version || requested.valueString || requested.readonly)) ? "categories" : "home";

  const badge = document.getElementById("verBadge");
  badge.hidden = false;
  badge.textContent = "v" + CURRENT_VERSION;
  const homeVersion = document.getElementById("homeVersion");
  homeVersion.hidden = false;
  homeVersion.textContent = "v" + CURRENT_VERSION;

  if (noticeHtml) showNotice(noticeHtml, ""); else hideNotice();
  render();
}
async function boot() {
  showNotice("ルールデータを読み込み中…", "loading");
  const requested = parseParam();  // { version, valueString } or null

  const manifest = await fetchJson("rules/manifest.json");
  const latest = manifest.latest;
  const known = manifest.versions;
  let version = (requested && requested.version) ? requested.version : latest;
  let notice = "";

  if (requested && requested.version && !known.includes(requested.version)) {
    notice =
      `共有リンクのバージョン「${requested.version}」は見つかりませんでした。` +
      `最新バージョン（${latest}）で表示します。選択内容は復元されていません。`;
    version = latest;
    requested.valueString = "";
  }

  try {
    // @todo 後で戻す
    // const data = await fetchJson(versionUrl(version));
    const data = await fetchJson("rules/latest.json");
    finalize(data, requested, version, notice);
  } catch (e) {
    showNotice(`バージョン ${version} のルールデータを読み込めませんでした。`, "");
  }
}
boot();
