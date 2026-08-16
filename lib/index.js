/**
 * dsh-deepseek-quota — host half.
 *
 * Registers one exact HTTP route on the dsh web server:
 *
 *   GET /api/deepseek-balance
 *
 * which resolves the DeepSeek API key through the credentials seam
 * (the same `DEEPSEEK_API_KEY` reference the llm-deepseek adapter uses),
 * calls DeepSeek's public `/user/balance` endpoint, and returns:
 *
 *   {
 *     "ok": true,
 *     "balance": <provider payload>,
 *     "todayConsumed": <number|null>,
 *     "todayConsumedSource": "official" | "estimate"
 *   }
 *
 * `todayConsumed` — the widget's "今日已消费" value — comes from one of two
 * sources:
 *
 * 1. **Official (preferred)**: when the optional `DEEPSEEK_PLATFORM_TOKEN`
 *    credential is configured, the host queries DeepSeek's dashboard usage
 *    API (`platform.deepseek.com/api/v0/usage/cost?month=&year=` — the same
 *    date-filterable data the platform web console shows) and picks today's
 *    row. Source is reported as `"official"`.
 * 2. **Estimate (fallback)**: without the platform token, the host meters the
 *    balance: it persists the first (day-opening) balance of the local
 *    calendar day under `$DSH_HOME/storages/deepseek-quota-day.json` and
 *    reports `max(0, opening − current)`. Source is `"estimate"`, and the
 *    widget prefixes the value with "≈".
 *
 * Provider errors and local failures return a small `{ ok, error, message }`
 * envelope the browser widget renders. The API key never leaves the host: the
 * browser only ever talks to this route, and keys are resolved per request
 * through `ctx.credentials`.
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { costOf, priceAt } from "./pricing.js";

const name = "dsh-deepseek-quota";
const inject = ["credentials", "webServer"];

const PUBLIC_BASE_URL = "https://api.deepseek.com";
/** Environment override honored for parity with the llm-deepseek adapter. */
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = credentialRef("DEEPSEEK_API_KEY");
/** Optional platform session token (localStorage `userToken` of platform.deepseek.com). */
const PLATFORM_TOKEN_REF = credentialRef("DEEPSEEK_PLATFORM_TOKEN");
const BALANCE_PATH = "/user/balance";
const ROUTE_PATH = "/api/deepseek-balance";
const SESSION_COST_ROUTE_PATH = "/api/deepseek-session-cost";
const TIMEOUT_MS = 15000;
/** Daily-meter state file name inside `$DSH_HOME/storages`. */
const DAY_STATE_FILE = "deepseek-quota-day.json";
/** Platform usage (cost) endpoint: per-day cost for one month, filterable by date. */
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Extract a readable provider message from a DeepSeek error body. */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === "object" && parsed.error !== null && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- daily consumption: official platform source -------------------------

/** Local calendar day as `YYYY-MM-DD` (dashboard rows are keyed by date). */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Coerce a possibly-string number to a finite number, or NaN. */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Fetch today's official cost from the DeepSeek platform dashboard API.
 * Response envelope: `{ code: 0, data: { biz_code: 0, biz_data: { days: [
 *   { date: "YYYY-MM-DD", data: [ { usage: [ { cost|amount, ... } ] } ] }
 * ] } } }`. Parsing is defensive against renamed fields; returns `null` when
 * the shape differs or today's row is absent (caller falls back).
 * @returns today's cost in the account currency, or `null`.
 * @throws on transport errors, non-zero envelope codes, and HTTP failures.
 */
