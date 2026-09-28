import type { Config } from "@netlify/functions";
import checkTennis from "./check-tennis.js";
import { deleteSubscription, getSubscription, makeSubscription, setSubscription, summarizeSubscription } from "./_shared/subscriptions.js";

type TelegramUpdate = {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
};

type CheckResponse = {
  ok?: boolean;
  checkedAt?: string;
  durationMs?: number;
  results?: Array<{
    watch?: { name?: string };
    date?: string;
    dateAvailable?: boolean;
    countText?: string;
    matchingTimes?: string[];
    timeCheck?: string;
    reason?: string;
    url?: string;
  }>;
  alertCandidates?: number;
  error?: string;
};

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: true, message: "Telegram webhook endpoint. Use POST." });
  }

  const expectedSecret = Netlify.env.get("TELEGRAM_WEBHOOK_SECRET");
  const actualSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (expectedSecret && actualSecret !== expectedSecret) {
    return json({ ok: false, error: "Invalid Telegram webhook secret." }, 401);
  }

  const update = await req.json().catch(() => undefined) as TelegramUpdate | undefined;
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text?.trim() ?? "";

  if (!chatId) {
    return json({ ok: true, ignored: "missing chat id" });
  }

  if (text.startsWith("/check")) {
    await sendTelegram(chatId, "Checking tennis slots now...");
    const result = await runDryCheck(req.url);
    await sendTelegram(chatId, formatCheckSummary(result));
    return json({ ok: true, command: "/check" });
  }

  if (text.startsWith("/set")) {
    try {
      const subscription = makeSubscription(String(chatId), text);
      await setSubscription(subscription);
      await sendTelegram(chatId, `Subscription saved\n${summarizeSubscription(subscription)}`);
    } catch (error) {
      await sendTelegram(chatId, `Failed to save subscription\n${formatError(error)}`);
    }
    return json({ ok: true, command: "/set" });
  }

  if (text.startsWith("/clear")) {
    await deleteSubscription(String(chatId));
    await sendTelegram(chatId, "Subscription cleared.");
    return json({ ok: true, command: "/clear" });
  }

  if (text.startsWith("/status")) {
    const subscription = await getSubscription(String(chatId));
    await sendTelegram(chatId, summarizeSubscription(subscription));
    return json({ ok: true, command: "/status" });
  }

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(chatId, [
      "Available commands:",
      "/set date=10/3,10/4 hour=19,20",
      "/set start=10/1 end=10/31 hour=18,19 court=worldcup,seonam",
      "/check - run a tennis availability check now",
      "/status - show bot status",
      "/clear - remove your saved subscription",
    ].join("\n"));
    return json({ ok: true, command: "help" });
  }

  return json({ ok: true, ignored: text || "empty message" });
};

export const config: Config = {
  path: "/telegram",
};

async function runDryCheck(baseUrl: string): Promise<CheckResponse> {
  const url = new URL(baseUrl);
  url.pathname = "/.netlify/functions/check-tennis";
  url.search = "?dryRun=1";

  const response = await checkTennis(new Request(url));
  return await response.json() as CheckResponse;
}

async function sendTelegram(chatId: string | number, text: string) {
  const token = Netlify.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

function formatCheckSummary(result: CheckResponse) {
  if (!result.ok) {
    return `Check failed\n${result.error ?? "Unknown error"}`;
  }

  const results = result.results ?? [];
  const available = results.filter((item) => item.dateAvailable);
  const matched = results.filter((item) => item.timeCheck === "matched");
  const unknown = results.filter((item) => item.timeCheck === "unknown");

  const lines = [
    "Tennis check complete",
    `Checked: ${result.checkedAt ?? new Date().toISOString()}`,
    `Duration: ${result.durationMs ?? "?"}ms`,
    `Available dates: ${available.length}/${results.length}`,
    `Matched times: ${matched.length}`,
    unknown.length > 0 ? `Unknown time checks: ${unknown.length}` : undefined,
  ].filter(Boolean) as string[];

  const highlights = [...matched, ...(matched.length === 0 ? available : [])].slice(0, 8);
  for (const item of highlights) {
    const times = item.matchingTimes && item.matchingTimes.length > 0 ? ` ${item.matchingTimes.join(", ")}` : "";
    lines.push(`- ${item.watch?.name ?? "watch"} ${item.date ?? ""}${times} ${item.countText ?? ""}`.trim());
  }

  if (highlights.length === 0 && unknown.length > 0) {
    lines.push("Some date checks succeeded, but time-slot details were unknown. Check Netlify logs for details.");
  }

  if (highlights.length === 0 && available.length === 0) {
    lines.push("No matching availability found.");
  }

  return lines.join("\n");
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
