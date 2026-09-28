import type { Config } from "@netlify/functions";
import { listSubscriptions } from "./_shared/subscriptions.js";

type Watch = {
  name?: string;
  serviceId?: string;
  url?: string;
  searchKeyword?: string;
  titleIncludes?: string[];
  titleExcludes?: string[];
  weekendsOnly?: boolean;
  dates?: string[];
  times?: string[];
};

export default async () => {
  const telegramBotToken = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  const telegramChatId = Netlify.env.get("TELEGRAM_CHAT_ID");
  const rawWatches = Netlify.env.get("WATCHES_JSON");
  const subscriptions = await listSubscriptions().catch(() => []);

  let watches: Watch[] = [];
  let watchesError: string | undefined;

  try {
    watches = rawWatches ? JSON.parse(rawWatches) : [];
    if (!Array.isArray(watches)) {
      watchesError = "WATCHES_JSON must be a JSON array.";
      watches = [];
    }
  } catch (error) {
    watchesError = error instanceof Error ? error.message : String(error);
  }

  const watchSummaries = watches.map((watch) => ({
    name: watch.name ?? null,
    target: watch.serviceId ? "serviceId" : watch.url ? "url" : watch.searchKeyword ? "searchKeyword" : "missing",
    serviceId: watch.serviceId ?? null,
    searchKeyword: watch.searchKeyword ?? null,
    titleIncludes: watch.titleIncludes ?? [],
    weekendsOnly: Boolean(watch.weekendsOnly),
    dates: watch.dates ?? [],
    times: watch.times ?? [],
    valid: Boolean(
      watch.name
      && (watch.serviceId || watch.url || watch.searchKeyword)
      && Array.isArray(watch.dates)
      && watch.dates.length > 0,
    ),
  }));

  const ok = Boolean(telegramBotToken && !watchesError && watchSummaries.every((watch) => watch.valid));

  return json({
    ok,
    checkedAt: new Date().toISOString(),
    schedule: "* * * * *",
    endpoints: {
      status: "/status",
      checkDryRun: "/check",
      checkAndSendTelegram: "/check?send=1",
    },
    env: {
      TELEGRAM_BOT_TOKEN: telegramBotToken ? "set" : "missing",
      TELEGRAM_CHAT_ID: telegramChatId ? "set" : "missing",
      TELEGRAM_WEBHOOK_SECRET: Netlify.env.get("TELEGRAM_WEBHOOK_SECRET") ? "set" : "missing",
      WATCHES_JSON: rawWatches ? "set" : "missing",
    },
    subscriptions: subscriptions.length,
    configured: Boolean(rawWatches || subscriptions.length > 0),
    watchesError,
    watches: watchSummaries,
  });
};

export const config: Config = {
  path: "/status",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
