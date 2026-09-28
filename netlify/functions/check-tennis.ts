import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Browser, type Page } from "playwright-core";
import { listSubscriptions, type Subscription } from "./_shared/subscriptions.js";

type Watch = {
  name: string;
  chatId?: string;
  serviceId?: string;
  url?: string;
  searchKeyword?: string;
  titleIncludes?: string[];
  titleExcludes?: string[];
  weekendsOnly?: boolean;
  weekdays?: number[];
  dates: string[];
  times?: string[];
};

type ResolvedService = {
  name: string;
  serviceId?: string;
  url: string;
  title?: string;
};

type CalendarResponse = {
  resultStats?: {
    resultCode?: string;
    resultMsg?: string;
  };
  resultListDays?: Array<{
    YMD?: string;
    SVC_RESVE_CODE?: string;
  }>;
  resultListTm?: Record<string, {
    RCEPT_POSBL_YN?: string;
    RESVE_POSBL_CNT?: number | string;
    REG_TOTAL_CNT?: number | string;
    RCRIT_NMPR_CNT?: number | string;
  }>;
};

type SlotResult = {
  watch: Watch;
  date: string;
  dateAvailable: boolean;
  countText?: string;
  matchingTimes: string[];
  timeCheck: "not_requested" | "matched" | "not_matched" | "unknown";
  url: string;
  reason?: string;
};

const SEOUL_BASE_URL = "https://yeyak.seoul.go.kr";

