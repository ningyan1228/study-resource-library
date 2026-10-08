const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const SERVICE_NAME = process.env.SERVICE_NAME || "study-resource-api";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_OWNER = process.env.GITHUB_OWNER || "ningyan1228";
const GITHUB_REPO = process.env.GITHUB_REPO || "study-resource-library";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const GITHUB_DATA_PATH = process.env.GITHUB_DATA_PATH || "pan-search-data.js";
const GITHUB_API_BASE = "https://api.github.com";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const LINKS_FILE = path.join(DATA_DIR, "extra-links.json");
const SITE_NOTICE_FILE = path.join(DATA_DIR, "site-notice.json");
const SHORE_LETTER_FILE = path.join(DATA_DIR, "shore-letter.json");
const DRIFT_BOTTLES_FILE = path.join(DATA_DIR, "drift-bottles.json");
const LINK_HEALTH_BATCH_SIZE = Math.max(1, Math.min(30, Number(process.env.LINK_HEALTH_BATCH_SIZE || 15)));
const LINK_HEALTH_INTERVAL_MS = Math.max(60 * 60 * 1000, Number(process.env.LINK_HEALTH_INTERVAL_MS || 6 * 60 * 60 * 1000));
const LINK_HEALTH_AUTOCHECK = process.env.LINK_HEALTH_AUTOCHECK !== "false";
let linkHealthCheckRunning = false;
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "https://study.202510319.xyz,https://ningyan1228.github.io,http://localhost:8765,http://127.0.0.1:8765")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

fs.mkdirSync(DATA_DIR, { recursive: true });

function normalizeSiteNotice(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const tone = ["notice", "maintenance", "recovered"].includes(input.tone) ? input.tone : "notice";
  return {
    active: input.active === true,
    tone,
    title: boundedText(input.title, 80),
    message: boundedText(input.message, 220),
    updatedAt: input.updatedAt || null
  };
}

function readSiteNotice() {
  try {
    return normalizeSiteNotice(JSON.parse(fs.readFileSync(SITE_NOTICE_FILE, "utf8")));
  } catch (_) {
    return normalizeSiteNotice({});
  }
}

function writeSiteNotice(raw) {
  const notice = normalizeSiteNotice({ ...raw, updatedAt: new Date().toISOString() });
  fs.writeFileSync(SITE_NOTICE_FILE, JSON.stringify(notice, null, 2));
  return notice;
}
function normalizeShoreLetter(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  return { active: input.active !== false, title: boundedText(input.title, 80) || "一封给备考路上的你", message: boundedText(input.message, 220) || "资料会持续整理，愿你不必一个人翻遍全网。", updatedAt: input.updatedAt || null };
}
function readShoreLetter() { try { return normalizeShoreLetter(JSON.parse(fs.readFileSync(SHORE_LETTER_FILE, "utf8"))); } catch (_) { return normalizeShoreLetter({}); } }
function writeShoreLetter(raw) { const letter = normalizeShoreLetter({ ...raw, updatedAt: new Date().toISOString() }); fs.writeFileSync(SHORE_LETTER_FILE, JSON.stringify(letter, null, 2)); return letter; }function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      if (index <= 0) return cookies;
      const key = part.slice(0, index);
      const value = part.slice(index + 1);
      try {
        cookies[key] = decodeURIComponent(value);
      } catch (_) {
        cookies[key] = value;
      }
      return cookies;
    }, {});
}

function getRequestToken(req, url) {
  return url.searchParams.get("token")
    || req.headers.authorization?.replace(/^Bearer\s+/i, "")
    || parseCookies(req).admin_token
    || "";
}

function adminCookieHeader(token) {
  if (!token) return "";
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `admin_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`;
}

function sendAdminRedirect(res, location, token) {
  const headers = { Location: location };
  const cookie = adminCookieHeader(token);
  if (cookie) headers["Set-Cookie"] = cookie;
  res.writeHead(303, headers);
  res.end();
}

function createEmptyStats() {
  return {
    searches: {},
    dailySearches: {},
    dailyVisitors: {},
    noResults: {},
    clicks: {},
    brokenLinks: [],
    copies: {},
    linkHealth: {},
    linkHealthCursor: 0,
    linkHealthLastCheckAt: null,
    updatedAt: null
  };
}

function normalizeStatsShape(raw) {
  const stats = raw && typeof raw === "object" ? raw : createEmptyStats();
  stats.searches = stats.searches && typeof stats.searches === "object" ? stats.searches : {};
  stats.dailySearches = stats.dailySearches && typeof stats.dailySearches === "object" ? stats.dailySearches : {};
  stats.dailyVisitors = stats.dailyVisitors && typeof stats.dailyVisitors === "object" ? stats.dailyVisitors : {};
  stats.noResults = stats.noResults && typeof stats.noResults === "object" ? stats.noResults : {};
  stats.clicks = stats.clicks && typeof stats.clicks === "object" ? stats.clicks : {};
  stats.brokenLinks = Array.isArray(stats.brokenLinks) ? stats.brokenLinks : [];
stats.copies = stats.copies && typeof stats.copies === "object" ? stats.copies : {};
  stats.linkHealth = stats.linkHealth && typeof stats.linkHealth === "object" ? stats.linkHealth : {};
  // Captcha, risk-control and transient network pages are not evidence of a dead link.
  Object.keys(stats.linkHealth).forEach((url) => {
    const status = stats.linkHealth[url]?.status;
    if (status === "manual_review" || status === "unknown") delete stats.linkHealth[url];
  });
  stats.linkHealthCursor = Math.max(0, Number(stats.linkHealthCursor || 0));
  stats.linkHealthLastCheckAt = stats.linkHealthLastCheckAt || null;
  stats.updatedAt = stats.updatedAt || null;
  return stats;
}

function readStats() {
  try {
    return normalizeStatsShape(JSON.parse(fs.readFileSync(STATS_FILE, "utf8")));
  } catch (_) {
    return createEmptyStats();
  }
}

function writeStats(stats) {
  stats.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function boundedText(value, length = 2048) {
  return String(value || "").trim().slice(0, length);
}

function normalizeDriftBottle(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const status = ["pending", "approved", "deleted"].includes(input.status) ? input.status : "pending";
  const id = String(input.id || "");
  return {
    id: /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : "",
    message: boundedText(input.message, 48).replace(/\s+/g, " "),
    status,
    createdAt: input.createdAt || null,
    reviewedAt: input.reviewedAt || null,
    source: boundedText(input.source, 120)
  };
}

function readDriftBottles() {
  try {
    const items = JSON.parse(fs.readFileSync(DRIFT_BOTTLES_FILE, "utf8"));
    return (Array.isArray(items) ? items : []).map(normalizeDriftBottle).filter((item) => item.id && item.message);
  } catch (_) {
    return [];
  }
}

function writeDriftBottles(items) {
  const next = (Array.isArray(items) ? items : []).map(normalizeDriftBottle).filter((item) => item.id && item.message).slice(0, 500);
  const temporary = `${DRIFT_BOTTLES_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2));
  fs.renameSync(temporary, DRIFT_BOTTLES_FILE);
  return next;
}

function createDriftBottle(raw, source = "") {
  const message = boundedText(raw?.message, 48).replace(/\s+/g, " ");
  if (message.length < 2) throw new Error("请至少写 2 个字");
  const bottles = readDriftBottles();
  const now = Date.now();
  const repeated = bottles.find((item) => item.source === source && item.createdAt && now - Date.parse(item.createdAt) < 20000);
  if (repeated) throw new Error("请稍后再投递");
  const bottle = {
    id: crypto.randomBytes(16).toString("hex"),
    message,
    status: "pending",
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    source
  };
  bottles.unshift(bottle);
  writeDriftBottles(bottles);
  return bottle;
}

function reviewDriftBottle(id, action) {
  const bottles = readDriftBottles();
  const bottle = bottles.find((item) => item.id === String(id || ""));
  if (!bottle) throw new Error("未找到这条漂流瓶");
  if (action !== "approve" && action !== "delete") throw new Error("未知审核操作");
  bottle.status = action === "approve" ? "approved" : "deleted";
  bottle.reviewedAt = new Date().toISOString();
  writeDriftBottles(bottles);
  return bottle;
}

function getPublicDriftBottles() {
  return readDriftBottles()
    .filter((item) => item.status === "approved")
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, 30)
    .map(({ id, message, createdAt }) => ({ id, message, createdAt }));
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(number, Number.MAX_SAFE_INTEGER)) : 0;
}

function cleanLinkHealthState(stats, activeUrls) {
  const allowed = new Set(activeUrls || []);
  Object.keys(stats.linkHealth || {}).forEach((url) => {
    if (!allowed.has(url)) delete stats.linkHealth[url];
  });
}

function clearHiddenLinkState(oldUrl) {
  if (!oldUrl) return;
  const stats = readStats();
  if (stats.linkHealth && stats.linkHealth[oldUrl]) {
    delete stats.linkHealth[oldUrl];
    writeStats(stats);
  }
}

function getHiddenLinkUrls(stats = readStats()) {
  return Object.values(stats.linkHealth || {})
    .filter((item) => item && item.status === "hidden" && item.url)
    .map((item) => item.url);
}

function platformFromUrl(url) {
  return /pan\.baidu\.com/i.test(String(url || "")) ? "baidu" : "quark";
}

function containsOneOf(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

async function inspectPublicPanLink(item) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(item.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; StudyResourceHealth/1.0; +https://study.202510319.xyz/)",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7"
      }
    });
    const page = (await response.text()).slice(0, 180000);
    const normalized = page.replace(/\s+/g, " ");
    const challenge = containsOneOf(normalized, ["验证码", "安全验证", "访问过于频繁", "访问受限", "请完成验证", "滑动验证"]);
    const invalid = item.platform === "quark"
      ? containsOneOf(normalized, ["该分享已失效", "分享已失效", "该分享不存在", "不可访问"])
      : containsOneOf(normalized, ["分享的文件已经被取消", "分享已失效", "啊哦，你来晚了", "页面不存在", "链接不存在"]);

    if (invalid) return { status: "failed", detail: "页面明确提示分享已失效" };
    if (challenge || response.status === 401 || response.status === 403 || response.status === 429) {
      return { status: "skipped", detail: "页面要求验证或触发访问限制" };
    }
    if (!response.ok) return { status: "skipped", detail: `HTTP ${response.status}` };
    if (normalized.length < 160) return { status: "skipped", detail: "页面内容不足，无法确认" };
    return { status: "healthy", detail: "公开分享页可访问" };
  } catch (error) {
    return { status: "skipped", detail: error?.name === "AbortError" ? "检测超时" : "网络检测失败" };
  } finally {
    clearTimeout(timer);
  }
}

async function getLinkHealthInventory() {
  const config = assertGitHubConfig();
  const ghPath = encodeGitHubPath(config.dataPath);
  const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
  const panData = extractPanSearchData(await readGitHubFileContent(fileData));
  const byUrl = new Map();
  [...(Array.isArray(panData.items) ? panData.items : []), ...readExtraLinks()].forEach((item) => {
    const url = String(item?.url || "").trim();
    if (!/^https?:\/\//i.test(url) || byUrl.has(url)) return;
    const platform = item?.platform === "baidu" || item?.platform === "quark" ? item.platform : platformFromUrl(url);
    if (platform !== "baidu" && platform !== "quark") return;
    byUrl.set(url, { url, title: String(item?.title || "未命名资料"), platform });
  });
  return Array.from(byUrl.values()).sort((a, b) => a.url.localeCompare(b.url));
}

function addAutomaticBrokenReport(stats, item, checkedAt) {
  const duplicate = (stats.brokenLinks || []).some((report) => !report?.resolvedAt && report?.url === item.url);
  if (duplicate) return;
  stats.brokenLinks.unshift({
    title: item.title,
    url: item.url,
    platform: item.platform,
    query: "自动失效检测",
    source: "link-health-check",
    reason: "连续两次检测到分享已失效，已从公开搜索隐藏",
    ts: checkedAt
  });
  stats.brokenLinks = stats.brokenLinks.slice(0, 500);
}

const LINK_HEALTH_CHECK_MIN_INTERVAL_MS = 15000;
let linkHealthCheckLastRunAt = 0;

async function runLinkHealthCheck(options = {}) {
  if (linkHealthCheckRunning) throw new Error("链接检测正在进行，请稍后刷新后台查看结果");
  const now = Date.now();
  if (now - linkHealthCheckLastRunAt < LINK_HEALTH_CHECK_MIN_INTERVAL_MS) {
    throw new Error("链接检测请求过于频繁，请稍后再试");
  }
  linkHealthCheckLastRunAt = now;
  linkHealthCheckRunning = true;
  try {
    const inventory = await getLinkHealthInventory();
    const stats = readStats();
    cleanLinkHealthState(stats, inventory.map((item) => item.url));
    const count = Math.max(1, Math.min(LINK_HEALTH_BATCH_SIZE, Number(options.limit || LINK_HEALTH_BATCH_SIZE), inventory.length || 1));
    const start = inventory.length ? stats.linkHealthCursor % inventory.length : 0;
    const selected = inventory.length ? Array.from({ length: count }, (_, offset) => inventory[(start + offset) % inventory.length]) : [];
    const checkedAt = new Date().toISOString();
    const summary = { checked: 0, healthy: 0, failed: 0, hidden: 0, skipped: 0 };

    for (const item of selected) {
      const result = await inspectPublicPanLink(item);
      const previous = stats.linkHealth[item.url] || { url: item.url, title: item.title, platform: item.platform, consecutiveFailures: 0 };
      const health = { ...previous, url: item.url, title: item.title, platform: item.platform, lastCheckedAt: checkedAt, lastStatus: result.status, lastDetail: result.detail };
      summary.checked += 1;
      if (result.status === "healthy") {
        health.status = "healthy";
        health.consecutiveFailures = 0;
        health.lastHealthyAt = checkedAt;
        summary.healthy += 1;
      } else if (result.status === "failed") {
        health.consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
        if (health.consecutiveFailures >= 2) {
          health.status = "hidden";
          health.hiddenAt = health.hiddenAt || checkedAt;
          addAutomaticBrokenReport(stats, item, checkedAt);
          summary.hidden += 1;
        } else {
          health.status = "suspected";
          summary.failed += 1;
        }
      } else {
        // A captcha, rate-limit, timeout or other inconclusive response is not a failure.
        summary.skipped += 1;
        continue;
      }      stats.linkHealth[item.url] = health;
    }
    stats.linkHealthCursor = inventory.length ? (start + selected.length) % inventory.length : 0;
    stats.linkHealthLastCheckAt = checkedAt;
    writeStats(stats);
    return { ...summary, total: inventory.length, nextCursor: stats.linkHealthCursor, checkedAt };
  } finally {
    linkHealthCheckRunning = false;
  }
}
const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function shanghaiDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(SHANGHAI_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addDaysToDateKey(key, days) {
  const [year, month, day] = String(key || "").split("-").map(Number);
  if (!year || !month || !day) return shanghaiDateKey();
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function getWeekStartKey(todayKey) {
  const [year, month, day] = todayKey.split("-").map(Number);
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const mondayOffset = 1 - (utcDay || 7);
  return addDaysToDateKey(todayKey, mondayOffset);
}

function countDailySearch(stats, key) {
  return Number(stats?.dailySearches?.[key] || 0);
}

function sumDailySearches(stats, startKey, endKey) {
  return Object.entries(stats?.dailySearches || {}).reduce((sum, [key, value]) => {
    if (key >= startKey && key <= endKey) return sum + Number(value || 0);
    return sum;
  }, 0);
}

function formatYesterdayChange(today, yesterday) {
  if (!yesterday) {
    return { text: today > 0 ? "新增" : "—", color: "#64748b" };
  }
  const diff = today - yesterday;
  const percent = Math.round((diff / yesterday) * 100);
  const sign = diff > 0 ? "+" : "";
  const percentSign = percent > 0 ? "+" : "";
  return {
    text: `${sign}${diff}（${percentSign}${percent}%）`,
    color: diff > 0 ? "#059669" : diff < 0 ? "#dc2626" : "#64748b"
  };
}

function getSearchPeriodStats(stats, now = Date.now()) {
  const todayKey = shanghaiDateKey(now);
  const yesterdayKey = addDaysToDateKey(todayKey, -1);
  const weekStartKey = getWeekStartKey(todayKey);
  const monthStartKey = `${todayKey.slice(0, 7)}-01`;
  const today = countDailySearch(stats, todayKey);
  const yesterday = countDailySearch(stats, yesterdayKey);
  return {
    todayKey,
    yesterdayKey,
    today,
    yesterday,
    change: formatYesterdayChange(today, yesterday),
    week: sumDailySearches(stats, weekStartKey, todayKey),
    month: sumDailySearches(stats, monthStartKey, todayKey),
    weekStartKey,
    monthStartKey,
    monthKey: todayKey.slice(0, 7),
    dailySearches: stats.dailySearches || {}
  };
}
function renderSearchCalendar(period) {
  const [year, month] = period.monthKey.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const recordStartKey = "2026-08-07";
  const daily = period.dailySearches || {};
  const counts = Array.from({ length: daysInMonth }, (_, index) => {
    const dateKey = `${period.monthKey}-${String(index + 1).padStart(2, "0")}`;
    return Math.max(0, Number(daily[dateKey]) || 0);
  });
  const maxCount = Math.max(1, ...counts);
  const weekdayNames = ["一", "二", "三", "四", "五", "六", "日"];
  const blanks = Array.from({ length: firstWeekday }, () => `<span class="search-calendar-blank" aria-hidden="true"></span>`).join("");
  const days = Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    const dateKey = `${period.monthKey}-${String(day).padStart(2, "0")}`;
    const count = counts[index];
    const isFuture = dateKey > period.todayKey;
    const isBeforeRecord = dateKey < recordStartKey;
    const isToday = dateKey === period.todayKey;
    const state = isFuture ? "is-future" : isBeforeRecord ? "is-before-record" : count ? "has-data" : "is-zero";
    const value = isFuture || isBeforeRecord ? "—" : count;
    const level = count ? Math.max(0.14, Math.min(1, count / maxCount)) : 0;
    const label = isFuture ? `${dateKey}，未来日期` : isBeforeRecord ? `${dateKey}，开始记录前` : `${dateKey}，搜索 ${count} 次`;
    return `<div class="search-calendar-day ${state}${isToday ? " is-today" : ""}" style="--search-level:${level}" aria-label="${escapeHtml(label)}"><span class="calendar-day-number">${day}</span><strong>${value}</strong>${isFuture || isBeforeRecord ? "" : '<small>次搜索</small>'}</div>`;
  }).join("");
  return `<section class="search-calendar" aria-label="${year} 年 ${month} 月每日搜索次数"><div class="search-calendar-head"><div class="calendar-title"><span class="calendar-title-icon" aria-hidden="true">日</span><div><p class="calendar-eyebrow">SEARCH ACTIVITY</p><h4>${year} 年 ${month} 月</h4><p>每天的站内搜索次数</p></div></div><div class="calendar-max"><span>单日峰值</span><strong>${maxCount}</strong><small>次</small></div></div><div class="search-calendar-legend"><span><i class="legend-dot low"></i>较少</span><span><i class="legend-dot mid"></i>活跃</span><span><i class="legend-dot high"></i>高峰</span><b><i></i>今天</b></div><div class="search-calendar-weekdays">${weekdayNames.map((name, index) => `<span class="${index > 4 ? "is-weekend" : ""}">${name}</span>`).join("")}</div><div class="search-calendar-grid">${blanks}${days}</div><p class="search-calendar-note"><span>—</span> 尚未开始记录或未来日期；<b>0</b> 表示当天已记录但没有搜索。</p></section>`;
}
function readExtraLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch (_) {
    return [];
  }
}

function writeExtraLinks(items) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify({ items, updatedAt: new Date().toISOString() }, null, 2));
}

function normalizePlatform(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("baidu") || text.includes("百度")) return "baidu";
  return "quark";
}

function normalizeExtraLink(raw) {
  const title = String(raw.title || "").trim().slice(0, 160);
  const url = String(raw.url || "").trim().slice(0, 800);
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const platform = normalizePlatform(raw.platform || url);
  const section = String(raw.section || "后台新增").trim().slice(0, 80) || "后台新增";
  const code = String(raw.code || "").trim().slice(0, 40);
  const context = String(raw.context || raw.description || title).trim().slice(0, 400) || title;
  return {
    id: raw.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    url,
    platform,
    section,
    code,
    context,
    searchText: [title, section, context, code, platform].filter(Boolean).join(" "),
    sources: [{ file: "server-admin", line: 1 }],
    createdAt: raw.createdAt || new Date().toISOString()
  };
}

function addExtraLink(raw) {
  const item = normalizeExtraLink(raw);
  if (!item) return { ok: false, error: "标题或链接不正确" };
  const items = readExtraLinks();
  if (items.some((old) => old.url === item.url)) {
    return { ok: false, error: "这个链接已经存在" };
  }
  items.unshift(item);
  writeExtraLinks(items);
  return { ok: true, item };
}

function getGitHubConfig() {
  return {
    token: GITHUB_TOKEN,
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    branch: GITHUB_BRANCH,
    dataPath: GITHUB_DATA_PATH
  };
}

function assertGitHubConfig() {
  const config = getGitHubConfig();
  const missing = [];
  if (!config.token) missing.push("GITHUB_TOKEN");
  if (!config.owner) missing.push("GITHUB_OWNER");
  if (!config.repo) missing.push("GITHUB_REPO");
  if (!config.branch) missing.push("GITHUB_BRANCH");
  if (!config.dataPath) missing.push("GITHUB_DATA_PATH");
  if (missing.length) throw new Error(`缺少 GitHub 配置：${missing.join(", ")}`);
  return config;
}

function encodeGitHubPath(filePath) {
  return String(filePath || "").split("/").map(encodeURIComponent).join("/");
}

async function githubRequest(pathname, options = {}) {
  const config = assertGitHubConfig();
  const response = await fetch(`${GITHUB_API_BASE}${pathname}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `${SERVICE_NAME}-sync`,
      ...(options.headers || {})
    },
    body: options.body
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.message || text || `GitHub HTTP ${response.status}`);
  }
  return data;
}