async function fetchPlatformTodayCost(token) {
  const now = new Date();
  const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DeepSeek 平台用量接口返回 HTTP ${response.status}`);
  const body = await response.json();
  const biz = body && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      throw new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
    }
    throw new Error(`DeepSeek 平台用量接口错误 (code ${code ?? "unknown"})`);
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return null;
  const today = localDate();
  const entry = days.find((d) => d && d.date === today);
  if (!entry || !Array.isArray(entry.data)) return null;
  let total = 0;
  for (const modelEntry of entry.data) {
    if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
    for (const u of modelEntry.usage) {
      if (!u || typeof u !== "object") continue;
      const value = toFinite(u.cost ?? u.amount);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

// ---- daily consumption: balance-delta estimate ---------------------------

/**
 * Absolute path of the daily-meter state file. Prefers the harness-provided
 * `dshHomePath` service, then `$DSH_HOME`, then the default home.
 */
function dayStatePath(ctx) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") {
    storages = homeFn("storages");
  } else if (process.env.DSH_HOME) {
    storages = join(process.env.DSH_HOME, "storages");
  } else {
    storages = join(homedir(), ".dsh", "storages");
  }
  return join(storages, DAY_STATE_FILE);
}

/** Read the persisted meter state; `null` when absent or malformed. */
function loadDayState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.date === "string" &&
      typeof parsed.opening === "number" &&
      typeof parsed.last === "number"
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

/** Persist the meter state (best-effort; a failure just resets the meter). */
function saveDayState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {}
}

/**
 * Advance the daily meter with one observed balance and return today's
 * consumption estimate, or `null` when the balance is unusable.
 *
 * Recharge-aware: the state keeps `toppedUp` (max topped-up balance seen
 * today) and `charged` (accumulated recharges today). A topped-up balance
 * increase counts as a recharge, so the estimate is
 * `max(0, opening + charged − balance)` — mid-day top-ups no longer break
 * the figure. Day-opening estimate for a fresh day: the last balance
 * observed on the previous day (falls back to the current balance, i.e.
 * zero consumption, when no history exists). Legacy state files without
 * `toppedUp`/`charged` migrate on first observation (no retroactive
 * recharge is assumed).
 */
function computeTodayConsumed(ctx, balance, toppedUp) {
  if (!Number.isFinite(balance)) return null;
  const path = dayStatePath(ctx);
  const today = localDate();
  const stored = loadDayState(path);
  let opening;
  let charged = 0;
  let seenTopup = Number.isFinite(toppedUp) ? toppedUp : 0;
  if (stored !== null && stored.date === today) {
    opening = stored.opening;
    charged = Number.isFinite(stored.charged) ? stored.charged : 0;
    const prevTopup = Number.isFinite(stored.toppedUp) ? stored.toppedUp : null;
    if (prevTopup !== null && Number.isFinite(toppedUp) && toppedUp > prevTopup + 0.005) {
      // 检测到充值：充值余额较上次观察变大，差额计入今日累计充值
      charged += toppedUp - prevTopup;
      seenTopup = toppedUp;
    } else {
      // 未充值（或旧格式首次迁移，不回溯误判充值）：记录当前观察值
      seenTopup = Number.isFinite(toppedUp) ? toppedUp : (prevTopup ?? 0);
    }
  } else {
    // 新的一天：期初 = 昨天的最后余额（无历史则当前余额），充值累计清零
    opening = stored !== null ? stored.last : balance;
    charged = 0;
  }
  saveDayState(path, { date: today, opening, last: balance, toppedUp: seenTopup, charged });
  // 今日已用 = 期初余额 + 今日累计充值 − 当前余额（充值不再让估算失真）
  const consumed = Math.max(0, opening + charged - balance);
  return Math.round(consumed * 100) / 100;
}

// ---- plugin body ---------------------------------------------------------

/** Round a cost to 6 decimals for the wire (costs can be fractions of a cent). */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Empty per-session cost record (flat sums + per-bucket token/cost pairs for the formula breakdown). */
function emptyCostRecord() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    buckets: {
      input: { tokens: 0, cost: 0 },
      cacheRead: { tokens: 0, cost: 0 },
      output: { tokens: 0, cost: 0 }
    }
  };
}

/** Price one `assistant/message` event into a cost record (shared by live and replay paths). */
function priceEventInto(record, event) {
  const data = event.data;
  const usage = data?.usage;
  if (usage === void 0 || usage === null) return false;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return false;
  const source = data.message?.source;
  const model = typeof source?.model === "string" ? source.model : "unknown";
  const unit = priceAt(model, event.time ?? Date.now());
  const sample = costOf(usage, unit);
  record.calls += 1;
  record.cost += sample.cost;
  record.costUsd += sample.costUsd;
  record.inputTokens += sample.inputTokens;
  record.cacheReadTokens += sample.cacheReadTokens;
  record.outputTokens += sample.outputTokens;
  // 分桶累计（按每条消息的实际单价），供"计算公式"明细展示。
  record.buckets.input.tokens += sample.inputTokens;
  record.buckets.input.cost += (sample.inputTokens * unit.cny.input) / 1e6;
  record.buckets.cacheRead.tokens += sample.cacheReadTokens;
  record.buckets.cacheRead.cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
  record.buckets.output.tokens += sample.outputTokens;
  record.buckets.output.cost += (sample.outputTokens * unit.cny.output) / 1e6;
  return true;
}

/**
 * Build the formula breakdown for one cost record: per bucket `{ label, tokens,
 * rate, subtotal }`, where `rate` is the EFFECTIVE blended price (¥/M) — the
 * exact `subtotal / tokens × 1e6` so `tokens × rate = subtotal` holds for the
 * displayed formula. Zero-token buckets are kept with rate 0.
 */
function breakdownOf(record) {
  const parts = [
    { label: "输入(未命中)", key: "input" },
    { label: "缓存命中", key: "cacheRead" },
    { label: "输出", key: "output" }
  ];
  return parts.map(({ label, key }) => {
    const bucket = record.buckets[key];
    const tokens = bucket.tokens;
    const subtotal = bucket.cost;
    const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
    return { label, tokens, rate, subtotal: roundCost(subtotal) };
  });
}

/** Min interval between log re-decodings of the same session (avoids churn during active turns). */
const REPLAY_MIN_INTERVAL_MS = 2000;

/**
 * Replay a session's persisted log and price EVERY assistant/message event, so
 * the reported cost covers the whole conversation (including messages that
 * happened before this plugin loaded — the live in-memory ledger alone would
 * undercount after a restart). Cached per session by the log's stat revision
 * (`readStoredRevision`), with a short minimum re-decode interval.
 *
 * @param ctx - plugin context (reads `sessionPersistence`).
 * @param sessionId - session to price.
 * @returns the cost record plus the revision, or `null` when the session has
 * no stored log or the persistence seam is unavailable.
 */
async function replaySessionCost(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (persistence === void 0 || typeof persistence.readRaw !== "function" || typeof persistence.readStoredRevision !== "function") {
    return null;
  }
  let revision;
  try {
    revision = await persistence.readStoredRevision(sessionId);
  } catch (error) {
    ctx.logger.warn("dsh-deepseek-quota: failed to read session log revision");
    ctx.logger.warn(error);
    return null;
  }
  if (revision === void 0) return null;
  const cached = logCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  try {
    const raw = await persistence.readRaw(sessionId);
    if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
    const record = emptyCostRecord();
    for (const line of raw.content.split("\n")) {
      if (line === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event === null || typeof event !== "object" || event.type !== "assistant/message") continue;
      try {
        priceEventInto(record, event);
      } catch {
        // one malformed message must not fail the whole replay
      }
    }
    const result = { ...record, revision, at: Date.now() };
    logCostCache.set(sessionId, result);
    return result;
  } catch (error) {
    ctx.logger.warn("dsh-deepseek-quota: failed to replay session log for costing");
    ctx.logger.warn(error);
    return null;
  }
}

/** Whole-session log replay cache: sessionId -> { revision, calls, cost, ..., at }. */
const logCostCache = new Map();

function apply(ctx) {
  // ---- current-conversation cost ledger ----------------------------------
  // 订阅 session/event 实时累计（覆盖尚未落盘的进行中消息）；查询时优先用
  // 全量日志回放（replaySessionCost）以获得包含重启前历史的整段会话费用。
  const bySession = new Map();
  const headersBySession = new Map();

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "request/header" && event.data?.header?.config) {
        const header = event.data.header.config;
        if (typeof header.provider === "string" && typeof header.model === "string") {
          headersBySession.set(session.id, { provider: header.provider, model: header.model });
        }
        return;
      }
      if (event?.type !== "assistant/message") return;
      let record = bySession.get(session.id);
      if (record === void 0) {
        record = { ...emptyCostRecord(), updatedAt: 0 };
        bySession.set(session.id, record);
      }
      priceEventInto(record, event);
      record.updatedAt = event.time ?? Date.now();
    } catch (error) {
      ctx.logger.warn("dsh-deepseek-quota: failed to price an assistant/message event");
      ctx.logger.warn(error);
    }
  });

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
          if (hit === void 0) {
            sendJson(res, 503, {
              ok: false,
              error: "no-api-key",
              message: "未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。"
            });
            return;
          }
          const response = await fetch(balanceUrl(), {
            headers: {
              Authorization: `Bearer ${hit.value}`,
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(TIMEOUT_MS)
          });
          const text = await response.text();
          if (!response.ok) {
            sendJson(res, response.status, {
              ok: false,
              error: "provider",
              message: providerMessage(text, response.status)
            });
            return;
          }
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          const info = body && Array.isArray(body.balance_infos) ? body.balance_infos[0] : null;
          const total = info ? Number(info.total_balance) : NaN;
          const toppedUp = info ? Number(info.topped_up_balance) : NaN;

          // Today's consumption: official platform data first, then the
          // balance-delta estimate.
          let todayConsumed = null;
          let todayConsumedSource = "estimate";
          const platformHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
          if (platformHit !== void 0) {
            try {
              const official = await fetchPlatformTodayCost(platformHit.value);
              if (official !== null) {
                todayConsumed = official;
                todayConsumedSource = "official";
              } else {
                ctx.logger.warn("dsh-deepseek-quota: platform usage returned no today row; falling back to the balance-delta estimate");
              }
            } catch (error) {
              ctx.logger.warn("dsh-deepseek-quota: platform usage fetch failed; falling back to the balance-delta estimate");
              ctx.logger.warn(error);
            }
          }
          if (todayConsumedSource !== "official" && Number.isFinite(total)) {
            todayConsumed = computeTodayConsumed(ctx, total, Number.isFinite(toppedUp) ? toppedUp : null);
          }

          sendJson(res, 200, { ok: true, balance: body, todayConsumed, todayConsumedSource });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-quota: failed to fetch DeepSeek balance");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            error: "fetch-failed",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }),
    "dsh-deepseek-quota: balance route"
  );

  // 当前对话费用查询：GET /api/deepseek-session-cost?sessionId=<id>
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: SESSION_COST_ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          // 优先：全量日志回放（包含重启前的历史，与 dsh 会话统计同源）。
          // 兜底：实时内存记账（覆盖尚未落盘的进行中消息）。
          let record = null;
          let source = null;
          if (sessionId !== "") {
            const replay = await replaySessionCost(ctx, sessionId);
            if (replay !== null) {
              record = replay;
              source = "log";
            } else {
              const live = bySession.get(sessionId);
              if (live !== void 0) {
                record = live;
                source = "live";
              }
            }
          }
          if (record === null) {
            sendJson(res, 200, {
              ok: true,
              sessionId,
              cost: null,
              costUsd: null,
              calls: 0,
              inputTokens: 0,
              cacheReadTokens: 0,
              outputTokens: 0,
              breakdown: null
            });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            sessionId,
            source,
            cost: roundCost(record.cost),
            costUsd: roundCost(record.costUsd),
            calls: record.calls,
            inputTokens: record.inputTokens,
            cacheReadTokens: record.cacheReadTokens,
            outputTokens: record.outputTokens,
            breakdown: breakdownOf(record)
          });
        } catch (error) {
          ctx.logger.warn("dsh-deepseek-quota: session-cost lookup failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-deepseek-quota: session cost route"
  );
}

export { name, inject, apply };