export default async (req: Request) => {
  const startedAt = new Date();
  const watches = await parseWatches();
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";

  if (watches.length === 0) {
    return json({
      ok: true,
      idle: true,
      checkedAt: startedAt.toISOString(),
      message: "No watches configured. Use Telegram /set or set WATCHES_JSON.",
      results: [],
      alertCandidates: 0,
      sent: [],
    });
  }

  let browser: Browser | undefined;

  try {
    console.log("Starting browser launch...", { watchCount: watches.length });
    browser = await launchBrowser();
    console.log("Browser launched", { elapsedMs: Date.now() - startedAt.getTime() });
    const results: SlotResult[] = [];

    for (const watch of watches) {
      const page = await browser.newPage();
      try {
        results.push(...await checkWatch(page, watch));
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    const alerts = results.filter(shouldAlert);
    const sent = dryRun ? [] : await sendNewAlerts(alerts);
    const totalMs = Date.now() - startedAt.getTime();

    console.log("Check complete", { results: results.length, alerts: alerts.length, totalMs });
    return json({
      ok: true,
      dryRun,
      checkedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      results,
      alertCandidates: alerts.length,
      sent,
    });
  } catch (error) {
    console.error(error);
    if (!dryRun) {
      const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
      const chatId = Netlify.env.get("TELEGRAM_CHAT_ID");
      if (token && chatId) {
        await sendTelegram(`Tennis monitor error\n${formatError(error)}`).catch(console.error);
      }
    }
    return json({
      ok: false,
      checkedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      error: formatError(error),
      results: [],
      alertCandidates: 0,
      sent: [],
    });
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

export const config: Config = {
  schedule: "* * * * *",
};

async function launchBrowser() {
  const executablePath = await chromium.executablePath();

  return playwrightChromium.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
}

async function checkWatch(page: Page, watch: Watch): Promise<SlotResult[]> {
  validateWatch(watch);

  const results: SlotResult[] = [];
  const services = await resolveServices(watch);

  for (const service of services) {
    await page.goto(service.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForFunction(() => typeof (window as any).$ === "function" && Boolean(document.querySelector("#aform")), null, {
      timeout: 10_000,
    });

    const serviceWatch = {
      ...watch,
      name: service.title ? `${watch.name} - ${service.title}` : service.name,
      serviceId: service.serviceId ?? watch.serviceId,
      url: service.url,
    };
    const datesByMonth = groupDatesByMonth(filterDates(watch.dates, watch.weekdays ?? (watch.weekendsOnly ? [0, 6] : undefined)));

    for (const [yyyymm, dates] of datesByMonth) {
      const calendar = await readCalendar(page, yyyymm);

      for (const date of dates) {
        const ymd = compactDate(date);
        const day = calendar.resultListDays?.find((item) => item.YMD === ymd);
        const tm = calendar.resultListTm?.[ymd];
        const dateAvailable = day?.SVC_RESVE_CODE === "Y" && tm?.RCEPT_POSBL_YN === "1" && Number(tm.RESVE_POSBL_CNT ?? 0) > 0;
        const countText = tm ? `${tm.REG_TOTAL_CNT ?? "?"}/${tm.RCRIT_NMPR_CNT ?? "?"}` : undefined;

        if (!dateAvailable) {
          results.push({
            watch: serviceWatch,
            date,
            dateAvailable: false,
            countText,
            matchingTimes: [],
            timeCheck: "not_requested",
            url: service.url,
            reason: "date_not_available",
          });
          continue;
        }

        const requestedTimes = normalizeTimes(watch.times ?? []);
        if (requestedTimes.length === 0) {
          results.push({
            watch: serviceWatch,
            date,
            dateAvailable: true,
            countText,
            matchingTimes: [],
            timeCheck: "not_requested",
            url: service.url,
          });
          continue;
        }

        const timeResult = await readTimeAvailability(page, ymd, requestedTimes);
        results.push({
          watch: serviceWatch,
          date,
          dateAvailable: true,
          countText,
          matchingTimes: timeResult.matches,
          timeCheck: timeResult.status,
          url: service.url,
          reason: timeResult.reason,
        });
      }
    }
  }

  return results;
}

async function resolveServices(watch: Watch): Promise<ResolvedService[]> {
  if (watch.url || watch.serviceId) {
    return [{
      name: watch.name,
      serviceId: watch.serviceId,
      url: watch.url ?? `${SEOUL_BASE_URL}/web/reservation/selectReservView.do?rsv_svc_id=${encodeURIComponent(watch.serviceId ?? "")}`,
    }];
  }

  const keyword = watch.searchKeyword?.trim();
  if (!keyword) return [];

  const body = new URLSearchParams({
    code: "T100",
    dCode: "T108",
    sch_text: keyword,
    search: keyword,
    search2: keyword,
    sch_order: "1",
    sch_view_type: "1",
    currentPage: "1",
  });

  const response = await fetch(`${SEOUL_BASE_URL}/web/search/selectPageListDetailSearchImg.do`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 tennis availability monitor",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`${watch.name}: search failed ${response.status}`);
  }

  const html = await response.text();
  const services = parseSearchResults(html)
    .filter((service) => matchesTitleFilters(service.title, watch))
    .map((service) => ({
      ...service,
      name: service.title,
      url: `${SEOUL_BASE_URL}/web/reservation/selectReservView.do?rsv_svc_id=${encodeURIComponent(service.serviceId)}`,
    }));

  if (services.length === 0) {
    throw new Error(`${watch.name}: no reservation services matched searchKeyword/title filters.`);
  }

  return services;
}

function parseSearchResults(html: string) {
  const pattern = /fnDetailPage\('([^']+)'[^)]*\)[^>]*title="([^"]+)"/g;
  const results: Array<{ serviceId: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    results.push({
      serviceId: match[1],
      title: decodeHtml(match[2]),
    });
  }

  return results;
}

function matchesTitleFilters(title: string, watch: Watch) {
  const includes = watch.titleIncludes ?? [];
  const excludes = watch.titleExcludes ?? [];
  return includes.every((part) => title.includes(part)) && excludes.every((part) => !title.includes(part));
}

async function readCalendar(page: Page, yyyymm: string): Promise<CalendarResponse> {
  const year = yyyymm.slice(0, 4);
  const month = yyyymm.slice(4, 6);

  return page.evaluate(async ({ year, month, yyyymm }: { year: string; month: string; yyyymm: string }) => {
    const $ = (window as any).$;
    $("#yyyy").val(year);
    $("#mm").val(month);
    $("#yyyymm").val(yyyymm);
    $("#sltYear").val(year);
    $("#sltMonth").val(month);

    return await new Promise((resolve, reject) => {
      $.ajax({
        type: "POST",
        dataType: "json",
        url: "/web/reservation/selectListReservCalAjax.do",
        data: $("#aform").serialize(),
        success: resolve,
        error: (xhr: any, textStatus: string, thrownError: unknown) => {
          reject(new Error(`calendar ajax failed: ${textStatus} ${thrownError ?? ""} ${xhr?.status ?? ""}`));
        },
      });
    });
  }, { year, month, yyyymm });
}

async function readTimeAvailability(page: Page, ymd: string, requestedTimes: string[]) {
  try {
    const html = await page.evaluate(async ({ ymd }: { ymd: string }) => {
      const $ = (window as any).$;
      $("#useDe").val(ymd);
      $("#aform").find('input[name="formToken"]').remove();
      $("#aform").append(`<input type="hidden" name="formToken" value="${Date.now()}" />`);

      return await new Promise<string>((resolve, reject) => {
        $.ajax({
          type: "POST",
          dataType: "html",
          url: "/web/reservation/insertFormReserve.do",
          data: $("#aform").serialize(),
          success: resolve,
          error: (xhr: any, textStatus: string, thrownError: unknown) => {
            reject(new Error(`time form ajax failed: ${textStatus} ${thrownError ?? ""} ${xhr?.status ?? ""}`));
          },
        });
      });
    }, { ymd });

    const text = stripHtml(html);
    if (looksLikeLoginPage(text)) {
      return {
        status: "unknown" as const,
        matches: [],
        reason: "reservation_form_requires_login",
      };
    }

    const matches = requestedTimes.filter((time) => hasAvailableTime(html, time));
    return {
      status: matches.length > 0 ? "matched" as const : "not_matched" as const,
      matches,
    };
  } catch (error) {
    return {
      status: "unknown" as const,
      matches: [],
      reason: formatError(error),
    };
  }
}

function hasAvailableTime(html: string, time: string) {
  const normalizedHtml = html.replace(/\s+/g, " ");
  const patterns = timePatterns(time);

  for (const pattern of patterns) {
    const index = normalizedHtml.indexOf(pattern);
    if (index < 0) continue;

    const windowText = normalizedHtml.slice(Math.max(0, index - 180), index + 220);
    if (!/(closed|unavailable|disabled|sold out|full|마감|불가)/i.test(windowText)) {
      return true;
    }
  }

  return false;
}

function shouldAlert(result: SlotResult) {
  if (!result.dateAvailable) return false;
  if (result.timeCheck === "not_requested") return true;
  return result.timeCheck === "matched";
}

async function sendNewAlerts(results: SlotResult[]) {
  const store = getStore({ name: "tennis-alert-state", consistency: "strong" });
  const sent: string[] = [];
  const activeKeys = new Set(results.map(alertKey));

  for (const result of results) {
    const key = alertKey(result);
    const existing = await store.get(key);
    if (existing) continue;

    await sendTelegram(formatAlert(result), result.watch.chatId);
    await store.setJSON(key, {
      sentAt: new Date().toISOString(),
      watch: result.watch.name,
      date: result.date,
      matchingTimes: result.matchingTimes,
    });
    sent.push(key);
  }

  const { blobs } = await store.list();
  await Promise.all(
    blobs
      .filter((blob: { key: string }) => blob.key.startsWith("slot/") && !activeKeys.has(blob.key))
      .map((blob: { key: string }) => store.delete(blob.key)),
  );

  return sent;
}

async function sendTelegram(text: string, chatIdOverride?: string) {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = chatIdOverride ?? Netlify.env.get("TELEGRAM_CHAT_ID");

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  if (!chatId) {
    throw new Error("No chat ID specified. Use Telegram /set command or set TELEGRAM_CHAT_ID.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

function formatAlert(result: SlotResult) {
  const times = result.matchingTimes.length > 0 ? result.matchingTimes.join(", ") : "date available";
  return [
    "Tennis reservation available",
    `Court: ${result.watch.name}`,
    `Date: ${result.date}`,
    `Time: ${times}`,
    result.countText ? `Count: ${result.countText}` : undefined,
    `Link: ${result.url}`,
  ].filter(Boolean).join("\n");
}

async function parseWatches(): Promise<Watch[]> {
  const raw = Netlify.env.get("WATCHES_JSON");
  const watches = raw ? JSON.parse(raw) as Watch[] : [];

  if (!Array.isArray(watches)) {
    throw new Error("WATCHES_JSON must be a JSON array.");
  }

  const subscriptions = await listSubscriptions().catch((error) => {
    console.error("Failed to list subscriptions", error);
    return [] as Subscription[];
  });

  return [
    ...watches,
    ...subscriptions.flatMap((subscription) => subscription.watches.map((watch) => ({
      ...watch,
      chatId: subscription.chatId,
    }))),
  ];
}

function validateWatch(watch: Watch) {
  if (!watch.name) throw new Error("Every watch needs a name.");
  if (!watch.serviceId && !watch.url && !watch.searchKeyword) {
    throw new Error(`${watch.name}: serviceId, url, or searchKeyword is required.`);
  }
  if (!Array.isArray(watch.dates) || watch.dates.length === 0) throw new Error(`${watch.name}: dates are required.`);
}

function groupDatesByMonth(dates: string[]) {
  const groups = new Map<string, string[]>();
  for (const date of dates) {
    const ymd = compactDate(date);
    const yyyymm = ymd.slice(0, 6);
    groups.set(yyyymm, [...(groups.get(yyyymm) ?? []), date]);
  }
  return groups;
}

function filterDates(dates: string[], allowedWeekdays?: number[]) {
  if (!allowedWeekdays) return dates;
  return dates.filter((date) => {
    const ymd = compactDate(date);
    const year = Number(ymd.slice(0, 4));
    const month = Number(ymd.slice(4, 6)) - 1;
    const day = Number(ymd.slice(6, 8));
    const weekday = new Date(Date.UTC(year, month, day)).getUTCDay();
    return allowedWeekdays.includes(weekday);
  });
}

function normalizeTimes(times: string[]) {
  return times.map((time) => {
    const match = time.match(/^(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return time;
    return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
  });
}

function timePatterns(time: string) {
  const [hour, minute] = time.split(":");
  return [
    `${hour}:${minute}`,
    `${Number(hour)}:${minute}`,
  ];
}

function compactDate(date: string) {
  const compact = date.replace(/\D/g, "");
  if (!/^\d{8}$/.test(compact)) {
    throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  }
  return compact;
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function looksLikeLoginPage(text: string) {
  return /login|password|member|로그인|비밀번호|본인인증/i.test(text) && !/time|reservation|예약/.test(text);
}

function alertKey(result: SlotResult) {
  const service = result.watch.serviceId ?? result.watch.url ?? result.watch.name;
  const times = result.matchingTimes.length > 0 ? result.matchingTimes.join("_") : "date";
  return `slot/${slug(`${service}_${result.date}_${times}`)}.json`;
}

function slug(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