async function readGitHubFileContent(fileData) {
  const config = assertGitHubConfig();

  if (fileData?.content && fileData.encoding === "base64") {
    return Buffer.from(String(fileData.content).replace(/\s/g, ""), "base64").toString("utf8");
  }

  if (fileData?.download_url) {
    const response = await fetch(fileData.download_url, {
      headers: {
        Accept: "application/vnd.github.raw",
        Authorization: `Bearer ${config.token}`,
        "User-Agent": `${SERVICE_NAME}-sync`
      }
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `GitHub raw HTTP ${response.status}`);
    }

    return response.text();
  }

  if (fileData?.sha) {
    const blob = await githubRequest(`/repos/${config.owner}/${config.repo}/git/blobs/${fileData.sha}`);
    if (blob?.content && blob.encoding === "base64") {
      return Buffer.from(String(blob.content).replace(/\s/g, ""), "base64").toString("utf8");
    }
  }

  throw new Error("GitHub 返回的 pan-search-data.js 文件内容为空，无法读取原始数据");
}

function extractPanSearchData(js) {
  const markerIndex = js.indexOf("window.PAN_SEARCH_DATA");
  const start = js.indexOf("{", markerIndex >= 0 ? markerIndex : 0);
  if (start < 0) throw new Error("没有找到 pan-search-data.js 里的数据对象");

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = start; index < js.length; index += 1) {
    const char = js[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(js.slice(start, index + 1));
      }
    }
  }

  throw new Error("pan-search-data.js 数据对象不完整");
}

function formatPanSearchData(data) {
  return `window.PAN_SEARCH_DATA = ${JSON.stringify(data, null, 2)};\n`;
}

function getMaxPanResourceId(items) {
  return items.reduce((max, item) => {
    const match = String(item.id || "").match(/^r(\d+)$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

function makeGitHubPanItem(link, nextId) {
  const platform = link.platform === "baidu" ? "baidu" : "quark";
  const title = String(link.title || "未命名资料").trim();
  const section = String(link.section || "后台新增").trim() || "后台新增";
  const context = String(link.context || `${title} 链接：${link.url}`).trim();
  const code = String(link.code || "").trim();
  return {
    id: `r${nextId}`,
    title,
    platform,
    url: link.url,
    code,
    section,
    context,
    sources: [
      {
        file: "server/data/extra-links.json",
        line: 1,
        section
      }
    ],
    searchText: [title, section, context, code, "server/data/extra-links.json"].filter(Boolean).join(" ")
  };
}

function refreshPanSearchTotals(data, addedItems) {
  const items = Array.isArray(data.items) ? data.items : [];
  const unique = {
    quark: items.filter((item) => item.platform === "quark").length,
    baidu: items.filter((item) => item.platform === "baidu").length,
    total: items.length
  };
  const oldRaw = data.totals?.raw || {};
  const addedRaw = {
    quark: addedItems.filter((item) => item.platform === "quark").length,
    baidu: addedItems.filter((item) => item.platform === "baidu").length,
    total: addedItems.length
  };
  data.totals = data.totals || {};
  data.totals.unique = unique;
  data.totals.raw = {
    quark: Number(oldRaw.quark || unique.quark) + addedRaw.quark,
    baidu: Number(oldRaw.baidu || unique.baidu) + addedRaw.baidu,
    total: Number(oldRaw.total || unique.total) + addedRaw.total
  };
  data.generatedAt = new Date().toISOString();
}

function normalizeHttpUrl(value, label = "链接") {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    throw new Error(`${label}格式不正确`);
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw new Error(`${label}必须以 http:// 或 https:// 开头`);
  }
  return text;
}

function replaceTextValue(value, oldUrl, newUrl) {
  if (!oldUrl) return value;
  return typeof value === "string" ? value.split(oldUrl).join(newUrl) : value;
}

function refreshPanSearchTotalsAfterReplacement(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  data.totals = data.totals || {};
  data.totals.unique = {
    quark: items.filter((item) => item.platform === "quark").length,
    baidu: items.filter((item) => item.platform === "baidu").length,
    total: items.length
  };
  data.generatedAt = new Date().toISOString();
}

function replaceExtraLinkUrl(oldUrl, newUrl, platform) {
  const items = readExtraLinks();
  let updated = 0;
  items.forEach((item) => {
    if (item?.url !== oldUrl) return;
    item.updatedAt = new Date().toISOString();
    item.url = newUrl;
    item.platform = platform || normalizePlatform(newUrl);
    item.context = replaceTextValue(item.context, oldUrl, newUrl);
    item.searchText = replaceTextValue(item.searchText, oldUrl, newUrl);
    updated += 1;
  });
  if (updated > 0) writeExtraLinks(items);
  return updated;
}

function removeExtraLinkUrl(oldUrl) {
  const items = readExtraLinks();
  const remaining = items.filter((item) => item?.url !== oldUrl);
  const removed = items.length - remaining.length;
  if (removed > 0) writeExtraLinks(remaining);
  return removed;
}

function resolveBrokenLinkReports(oldUrl, newUrl, fallback = {}) {
  const stats = readStats();
  const now = new Date().toISOString();
  const normalizedOldUrl = String(oldUrl || "").trim();
  const normalizedTitle = normalizeBaiduTitleForMatch(fallback.title || "");
  const normalizedPlatform = fallback.platform ? normalizePlatform(fallback.platform) : "";
  let resolved = 0;
  stats.brokenLinks = Array.isArray(stats.brokenLinks) ? stats.brokenLinks : [];
  stats.brokenLinks.forEach((item) => {
    if (item?.resolvedAt) return;
    const itemUrl = String(item?.url || "").trim();
    const byUrl = normalizedOldUrl && itemUrl === normalizedOldUrl;
    const byTitle = !normalizedOldUrl
      && !itemUrl
      && normalizedTitle
      && normalizeBaiduTitleForMatch(item?.title || "") === normalizedTitle
      && (!normalizedPlatform || normalizePlatform(item?.platform || normalizedPlatform) === normalizedPlatform);
    if (!byUrl && !byTitle) return;
    item.resolvedAt = now;
    item.replacementUrl = newUrl;
    resolved += 1;
  });
  if (resolved > 0) writeStats(stats);
  return { resolved, resolvedAt: now };
}

function markBrokenLinkReportsRemoved(oldUrl, fallback = {}) {
  const stats = readStats();
  const now = new Date().toISOString();
  const normalizedOldUrl = String(oldUrl || "").trim();
  const normalizedPlatform = fallback.platform ? normalizePlatform(fallback.platform) : platformFromUrl(normalizedOldUrl);
  let resolved = 0;

  if (!normalizedOldUrl) throw new Error("缺少原失效链接，无法从搜索中下架");

  stats.brokenLinks = Array.isArray(stats.brokenLinks) ? stats.brokenLinks : [];
  stats.brokenLinks.forEach((item) => {
    if (item?.resolvedAt || String(item?.url || "").trim() !== normalizedOldUrl) return;
    item.resolvedAt = now;
    item.removedAt = now;
    item.resolution = "removed";
    item.replacementUrl = "";
    resolved += 1;
  });

  // Keep already-loaded public pages from returning the old result while the
  // GitHub Pages cache catches up with the source-index removal.
  stats.linkHealth = stats.linkHealth && typeof stats.linkHealth === "object" ? stats.linkHealth : {};
  stats.linkHealth[normalizedOldUrl] = {
    url: normalizedOldUrl,
    title: String(fallback.title || "").trim(),
    platform: normalizedPlatform,
    status: "hidden",
    detail: "管理员下架：原链接已在批量更新中替换，不再出现在公开搜索",
    hiddenAt: now,
    lastCheckedAt: now
  };
  writeStats(stats);
  return { resolved, resolvedAt: now };
}

function refreshSearchTextForPanItem(item) {
  item.searchText = [item.title, item.section, item.context, item.code, item.platform, item.url].filter(Boolean).join(" ");
}

function resetContextForMissingOldUrl(item, platform) {
  const current = String(item.context || "");
  const urlCount = (current.match(/https?:\/\//g) || []).length;
  const sourceFiles = Array.isArray(item.sources) ? item.sources.map((source) => source?.file).filter(Boolean) : [];
  if (platform === "quark" && (urlCount > 1 || sourceFiles.includes("admin-bulk-quark") || !current.trim())) {
    item.context = `夸克网盘批量导入：${item.title}`;
    return;
  }
  if (!current.trim()) {
    item.context = `${platform === "baidu" ? "百度网盘" : "夸克网盘"}补链：${item.title}`;
  }
}

async function replaceBrokenLinkInGitHub({ oldUrl, newUrl, platform, oldPlatform, title }) {
  const rawOldUrl = String(oldUrl || "").trim();
  const normalizedOldUrl = rawOldUrl ? normalizeHttpUrl(rawOldUrl, "旧链接") : "";
  const normalizedNewUrl = normalizeHttpUrl(newUrl, "新链接");
  const normalizedPlatform = platform ? normalizePlatform(platform) : normalizePlatform(normalizedNewUrl);
  const normalizedOldPlatform = oldPlatform ? normalizePlatform(oldPlatform) : normalizedPlatform;
  const normalizedTitle = normalizeBaiduTitleForMatch(title || "");
  const config = assertGitHubConfig();

  if (!normalizedOldUrl && !normalizedTitle) {
    throw new Error("旧链接为空时，需要资源标题用于定位 GitHub 数据");
  }
  if (normalizedOldUrl && normalizedOldUrl === normalizedNewUrl) {
    throw new Error("新链接不能和旧链接相同");
  }

  const ghPath = encodeGitHubPath(config.dataPath);
  const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
  if (!fileData || fileData.type !== "file" || !fileData.sha) {
    throw new Error("GitHub 返回的 pan-search-data.js 文件信息不完整");
  }

  const currentContent = await readGitHubFileContent(fileData);
  const panData = extractPanSearchData(currentContent);
  panData.items = Array.isArray(panData.items) ? panData.items : [];

  const titlePlatformMatches = normalizedTitle
    ? panData.items.filter((item) => normalizePlatform(item?.platform) === normalizedOldPlatform && normalizeBaiduTitleForMatch(item?.title || "") === normalizedTitle)
    : [];
  let matchedItems = normalizedOldUrl
    ? panData.items.filter((item) => item?.url === normalizedOldUrl)
    : titlePlatformMatches;
  let matchedBy = normalizedOldUrl ? "url" : "title-platform";

  // A feedback report can outlive a bulk update. Only fall back when exactly one
  // current item has the same normalized title and original platform.
  if (normalizedOldUrl && !matchedItems.length && normalizedTitle) {
    if (titlePlatformMatches.length === 1) {
      matchedItems = titlePlatformMatches;
      matchedBy = "title-platform-fallback";
    } else if (titlePlatformMatches.length > 1) {
      throw new Error(`旧链接已不在 GitHub 索引中；同标题、同平台找到 ${titlePlatformMatches.length} 条，无法安全自动替换，请先人工确认`);
    }
  }
  if (!matchedItems.length) {
    throw new Error(normalizedOldUrl
      ? "GitHub pan-search-data.js 中没有找到旧链接，也没有找到唯一的同标题同平台资源"
      : "旧链接为空，且没有按标题和平台找到对应 GitHub 资源");
  }
  const matchedSet = new Set(matchedItems);
  const duplicate = panData.items.find((item) => item?.url === normalizedNewUrl && !matchedSet.has(item));
  if (duplicate) {
    throw new Error(`新链接已存在于 GitHub 数据中：${duplicate.title || duplicate.id || duplicate.url}`);
  }

  let changed = 0;
  matchedItems.forEach((item) => {
    const before = JSON.stringify({ url: item.url, platform: item.platform, context: item.context, searchText: item.searchText, code: item.code });
    const matchedOldUrl = String(item.url || "").trim();
    item.url = normalizedNewUrl;
    item.platform = normalizedPlatform;
    if (matchedOldUrl) {
      item.context = replaceTextValue(item.context, matchedOldUrl, normalizedNewUrl);
      item.searchText = replaceTextValue(item.searchText, matchedOldUrl, normalizedNewUrl);
    } else {
      resetContextForMissingOldUrl(item, normalizedPlatform);
    }
    refreshSearchTextForPanItem(item);
    const after = JSON.stringify({ url: item.url, platform: item.platform, context: item.context, searchText: item.searchText, code: item.code });
    if (before !== after) changed += 1;
  });

  let commitUrl = "";
  if (changed > 0) {
    refreshPanSearchTotalsAfterReplacement(panData);
    const updatedContent = formatPanSearchData(panData);
    const putData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Replace broken pan link (${matchedItems.length})`,
        content: Buffer.from(updatedContent, "utf8").toString("base64"),
        sha: fileData.sha,
        branch: config.branch
      })
    });
    commitUrl = putData?.commit?.html_url || "";
  }

  const extraUpdated = normalizedOldUrl ? replaceExtraLinkUrl(normalizedOldUrl, normalizedNewUrl, normalizedPlatform) : 0;
  const statsResult = resolveBrokenLinkReports(normalizedOldUrl, normalizedNewUrl, { title, platform: normalizedPlatform });
  clearHiddenLinkState(normalizedOldUrl);

  return {
    ok: true,
    oldUrl: normalizedOldUrl,
    newUrl: normalizedNewUrl,
    platform: normalizedPlatform,
    matchedBy,
    replaced: matchedItems.length,
    changed,
    extraUpdated,
    resolvedReports: statsResult.resolved,
    resolvedAt: statsResult.resolvedAt,
    commitUrl,
    message: changed > 0
      ? `已替换 GitHub 中 ${matchedItems.length} 条链接${matchedBy === "title-platform-fallback" ? "（旧链接已更新，已按同标题同平台唯一资源定位）" : ""}，标记 ${statsResult.resolved} 条反馈为已处理`
      : `GitHub 中 ${matchedItems.length} 条资源已是目标链接，已标记 ${statsResult.resolved} 条反馈为已处理`
  };
}

async function removeBrokenLinkFromSearch({ oldUrl, oldPlatform, title }) {
  const normalizedOldUrl = normalizeHttpUrl(oldUrl, "原失效链接");
  const normalizedPlatform = oldPlatform ? normalizePlatform(oldPlatform) : platformFromUrl(normalizedOldUrl);
  const config = assertGitHubConfig();
  const ghPath = encodeGitHubPath(config.dataPath);
  const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
  if (!fileData || fileData.type !== "file" || !fileData.sha) {
    throw new Error("GitHub 返回的 pan-search-data.js 文件信息不完整");
  }

  const currentContent = await readGitHubFileContent(fileData);
  const panData = extractPanSearchData(currentContent);
  panData.items = Array.isArray(panData.items) ? panData.items : [];
  const matchedItems = panData.items.filter((item) => String(item?.url || "").trim() === normalizedOldUrl);
  let commitUrl = "";

  if (matchedItems.length) {
    const matchedSet = new Set(matchedItems);
    panData.items = panData.items.filter((item) => !matchedSet.has(item));
    refreshPanSearchTotalsAfterReplacement(panData);
    const updatedContent = formatPanSearchData(panData);
    const putData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Remove broken pan link from search (${matchedItems.length})`,
        content: Buffer.from(updatedContent, "utf8").toString("base64"),
        sha: fileData.sha,
        branch: config.branch
      })
    });
    commitUrl = putData?.commit?.html_url || "";
  }

  const extraRemoved = removeExtraLinkUrl(normalizedOldUrl);
  const statsResult = markBrokenLinkReportsRemoved(normalizedOldUrl, { title, platform: normalizedPlatform });
  return {
    ok: true,
    oldUrl: normalizedOldUrl,
    removed: matchedItems.length,
    extraRemoved,
    resolvedReports: statsResult.resolved,
    resolvedAt: statsResult.resolvedAt,
    commitUrl,
    message: matchedItems.length || extraRemoved
      ? `已从公开搜索库移除 ${matchedItems.length + extraRemoved} 条原链接，并标记 ${statsResult.resolved} 条反馈为已下架`
      : `原链接已不在当前搜索库中，已标记 ${statsResult.resolved} 条反馈为已下架；前台会继续隐藏该链接`
  };
}
function normalizeBaiduTitleForMatch(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^\s*(?:第?\d+|[一二三四五六七八九十百千]+)\s*[\.、:：\-)）_]\s*/g, "")
    .replace(/(?:百度网盘|网盘)?\s*(?:链接|地址|提取码|密码|pwd|code)\s*[:：=]?/gi, "")
    .replace(/[\s\u3000\-—_·.,，。:：;；、/\\|()（）\[\]【】{}《》<>“”"'‘’!！?？+]+/g, "")
    .toLowerCase();
}

function stripTrailingUrlPunctuation(value) {
  return String(value || "").replace(/[，,。；;、)）】\]}>]+$/g, "");
}

function extractBaiduPwdFromText(value) {
  const text = String(value || "");
  const pwdMatch = text.match(/[?&]pwd=([A-Za-z0-9]{2,12})/i)
    || text.match(/(?:提取码|提取碼|密码|密碼|pwd|code)\s*[:：=]?\s*([A-Za-z0-9]{2,12})/i);
  return pwdMatch ? pwdMatch[1].trim() : "";
}

function normalizeBaiduUrl(rawUrl, code = "") {
  const text = stripTrailingUrlPunctuation(rawUrl);
  const parsed = new URL(text);
  if (!/^https?:$/i.test(parsed.protocol) || !/pan\.baidu\.com$/i.test(parsed.hostname)) {
    throw new Error("不是有效的百度网盘链接");
  }
  const pwd = code || parsed.searchParams.get("pwd") || "";
  if (pwd) parsed.searchParams.set("pwd", pwd);
  return { url: parsed.toString(), code: pwd };
}

