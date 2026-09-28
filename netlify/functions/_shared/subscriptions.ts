import { getStore } from "@netlify/blobs";

export type WatchConfig = {
  name: string;
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

export type Subscription = {
  chatId: string;
  createdAt: string;
  updatedAt: string;
  watches: WatchConfig[];
};

type WatchTemplate = Omit<WatchConfig, "dates" | "times">;

const DEFAULT_SERVICES: Record<string, WatchTemplate> = {
  worldcupWeekendA: {
    name: "World Cup Park tennis A weekend",
    searchKeyword: "\uc6d4\ub4dc\ucef5\uacf5\uc6d0",
    titleIncludes: ["\uc6d4\ub4dc\ucef5\uacf5\uc6d0", "\ud14c\ub2c8\uc2a4\uc7a5", "A\uba74", "\uc8fc\ub9d0"],
  },
  seonamCourt5: {
    name: "Seonam Center tennis court 5",
    serviceId: "S210219091826906010",
    weekendsOnly: true,
  },
  seonamCourt7: {
    name: "Seonam Center tennis court 7",
    serviceId: "S210219092115226884",
    weekendsOnly: true,
  },
  seonamCourt12: {
    name: "Seonam Center tennis court 12",
    serviceId: "S210224095950585838",
    weekendsOnly: true,
  },
};

export async function getSubscription(chatId: string) {
  const store = getStore({ name: "tennis-subscriptions", consistency: "strong" });
  return await store.get(subscriptionKey(chatId), { type: "json" }) as Subscription | null;
}

export async function setSubscription(subscription: Subscription) {
  const store = getStore({ name: "tennis-subscriptions", consistency: "strong" });
  await store.setJSON(subscriptionKey(subscription.chatId), subscription);
}

export async function deleteSubscription(chatId: string) {
  const store = getStore({ name: "tennis-subscriptions", consistency: "strong" });
  await store.delete(subscriptionKey(chatId));
}

export async function listSubscriptions() {
  const store = getStore({ name: "tennis-subscriptions", consistency: "strong" });
  const { blobs } = await store.list({ prefix: "chat/" });
  const subscriptions: Subscription[] = [];

  for (const blob of blobs) {
    const subscription = await store.get(blob.key, { type: "json" }) as Subscription | null;
    if (subscription) subscriptions.push(subscription);
  }

  return subscriptions;
}

export function makeSubscription(chatId: string, text: string, now = new Date()) {
  const options = parseOptions(text);
  const dates = parseDates(options);
  const times = parseTimes(options.hour ?? options.time);
  const services = parseServices(options.court ?? options.courts);
  const weekdays = parseWeekdays(options.weekday ?? options.day);

  return {
    chatId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    watches: services.map((service) => ({
      ...service,
      weekdays,
      dates,
      times,
    })),
  } satisfies Subscription;
}

export function summarizeSubscription(subscription: Subscription | null) {
  if (!subscription) return "No subscription is set. Use /set date=10/3-10/31 hour=19,20";

  const lines = [
    `Subscription for chat ${subscription.chatId}`,
    `Updated: ${subscription.updatedAt}`,
  ];

  for (const watch of subscription.watches) {
    lines.push(`- ${watch.name}`);
    lines.push(`  dates: ${summarizeDates(watch.dates)}`);
    lines.push(`  times: ${(watch.times ?? []).join(", ") || "any"}`);
    lines.push(`  weekdays: ${summarizeWeekdays(watch.weekdays ?? [0, 6])}`);
  }

  return lines.join("\n");
}

function subscriptionKey(chatId: string) {
  return `chat/${chatId}.json`;
}

function parseOptions(text: string) {
  const options: Record<string, string> = {};
  for (const token of text.split(/\s+/).slice(1)) {
    const [key, ...rest] = token.split("=");
    if (key && rest.length > 0) options[key.toLowerCase()] = rest.join("=");
  }
  return options;
}

function parseServices(value?: string) {
  const requested = (value ?? "worldcup,seonam").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const services: WatchTemplate[] = [];

  for (const item of requested) {
    if (["worldcup", "worldcup-a", "\uc6d4\ub4dc\ucef5", "\uc6d4\ub4dc\ucef5\uacf5\uc6d0"].includes(item)) {
      services.push(DEFAULT_SERVICES.worldcupWeekendA);
    } else if (["seonam", "\uc11c\ub0a8", "\uc11c\ub0a8\uc13c\ud130"].includes(item)) {
      services.push(DEFAULT_SERVICES.seonamCourt5, DEFAULT_SERVICES.seonamCourt7, DEFAULT_SERVICES.seonamCourt12);
    } else if (["seonam5", "5"].includes(item)) {
      services.push(DEFAULT_SERVICES.seonamCourt5);
    } else if (["seonam7", "7"].includes(item)) {
      services.push(DEFAULT_SERVICES.seonamCourt7);
    } else if (["seonam12", "12"].includes(item)) {
      services.push(DEFAULT_SERVICES.seonamCourt12);
    }
  }

  return services.length > 0
    ? services
    : [DEFAULT_SERVICES.worldcupWeekendA, DEFAULT_SERVICES.seonamCourt5, DEFAULT_SERVICES.seonamCourt7, DEFAULT_SERVICES.seonamCourt12];
}

function parseDates(options: Record<string, string>) {
  if (options.date) {
    return options.date.split(",").flatMap(parseDateValue);
  }

  const start = options.start ? parseDateToken(options.start) : todayKst();
  const end = options.end ? parseDateToken(options.end, start) : addDays(start, 30);
  return expandRange(start, end);
}

function parseDateValue(value: string) {
  const rangeMatch = value.trim().match(/^(.+?)-(.+)$/);
  if (!rangeMatch) return [parseDateToken(value)];

  const start = parseDateToken(rangeMatch[1]);
  const end = parseDateToken(rangeMatch[2], start);
  return expandRange(start, end);
}

function expandRange(start: string, end: string) {
  const dates = [];
  let cursor = start;

  while (cursor <= end) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  return dates;
}

function parseTimes(value?: string) {
  if (!value) return undefined;
  return value.split(",").map((item) => {
    const match = item.trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return item.trim();
    return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
  });
}

function parseDateToken(value: string, baseDate?: string) {
  const parts = value.trim().split(/[/-]/).map(Number);
  const now = new Date();
  const kstYear = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric" }).format(now);
  const baseYear = baseDate ? Number(baseDate.slice(0, 4)) : Number(kstYear);

  if (parts.length === 1 && baseDate) {
    return formatDate(baseYear, Number(baseDate.slice(5, 7)), parts[0]);
  }
  if (parts.length === 2) {
    return formatDate(baseYear, parts[0], parts[1]);
  }
  if (parts.length === 3) {
    return formatDate(parts[0], parts[1], parts[2]);
  }
  throw new Error(`Invalid date: ${value}`);
}

function todayKst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function summarizeDates(dates: string[]) {
  if (dates.length <= 8) return dates.join(", ");
  return `${dates[0]} ... ${dates[dates.length - 1]} (${dates.length} days)`;
}

function parseWeekdays(value?: string): number[] {
  if (!value) return [0, 6];

  const dayNames: Record<string, number> = {
    sun: 0, 일: 0,
    mon: 1, 월: 1,
    tue: 2, 화: 2,
    wed: 3, 수: 3,
    thu: 4, 목: 4,
    fri: 5, 금: 5,
    sat: 6, 토: 6,
  };

  const days = new Set<number>();
  for (const token of value.split(",")) {
    const trimmed = token.trim().toLowerCase();

    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      if (num >= 0 && num <= 6) days.add(num);
    } else if (dayNames[trimmed] !== undefined) {
      days.add(dayNames[trimmed]);
    }
  }

  return days.size > 0 ? Array.from(days).sort((a, b) => a - b) : [0, 6];
}

function summarizeWeekdays(weekdays: number[]): string {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return weekdays.map((d) => dayNames[d]).join(",");
}