function findPreviousBulkTitle(lines, startIndex) {
  for (let index = startIndex - 1; index >= 0 && index >= startIndex - 4; index -= 1) {
    const line = String(lines[index] || "").trim();
    if (!line) continue;
    if (/pan\.baidu\.com\/s\//i.test(line)) continue;
    if (/^(?:提取码|提取碼|密码|密碼|pwd|code)\s*[:：=]/i.test(line)) continue;
    return line;
  }
  return "";
}

function parseBulkBaiduText(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  const lines = text.split("\n");
  const records = [];
  const invalid = [];
  const linkPattern = /https?:\/\/pan\.baidu\.com\/s\/[^\s，,；;。)）】\]}>]+/ig;

  lines.forEach((line, lineIndex) => {
    linkPattern.lastIndex = 0;
    let match;
    while ((match = linkPattern.exec(line))) {
      const rawUrl = match[0];
      const before = line.slice(0, match.index)
        .replace(/(?:百度网盘)?\s*(?:链接|地址|url)\s*[:：=]?\s*$/i, "")
        .trim();
      const title = before || findPreviousBulkTitle(lines, lineIndex);
      const lookahead = [line.slice(match.index), lines[lineIndex + 1] || "", lines[lineIndex + 2] || ""].join(" ");
      const codeFromText = extractBaiduPwdFromText(lookahead);

      try {
        const normalized = normalizeBaiduUrl(rawUrl, codeFromText);
        const normalizedTitle = normalizeBaiduTitleForMatch(title);
        if (!title || !normalizedTitle) {
          invalid.push({ title: title || "未识别标题", url: normalized.url, reason: `第 ${lineIndex + 1} 行缺少可匹配标题` });
          continue;
        }
        records.push({ title: title.trim(), normalizedTitle, url: normalized.url, code: normalized.code, line: lineIndex + 1 });
      } catch (error) {
        invalid.push({ title: title || "未识别标题", url: rawUrl, reason: error.message || "链接格式不完整" });
      }
    }
  });

  return { records, invalid };
}

async function readGitHubPanSearchDataFile() {
  const config = assertGitHubConfig();
  const ghPath = encodeGitHubPath(config.dataPath);
  const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
  if (!fileData || fileData.type !== "file" || !fileData.sha) {
    throw new Error("GitHub 返回的 pan-search-data.js 文件信息不完整");
  }
  const currentContent = await readGitHubFileContent(fileData);
  const panData = extractPanSearchData(currentContent);
  panData.items = Array.isArray(panData.items) ? panData.items : [];
  return { config, ghPath, fileData, panData };
}

function createBulkBaiduNewItem(record, nextId, defaultSection) {
  const title = String(record.title || "未命名百度资料").trim();
  const section = String(defaultSection || "百度批量新增").trim() || "百度批量新增";
  const context = `百度网盘批量导入：${title}`;
  const code = String(record.code || "").trim();
  const url = String(record.newUrl || record.url || "").trim();
  if (!url) throw new Error(`百度批量新增“${title}”缺少有效链接，已停止提交`);
  return {
    id: `r${nextId}`,
    title,
    platform: "baidu",
    url,
    code,
    section,
    context,
    sources: [{ file: "admin-bulk-baidu", line: record.line || 1, section }],
    searchText: [title, section, context, code, "baidu", url].filter(Boolean).join(" ")
  };
}

function createBaiduBulkPlan(rawText, panData, defaultSection = "百度批量新增") {
  const parsed = parseBulkBaiduText(rawText);
  const titleMap = new Map();
  const inputTitleMap = new Map();

  panData.items.forEach((item) => {
    if (item?.platform !== "baidu") return;
    const normalizedTitle = normalizeBaiduTitleForMatch(item.title);
    if (!normalizedTitle) return;
    const rows = titleMap.get(normalizedTitle) || [];
    rows.push(item);
    titleMap.set(normalizedTitle, rows);
  });

  parsed.records.forEach((record) => {
    const rows = inputTitleMap.get(record.normalizedTitle) || [];
    rows.push(record);
    inputTitleMap.set(record.normalizedTitle, rows);
  });

  const plan = {
    ok: true,
    rawCount: parsed.records.length,
    defaultSection: String(defaultSection || "百度批量新增").trim() || "百度批量新增",
    replace: [],
    add: [],
    unchanged: [],
    inputDuplicate: [],
    targetDuplicate: [],
    unmatchedTarget: [],
    independentAdd: [],
    ignored: parsed.invalid.map((row) => ({ ...row, reason: row.reason || "无法解析标题或百度链接" }))
  };

  inputTitleMap.forEach((inputRows, normalizedTitle) => {
    const record = inputRows[0];
    if (inputRows.length > 1) {
      plan.inputDuplicate.push({
        title: record.title,
        normalizedTitle,
        inputCount: inputRows.length,
        lines: inputRows.map((row) => row.line),
        urls: inputRows.map((row) => row.url),
        reason: `输入中有 ${inputRows.length} 条标准化后同名的链接（第 ${inputRows.map((row) => row.line).join("、")} 行）；将按链接逐条覆盖或新增`
      });
    }

    const matches = titleMap.get(normalizedTitle) || [];
    if (!matches.length) {
      inputRows.forEach((incoming) => plan.add.push({
        title: incoming.title,
        normalizedTitle: incoming.normalizedTitle,
        newUrl: incoming.url,
        newCode: incoming.code,
        section: plan.defaultSection,
        line: incoming.line,
        reason: "网站暂无同名百度资源，将直接新增"
      }));
      return;
    }

    if (matches.length > 1) {
      plan.targetDuplicate.push({
        title: matches[0]?.title || record.title,
        normalizedTitle,
        inputCount: inputRows.length,
        matchedCount: matches.length,
        itemIds: matches.map((item) => item.id).filter(Boolean),
        urls: inputRows.map((row) => row.url),
        reason: `网站中有 ${matches.length} 条标准化后同名的百度资料；将按链接优先匹配，再依次覆盖`
      });
    }

    let availableItems = [...matches];
    const exactInputIndexes = new Set();
    inputRows.forEach((incoming, index) => {
      const exactItems = availableItems.filter((item) => String(item.url || "") === incoming.url && String(item.code || "").trim() === incoming.code);
      if (!exactItems.length) return;
      const exactSet = new Set(exactItems);
      availableItems = availableItems.filter((item) => !exactSet.has(item));
      exactInputIndexes.add(index);
      plan.unchanged.push({
        title: exactItems[0]?.title || incoming.title,
        normalizedTitle,
        newUrl: incoming.url,
        newCode: incoming.code,
        matchedCount: exactItems.length,
        reason: `链接和提取码无变化，已匹配 ${exactItems.length} 条百度资源`
      });
    });

    const pendingInputs = inputRows.filter((_, index) => !exactInputIndexes.has(index));
    const pairCount = Math.min(pendingInputs.length, availableItems.length);
    for (let index = 0; index < pairCount; index += 1) {
      const incoming = pendingInputs[index];
      const item = availableItems[index];
      plan.replace.push({
        title: item.title || incoming.title,
        normalizedTitle,
        oldUrl: item.url || "",
        newUrl: incoming.url,
        oldCode: String(item.code || "").trim(),
        newCode: incoming.code,
        line: incoming.line,
        matchedCount: 1,
        itemIds: item.id ? [item.id] : [],
        items: [item],
        reason: "同标题资料逐条匹配，将覆盖旧百度链接"
      });
    }

    pendingInputs.slice(pairCount).forEach((incoming) => plan.add.push({
      title: incoming.title,
      normalizedTitle: incoming.normalizedTitle,
      newUrl: incoming.url,
      newCode: incoming.code,
      section: plan.defaultSection,
      line: incoming.line,
      reason: "同名旧资料已全部匹配，剩余新链接将作为独立资料新增"
    }));

    const remainingItems = availableItems.slice(pairCount);
    if (remainingItems.length) {
      plan.unmatchedTarget.push({
        title: remainingItems[0]?.title || record.title,
        normalizedTitle,
        matchedCount: remainingItems.length,
        itemIds: remainingItems.map((item) => item.id).filter(Boolean),
        urls: remainingItems.map((item) => item.url).filter(Boolean),
        reason: `网站同名旧资料比本次新链接多 ${remainingItems.length} 条，未配对的旧资料保持不变`
      });
    }
  });

  plan.summary = {
    raw: parsed.records.length,
    uniqueTitles: inputTitleMap.size,
    replace: plan.replace.reduce((sum, row) => sum + Number(row.matchedCount || 0), 0),
    add: plan.add.length,
    unchanged: plan.unchanged.reduce((sum, row) => sum + Number(row.matchedCount || 0), 0),
    inputDuplicate: plan.inputDuplicate.length,
    inputDuplicateRecords: plan.inputDuplicate.reduce((sum, row) => sum + Number(row.inputCount || 0), 0),
    targetDuplicate: plan.targetDuplicate.length,
    targetDuplicateRecords: plan.targetDuplicate.reduce((sum, row) => sum + Number(row.matchedCount || 0), 0),
    unmatchedTarget: plan.unmatchedTarget.reduce((sum, row) => sum + Number(row.matchedCount || 0), 0),
    independentAdd: plan.independentAdd.length,
    ignored: plan.ignored.length,
    parsed: parsed.records.length
  };
  return plan;
}

function serializeBaiduBulkPlan(plan) {
  const slim = { ...plan };
  delete slim.ok;
  slim.replace = plan.replace.map(({ items, ...row }) => row);
  slim.update = slim.replace;
  slim.add = plan.add.map((row) => ({ ...row }));
  slim.unchanged = plan.unchanged.map((row) => ({ ...row }));
  slim.inputDuplicate = plan.inputDuplicate.map((row) => ({ ...row }));
  slim.targetDuplicate = plan.targetDuplicate.map((row) => ({ ...row }));
  slim.unmatchedTarget = plan.unmatchedTarget.map((row) => ({ ...row }));
  slim.independentAdd = plan.independentAdd.map((row) => ({ ...row }));
  slim.ignored = plan.ignored.map((row) => ({ ...row }));
  slim.unmatched = slim.unmatchedTarget;
  slim.duplicateInput = slim.inputDuplicate;
  slim.ambiguous = slim.targetDuplicate;
  slim.githubDuplicate = [];
  slim.invalid = slim.ignored;
  return slim;
}

async function previewBulkBaiduLinks(rawText, defaultSection = "百度批量新增") {
  const { panData } = await readGitHubPanSearchDataFile();
  return serializeBaiduBulkPlan(createBaiduBulkPlan(rawText, panData, defaultSection));
}

function refreshSearchTextForBulkBaidu(item) {
  item.searchText = [item.title, item.section, item.context, item.code, item.platform, item.url].filter(Boolean).join(" ");
}

async function applyBulkBaiduLinks(rawText, defaultSection = "百度批量新增", mode = "safe") {
  const { config, ghPath, fileData, panData } = await readGitHubPanSearchDataFile();
  const plan = createBaiduBulkPlan(rawText, panData, defaultSection);
  const appendAmbiguous = mode === "append-ambiguous";
  const additions = [...plan.add, ...(appendAmbiguous ? plan.independentAdd : [])];
  const totalChanges = plan.summary.replace + additions.length;
  if (!totalChanges) {
    return {
      ok: false,
      ...serializeBaiduBulkPlan(plan),
      message: "所有可匹配链接均无变化，未提交 GitHub"
    };
  }

  plan.replace.forEach((row) => {
    row.items.forEach((item) => {
      const oldUrl = item.url || "";
      const oldCode = String(item.code || "").trim();
      item.platform = "baidu";
      item.url = row.newUrl;
      item.code = row.newCode || "";
      item.context = replaceTextValue(item.context, oldUrl, row.newUrl);
      item.searchText = replaceTextValue(item.searchText, oldUrl, row.newUrl);
      if (oldCode && row.newCode && oldCode !== row.newCode) {
        item.context = replaceTextValue(item.context, oldCode, row.newCode);
        item.searchText = replaceTextValue(item.searchText, oldCode, row.newCode);
      }
      refreshSearchTextForBulkBaidu(item);
    });
  });

  let nextId = getMaxPanResourceId(panData.items) + 1;
  additions.forEach((record) => {
    const item = createBulkBaiduNewItem(record, nextId, plan.defaultSection);
    nextId += 1;
    panData.items.push(item);
  });

  refreshPanSearchTotalsAfterReplacement(panData);
  const updatedContent = formatPanSearchData(panData);
  const putData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Batch replace/add Baidu pan links (${plan.summary.replace} replace, ${plan.summary.add} direct add, ${appendAmbiguous ? plan.summary.independentAdd : 0} independent add)`,
      content: Buffer.from(updatedContent, "utf8").toString("base64"),
      sha: fileData.sha,
      branch: config.branch
    })
  });

  githubResourceSummaryCache = null;
  return {
    ok: true,
    ...serializeBaiduBulkPlan(plan),
    commitUrl: putData?.commit?.html_url || "",
    message: `已替换 ${plan.summary.replace} 条百度资源，直接新增 ${plan.summary.add} 条；输入同名 ${plan.summary.inputDuplicate || 0} 组、网站同名 ${plan.summary.targetDuplicate || 0} 组均已按逐条规则处理，${plan.summary.unmatchedTarget || 0} 条未配对旧资料保持不变`

  };
}
function normalizeQuarkUrl(rawUrl) {
  const text = stripTrailingUrlPunctuation(rawUrl);
  const parsed = new URL(text);
  if (!/^https?:$/i.test(parsed.protocol) || !/^pan\.quark\.cn$/i.test(parsed.hostname) || !/^\/s\//i.test(parsed.pathname)) {
    throw new Error("不是有效的夸克网盘链接");
  }
  return parsed.toString();
}

function findPreviousQuarkBulkTitle(lines, startIndex) {
  for (let index = startIndex - 1; index >= 0 && index >= startIndex - 4; index -= 1) {
    const line = String(lines[index] || "").trim();
    if (!line) continue;
    if (/pan\.(?:quark|baidu)\.cn\/s\//i.test(line)) continue;
    if (/^(?:链接|地址|url)\s*[:：=]/i.test(line)) continue;
    return line;
  }
  return "";
}

function parseBulkQuarkText(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  const lines = text.split("\n");
  const records = [];
  const invalid = [];
  const linkPattern = /https?:\/\/pan\.quark\.cn\/s\/[^\s，,；;。)）】\]}>]+/ig;

  lines.forEach((line, lineIndex) => {
    linkPattern.lastIndex = 0;
    let match;
    while ((match = linkPattern.exec(line))) {
      const rawUrl = match[0];
      const before = line.slice(0, match.index)
        .replace(/(?:夸克网盘)?\s*(?:链接|地址|url)\s*[:：=]?\s*$/i, "")
        .trim();
      const title = before || findPreviousQuarkBulkTitle(lines, lineIndex);

      try {
        const normalizedUrl = normalizeQuarkUrl(rawUrl);
        const normalizedTitle = normalizeBaiduTitleForMatch(title);
        if (!title || !normalizedTitle) {
          invalid.push({ title: title || "未识别标题", url: normalizedUrl, reason: `第 ${lineIndex + 1} 行缺少可匹配标题` });
          continue;
        }
        records.push({ title: title.trim(), normalizedTitle, url: normalizedUrl, code: "", line: lineIndex + 1 });
      } catch (error) {
        invalid.push({ title: title || "未识别标题", url: rawUrl, reason: error.message || "链接格式不完整" });
      }
    }
  });

  return { records, invalid };
}

function createBulkQuarkNewItem(record, nextId, defaultSection) {
  const title = String(record.title || "未命名夸克资料").trim();
  const section = String(defaultSection || "夸克批量新增").trim() || "夸克批量新增";
  const context = `夸克网盘批量导入：${title}`;
  const url = String(record.newUrl || record.url || "").trim();
  return {
    id: `r${nextId}`,
    title,
    platform: "quark",
    url,
    code: "",
    section,
    context,
    sources: [{ file: "admin-bulk-quark", line: record.line || 1, section }],
    searchText: [title, section, context, "quark", url].filter(Boolean).join(" ")
  };
}

function createQuarkBulkPlan(rawText, panData, defaultSection = "夸克批量新增") {
  const parsed = parseBulkQuarkText(rawText);
  const titleMap = new Map();

  panData.items.forEach((item) => {
    if (item?.platform !== "quark") return;
    const normalizedTitle = normalizeBaiduTitleForMatch(item.title);
    if (!normalizedTitle) return;
    const rows = titleMap.get(normalizedTitle) || [];
    rows.push(item);
    titleMap.set(normalizedTitle, rows);
  });

  const finalRecords = new Map();
  parsed.records.forEach((record) => {
    finalRecords.set(record.normalizedTitle, record);
  });

  const plan = {
    ok: true,
    rawCount: parsed.records.length,
    defaultSection: String(defaultSection || "夸克批量新增").trim() || "夸克批量新增",
    replace: [],
    add: [],
    unchanged: [],
    ignored: parsed.invalid.map((row) => ({ ...row, reason: row.reason || "无法解析标题或夸克链接" }))
  };

  finalRecords.forEach((record) => {
    const matches = titleMap.get(record.normalizedTitle) || [];
    if (!matches.length) {
      plan.add.push({
        title: record.title,
        normalizedTitle: record.normalizedTitle,
        newUrl: record.url,
        newCode: "",
        section: plan.defaultSection,
        line: record.line,
        reason: "网站暂无同名夸克资源，将直接新增"
      });
      return;
    }

    const unchangedItems = matches.filter((item) => String(item.url || "") === record.url);
    if (unchangedItems.length === matches.length) {
      plan.unchanged.push({
        title: matches[0]?.title || record.title,
        normalizedTitle: record.normalizedTitle,
        newUrl: record.url,
        newCode: "",
        matchedCount: matches.length,
        reason: `链接无变化，已匹配 ${matches.length} 条夸克资源`
      });
      return;
    }

    plan.replace.push({
      title: matches[0]?.title || record.title,
      normalizedTitle: record.normalizedTitle,
      oldUrl: matches[0]?.url || "",
      newUrl: record.url,
      oldCode: "",
      newCode: "",
      line: record.line,
      matchedCount: matches.length,
      itemIds: matches.map((item) => item.id).filter(Boolean),
      items: matches,
      reason: matches.length > 1 ? `同名夸克资源 ${matches.length} 条，将全部替换为该新链接` : "标题匹配，将替换夸克链接"
    });
  });

  plan.summary = {
    parsed: finalRecords.size,
    replace: plan.replace.reduce((sum, row) => sum + Number(row.matchedCount || 0), 0),
    add: plan.add.length,
    unchanged: plan.unchanged.length,
    ignored: plan.ignored.length
  };
  return plan;
}

function serializeQuarkBulkPlan(plan) {
  const slim = { ...plan };
  delete slim.ok;
  slim.replace = plan.replace.map(({ items, ...row }) => row);
  slim.update = slim.replace;
  slim.add = plan.add.map((row) => ({ ...row }));
  slim.unchanged = plan.unchanged.map((row) => ({ ...row }));
  slim.ignored = plan.ignored.map((row) => ({ ...row }));
  slim.unmatched = [];
  slim.duplicateInput = [];
  slim.ambiguous = [];
  slim.githubDuplicate = [];
  slim.invalid = slim.ignored;
  return slim;
}

async function previewBulkQuarkLinks(rawText, defaultSection = "夸克批量新增") {
  const { panData } = await readGitHubPanSearchDataFile();
  return serializeQuarkBulkPlan(createQuarkBulkPlan(rawText, panData, defaultSection));
}

function refreshSearchTextForBulkQuark(item) {
  item.searchText = [item.title, item.section, item.context, item.code, item.platform, item.url].filter(Boolean).join(" ");
}

async function applyBulkQuarkLinks(rawText, defaultSection = "夸克批量新增") {
  const { config, ghPath, fileData, panData } = await readGitHubPanSearchDataFile();
  const plan = createQuarkBulkPlan(rawText, panData, defaultSection);
  const totalChanges = plan.summary.replace + plan.summary.add;
  if (!totalChanges) {
    return { ok: false, ...serializeQuarkBulkPlan(plan), message: "没有需要替换或新增的夸克链接，未提交 GitHub" };
  }

  plan.replace.forEach((row) => {
    row.items.forEach((item) => {
      const oldUrl = item.url || "";
      item.platform = "quark";
      item.url = row.newUrl;
      item.code = "";
      if (oldUrl) {
        item.context = replaceTextValue(item.context, oldUrl, row.newUrl);
        item.searchText = replaceTextValue(item.searchText, oldUrl, row.newUrl);
      } else {
        item.context = `夸克网盘批量导入：${item.title}`;
      }
      refreshSearchTextForBulkQuark(item);
    });
  });

  let nextId = getMaxPanResourceId(panData.items) + 1;
  plan.add.forEach((record) => {
    const item = createBulkQuarkNewItem(record, nextId, plan.defaultSection);
    nextId += 1;
    panData.items.push(item);
  });

  refreshPanSearchTotalsAfterReplacement(panData);
  const updatedContent = formatPanSearchData(panData);
  const putData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `Batch replace/add Quark pan links (${plan.summary.replace} replace, ${plan.summary.add} add)`,
      content: Buffer.from(updatedContent, "utf8").toString("base64"),
      sha: fileData.sha,
      branch: config.branch
    })
  });

  githubResourceSummaryCache = null;
  return {
    ok: true,
    ...serializeQuarkBulkPlan(plan),
    commitUrl: putData?.commit?.html_url || "",
    message: `已替换 ${plan.summary.replace} 条夸克资源，直接新增 ${plan.summary.add} 条夸克资源`

  };
}
async function syncExtraLinksToGitHub() {
  const config = assertGitHubConfig();
  const extraLinks = readExtraLinks();

  if (!extraLinks.length) {
    return { ok: true, added: 0, skipped: 0, message: "没有可同步的后台新增资料" };
  }

  const ghPath = encodeGitHubPath(config.dataPath);
  const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
  if (!fileData || fileData.type !== "file" || !fileData.sha) {
    throw new Error("GitHub 返回的 pan-search-data.js 文件信息不完整");
  }

  const currentContent = await readGitHubFileContent(fileData);
  const panData = extractPanSearchData(currentContent);
  panData.items = Array.isArray(panData.items) ? panData.items : [];

  const existingUrls = new Set(panData.items.map((item) => item.url).filter(Boolean));
  let nextId = getMaxPanResourceId(panData.items) + 1;
  const addedItems = [];
  const skippedItems = [];

  [...extraLinks].reverse().forEach((link) => {
    if (!link?.url || existingUrls.has(link.url)) {
      skippedItems.push(link);
      return;
    }
    const item = makeGitHubPanItem(link, nextId);
    nextId += 1;
    panData.items.push(item);
    existingUrls.add(item.url);
    addedItems.push(item);
  });

  if (!addedItems.length) {
    return { ok: true, added: 0, skipped: skippedItems.length, message: "GitHub 已包含这些链接，无需重复同步" };
  }

  refreshPanSearchTotals(panData, addedItems);
  const updatedContent = formatPanSearchData(panData);
  const commitMessage = `Sync ${addedItems.length} server pan links`;
  const putData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(updatedContent, "utf8").toString("base64"),
      sha: fileData.sha,
      branch: config.branch
    })
  });

  return {
    ok: true,
    added: addedItems.length,
    skipped: skippedItems.length,
    commitUrl: putData?.commit?.html_url || "",
    firstId: addedItems[0]?.id || "",
    lastId: addedItems[addedItems.length - 1]?.id || "",
    message: `已追加 ${addedItems.length} 条到 GitHub pan-search-data.js`

  };
}
function readFormBody(body) {
  const params = new URLSearchParams(body || "");
  return Object.fromEntries(params.entries());
}

function wantsJsonResponse(req) {
  const accept = String(req.headers.accept || "");
  const contentType = String(req.headers["content-type"] || "");
  return accept.includes("application/json") || contentType.includes("application/json");
}
function isAdminToken(token) {
  return Boolean(ADMIN_TOKEN && token === ADMIN_TOKEN);
}


function keyOf(value) {
  return String(value || "").trim().slice(0, 160) || "unknown";
}

function bump(bucket, key, extra = {}) {
  const id = keyOf(key);
  bucket[id] = bucket[id] || { count: 0, ...extra };
  bucket[id].count += 1;
  Object.assign(bucket[id], extra);
}

function buildPublicResourceInsights(stats) {
  const ranking = entryList(stats.clicks, 50)
    .filter((item) => item?.href && Number(item.count || 0) > 0)
    .map((item) => ({
      label: boundedText(item.label || item.text || "资料入口", 140),
      url: boundedText(item.href, 1024),
      count: Number(item.count || 0)
    }))
    .slice(0, 20);

  const latestByUrl = new Map();
  (stats.brokenLinks || []).forEach((item) => {
    const status = item?.resolvedAt ? "recovered" : "pending";
    const key = `${status}:${item?.url || ""}:${item?.replacementUrl || ""}`;
    const previous = latestByUrl.get(key);
    if (!previous || Number(item?.ts || 0) > Number(previous?.ts || 0)) latestByUrl.set(key, item);
  });

  const linkCare = [...latestByUrl.values()]
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0))
    .slice(0, 200)
    .map((item) => ({
      url: boundedText(item?.url || "", 1024),
      replacementUrl: boundedText(item?.replacementUrl || "", 1024),
      status: item?.resolvedAt ? "recovered" : "pending",
      updatedAt: item?.resolvedAt || item?.ts || null
    }));

  return {
    ok: true,
    ranking,
    linkCare,
    brokenSummary: {
      pending: (stats.brokenLinks || []).filter((item) => !item?.resolvedAt).length,
      recovered: (stats.brokenLinks || []).filter((item) => item?.resolvedAt).length
    },
    updatedAt: stats.updatedAt || null
  };
}
function updateStats(event) {
  const stats = readStats();
  const payload = event.payload || {};

  if (event.type === "site_view") {
    const dayKey = shanghaiDateKey(event.ts || Date.now());
    const visitorId = boundedText(payload.visitorId, 80);
    if (visitorId) { stats.dailyVisitors = stats.dailyVisitors || {}; const visitors = Array.isArray(stats.dailyVisitors[dayKey]) ? stats.dailyVisitors[dayKey] : []; if (!visitors.includes(visitorId)) visitors.push(visitorId); stats.dailyVisitors[dayKey] = visitors.slice(-50000); }
  }

  if (event.type === "search") {
    bump(stats.searches, payload.keyword, {
      lastMatched: Number(payload.matched || 0),
      lastQuark: Number(payload.quark || 0),
      lastBaidu: Number(payload.baidu || 0)
    });
    const dayKey = shanghaiDateKey(event.ts || Date.now());
    stats.dailySearches = stats.dailySearches && typeof stats.dailySearches === "object" ? stats.dailySearches : {};
  stats.dailyVisitors = stats.dailyVisitors && typeof stats.dailyVisitors === "object" ? stats.dailyVisitors : {};
    stats.dailySearches[dayKey] = Number(stats.dailySearches[dayKey] || 0) + 1;
    if (payload.noResult) bump(stats.noResults, payload.keyword);
  }

  if (event.type === "resource_click") {
    bump(stats.clicks, payload.label || payload.href, {
      href: payload.href || "",
      text: payload.text || ""
    });
  }

  if (event.type === "copy_link") {
    bump(stats.copies, payload.url, { query: payload.query || "" });
  }

  if (event.type === "broken_link") {
    const url = boundedText(payload.url, 1024);
    const duplicate = url && stats.brokenLinks.some((report) => !report?.resolvedAt && report?.url === url);
    if (!duplicate) {
      stats.brokenLinks.unshift({
        title: boundedText(payload.title, 512),
        url,
        platform: boundedText(payload.platform, 32),
        query: boundedText(payload.query, 256),
        source: "user-confirmed",
        reason: "User confirmed the share page explicitly showed invalid, deleted, or unavailable.",
        ts: event.ts || Date.now()
      });
      stats.brokenLinks = stats.brokenLinks.slice(0, 500);
    }
  }
  writeStats(stats);
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function send(res, req, status, data, headers = {}) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function sendHtml(res, req, status, html, headers = {}) {
  setCors(req, res);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(html);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > 1024 * 1024) {
        reject(new Error("Payload too large: max 1MB"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function entryList(bucket, limit = 20) {
  return Object.entries(bucket || {})
    .map(([label, data]) => ({ label, ...(data || {}), count: Number(data?.count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function countAll(bucket) {
  return Object.values(bucket || {}).reduce((sum, data) => sum + Number(data?.count || 0), 0);
}

function formatTime(value) {
  if (!value) return "-";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

function renderSearchPeriodCard(period) {
  return `
        <section class="summary-card search-period-card">
          <div class="period-card-head"><div><h3>搜索周期</h3><p>按 Asia/Shanghai 统计</p></div><small>从 2026-08-07 开始记录</small></div>
          <div class="search-period-metrics">
            <div class="period-metric is-today"><span>今日</span><strong>${period.today}</strong></div>
            <div class="period-metric is-change"><span>较昨日</span><strong style="color:${period.change.color}">${escapeHtml(period.change.text)}</strong></div>
            <div class="period-metric"><span>昨日</span><strong>${period.yesterday}</strong></div>
            <div class="period-metric"><span>本周</span><strong>${period.week}</strong></div>
            <div class="period-metric"><span>本月</span><strong>${period.month}</strong></div>
          </div>
          <p class="period-card-note">累计搜索在顶部保留；今日 ${escapeHtml(period.todayKey)}，本周从 ${escapeHtml(period.weekStartKey)} 起。</p>
          ${renderSearchCalendar(period)}
        </section>
  `;
}
function renderBrokenFeedbackAlert(unresolvedBroken) { if (!unresolvedBroken.length) return ""; const latestKey = `${unresolvedBroken.length}:${Math.max(...unresolvedBroken.map((item) => Number(item.ts || 0)))}`; const preview = unresolvedBroken.slice(0, 3).map((item) => `<li><strong>${escapeHtml(item.title || item.url || "未命名资源")}</strong><span>${escapeHtml(formatTime(item.ts))}</span></li>`).join(""); return `<input class="broken-alert-toggle" id="broken-alert-dismiss" type="checkbox" aria-hidden="true" /><section class="broken-alert-backdrop" data-alert-key="${escapeHtml(latestKey)}" role="dialog" aria-modal="true" aria-labelledby="broken-alert-title"><div class="broken-alert-modal"><label class="broken-alert-close" for="broken-alert-dismiss" aria-label="关闭提醒">×</label><span class="broken-alert-icon" aria-hidden="true">!</span><p class="broken-alert-eyebrow">有新的待处理事项</p><h2 id="broken-alert-title">收到 ${unresolvedBroken.length} 条失效反馈</h2><p class="broken-alert-copy">已看过的反馈不会再次弹出；收到新的失效反馈时会重新提醒。</p><ul class="broken-alert-list">${preview}</ul><div class="broken-alert-actions"><button class="btn" type="button" onclick="window.location.hash=&quot;broken-links&quot;">立即处理</button><label class="btn secondary" for="broken-alert-dismiss">关闭提醒</label></div></div></section>`; }

function renderRows(rows, options = {}) {
  if (!rows.length) {
    return `<div class="empty">暂无数据</div>`;
  }

  return rows
    .map((item, index) => {
      const meta = [];
      if (item.lastMatched !== undefined) meta.push(`匹配 ${item.lastMatched} 条`);
      if (item.lastQuark !== undefined) meta.push(`夸克 ${item.lastQuark}`);
      if (item.lastBaidu !== undefined) meta.push(`百度 ${item.lastBaidu}`);
      if (item.text) meta.push(item.text);
      if (item.query) meta.push(`搜索词：${item.query}`);
      return `
        <article class="stat-row">
          <div class="rank">${index + 1}</div>
          <div class="stat-main">
            <strong>${escapeHtml(item.label)}</strong>
            ${meta.length ? `<p>${escapeHtml(meta.join(" · "))}</p>` : ""}
            ${item.href ? `<a href="${escapeHtml(item.href)}" target="_blank" rel="noopener noreferrer">打开链接</a>` : ""}
          </div>
          <span class="count">${item.count}</span>
        </article>
      `;
    })
    .join("");
}

function renderBrokenLinks(items, token) {
  if (!items.length) return `<div class="empty">暂无反馈</div>`;

  return items.slice(0, 80).map((item, index) => {
    const resolved = Boolean(item.resolvedAt);
    const meta = [
      item.platform,
      item.query ? `搜索词：${item.query}` : "",
      formatTime(item.ts)
    ].filter(Boolean).join(" · ");

    return `
    <article class="stat-row broken-row ${resolved ? "is-resolved" : ""}">
      <div class="rank">${index + 1}</div>
      <div class="stat-main">
        <strong>${escapeHtml(item.title || item.url || "未命名资源")}</strong>
        <p>${escapeHtml(meta)}</p>
        ${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">打开原链接检查</a>` : ""}
        ${resolved ? `
          <div class="resolved-box">
            <strong>${item.resolution === "removed" ? "已下架" : "已处理"}</strong>
            ${item.resolution === "removed"
              ? `<p>原失效链接已从公开搜索中移除，不会再被搜到。</p>`
              : `<p>新链接：<a href="${escapeHtml(item.replacementUrl || "")}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.replacementUrl || "-")}</a></p>`}
            <p>处理时间：${escapeHtml(formatTime(item.resolvedAt))}</p>
          </div>
        ` : `
          <form class="replace-form" method="post" action="/admin/replace-broken-link">
            <input type="hidden" name="oldUrl" value="${escapeHtml(item.url || "")}" />
            <input type="hidden" name="title" value="${escapeHtml(item.title || "")}" />
            <input type="hidden" name="oldPlatform" value="${escapeHtml(item.platform || "")}" />
            <label>新链接<input name="newUrl" type="url" required placeholder="https://pan.quark.cn/s/..." /></label>
            <label>平台<select name="platform"><option value="">自动识别</option><option value="quark">夸克</option><option value="baidu">百度</option></select></label>
            <button type="submit">替换并标记已处理</button>
            ${item.url ? `<div class="replace-actions"><button class="remove-link" type="submit" formaction="/admin/remove-broken-link" formmethod="post" formnovalidate onclick="return confirm('确认原链接已经由批量更新替换？此操作会将旧链接从公开搜索中移除。')">原链接已批量更新，不再搜索</button><small>不填新链接，只下架这一条旧链接。</small></div>` : ""}
          </form>
        `}
      </div>
    </article>
  `;
  }).join("");
}
function renderLinkHealthPanel(stats, notice = {}) {
  const health = Object.values(stats.linkHealth || {});
  const hidden = health.filter((item) => item?.status === "hidden");
  const suspected = health.filter((item) => item?.status === "suspected");
  const userConfirmed = (stats.brokenLinks || []).filter((item) => item?.source === "user-confirmed" && !item?.resolvedAt);
  const statusMessage = notice.healthMessage ? `<p class="hint" style="margin:14px 0 0"><strong>${escapeHtml(notice.healthStatus === "ok" ? "\u521d\u7b5b\u5b8c\u6210\uff1a" : "\u521d\u7b5b\u672a\u5b8c\u6210\uff1a")}</strong>${escapeHtml(notice.healthMessage)}</p>` : "";
  const hiddenList = hidden.slice(0, 5).map((item) => `<li><strong>${escapeHtml(item.title || item.url)}</strong><small>${escapeHtml(item.platform)} \u00b7 ${escapeHtml(formatTime(item.hiddenAt || item.lastCheckedAt))}</small></li>`).join("");
  return `
    <section class="panel manager" style="margin-bottom:16px">
      <header><h2>\u7f51\u76d8\u94fe\u63a5\u81ea\u52a8\u521d\u7b5b</h2><small>\u6bcf 6 \u5c0f\u65f6\u4f4e\u9891\u62bd\u68c0 ${LINK_HEALTH_BATCH_SIZE} \u6761</small></header>
      <p class="hint">\u53ea\u5728\u9875\u9762\u51fa\u73b0\u660e\u786e\u7684\u201c\u5206\u4eab\u5931\u6548\u3001\u6587\u4ef6\u5df2\u5220\u9664\u6216\u94fe\u63a5\u4e0d\u5b58\u5728\u201d\u63d0\u793a\u65f6\uff0c\u624d\u5224\u4e3a\u5931\u6548\uff1b\u8fde\u7eed\u4e24\u6b21\u786e\u8ba4\u540e\u624d\u4ece\u516c\u5f00\u641c\u7d22\u9690\u85cf\u3002\u9a8c\u8bc1\u7801\u3001\u98ce\u63a7\u3001\u9650\u6d41\u548c\u7f51\u7edc\u8d85\u65f6\u5747\u4f1a\u8df3\u8fc7\uff0c\u4e0d\u4f1a\u5236\u9020\u4eba\u5de5\u5f85\u529e\u3002</p>
      <div class="quick-stats" style="margin-top:16px">
        <div class="quick-stat"><span>\u5df2\u9690\u85cf\u5f85\u8865\u94fe</span><strong>${hidden.length}</strong></div>
        <div class="quick-stat"><span>\u9996\u6b21\u7591\u4f3c\u5931\u6548</span><strong>${suspected.length}</strong></div>
        <div class="quick-stat"><span>\u7528\u6237\u786e\u8ba4\u5f85\u8865\u94fe</span><strong>${userConfirmed.length}</strong></div>
      </div>
      <form method="post" action="/admin/check-pan-links" style="padding-top:16px"><button type="submit">\u8fd0\u884c\u4e0b\u4e00\u6279\u521d\u7b5b ${LINK_HEALTH_BATCH_SIZE} \u6761\u94fe\u63a5</button></form>
      <p class="hint">\u4e0a\u6b21\u521d\u7b5b\uff1a${escapeHtml(formatTime(stats.linkHealthLastCheckAt))}\u3002\u7cfb\u7edf\u4f1a\u6309\u987a\u5e8f\u8f6e\u6362\u68c0\u67e5\uff0c\u4e0d\u4f1a\u4e00\u6b21\u6027\u9ad8\u9891\u8bbf\u95ee\u5168\u90e8\u7f51\u76d8\u94fe\u63a5\u3002</p>
      ${statusMessage}
      ${hiddenList ? `<ul class="broken-alert-list" style="margin:16px 0 0">${hiddenList}</ul>` : ""}
    </section>`;
}function renderAdminLogin(message = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/svg+xml" href="https://study.202510319.xyz/assets/favicon.svg?v=20260804-admin" />
  <title>学习资源库统计后台</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#eef6ff;color:#102033}.card{width:min(480px,calc(100vw - 32px));padding:30px;border:1px solid #d8e6f3;border-radius:24px;background:rgba(255,255,255,.9);box-shadow:0 28px 70px rgba(23,70,120,.14)}h1{margin:0 0 10px;font-size:30px}p{color:#66758a}input{box-sizing:border-box;width:100%;height:52px;border:1px solid #cbdcec;border-radius:14px;padding:0 14px;font-size:16px}button{height:48px;margin-top:14px;padding:0 20px;border:0;border-radius:14px;background:#007aff;color:white;font-weight:800;font-size:16px}.err{color:#ef4444;font-weight:700}
  </style>
</head>
<body>
  <form class="card" method="get" action="/admin">
    <h1>统计后台</h1>
    <p>输入服务器 .env 里的 ADMIN_TOKEN。</p>
    ${message ? `<p class="err">${escapeHtml(message)}</p>` : ""}
    <input name="token" type="password" placeholder="ADMIN_TOKEN" autofocus />
    <button type="submit">进入后台</button>
  </form>
</body>
</html>`;
}

function renderSyncNotice(notice = {}) {
  if (!notice.status) return "";
  const ok = notice.status === "ok";
  const parts = [];
  if (notice.message) parts.push(notice.message);
  if (notice.added !== "") parts.push(`追加 ${notice.added} 条`);
  if (notice.skipped !== "") parts.push(`跳过 ${notice.skipped} 条`);
  return `
    <div class="sync-notice ${ok ? "ok" : "error"}">
      <strong>${ok ? "同步完成" : "同步失败"}</strong>
      <p>${escapeHtml(parts.filter(Boolean).join("，") || (ok ? "已同步到 GitHub" : "请检查 GitHub Token 和仓库权限"))}</p>
      ${notice.commit ? `<a href="${escapeHtml(notice.commit)}" target="_blank" rel="noopener noreferrer">查看 GitHub 提交</a>` : ""}
    </div>
  `;
}
function renderReplaceNotice(notice = {}) {
  if (!notice.replaceStatus) return "";
  const ok = notice.replaceStatus === "ok";
  const removed = notice.replaceAction === "removed";
  return `
    <div class="replace-notice ${ok ? "ok" : "error"}">
      <strong>${ok ? (removed ? "原链接已下架" : "补链替换完成") : (removed ? "原链接下架失败" : "补链替换失败")}</strong>
      <p>${escapeHtml(notice.replaceMessage || (ok ? (removed ? "原链接已从公开搜索中移除" : "已替换 GitHub 链接并标记反馈") : "请检查 GitHub Token 或原链接是否仍存在"))}</p>
      ${notice.replaceCommit ? `<a href="${escapeHtml(notice.replaceCommit)}" target="_blank" rel="noopener noreferrer">查看 GitHub 提交</a>` : ""}
    </div>
  `;
}
let githubResourceSummaryCache = null;

function percentage(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(value || 0) / total) * 100)));
}

function summarizePanSearchData(panData) {
  const items = Array.isArray(panData.items) ? panData.items : [];
  const platform = { quark: 0, baidu: 0, other: 0 };
  const categories = new Map();

  items.forEach((item) => {
    const platformKey = item?.platform === "baidu" ? "baidu" : item?.platform === "quark" ? "quark" : "other";
    platform[platformKey] += 1;
    const category = String(item?.section || "未分类").trim() || "未分类";
    categories.set(category, (categories.get(category) || 0) + 1);
  });

  const categoryRows = [...categories.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    total: items.length,
    platform,
    categories: {
      total: categories.size,
      top: categoryRows.slice(0, 8)
    }
  };
}

async function getGitHubResourceSummary() {
  const now = Date.now();
  if (githubResourceSummaryCache && now - githubResourceSummaryCache.cachedAt < 5 * 60 * 1000) {
    return githubResourceSummaryCache.value;
  }

  try {
    const config = assertGitHubConfig();
    const ghPath = encodeGitHubPath(config.dataPath);
    const fileData = await githubRequest(`/repos/${config.owner}/${config.repo}/contents/${ghPath}?ref=${encodeURIComponent(config.branch)}`);
    const content = await readGitHubFileContent(fileData);
    const panData = extractPanSearchData(content);
    const summary = summarizePanSearchData(panData);
    githubResourceSummaryCache = { cachedAt: now, value: summary };
    return summary;
  } catch (error) {
    const summary = {
      ok: false,
      fetchedAt: new Date().toISOString(),
      total: 0,
      platform: { quark: 0, baidu: 0, other: 0 },
      categories: { total: 0, top: [] },
      error: error.message || "GitHub 数据读取失败"
    };
    githubResourceSummaryCache = { cachedAt: now, value: summary };
    return summary;
  }
}

function renderHorizontalBar(label, count, total, className = "") {
  const pct = percentage(count, total);
  return `
    <div class="viz-row ${className}">
      <div class="viz-row-head"><strong>${escapeHtml(label)}</strong><span>${count} · ${pct}%</span></div>
      <div class="viz-track"><i style="width:${pct}%"></i></div>
    </div>
  `;
}

function renderPlatformChart(summary) {
  if (!summary?.ok) return `<div class="viz-state error">GitHub 资源统计读取失败：${escapeHtml(summary?.error || "未知错误")}</div>`;
  const total = Number(summary.total || 0);
  const quark = Number(summary.platform?.quark || 0);
  const baidu = Number(summary.platform?.baidu || 0);
  const other = Number(summary.platform?.other || 0);
  const quarkPct = percentage(quark, total);
  const baiduPct = percentage(baidu, total);
  const otherPct = Math.max(0, 100 - quarkPct - baiduPct);
  return `
    <div class="platform-chart" aria-label="资源平台占比">
      <div class="stack-bar"><span class="quark" style="width:${quarkPct}%"></span><span class="baidu" style="width:${baiduPct}%"></span><span class="other" style="width:${otherPct}%"></span></div>
      ${renderHorizontalBar("夸克", quark, total, "quark")}
      ${renderHorizontalBar("百度", baidu, total, "baidu")}
      ${other ? renderHorizontalBar("其他", other, total, "other") : ""}
    </div>
  `;
}

function renderCategoryChart(summary) {
  if (!summary?.ok) return `<div class="viz-state error">分类统计暂不可用</div>`;
  const rows = summary.categories?.top || [];
  if (!rows.length) return `<div class="viz-state">暂无分类数据</div>`;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return rows.map((row) => renderHorizontalBar(row.label, row.count, max)).join("");
}

function renderFeedbackChart(unresolved, resolved) {
  const total = Number(unresolved || 0) + Number(resolved || 0);
  return `
    <div class="feedback-chart">
      ${renderHorizontalBar("待处理", unresolved, total, "warning")}
      ${renderHorizontalBar("已处理", resolved, total, "success")}
    </div>
  `;
}
function renderBulkDetailRows(title, rows, type = "") {
  const list = Array.isArray(rows) ? rows.slice(0, 12) : [];
  if (!list.length) return "";
  return `
    <details class="bulk-details ${escapeHtml(type)}" open>
      <summary>${escapeHtml(title)}（显示 ${list.length} 条）</summary>
      <div class="bulk-detail-list">
        ${list.map((row) => {
          const urls = Array.isArray(row.urls) ? row.urls : [row.newUrl || row.url].filter(Boolean);
          return `
            <article class="bulk-detail-row">
              <strong>${escapeHtml(row.title || "未识别标题")}</strong>
              <p>${escapeHtml(row.reason || [row.oldUrl, row.newUrl || row.url].filter(Boolean).join(" → "))}</p>
              ${urls.slice(0, 4).map((item) => `<code>${escapeHtml(item)}</code>`).join("")}
              ${urls.length > 4 ? `<p>另有 ${urls.length - 4} 条链接未展开</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </details>
  `;
}

function renderBulkBaiduResult(notice = {}) {
  const plan = notice.bulkPlan;
  if (!plan) return "";
  const status = notice.bulkStatus || "preview";
  const ok = status === "applied";
  const failed = status === "error";
  const summary = plan.summary || { raw: 0, uniqueTitles: 0, replace: 0, add: 0, unchanged: 0, inputDuplicate: 0, targetDuplicate: 0, unmatchedTarget: 0, ignored: 0 };
  const executableChanges = Number(summary.replace || 0) + Number(summary.add || 0);
  const confirmation = status === "preview"
    ? executableChanges > 0
      ? `
        <form method="post" action="/admin/bulk-baidu-apply" class="bulk-confirm-form">
          <input type="hidden" name="confirm" value="1" />
          <input type="hidden" name="defaultSection" value="${escapeHtml(notice.bulkDefaultSection || plan.defaultSection || "百度批量新增")}" />
          <textarea name="rawText" hidden>${escapeHtml(notice.bulkRawText || "")}</textarea>
          <button type="submit">确认执行：替换 ${summary.replace || 0} 条，新增 ${summary.add || 0} 条</button>
        </form>
      `
      : `<p class="bulk-noop">本次没有可提交的更新：${summary.unchanged || 0} 条链接已是当前版本，${summary.unmatchedTarget || 0} 条旧资料未配对而保持不变。请粘贴实际更新后的百度链接再预览。</p>`
    : "";
  return `
    <div class="bulk-result ${ok ? "ok" : failed ? "error" : "preview"}" id="bulk-preview-result">
      <div class="bulk-result-head">
        <div>
          <strong>${ok ? "批量更新完成" : failed ? "批量处理失败" : "预览结果"}</strong>
          <p>${escapeHtml(notice.bulkMessage || (ok ? "已提交到 GitHub" : failed ? "请检查文本格式或 GitHub 配置" : "确认无误后再提交，预览不会修改 GitHub。"))}</p>
          ${notice.bulkCommit ? `<a href="${escapeHtml(notice.bulkCommit)}" target="_blank" rel="noopener noreferrer">查看 GitHub 提交</a>` : ""}
        </div>
      </div>
      <div class="bulk-counts">
        <div><span>原始链接</span><strong>${summary.raw ?? summary.parsed ?? 0}</strong></div>
        <div><span>不同标题</span><strong>${summary.uniqueTitles ?? summary.parsed ?? 0}</strong></div>
        <div><span>安全替换</span><strong>${summary.replace || 0}</strong></div>
        <div><span>无变化</span><strong>${summary.unchanged || 0}</strong></div>
        <div><span>直接新增</span><strong>${summary.add || 0}</strong></div>
        <div><span>输入同名组</span><strong>${summary.inputDuplicate || 0}</strong></div>
        <div><span>网站同名组</span><strong>${summary.targetDuplicate || 0}</strong></div>
        <div><span>未配对旧资料</span><strong>${summary.unmatchedTarget || 0}</strong></div>
        <div><span>已忽略</span><strong>${summary.ignored || 0}</strong></div>
      </div>
      ${summary.unmatchedTarget ? `<p class="hint" style="padding:0 0 4px">有 ${summary.unmatchedTarget} 条网站旧资料没有对应的新链接，因此本次保持不变；其余同名资料均会按链接优先、再按顺序逐条更新。</p>` : ""}
      ${confirmation}
      ${renderBulkDetailRows("替换", plan.replace || plan.update, "update")}
      ${renderBulkDetailRows("无变化", plan.unchanged, "unchanged")}
      ${renderBulkDetailRows("直接新增", plan.add, "update")}
      ${renderBulkDetailRows("输入同名（逐条处理）", plan.inputDuplicate || plan.duplicateInput, "update")}
      ${renderBulkDetailRows("网站同名（逐条处理）", plan.targetDuplicate || plan.ambiguous, "update")}
      ${renderBulkDetailRows("未配对旧资料（保持不变）", plan.unmatchedTarget || plan.unmatched, "error")}
      ${renderBulkDetailRows("已忽略", plan.ignored || plan.invalid, "error")}
    </div>
  `;
}

function renderBulkBaiduPanel(notice = {}) {
  return `
    <section class="panel manager bulk-manager" id="bulk-baidu-update" style="margin-top:18px">
      <header><h2>批量更新百度链接</h2><small>粘贴标题 + 链接 + 提取码，先预览再确认</small></header>
      <form method="post" action="/admin/bulk-baidu-preview" class="bulk-form">
        <label>新增默认分类
          <input name="defaultSection" value="${escapeHtml(notice.bulkDefaultSection || "百度批量新增")}" placeholder="百度批量新增" />
        </label>
        <label class="full">完整文本
          <textarea name="rawText" required placeholder="例如：\n2025 下半年资料\n链接：https://pan.baidu.com/s/xxxx\n提取码：abcd">${escapeHtml(notice.bulkRawText || "")}</textarea>
        </label>
        <div class="full"><button type="submit">预览替换/新增</button></div>
      </form>
      <p class="hint">只会按标准化标题匹配 GitHub 中 <code>platform=baidu</code> 的资源。同标题会优先识别链接无变化，再将剩余新链接和旧资料按顺序逐条覆盖；新链接更多时，超出的链接作为独立资料新增。网站旧资料更多时，未配对项保持不变并在预览中提示。确认后一次 GitHub commit，不会修改夸克资源。</p>
      ${renderBulkBaiduResult(notice)}
    </section>
  `;
}

function renderBulkQuarkResult(notice = {}) {
  const plan = notice.quarkBulkPlan;
  if (!plan) return "";
  const status = notice.quarkBulkStatus || "preview";
  const ok = status === "applied";
  const failed = status === "error";
  const summary = plan.summary || { parsed: 0, replace: 0, add: 0, unchanged: 0, ignored: 0 };
  return `
    <div class="bulk-result ${ok ? "ok" : failed ? "error" : "preview"}" id="bulk-quark-preview-result">
      <div class="bulk-result-head">
        <div>
          <strong>${ok ? "批量更新完成" : failed ? "批量处理失败" : "预览结果"}</strong>
          <p>${escapeHtml(notice.quarkBulkMessage || (ok ? "已提交到 GitHub" : failed ? "请检查文本格式或 GitHub 配置" : "确认无误后再提交，预览不会修改 GitHub。"))}</p>
          ${notice.quarkBulkCommit ? `<a href="${escapeHtml(notice.quarkBulkCommit)}" target="_blank" rel="noopener noreferrer">查看 GitHub 提交</a>` : ""}
        </div>
      </div>
      <div class="bulk-counts">
        <div><span>识别</span><strong>${summary.parsed || 0}</strong></div>
        <div><span>替换</span><strong>${summary.replace || 0}</strong></div>
        <div><span>无变化</span><strong>${summary.unchanged || 0}</strong></div>
        <div><span>直接新增</span><strong>${summary.add || 0}</strong></div>
        <div><span>已忽略</span><strong>${summary.ignored || 0}</strong></div>
      </div>
      ${renderBulkDetailRows("替换", plan.replace || plan.update, "update")}
      ${renderBulkDetailRows("无变化", plan.unchanged, "unchanged")}
      ${renderBulkDetailRows("直接新增", plan.add, "update")}
      ${renderBulkDetailRows("已忽略", plan.ignored || plan.invalid, "error")}
      ${status === "preview" && (Number(summary.replace || 0) + Number(summary.add || 0)) > 0 ? `
        <form method="post" action="/admin/bulk-quark-apply" class="bulk-confirm-form">
          <input type="hidden" name="confirm" value="1" />
          <input type="hidden" name="defaultSection" value="${escapeHtml(notice.quarkBulkDefaultSection || plan.defaultSection || "夸克批量新增")}" />
          <textarea name="rawText" hidden>${escapeHtml(notice.quarkBulkRawText || "")}</textarea>
          <button type="submit">确认执行：替换 ${summary.replace || 0} 条，新增 ${summary.add || 0} 条</button>
        </form>
      ` : ""}
    </div>
  `;
}

function renderBulkQuarkPanel(notice = {}) {
  return `
    <section class="panel manager bulk-manager" id="bulk-quark-update" style="margin-top:18px">
      <header><h2>批量更新夸克链接</h2><small>粘贴标题 + 夸克链接，先预览再确认</small></header>
      <form method="post" action="/admin/bulk-quark-preview" class="bulk-form">
        <label>新增默认分类
          <input name="defaultSection" value="${escapeHtml(notice.quarkBulkDefaultSection || "夸克批量新增")}" placeholder="夸克批量新增" />
        </label>
        <label class="full">完整文本
          <textarea name="rawText" required placeholder="例如：\n行测申论】2027超格资料\n链接：https://pan.quark.cn/s/xxxx\n\n【公考资料】2027资料合集\n链接：https://pan.quark.cn/s/yyyy">${escapeHtml(notice.quarkBulkRawText || "")}</textarea>
        </label>
        <div class="full"><button type="submit">预览替换/新增</button></div>
      </form>
      <p class="hint">只会按标准化完整标题匹配 GitHub 中 <code>platform=quark</code> 的资源；同名多条会全部替换，没有同名会直接新增，重复导入按最后一条生效。新增资料默认分类为 <code>夸克批量新增</code>，确认后一次 GitHub commit，不会修改百度资源。</p>
      ${renderBulkQuarkResult(notice)}
    </section>
  `;
}
function renderDriftBottleReview(bottles, notice = {}) {
  const pending = bottles.filter((item) => item.status === "pending");
  const approved = bottles.filter((item) => item.status === "approved");
  const deleted = bottles.filter((item) => item.status === "deleted");
  const renderItem = (item, index) => `<article class="stat-row broken-row"><div class="rank">${index + 1}</div><div class="stat-main"><strong>${escapeHtml(item.message)}</strong><p>投递于 ${escapeHtml(formatTime(item.createdAt))}</p>${item.status === "pending" ? `<form method="post" action="/admin/drift-bottles/review" class="actions" style="margin-top:10px"><input type="hidden" name="id" value="${escapeHtml(item.id)}" /><button type="submit" name="action" value="approve" style="background:linear-gradient(180deg,#34d399,#059669)">通过公开</button><button type="submit" name="action" value="delete" style="background:#fff;color:#b91c1c;border:1px solid #fecaca">删除</button></form>` : `<p>${item.status === "approved" ? "已公开" : "已删除"}${item.reviewedAt ? ` · ${escapeHtml(formatTime(item.reviewedAt))}` : ""}</p>`}</div></article>`;
  return `
    <section class="admin-section" id="drift-bottles" data-section="drift">
      <div class="section-lead"><div><h2>漂流瓶审核</h2><p>前台匿名留言会先进入这里；只有“通过公开”的内容才会在首页漂流。</p></div></div>
      <div class="summary-grid" style="margin-bottom:16px"><section class="summary-card"><h3>审核队列</h3><p>待审核 <strong>${pending.length}</strong> 条，已公开 <strong>${approved.length}</strong> 条，已删除 <strong>${deleted.length}</strong> 条。</p><div class="quick-stats"><div class="quick-stat"><span>待审核</span><strong>${pending.length}</strong></div><div class="quick-stat"><span>已公开</span><strong>${approved.length}</strong></div><div class="quick-stat"><span>已删除</span><strong>${deleted.length}</strong></div></div></section></div>
      <section class="panel"><header><h2>待审核留言</h2><small>通过后首页会自动读取</small></header><div class="list">${pending.length ? pending.map(renderItem).join("") : `<div class="empty">当前没有待审核的漂流瓶</div>`}</div></section>
      <section class="panel" style="margin-top:16px"><header><h2>最近已公开</h2><small>最近 12 条</small></header><div class="list">${approved.slice(0, 12).map(renderItem).join("") || `<div class="empty">还没有公开的漂流瓶</div>`}</div></section>
      ${notice.drift === "approved" ? '<p class="hint" style="color:#047857"><strong>已通过公开，首页将在下一次读取时展示。</strong></p>' : notice.drift === "deleted" ? '<p class="hint" style="color:#b91c1c"><strong>该漂流瓶已删除，不会公开展示。</strong></p>' : ""}
    </section>`;
}
function renderAdminPage(stats, token, notice = {}, resourceSummary = null) {
  const searches = entryList(stats.searches, 30);
  const noResults = entryList(stats.noResults, 30);
  const clicks = entryList(stats.clicks, 40);
  const copies = entryList(stats.copies, 30);
  const brokenLinks = Array.isArray(stats.brokenLinks) ? stats.brokenLinks : [];
  const unresolvedBroken = brokenLinks.filter((item) => !item?.resolvedAt);
  const resolvedBroken = brokenLinks.filter((item) => item?.resolvedAt);
  const extraLinks = readExtraLinks();
  const githubConfigured = Boolean(GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO && GITHUB_BRANCH && GITHUB_DATA_PATH);
  const resourceOk = Boolean(resourceSummary?.ok);
  const resourceTotal = Number(resourceSummary?.total || 0);
  const quarkTotal = Number(resourceSummary?.platform?.quark || 0);
  const baiduTotal = Number(resourceSummary?.platform?.baidu || 0);
  const categoryTotal = Number(resourceSummary?.categories?.total || 0);
  const searchTotal = countAll(stats.searches);
  const searchPeriod = getSearchPeriodStats(stats);
  const noResultTotal = countAll(stats.noResults);
  const clickTotal = countAll(stats.clicks);
  const copyTotal = countAll(stats.copies);
  const siteNotice = readSiteNotice();
  const shoreLetter = readShoreLetter();
  const driftBottles = readDriftBottles();
  const pendingDriftBottleCount = driftBottles.filter((item) => item.status === "pending").length;
  const announcementSaved = notice.announcement === "ok";
  const shoreLetterSaved = notice.shoreLetter === "ok";

  const cards = [
    ["资源总数", resourceOk ? resourceTotal : "读取失败"],
    ["夸克资源", resourceOk ? quarkTotal : "-"],
    ["百度资源", resourceOk ? baiduTotal : "-"],
    ["分类数量", resourceOk ? categoryTotal : "-"],
    ["待处理失效", unresolvedBroken.length],
    ["累计搜索次数", searchTotal],
    ["今日访问人数", (stats.dailyVisitors?.[shanghaiDateKey(Date.now())] || []).length]
  ];
  const overviewBroken = unresolvedBroken.slice(0, 5);
  const adminDefaultTab = notice.adminDefaultTab || (notice.drift ? "drift" : ((notice.bulkPlan || notice.quarkBulkPlan) ? "supplement" : "overview"));
  const adminScrollTarget = notice.adminScrollTarget || (notice.quarkBulkPlan ? "bulk-quark-preview-result" : notice.bulkPlan ? "bulk-preview-result" : "");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="icon" type="image/svg+xml" href="https://study.202510319.xyz/assets/favicon.svg?v=20260804-admin" />
  <meta name="robots" content="noindex,nofollow" />
  <title>学习资源库统计后台</title>
  <style>
    :root{color-scheme:light;--bg:#eef6ff;--card:rgba(255,255,255,.9);--line:#d9e7f3;--text:#102033;--muted:#66758a;--blue:#007aff;--green:#10b981;--red:#ef4444;--shadow:0 24px 80px rgba(23,70,120,.13)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:radial-gradient(circle at top left,#dff3ff,transparent 32%),linear-gradient(180deg,#f8fcff,#edf6ff);color:var(--text)}.wrap{width:min(1180px,calc(100vw - 28px));margin:18px auto 56px}.hero,.panel,.metric,.admin-nav{border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow);backdrop-filter:blur(18px)}.hero{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:20px 22px;border-radius:24px}.hero h1{margin:0;font-size:clamp(26px,4vw,40px);letter-spacing:0}.hero p{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.6}.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 15px;border-radius:13px;text-decoration:none;font-weight:850;color:white;background:linear-gradient(180deg,#37b7ff,#007aff);white-space:nowrap}.btn.secondary{color:var(--text);background:#fff;border:1px solid var(--line)}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:14px 0}.metric{padding:14px 16px;border-radius:18px}.metric span{color:var(--muted);font-weight:800;font-size:13px}.metric strong{display:block;margin-top:6px;font-size:28px}.admin-nav{position:sticky;top:0;z-index:20;display:flex;gap:10px;align-items:center;margin:14px 0 18px;padding:10px;border-radius:20px;overflow-x:auto;scrollbar-width:none}.admin-nav::-webkit-scrollbar{display:none}.admin-nav a{display:inline-flex;align-items:center;justify-content:center;min-height:38px;padding:0 16px;border-radius:14px;color:#475569;text-decoration:none;font-weight:900;white-space:nowrap}.admin-nav a.is-active{background:#007aff;color:#fff;box-shadow:0 10px 24px rgba(0,122,255,.24)}.admin-section{display:none}.admin-section.is-active{display:block}.section-lead{display:flex;justify-content:space-between;gap:14px;align-items:end;margin:0 0 14px}.section-lead h2{margin:0;font-size:28px}.section-lead p{margin:6px 0 0;color:var(--muted);line-height:1.6}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.panel{border-radius:24px;overflow:hidden}.panel header{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:10px;align-items:center}.panel h2{margin:0;font-size:21px}.panel small{color:var(--muted);font-weight:800}.list{padding:12px}.stat-row{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:center;padding:13px;border-radius:16px}.stat-row:nth-child(odd){background:rgba(235,246,255,.78)}.rank{width:32px;height:32px;border-radius:11px;display:grid;place-items:center;background:#e0f2fe;color:#007aff;font-weight:900}.stat-main{min-width:0}.stat-main strong{display:block;font-size:15px;line-height:1.35;word-break:break-word}.stat-main p{margin:6px 0 0;color:var(--muted);font-size:13px;line-height:1.5}.stat-main a{display:inline-flex;margin-top:8px;color:var(--blue);font-weight:850;text-decoration:none}.count{min-width:40px;height:32px;padding:0 10px;border-radius:11px;display:grid;place-items:center;background:#007aff;color:white;font-weight:900}.empty{padding:28px;text-align:center;color:var(--muted);font-weight:800}.wide{grid-column:1/-1}.manager{margin:0}.manager form{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:20px}.manager label{display:grid;gap:7px;color:var(--muted);font-size:13px;font-weight:850}.manager input,.manager select,.manager textarea{width:100%;border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--text);font:inherit;padding:12px}.manager textarea{min-height:82px;resize:vertical}.manager .full{grid-column:1/-1}.manager button{width:max-content;min-height:44px;border:0;border-radius:14px;background:linear-gradient(180deg,#37b7ff,#007aff);color:#fff;font-weight:900;padding:0 18px}.hint{padding:0 20px 20px;color:var(--muted);font-size:13px;line-height:1.7}.broken-row{grid-template-columns:40px minmax(0,1fr)}.replace-form{display:grid;grid-template-columns:minmax(0,1fr)160px auto;gap:10px;align-items:end;margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.72)}.replace-form label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:900}.replace-form input,.replace-form select{width:100%;height:42px;border:1px solid var(--line);border-radius:12px;background:#fff;color:var(--text);font:inherit;padding:0 12px}.replace-form button{height:42px;border:0;border-radius:12px;background:linear-gradient(180deg,#34d399,#059669);color:#fff;font-weight:900;padding:0 14px;white-space:nowrap}.resolved-box{margin-top:12px;padding:12px;border:1px solid rgba(16,185,129,.28);border-radius:16px;background:rgba(16,185,129,.1)}.resolved-box strong{color:#047857}.resolved-box p{margin:6px 0 0}.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.summary-card{padding:18px;border-radius:22px;border:1px solid var(--line);background:rgba(255,255,255,.76)}.summary-card h3{margin:0 0 10px;font-size:18px}.summary-card p{margin:0;color:var(--muted);line-height:1.7}.quick-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}.quick-stat{padding:12px;border-radius:16px;background:#f2f8ff;border:1px solid var(--line)}.quick-stat span{display:block;color:var(--muted);font-size:12px;font-weight:850}.quick-stat strong{display:block;margin-top:4px;font-size:22px}.viz-grid{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:14px;margin-top:16px}.viz-card{min-width:0;padding:18px;border-radius:22px;background:linear-gradient(145deg,rgba(15,23,42,.94),rgba(30,41,59,.88));border:1px solid rgba(226,232,240,.18);box-shadow:0 22px 60px rgba(15,23,42,.24);color:#f8fafc;overflow:hidden}.viz-card h3{margin:0;color:#e5f1ff;font-size:17px}.viz-card .viz-number{display:flex;align-items:end;gap:8px;margin:12px 0 14px}.viz-card .viz-number strong{font-size:clamp(30px,4vw,44px);line-height:1}.viz-card .viz-number span{padding-bottom:6px;color:#b7c7dc;font-size:13px;font-weight:850}.viz-sub{margin:10px 0 0;color:#b7c7dc;font-size:12px;line-height:1.6}.stack-bar{display:flex;width:100%;height:16px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.08);margin:4px 0 14px}.stack-bar span{display:block;height:100%}.stack-bar .quark{background:linear-gradient(90deg,#22c55e,#84cc16)}.stack-bar .baidu{background:linear-gradient(90deg,#38bdf8,#2563eb)}.stack-bar .other{background:rgba(203,213,225,.42)}.viz-row{display:grid;gap:7px;margin-top:10px}.viz-row-head{display:flex;justify-content:space-between;gap:10px;align-items:center;color:#e5eefb;font-size:13px}.viz-row-head strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.viz-row-head span{color:#c4d3e7;white-space:nowrap}.viz-track{height:9px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}.viz-track i{display:block;height:100%;min-width:2px;border-radius:999px;background:linear-gradient(90deg,#60a5fa,#22c55e)}.viz-row.quark .viz-track i{background:linear-gradient(90deg,#22c55e,#bef264)}.viz-row.baidu .viz-track i{background:linear-gradient(90deg,#38bdf8,#2563eb)}.viz-row.warning .viz-track i{background:linear-gradient(90deg,#f59e0b,#f97316)}.viz-row.success .viz-track i{background:linear-gradient(90deg,#10b981,#4ade80)}.viz-state{display:grid;min-height:112px;place-items:center;text-align:center;border-radius:16px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.12);color:#dbeafe;font-weight:850;line-height:1.6;padding:18px}.viz-state.error{color:#fecaca;background:rgba(239,68,68,.12);border-color:rgba(248,113,113,.28)}.bulk-manager textarea{min-height:260px;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;line-height:1.55}.bulk-form{grid-template-columns:1fr}.bulk-result{margin:0 20px 20px;padding:16px;border-radius:20px;border:1px solid var(--line);background:#fff}.bulk-result.preview{background:#f8fbff}.bulk-result.ok{border-color:rgba(16,185,129,.34);background:#ecfdf5}.bulk-result.error{border-color:rgba(239,68,68,.34);background:#fef2f2}.bulk-result-head strong{display:block;font-size:18px}.bulk-result-head p{margin:6px 0 0;color:var(--muted);line-height:1.6}.bulk-result-head a{display:inline-flex;margin-top:8px;color:var(--blue);font-weight:900;text-decoration:none}.bulk-counts{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0}.bulk-counts div{padding:12px;border-radius:16px;background:#eef6ff;border:1px solid var(--line)}.bulk-counts span{display:block;color:var(--muted);font-size:12px;font-weight:850}.bulk-counts strong{display:block;margin-top:4px;font-size:24px}.bulk-details{margin-top:10px;border:1px solid var(--line);border-radius:16px;background:rgba(255,255,255,.72);overflow:hidden}.bulk-details summary{cursor:pointer;padding:12px 14px;font-weight:900;color:var(--text)}.bulk-detail-list{display:grid;gap:8px;padding:0 12px 12px;max-height:360px;overflow:auto}.bulk-detail-row{padding:10px;border-radius:13px;background:#f7fbff}.bulk-detail-row strong{display:block;word-break:break-word}.bulk-detail-row p{margin:5px 0;color:var(--muted);font-size:13px;line-height:1.5}.bulk-detail-row code{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#0369a1;background:#e0f2fe;border-radius:10px;padding:7px}.bulk-confirm-form{display:block;padding:14px 0 0}.bulk-confirm-form button{background:linear-gradient(180deg,#34d399,#059669)}.sync-notice,.replace-notice{margin:16px 20px 0;padding:14px 16px;border-radius:16px;border:1px solid var(--line);background:#fff}.sync-notice.ok,.replace-notice.ok{border-color:rgba(16,185,129,.35);background:rgba(236,253,245,.96)}.sync-notice.error,.replace-notice.error{border-color:rgba(239,68,68,.35);background:rgba(254,242,242,.96)}.sync-notice strong,.replace-notice strong{display:block;margin-bottom:6px}.sync-notice p,.replace-notice p{margin:0;color:var(--muted);line-height:1.6}.sync-notice a,.replace-notice a{display:inline-flex;margin-top:8px;color:var(--blue);font-weight:900;text-decoration:none}@media(max-width:960px){.metrics{grid-template-columns:repeat(3,1fr)}.grid,.summary-grid,.viz-grid{grid-template-columns:1fr}.replace-form{grid-template-columns:1fr}.replace-form button{width:100%}.section-lead{display:block}.section-lead .btn{margin-top:10px}}@media(max-width:640px){.wrap{width:min(100vw - 18px,1180px);margin-top:10px}.hero{display:block;padding:18px}.actions{margin-top:14px}.metrics{grid-template-columns:repeat(2,1fr)}.metric strong{font-size:24px}.admin-nav{border-radius:16px;margin-left:-2px;margin-right:-2px}.admin-nav a{padding:0 13px}.panel header{display:block}.panel small{display:block;margin-top:6px}.stat-row{grid-template-columns:34px minmax(0,1fr);align-items:start}.count{grid-column:2;width:max-content}.manager form{grid-template-columns:1fr;padding:16px}.manager .full{grid-column:auto}.quick-stats{grid-template-columns:1fr}}
.search-period-card{grid-column:1/-1;padding:20px 22px}.period-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.period-card-head h3{margin:0;font-size:20px}.period-card-head p{margin:5px 0 0;font-size:13px}.period-card-head small{padding:7px 10px;border-radius:999px;background:#eef6ff;color:#52708e;font-weight:800;white-space:nowrap}.search-period-metrics{display:grid;grid-template-columns:1.1fr 1.35fr repeat(3,1fr);gap:12px;margin-top:18px}.period-metric{min-width:0;padding:15px 16px;border-radius:17px;border:1px solid #dce9f6;background:linear-gradient(145deg,#f8fbff,#eef6ff)}.period-metric span{display:block;color:#66758a;font-size:13px;font-weight:850}.period-metric strong{display:block;margin-top:7px;color:#102033;font-size:clamp(24px,3vw,32px);line-height:1.05;letter-spacing:-.02em;white-space:nowrap}.period-metric.is-today{border-color:#177eea;background:linear-gradient(145deg,#2495ff,#007aff);box-shadow:0 12px 26px rgba(0,122,255,.24)}.period-metric.is-today span,.period-metric.is-today strong{color:#fff}.period-metric.is-change{background:linear-gradient(145deg,#fff8f4,#fff2ea);border-color:#fed7c3}.period-metric.is-change strong{font-size:clamp(21px,2.7vw,29px)}.period-card-note{margin:14px 0 0!important;color:#72839a!important;font-size:12px!important}.metrics .metric:last-child strong{font-size:32px;white-space:nowrap}.metrics .metric:last-child span{color:#3271a9}@media(max-width:960px){.search-period-metrics{grid-template-columns:repeat(3,1fr)}.period-metric.is-change{grid-column:span 2}}@media(max-width:640px){.period-card-head{display:block}.period-card-head small{display:inline-flex;margin-top:10px}.search-period-metrics{grid-template-columns:repeat(2,1fr);gap:10px}.period-metric.is-change{grid-column:auto}.period-metric:last-child{grid-column:span 2}.period-metric{padding:14px}.period-metric strong{font-size:27px}.metrics .metric:last-child strong{font-size:28px}}.search-calendar{margin-top:20px;padding-top:18px;border-top:1px solid #dbe8f4}.search-calendar-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.search-calendar-head h4{margin:0;color:#16283c;font-size:17px}.search-calendar-head p{margin:4px 0 0!important;color:#73849a!important;font-size:12px!important}.search-calendar-head small{padding:6px 9px;border-radius:999px;background:#eaf4ff;color:#3770a3;font-size:12px;font-weight:850;white-space:nowrap}.search-calendar-weekdays,.search-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}.search-calendar-weekdays{margin-top:15px}.search-calendar-weekdays span{text-align:center;color:#71839a;font-size:12px;font-weight:850}.search-calendar-grid{margin-top:8px}.search-calendar-blank{min-height:68px}.search-calendar-day{display:flex;min-height:68px;padding:9px 10px;flex-direction:column;justify-content:space-between;border:1px solid #dfeaf5;border-radius:13px;background:#f5f9fd;color:#596b80}.search-calendar-day>span{font-size:12px;font-weight:850}.search-calendar-day strong{color:#26394e;font-size:18px;line-height:1}.search-calendar-day.has-data{border-color:rgba(0,122,255,.28);background:linear-gradient(145deg,rgba(17,139,255,calc(.08 + var(--search-level) * .32)),rgba(238,247,255,.96));box-shadow:0 7px 18px rgba(28,124,214,calc(var(--search-level) * .12))}.search-calendar-day.has-data strong{color:#0678df}.search-calendar-day.is-zero{background:#f8fafc;color:#9aa8b8}.search-calendar-day.is-zero strong{color:#8797a9}.search-calendar-day.is-before-record,.search-calendar-day.is-future{border-style:dashed;background:rgba(248,250,252,.65);color:#b0bcc9}.search-calendar-day.is-before-record strong,.search-calendar-day.is-future strong{color:#a4b0be}.search-calendar-day.is-today{border:2px solid #087ff0;background:linear-gradient(145deg,#2495ff,#087def);box-shadow:0 12px 24px rgba(0,122,255,.28);color:#fff}.search-calendar-day.is-today strong{color:#fff}.search-calendar-note{margin:11px 0 0!important;color:#77889b!important;font-size:12px!important}@media(max-width:640px){.search-calendar-weekdays,.search-calendar-grid{gap:5px}.search-calendar-day,.search-calendar-blank{min-height:52px}.search-calendar-day{padding:7px 5px;border-radius:10px}.search-calendar-day strong{font-size:15px}.search-calendar-head{display:flex}.search-calendar-head h4{font-size:16px}.search-calendar-head small{font-size:11px}}.broken-alert-toggle{position:fixed;opacity:0;pointer-events:none}.broken-alert-toggle:checked+.broken-alert-backdrop{display:none}.broken-alert-backdrop{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:20px;background:rgba(15,32,51,.48);backdrop-filter:blur(7px)}.broken-alert-modal{position:relative;width:min(480px,100%);padding:28px;border:1px solid rgba(255,255,255,.76);border-radius:26px;background:linear-gradient(145deg,rgba(255,255,255,.98),rgba(240,248,255,.96));box-shadow:0 28px 80px rgba(15,54,93,.3)}.broken-alert-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:15px;background:linear-gradient(145deg,#ffaf38,#f97316);box-shadow:0 10px 24px rgba(249,115,22,.28);color:#fff;font-size:26px;font-weight:950}.broken-alert-eyebrow{margin:18px 0 4px!important;color:#e66d13!important;font-size:13px!important;font-weight:900}.broken-alert-modal h2{margin:0;color:#102033;font-size:25px;letter-spacing:-.02em}.broken-alert-copy{margin:9px 0 0!important;color:#64748b!important;line-height:1.65!important}.broken-alert-list{display:grid;gap:8px;margin:18px 0;padding:0;list-style:none}.broken-alert-list li{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:11px 12px;border:1px solid #dfeaf4;border-radius:13px;background:rgba(255,255,255,.78)}.broken-alert-list strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.broken-alert-list span{flex:none;color:#71839a;font-size:12px;white-space:nowrap}.broken-alert-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}.broken-alert-actions .btn{border:0;cursor:pointer}.broken-alert-close{position:absolute;top:14px;right:14px;display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:#eef4f9;color:#60738a;font-size:23px;line-height:1;cursor:pointer}.broken-alert-close:hover{background:#dfeaf4;color:#102033}@media(max-width:640px){.broken-alert-modal{padding:24px 18px}.broken-alert-list li{display:block}.broken-alert-list span{display:block;margin-top:4px}.broken-alert-actions{display:grid}.broken-alert-actions .btn{width:100%}}  .search-calendar{position:relative;isolation:isolate;margin-top:22px;padding:20px;border:1px solid rgba(170,205,235,.78);border-radius:22px;background:linear-gradient(145deg,rgba(255,255,255,.98),rgba(239,248,255,.94));box-shadow:0 18px 42px rgba(34,100,153,.10);overflow:hidden}.search-calendar:before{content:"";position:absolute;z-index:-1;width:220px;height:220px;right:-92px;top:-126px;border-radius:50%;background:radial-gradient(circle,rgba(33,150,243,.18),transparent 68%)}.search-calendar-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.calendar-title{display:flex;align-items:center;gap:11px}.calendar-title-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:13px;background:linear-gradient(145deg,#48b6ff,#007aff);box-shadow:0 10px 20px rgba(0,122,255,.22);color:#fff;font-size:17px;font-weight:950}.calendar-eyebrow{margin:0 0 2px!important;color:#2686d9!important;font-size:10px!important;letter-spacing:.09em;font-weight:900}.search-calendar-head h4{margin:0;color:#16283c;font-size:19px;letter-spacing:-.02em}.search-calendar-head p{margin:3px 0 0!important;color:#74859a!important;font-size:12px!important}.calendar-max{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:4px;padding:9px 11px;border:1px solid rgba(133,186,230,.45);border-radius:15px;background:rgba(234,246,255,.78);box-shadow:inset 0 1px 0 rgba(255,255,255,.75);white-space:nowrap}.calendar-max span{grid-column:1/-1;color:#6d8198;font-size:10px;font-weight:850}.calendar-max strong{color:#0879dc;font-size:24px;line-height:1.05;letter-spacing:-.04em}.calendar-max small{color:#5d748b;font-size:11px;font-weight:850}.search-calendar-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:17px 0 13px;padding:9px 11px;border-radius:13px;background:rgba(239,248,255,.72);color:#698096;font-size:11px;font-weight:800}.search-calendar-legend span,.search-calendar-legend b{display:inline-flex;align-items:center;gap:5px}.search-calendar-legend b{margin-left:auto;color:#2677bb}.legend-dot{width:9px;height:9px;border-radius:50%;background:#c9e6fa}.legend-dot.mid{background:#72bcf0}.legend-dot.high{background:#087ff0;box-shadow:0 0 0 3px rgba(0,122,255,.12)}.search-calendar-legend b i{width:8px;height:8px;border:2px solid #087ff0;border-radius:50%}.search-calendar-weekdays,.search-calendar-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}.search-calendar-weekdays{margin-top:0}.search-calendar-weekdays span{text-align:center;color:#7890a7;font-size:11px;font-weight:900}.search-calendar-weekdays span.is-weekend{color:#4d9fdb}.search-calendar-grid{margin-top:8px}.search-calendar-blank{min-height:74px}.search-calendar-day{position:relative;display:flex;min-height:74px;padding:10px 9px 8px;flex-direction:column;justify-content:space-between;border:1px solid #dce9f4;border-radius:16px;background:linear-gradient(145deg,#fbfdff,#f1f7fc);color:#60758c;box-shadow:inset 0 1px 0 rgba(255,255,255,.92);transition:transform .18s ease,box-shadow .18s ease}.search-calendar-day:hover{z-index:1;transform:translateY(-2px);box-shadow:0 10px 22px rgba(44,112,166,.14)}.calendar-day-number{font-size:12px;font-weight:900}.search-calendar-day strong{color:#2a4057;font-size:20px;line-height:1;letter-spacing:-.035em}.search-calendar-day small{color:#7a8da0;font-size:9px;font-weight:850}.search-calendar-day.has-data{border-color:rgba(0,122,255,.30);background:linear-gradient(145deg,rgba(44,154,255,calc(.16 + var(--search-level) * .38)),rgba(243,250,255,.98));box-shadow:0 7px 18px rgba(28,124,214,calc(var(--search-level) * .16)),inset 0 1px 0 rgba(255,255,255,.86)}.search-calendar-day.has-data strong{color:#006ed8}.search-calendar-day.is-zero{background:linear-gradient(145deg,#fafcff,#f3f7fa);color:#a0afbd}.search-calendar-day.is-zero strong{color:#9aa9b7}.search-calendar-day.is-before-record,.search-calendar-day.is-future{border-style:dashed;background:rgba(248,250,252,.62);color:#b0bdc9}.search-calendar-day.is-before-record strong,.search-calendar-day.is-future strong{color:#a9b5c0}.search-calendar-day.is-today{border:2px solid #087ff0;background:linear-gradient(145deg,#35a2ff,#0075e8);box-shadow:0 13px 26px rgba(0,122,255,.30),inset 0 1px 0 rgba(255,255,255,.35);color:#fff}.search-calendar-day.is-today strong,.search-calendar-day.is-today small{color:#fff}.search-calendar-note{display:flex;align-items:center;gap:5px;margin:13px 0 0!important;color:#7890a6!important;font-size:11px!important}.search-calendar-note span{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:6px;background:#edf4f9;color:#9cacbb;font-weight:950}.search-calendar-note b{color:#627a90}@media(max-width:640px){.search-calendar{padding:16px;border-radius:19px}.calendar-title-icon{width:34px;height:34px;border-radius:11px}.search-calendar-head h4{font-size:17px}.calendar-max{padding:8px 9px}.calendar-max strong{font-size:21px}.search-calendar-legend{gap:9px;margin:14px 0 11px;padding:8px 9px;font-size:10px}.search-calendar-legend b{margin-left:0}.search-calendar-weekdays,.search-calendar-grid{gap:5px}.search-calendar-blank{min-height:59px}.search-calendar-day{min-height:59px;padding:7px 5px 6px;border-radius:12px}.search-calendar-day strong{font-size:16px}.search-calendar-day small{display:none}.search-calendar-note{line-height:1.5;align-items:flex-start}}
</style>
<style>
  .replace-actions{grid-column:1/-1;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .replace-form button.remove-link{background:#fff;color:#0f766e;border:1px solid rgba(13,148,136,.36)}
  .replace-actions small{color:var(--muted);font-size:12px;font-weight:750}
  .bulk-noop{margin:14px 0;padding:12px 14px;border:1px solid #f0cc8a;border-radius:14px;background:#fff8e8;color:#8a5b12;font-size:13px;font-weight:750;line-height:1.6}
  @media(max-width:960px){.replace-actions{align-items:stretch}.replace-form button.remove-link{width:100%}}
</style>
</head>
<body data-default-tab="${escapeHtml(adminDefaultTab)}" data-scroll-target="${escapeHtml(adminScrollTarget)}">
  <main class="wrap">
    <section class="hero" id="top">
      <div>
        <h1>学习资源库统计后台</h1>
        <p>按分区管理新增资料、失效反馈和数据洞察；默认只显示概览，避免后台变成长卷轴。</p>
        <p>最后更新：${escapeHtml(formatTime(stats.updatedAt))}</p>
      </div>
      <div class="actions">
        <a class="btn" href="/admin">刷新数据</a>
        <a class="btn secondary" href="/api/stats">查看 JSON</a>
      </div>
    </section>

    <section class="metrics" aria-label="关键统计">
      ${cards.map(([label,count]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${count}</strong></div>`).join("")}
    </section>

    <nav class="admin-nav" aria-label="后台分区导航">
      <a href="#overview" data-tab="overview">概览</a>
      <a href="#announcement" data-tab="announcement">公告栏</a>
      <a href="#shore-letter" data-tab="shore-letter">上岸信笺</a>
      <a href="#drift-bottles" data-tab="drift">漂流瓶审核${pendingDriftBottleCount ? `（${pendingDriftBottleCount}）` : ""}</a>
      <a href="#supplement" data-tab="supplement">补充资料</a>
      <a href="#broken-links" data-tab="broken">失效反馈</a>
      <a href="#insights" data-tab="insights">数据洞察</a>

    </nav>

    <section class="admin-section" id="overview" data-section="overview">
      <div class="section-lead">
        <div><h2>概览</h2><p>这里只放最关键的状态和少量摘要，需要操作时切换到对应分区。</p></div>
      </div>
      <div class="summary-grid">
        <section class="summary-card">
          <h3>待处理事项</h3>
          <p>当前有 <strong>${unresolvedBroken.length}</strong> 条未处理失效反馈，后台新增资料 <strong>${extraLinks.length}</strong> 条，GitHub 同步配置 <strong>${githubConfigured ? "已配置" : "未配置"}</strong>。</p>
          <div class="quick-stats">
            <div class="quick-stat"><span>失效反馈总数</span><strong>${brokenLinks.length}</strong></div>
            <div class="quick-stat"><span>已处理反馈</span><strong>${resolvedBroken.length}</strong></div>
            <div class="quick-stat"><span>今日新增库</span><strong>${extraLinks.length}</strong></div>
          </div>
        </section>
        <section class="summary-card">
          <h3>快速入口</h3>
          <p>少量补链走“补充资料”，用户反馈打不开走“失效反馈”，搜索热词和点击排行在“数据洞察”。</p>
          <div class="actions" style="margin-top:14px">
            <a class="btn" href="#broken-links">处理失效反馈</a>
            <a class="btn secondary" href="#supplement">补充资料</a>
            <a class="btn secondary" href="#insights">看数据洞察</a>
          </div>
        </section>
        ${renderSearchPeriodCard(searchPeriod)}
      </div>
      <section class="viz-grid" aria-label="资源数据可视化">
        <article class="viz-card" id="resource-total">
          <h3>资源平台占比</h3>
          <div class="viz-number"><strong>${resourceOk ? resourceTotal : "-"}</strong><span>GitHub 资源</span></div>
          ${renderPlatformChart(resourceSummary)}
          <p class="viz-sub">${resourceOk ? `数据来自 GitHub ${escapeHtml(GITHUB_DATA_PATH)}，缓存 5 分钟。` : "GitHub 数据读取失败时仅影响资源图表，不影响后台其它功能。"}</p>
        </article>
        <article class="viz-card" id="category-chart">
          <h3>分类数量 Top</h3>
          <div class="viz-number"><strong>${resourceOk ? categoryTotal : "-"}</strong><span>个分类</span></div>
          ${renderCategoryChart(resourceSummary)}
        </article>
        <article class="viz-card" id="feedback-chart">
          <h3>反馈处理状态</h3>
          <div class="viz-number"><strong>${brokenLinks.length}</strong><span>条反馈</span></div>
          ${renderFeedbackChart(unresolvedBroken.length, resolvedBroken.length)}
          <p class="viz-sub">搜索 ${searchTotal} 次，点击 ${clickTotal} 次，复制 ${copyTotal} 次，无结果 ${noResultTotal} 次。</p>
        </article>
      </section>
      <section class="panel" style="margin-top:16px"><header><h2>最近待处理失效反馈</h2><small>最多 5 条</small></header><div class="list">${overviewBroken.length ? overviewBroken.map((item, index) => `<article class="stat-row broken-row"><div class="rank">${index + 1}</div><div class="stat-main"><strong>${escapeHtml(item.title || item.url || "未命名资源")}</strong><p>${escapeHtml([item.platform, item.query ? `搜索词：${item.query}` : "", formatTime(item.ts)].filter(Boolean).join(" · "))}</p>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">打开原链接检查</a>` : ""}</div></article>`).join("") : `<div class="empty">暂无待处理失效反馈</div>`}</div></section>
    </section>

    <section class="admin-section" id="announcement" data-section="announcement">
      <div class="section-lead"><div><h2>网站公告栏</h2><p>发布维护说明、资料更新提示或恢复通知。关闭公告时，首页会自动显示默认在线状态。</p></div></div>
      <section class="panel manager">
        <header><h2>编辑首页公告</h2><small>${siteNotice.updatedAt ? `上次发布：${escapeHtml(formatTime(siteNotice.updatedAt))}` : "当前使用默认状态"}</small></header>
        <form method="post" action="/admin/site-notice">
          <label class="full"><span><input type="checkbox" name="active" ${siteNotice.active ? "checked" : ""} /> 在首页显示此公告</span></label>
          <label>公告状态<select name="tone"><option value="notice" ${siteNotice.tone === "notice" ? "selected" : ""}>公告</option><option value="maintenance" ${siteNotice.tone === "maintenance" ? "selected" : ""}>维护中</option><option value="recovered" ${siteNotice.tone === "recovered" ? "selected" : ""}>已恢复</option></select></label>
          <label>公告标题<input name="title" maxlength="80" value="${escapeHtml(siteNotice.title)}" placeholder="例如：百度网盘部分资料维护中" /></label>
          <label class="full">说明<textarea name="message" maxlength="220" placeholder="例如：已在逐条修复，夸克和飞书资料可正常使用。">${escapeHtml(siteNotice.message)}</textarea></label>
          <div class="full"><button type="submit">保存并发布公告</button></div>
        </form>
        <p class="hint">取消勾选“在首页显示此公告”后保存，即可恢复首页默认文案。公告不需要改前端代码，发布后会自动显示在首页在线状态面板。</p>
        ${announcementSaved ? '<p class="hint" style="color:#047857"><strong>公告已保存并发布。</strong></p>' : ""}
      </section>
    </section>
    <section class="admin-section" id="shore-letter" data-section="shore-letter"><div class="section-lead"><div><h2>上岸信笺</h2><p>独立欢迎文案，不会使用网站公告内容。</p></div></div><section class="panel manager"><form method="post" action="/admin/shore-letter"><label class="full"><span><input type="checkbox" name="active" ${shoreLetter.active ? "checked" : ""} /> 首次访问时展示</span></label><label>标题<input name="title" maxlength="80" value="${escapeHtml(shoreLetter.title)}" /></label><label class="full">正文<textarea name="message" maxlength="220">${escapeHtml(shoreLetter.message)}</textarea></label><div class="full"><button type="submit">保存并发布信笺</button></div></form></section></section>
    ${renderDriftBottleReview(driftBottles, notice)}
    <section class="admin-section" id="supplement" data-section="supplement">
      <div class="section-lead"><div><h2>补充资料</h2><p>新增少量网盘链接，或把服务器增量数据追加同步到 GitHub。</p></div></div>
      <section class="panel manager" id="link-manager">
        <header><h2>新增网盘资料</h2><small>保存后前端会从服务器自动读取</small></header>
        <form method="post" action="/admin/links">
          <label>资料标题<input name="title" required placeholder="例如：花生十三资料分析600题" /></label>
          <label>网盘链接<input name="url" required placeholder="https://pan.quark.cn/s/..." /></label>
          <label>平台<select name="platform"><option value="quark">夸克</option><option value="baidu">百度</option></select></label>
          <label>分类<input name="section" placeholder="例如：行测 / 申论 / 面试" /></label>
          <label>提取码<input name="code" placeholder="百度网盘提取码，可不填" /></label>
          <label class="full">说明<textarea name="context" placeholder="简短说明，搜索时也会匹配这里"></textarea></label>
          <div class="full"><button type="submit">保存到搜索库</button></div>
        </form>
        <p class="hint">这里新增的是服务器增量数据，不会改 GitHub 上的大文件 pan-search-data.js。适合日常快速补链接。</p>
      </section>
      ${renderBulkBaiduPanel(notice)}
      ${renderBulkQuarkPanel(notice)}
      <section class="panel manager sync-manager" id="github-sync" style="margin-top:18px">
        <header><h2>同步到 GitHub</h2><small>手动追加到 pan-search-data.js</small></header>
        ${renderSyncNotice(notice)}
        <div class="sync-body">
          <p class="hint" style="padding-top:18px">这里会读取服务器 <code>data/extra-links.json</code>，按链接去重后追加到 GitHub 仓库根目录的 <code>pan-search-data.js</code>。不会覆盖已有数据。</p>
          <p class="hint">当前后台新增：<strong>${extraLinks.length}</strong> 条；GitHub 配置：<strong>${githubConfigured ? "已配置" : "未配置 GITHUB_TOKEN"}</strong></p>
          <form method="post" action="/admin/sync-github" style="padding-top:0">
            <button type="submit" ${githubConfigured ? "" : "disabled"}>同步新增资料到 GitHub</button>
          </form>
        </div>
        <p class="hint">建议攒一批资料后手动同步一次。同步后 GitHub Pages 可能需要等待几十秒到几分钟刷新缓存。</p>
      </section>
    </section>

    <section class="admin-section" id="broken-links" data-section="broken">
      <div class="section-lead"><div><h2>失效反馈</h2><p>自动检测连续两次确认失效后会暂时隐藏公开结果；用户反馈和自动检测都可在这里直接补链恢复。</p></div></div>
      ${renderLinkHealthPanel(stats, notice)}
      <section class="panel"><header><h2>失效反馈处理</h2><small>最近 80 条</small></header>${renderReplaceNotice(notice)}<div class="list">${renderBrokenLinks(brokenLinks, token)}</div></section>
    </section>

    <section class="admin-section" id="insights" data-section="insights">
      <div class="section-lead"><div><h2>数据洞察</h2><p>搜索、无结果、点击和复制排行集中放在这里，避免默认页面过长。</p></div></div>
      <div class="summary-grid" style="margin-bottom:16px">
        ${renderSearchPeriodCard(searchPeriod)}
      </div>
      <section class="grid">
        <section class="panel"><header><h2>热门搜索</h2><small>Top 30</small></header><div class="list">${renderRows(searches)}</div></section>
        <section class="panel"><header><h2>无结果搜索</h2><small>用来补资料</small></header><div class="list">${renderRows(noResults)}</div></section>
        <section class="panel wide"><header><h2>资源点击排行榜</h2><small>用户真实点击入口</small></header><div class="list">${renderRows(clicks)}</div></section>
        <section class="panel"><header><h2>复制链接排行</h2><small>Top 30</small></header><div class="list">${renderRows(copies)}</div></section>
      </section>
    </section>
  </main>
  ${renderBrokenFeedbackAlert(unresolvedBroken)}
  <script>
    (function () {
      var aliases = { "": "overview", "top": "overview", "overview": "overview", "announcement": "announcement", "shore-letter": "shore-letter", "drift-bottles": "drift", "drift": "drift", "supplement": "supplement", "link-manager": "supplement", "github-sync": "supplement", "bulk-baidu-update": "supplement", "bulk-preview-result": "supplement", "bulk-quark-update": "supplement", "bulk-quark-preview-result": "supplement", "broken-links": "broken", "insights": "insights" };
      var sections = Array.prototype.slice.call(document.querySelectorAll("[data-section]"));
      var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-tab]"));
      function activate() {
        var fallback = document.body.getAttribute("data-default-tab") || "overview";
        var raw = (window.location.hash || ("#" + fallback)).replace(/^#/, "");
        var active = aliases[raw] || fallback || "overview";
        sections.forEach(function (section) { section.classList.toggle("is-active", section.getAttribute("data-section") === active); });
        tabs.forEach(function (tab) { tab.classList.toggle("is-active", tab.getAttribute("data-tab") === active); });
      }
      function scrollToDefaultTarget() {
        if (window.location.hash) return;
        var targetId = document.body.getAttribute("data-scroll-target");
        if (!targetId) return;
        var target = document.getElementById(targetId);
        if (!target) return;
        window.setTimeout(function () { target.scrollIntoView({ behavior: "smooth", block: "start" }); }, 80);
      }
      window.addEventListener("hashchange", activate);
      activate();
      var brokenAlert = document.querySelector(".broken-alert-backdrop");
      if (brokenAlert) {
        var alertKey = brokenAlert.getAttribute("data-alert-key") || "";
        var storageKey = "study-resource-seen-broken-alert";
        try {
          if (localStorage.getItem(storageKey) === alertKey) brokenAlert.style.display = "none";
          var dismissAlert = function () { localStorage.setItem(storageKey, alertKey); };
          document.querySelector("#broken-alert-dismiss")?.addEventListener("change", dismissAlert);
          brokenAlert.querySelector(".broken-alert-close")?.addEventListener("click", dismissAlert);
          brokenAlert.querySelector(".btn.secondary")?.addEventListener("click", dismissAlert);
          brokenAlert.querySelector(".btn:not(.secondary)")?.addEventListener("click", dismissAlert);
        } catch (_) {}
      }      scrollToDefaultTarget();
      var refreshTimer;
      function refreshAdmin() { if (!document.hidden) window.location.reload(); }
      function scheduleAdminRefresh() { clearTimeout(refreshTimer); if (!document.hidden) refreshTimer = setTimeout(refreshAdmin, 300000); }
      document.addEventListener("visibilitychange", function () { if (document.hidden) clearTimeout(refreshTimer); else refreshAdmin(); });
      scheduleAdminRefresh();
    })();
  </script>
</body>
</html>`;
}
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    setCors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/api/health")) {
    return send(res, req, 200, { ok: true, service: SERVICE_NAME, time: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/drift-bottles") {
    return send(res, req, 200, { ok: true, items: getPublicDriftBottles() });
  }

  if (req.method === "POST" && url.pathname === "/api/drift-bottles") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const source = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().slice(0, 120);
      const bottle = createDriftBottle(body, source);
      return send(res, req, 201, { ok: true, item: { id: bottle.id, status: bottle.status, createdAt: bottle.createdAt } });
    } catch (error) {
      return send(res, req, 400, { ok: false, error: error.message || "投递失败" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/study-room/presence") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const snapshot = refreshStudyRoomPresence(body);
      return send(res, req, 200, { ok: true, ...snapshot });
    } catch (error) {
      return send(res, req, 400, { ok: false, error: error.message || "自习室连接失败" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/study-room/presence") {
    return send(res, req, 200, { ok: true, ...getStudyRoomSnapshot() });
  }

  if (req.method === "POST" && url.pathname === "/api/site-presence") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      return send(res, req, 200, { ok: true, ...refreshSitePresence(body) }, { "Cache-Control": "no-store" });
    } catch (error) {
      return send(res, req, 400, { ok: false, error: error.message || "在线状态连接失败" }, { "Cache-Control": "no-store" });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/site-presence") {
    return send(res, req, 200, { ok: true, ...getSitePresenceSnapshot() }, { "Cache-Control": "no-store" });
  }
  if (req.method === "POST" && url.pathname === "/api/events") {
    try {
      const body = await readBody(req);
      const event = JSON.parse(body || "{}");
      if (!event.type) return send(res, req, 400, { ok: false, error: "missing type" });

      const normalized = {
        type: String(event.type).slice(0, 60),
        payload: event.payload || {},
        page: String(event.page || "").slice(0, 500),
        referrer: String(event.referrer || "").slice(0, 500),
        userAgent: String(event.userAgent || "").slice(0, 500),
        ts: Number(event.ts || Date.now()),
        ip: String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").slice(0, 120)
      };

      fs.appendFileSync(EVENTS_FILE, JSON.stringify(normalized) + "\n");
      updateStats(normalized);
      return send(res, req, 200, { ok: true });
    } catch (error) {
      return send(res, req, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/site-notice") {
    return send(res, req, 200, { ok: true, notice: readSiteNotice() });
  }
  if (req.method === "GET" && url.pathname === "/api/shore-letter") return send(res, req, 200, { ok: true, letter: readShoreLetter() });
  if (req.method === "GET" && url.pathname === "/api/public-insights") {
    return send(res, req, 200, buildPublicResourceInsights(readStats()));
  }
  if (req.method === "GET" && url.pathname === "/api/link-health") {
    const stats = readStats();
    return send(res, req, 200, {
      ok: true,
      hiddenUrls: getHiddenLinkUrls(stats),
      items: Object.values(stats.linkHealth || {}).map(item => ({ url: item.url, status: item.status, lastCheckedAt: item.lastCheckedAt || null, lastHealthyAt: item.lastHealthyAt || null })),
      lastCheckAt: stats.linkHealthLastCheckAt || null
    });
  }

  if (req.method === "GET" && url.pathname === "/api/pan-links") {
    return send(res, req, 200, { ok: true, items: readExtraLinks() });
  }

  if (req.method === "POST" && url.pathname === "/api/pan-links") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return send(res, req, 403, { ok: false, error: "forbidden" });
    try {
      const body = await readBody(req);
      const result = addExtraLink(JSON.parse(body || "{}"));
      return send(res, req, result.ok ? 200 : 400, result);
    } catch (error) {
      return send(res, req, 400, { ok: false, error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/admin/drift-bottles/review") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    try {
      const form = readFormBody(await readBody(req));
      const bottle = reviewDriftBottle(form.id, form.action);
      sendAdminRedirect(res, `/admin?drift=${bottle.status === "approved" ? "approved" : "deleted"}#drift-bottles`, token);
      return;
    } catch (error) {
      return sendHtml(res, req, 400, renderAdminLogin(error.message || "审核失败"));
    }
  }
  if (req.method === "POST" && url.pathname === "/admin/site-notice") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    try {
      const form = readFormBody(await readBody(req));
      writeSiteNotice({
        active: form.active === "on",
        tone: form.tone,
        title: form.title,
        message: form.message
      });
      sendAdminRedirect(res, "/admin?announcement=ok#announcement", token);
      return;
    } catch (error) {
      return sendHtml(res, req, 400, renderAdminLogin(error.message || "公告保存失败"));
    }
  }
  if (req.method === "POST" && url.pathname === "/admin/shore-letter") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    try { const form = readFormBody(await readBody(req)); writeShoreLetter({ active: form.active === "on", title: form.title, message: form.message }); sendAdminRedirect(res, "/admin?shoreLetter=ok#shore-letter", token); return; } catch (error) { return sendHtml(res, req, 400, renderAdminLogin(error.message || "信笺保存失败")); }
  }
  if (req.method === "POST" && url.pathname === "/admin/links") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    const body = await readBody(req);
    addExtraLink(readFormBody(body));
    sendAdminRedirect(res, "/admin?link=ok#link-manager", token);
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/check-pan-links") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    const redirect = new URL("/admin", `http://${req.headers.host}`);
    try {
      const result = await runLinkHealthCheck();
      redirect.searchParams.set("health", "ok");
      redirect.searchParams.set("message", `\u672c\u6b21\u521d\u7b5b ${result.checked} \u6761\uff1a\u53ef\u8bbf\u95ee ${result.healthy}\uff0c\u9996\u6b21\u7591\u4f3c\u5931\u6548 ${result.failed}\uff0c\u5df2\u9690\u85cf ${result.hidden}\uff0c\u8df3\u8fc7\u672a\u5224\u5b9a ${result.skipped}\u3002`);
    } catch (error) {
      redirect.searchParams.set("health", "error");
      redirect.searchParams.set("message", error.message || "链接检测失败");
    }
    sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#broken-links`, token);
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/replace-broken-link") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }

    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json")
        ? JSON.parse(body || "{}")
        : readFormBody(body);
      const result = await replaceBrokenLinkInGitHub(payload);

      if (jsonResponse) return send(res, req, 200, result);

      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("replace", "ok");
      redirect.searchParams.set("message", result.message || "补链替换完成");
      if (result.commitUrl) redirect.searchParams.set("commit", result.commitUrl);
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#broken-links`, token);
      return;
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "replace failed" });

      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("replace", "error");
      redirect.searchParams.set("message", error.message || "补链替换失败");
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#broken-links`, token);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/admin/remove-broken-link") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }

    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json")
        ? JSON.parse(body || "{}")
        : readFormBody(body);
      const result = await removeBrokenLinkFromSearch(payload);
      if (jsonResponse) return send(res, req, 200, result);

      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("replace", "ok");
      redirect.searchParams.set("action", "removed");
      redirect.searchParams.set("message", result.message || "原链接已从公开搜索中下架");
      if (result.commitUrl) redirect.searchParams.set("commit", result.commitUrl);
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#broken-links`, token);
      return;
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "remove failed" });

      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("replace", "error");
      redirect.searchParams.set("action", "removed");
      redirect.searchParams.set("message", error.message || "原链接下架失败");
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#broken-links`, token);
      return;
    }
  }
  if (req.method === "POST" && url.pathname === "/admin/bulk-baidu-preview") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }
    let rawText = "";
    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json") ? JSON.parse(body || "{}") : readFormBody(body);
      rawText = String(payload.rawText || "");
      const defaultSection = String(payload.defaultSection || "百度批量新增").trim() || "百度批量新增";
      const plan = await previewBulkBaiduLinks(rawText, defaultSection);
      if (jsonResponse) return send(res, req, 200, { ok: true, plan });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      return sendHtml(res, req, 200, renderAdminPage(stats, token, { bulkStatus: "preview", bulkPlan: plan, bulkRawText: rawText, bulkDefaultSection: defaultSection, adminDefaultTab: "supplement", adminScrollTarget: "bulk-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "preview failed" });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      const plan = { summary: { parsed: 0, replace: 0, add: 0, unchanged: 0, ignored: 1 }, replace: [], add: [], unchanged: [], ignored: [{ title: "预览失败", reason: error.message || "预览失败" }] };
      return sendHtml(res, req, 400, renderAdminPage(stats, token, { bulkStatus: "error", bulkPlan: plan, bulkRawText: rawText, bulkMessage: error.message || "预览失败", adminDefaultTab: "supplement", adminScrollTarget: "bulk-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    }
  }

  if (req.method === "POST" && url.pathname === "/admin/bulk-baidu-apply") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }
    let rawText = "";
    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json") ? JSON.parse(body || "{}") : readFormBody(body);
      if (String(payload.confirm || "") !== "1") throw new Error("请先预览并确认后再提交");
      rawText = String(payload.rawText || "");
      const defaultSection = String(payload.defaultSection || "百度批量新增").trim() || "百度批量新增";
      const mode = String(payload.mode || "") === "append-ambiguous" ? "append-ambiguous" : "safe";
      const result = await applyBulkBaiduLinks(rawText, defaultSection, mode);
      if (jsonResponse) return send(res, req, result.ok ? 200 : 400, result);
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      return sendHtml(res, req, result.ok ? 200 : 400, renderAdminPage(stats, token, { bulkStatus: result.ok ? "applied" : "error", bulkPlan: result, bulkRawText: rawText, bulkDefaultSection: defaultSection, bulkMessage: result.message || "", bulkCommit: result.commitUrl || "", adminDefaultTab: "supplement", adminScrollTarget: "bulk-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "apply failed" });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      const plan = { summary: { parsed: 0, replace: 0, add: 0, unchanged: 0, ignored: 1 }, replace: [], add: [], unchanged: [], ignored: [{ title: "提交失败", reason: error.message || "提交失败" }] };
      return sendHtml(res, req, 400, renderAdminPage(stats, token, { bulkStatus: "error", bulkPlan: plan, bulkRawText: rawText, bulkMessage: error.message || "提交失败", adminDefaultTab: "supplement", adminScrollTarget: "bulk-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    }
  }
  if (req.method === "POST" && url.pathname === "/admin/bulk-quark-preview") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }
    let rawText = "";
    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json") ? JSON.parse(body || "{}") : readFormBody(body);
      rawText = String(payload.rawText || "");
      const defaultSection = String(payload.defaultSection || "夸克批量新增").trim() || "夸克批量新增";
      const plan = await previewBulkQuarkLinks(rawText, defaultSection);
      if (jsonResponse) return send(res, req, 200, { ok: true, plan });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      return sendHtml(res, req, 200, renderAdminPage(stats, token, { quarkBulkStatus: "preview", quarkBulkPlan: plan, quarkBulkRawText: rawText, quarkBulkDefaultSection: defaultSection, adminDefaultTab: "supplement", adminScrollTarget: "bulk-quark-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "preview failed" });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      const plan = { summary: { parsed: 0, replace: 0, add: 0, unchanged: 0, ignored: 1 }, replace: [], add: [], unchanged: [], ignored: [{ title: "预览失败", reason: error.message || "预览失败" }] };
      return sendHtml(res, req, 400, renderAdminPage(stats, token, { quarkBulkStatus: "error", quarkBulkPlan: plan, quarkBulkRawText: rawText, quarkBulkMessage: error.message || "预览失败", adminDefaultTab: "supplement", adminScrollTarget: "bulk-quark-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    }
  }

  if (req.method === "POST" && url.pathname === "/admin/bulk-quark-apply") {
    const token = getRequestToken(req, url);
    const jsonResponse = wantsJsonResponse(req);
    if (!isAdminToken(token)) {
      if (jsonResponse) return send(res, req, 403, { ok: false, error: "forbidden" });
      return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    }
    let rawText = "";
    try {
      const body = await readBody(req);
      const payload = String(req.headers["content-type"] || "").includes("application/json") ? JSON.parse(body || "{}") : readFormBody(body);
      if (String(payload.confirm || "") !== "1") throw new Error("请先预览并确认后再提交");
      rawText = String(payload.rawText || "");
      const defaultSection = String(payload.defaultSection || "夸克批量新增").trim() || "夸克批量新增";
      const result = await applyBulkQuarkLinks(rawText, defaultSection);
      if (jsonResponse) return send(res, req, result.ok ? 200 : 400, result);
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      return sendHtml(res, req, result.ok ? 200 : 400, renderAdminPage(stats, token, { quarkBulkStatus: result.ok ? "applied" : "error", quarkBulkPlan: result, quarkBulkRawText: rawText, quarkBulkDefaultSection: defaultSection, quarkBulkMessage: result.message || "", quarkBulkCommit: result.commitUrl || "", adminDefaultTab: "supplement", adminScrollTarget: "bulk-quark-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    } catch (error) {
      if (jsonResponse) return send(res, req, 400, { ok: false, error: error.message || "apply failed" });
      const stats = readStats();
      const resourceSummary = await getGitHubResourceSummary();
      const plan = { summary: { parsed: 0, replace: 0, add: 0, unchanged: 0, ignored: 1 }, replace: [], add: [], unchanged: [], ignored: [{ title: "提交失败", reason: error.message || "提交失败" }] };
      return sendHtml(res, req, 400, renderAdminPage(stats, token, { quarkBulkStatus: "error", quarkBulkPlan: plan, quarkBulkRawText: rawText, quarkBulkMessage: error.message || "提交失败", adminDefaultTab: "supplement", adminScrollTarget: "bulk-quark-preview-result" }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
    }
  }
  if (req.method === "POST" && url.pathname === "/admin/sync-github") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) return sendHtml(res, req, 403, renderAdminLogin("TOKEN 不正确"));
    try {
      const result = await syncExtraLinksToGitHub();
      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("sync", "ok");
      redirect.searchParams.set("added", String(result.added || 0));
      redirect.searchParams.set("skipped", String(result.skipped || 0));
      redirect.searchParams.set("message", result.message || "");
      if (result.commitUrl) redirect.searchParams.set("commit", result.commitUrl);
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#github-sync`, token);
      return;
    } catch (error) {
      const redirect = new URL("/admin", `http://${req.headers.host}`);
      redirect.searchParams.set("sync", "error");
      redirect.searchParams.set("message", error.message || "同步失败");
      sendAdminRedirect(res, `${redirect.pathname}${redirect.search}#github-sync`, token);
      return;
    }
  }
  if (req.method === "GET" && url.pathname === "/admin") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) {
      return sendHtml(res, req, token ? 403 : 200, renderAdminLogin(token ? "TOKEN 不正确" : ""));
    }
    const stats = readStats();
    const resourceSummary = await getGitHubResourceSummary();
    return sendHtml(res, req, 200, renderAdminPage(stats, token, {
      announcement: url.searchParams.get("announcement") || "",
      drift: url.searchParams.get("drift") || "",
      status: url.searchParams.get("sync") || "",
      added: url.searchParams.get("added") || "",
      skipped: url.searchParams.get("skipped") || "",
      message: url.searchParams.get("message") || "",
      commit: url.searchParams.get("commit") || "",
      replaceStatus: url.searchParams.get("replace") || "",
      replaceAction: url.searchParams.get("action") || "",
      replaceMessage: url.searchParams.get("message") || "",
      replaceCommit: url.searchParams.get("commit") || "",
      healthStatus: url.searchParams.get("health") || "",
      healthMessage: url.searchParams.get("health") ? (url.searchParams.get("message") || "") : ""
    }, resourceSummary), adminCookieHeader(token) ? { "Set-Cookie": adminCookieHeader(token) } : {});
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    const token = getRequestToken(req, url);
    if (!isAdminToken(token)) {
      return send(res, req, 403, { ok: false, error: "forbidden" });
    }
    return send(res, req, 200, { ok: true, stats: readStats() });
  }

  return send(res, req, 404, { ok: false, error: "not found" });
});

server.listen(PORT, () => {
  console.log(`${SERVICE_NAME} listening on ${PORT}`);
  if (LINK_HEALTH_AUTOCHECK) {
    const scheduledCheck = () => runLinkHealthCheck().catch((error) => console.error("link health check failed:", error.message));
    setTimeout(scheduledCheck, 5 * 60 * 1000);
    setInterval(scheduledCheck, LINK_HEALTH_INTERVAL_MS);
  }
});

// Anonymous in-memory presence: nothing is written to disk and each seat expires quickly.
const STUDY_ROOM_PRESENCE_TTL_MS = 2 * 60 * 1000;
const SITE_PRESENCE_TTL_MS = 90 * 1000;
const STUDY_ROOM_EXAM_TYPES = new Set(["公务员", "事业单位", "教招教资", "其他"]);
const STUDY_ROOM_STAGES = new Set(["起步", "基础", "强化", "冲刺", "面试"]);
const STUDY_ROOM_TASKS = new Set(["刷题", "申论", "资料分析", "面试", "整理资料", "安静自习"]);
const STUDY_ROOM_REGIONS = new Set(["未选择", "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西", "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆"]);
const studyRoomPresence = new Map();
const sitePresence = new Map();

function normalizeSitePresence(raw) {
  const id = boundedText(raw?.visitorId, 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error("缺少匿名访问标识");
  return { id };
}

function pruneSitePresence(now = Date.now()) {
  for (const [id, presence] of sitePresence.entries()) {
    if (!presence || now - Number(presence.lastSeen || 0) > SITE_PRESENCE_TTL_MS) sitePresence.delete(id);
  }
}

function getSitePresenceSnapshot() {
  pruneSitePresence();
  return { onlineCount: sitePresence.size, updatedAt: new Date().toISOString() };
}

function refreshSitePresence(raw) {
  const visitor = normalizeSitePresence(raw);
  pruneSitePresence();
  sitePresence.set(visitor.id, { lastSeen: Date.now() });
  return getSitePresenceSnapshot();
}

function normalizeStudyRoomProfile(raw) {
  const id = boundedText(raw?.visitorId, 100);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error("缺少匿名座位标识");
  const examType = STUDY_ROOM_EXAM_TYPES.has(raw?.examType) ? raw.examType : "公务员";
  const stage = STUDY_ROOM_STAGES.has(raw?.stage) ? raw.stage : "基础";
  const region = STUDY_ROOM_REGIONS.has(raw?.region) ? raw.region : "未选择";
  const task = STUDY_ROOM_TASKS.has(raw?.task) ? raw.task : "安静自习";
  const seatId = /^seat-(?:[1-9]|[12]\d|3[0-6])$/.test(String(raw?.seatId || "")) ? String(raw.seatId) : "";
  return { id, examType, stage, region, task, seatId };
}

function pruneStudyRoomPresence(now = Date.now()) {
  for (const [id, presence] of studyRoomPresence.entries()) {
    if (!presence || now - Number(presence.lastSeen || 0) > STUDY_ROOM_PRESENCE_TTL_MS) studyRoomPresence.delete(id);
  }
}

function getStudyRoomSnapshot(profile) {
  pruneStudyRoomPresence();
  const people = [...studyRoomPresence.values()];
  const taskCounts = {};
  for (const task of STUDY_ROOM_TASKS) taskCounts[task] = 0;
  people.forEach((person) => { taskCounts[person.task] = Number(taskCounts[person.task] || 0) + 1; });
  const match = profile ? {
    sameExam: people.filter((person) => person.id !== profile.id && person.examType === profile.examType).length,
    sameStage: people.filter((person) => person.id !== profile.id && person.stage === profile.stage).length,
    sameRegion: profile.region === "未选择" ? 0 : people.filter((person) => person.id !== profile.id && person.region === profile.region).length,
    hasRegion: profile.region !== "未选择"
  } : { sameExam: 0, sameStage: 0, sameRegion: 0, hasRegion: false };
  const seats = people.filter((person) => person.seatId).map((person) => ({ seatId: person.seatId, task: person.task }));
  return { onlineCount: people.length, taskCounts, match, seats, updatedAt: new Date().toISOString() };
}

function refreshStudyRoomPresence(raw) {
  const profile = normalizeStudyRoomProfile(raw);
  pruneStudyRoomPresence();
  if (profile.seatId) {
    const occupied = [...studyRoomPresence.values()].find((person) => person.id !== profile.id && person.seatId === profile.seatId);
    if (occupied) throw new Error("这个座位刚刚被其他同学选走了，请换一个空座。");
  }
  if (!profile.seatId) { studyRoomPresence.delete(profile.id); return getStudyRoomSnapshot(profile); }
  studyRoomPresence.set(profile.id, { ...profile, lastSeen: Date.now() });
  return getStudyRoomSnapshot(profile);
}




