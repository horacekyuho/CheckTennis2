# Check Tennis

Netlify scheduled function that checks Seoul public tennis reservation pages every minute and sends Telegram alerts when a watched slot appears.

## Environment Variables

Set these in Netlify:

```json
WATCHES_JSON=[
  {
    "name": "월드컵공원 테니스장 A면 주말",
    "searchKeyword": "월드컵공원",
    "titleIncludes": ["월드컵공원", "테니스장", "A면", "주말"],
    "dates": ["2026-10-03", "2026-10-04", "2026-10-10", "2026-10-11"],
    "times": ["19:00", "20:00"]
  },
  {
    "name": "서남센터 테니스장5번 코트",
    "serviceId": "S210219091826906010",
    "weekendsOnly": true,
    "dates": ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-10", "2026-10-11"],
    "times": ["19:00", "20:00"]
  }
]
```

Also set:

```text
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_WEBHOOK_SECRET=some-long-random-string
```

`TELEGRAM_CHAT_ID` is optional now. It is only used for static `WATCHES_JSON` automatic alerts. Telegram `/set` subscriptions reply to the chat that created them.

`serviceId` may be replaced with a full `url` if needed. For monthly services such as World Cup Park, prefer `searchKeyword` with `titleIncludes` so the function finds the current month's service automatically. Use `weekendsOnly: true` when a service does not split weekday/weekend in its title but you only want Saturday/Sunday dates checked.

## Useful Service IDs

Current search results found these Seoul reservation services:

### 월드컵공원

World Cup Park uses monthly service IDs, so prefer `searchKeyword`.

```text
S260911092705042045  10월 월드컵공원 테니스장 A면 (평일주간)
S260911094615300333  10월 월드컵공원 테니스장 A면 (주말)
S260911100613350759  10월 월드컵공원 테니스장 B면 (평일주간)
S260911101641344630  10월 월드컵공원 테니스장 B면 (평일야간)
```

### 서남센터

```text
S210224095950585838  서남센터 테니스장12번 코트
S210218174815551697  서남센터 테니스장1번 65세이상 전용코트
S210219085555417413  서남센터 테니스장2번 65세이상 전용코트
S210219091235657961  서남센터 테니스장3번 전용코트
S210219091826906010  서남센터 테니스장5번 코트
S210219092115226884  서남센터 테니스장7번 코트
```

## Endpoints

- Scheduled: every minute via `* * * * *`
- Status: `/status`
- Manual dry run: `/check`
- Manual check and Telegram send: `/check?send=1`
- Telegram webhook: `/telegram`
- Function fallback: `/.netlify/functions/check-tennis?dryRun=1`

## Telegram Commands

After deploy, register the webhook:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-site>.netlify.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Then send this to the bot in Telegram:

```text
/set date=10/3,10/4 hour=19,20
/check
```

Commands:

```text
/set date=10/3,10/4 hour=19,20
/set start=10/1 end=10/31 hour=18,19 court=worldcup,seonam
/status
/check
/clear
```

Options:

- `date`: comma-separated dates, e.g. `10/3,10/4` or `2026-10-03`.
- `start`, `end`: date range. If omitted, defaults to today through 30 days from today.
- `hour` or `time`: comma-separated start times, e.g. `18,19,20`.
- `court`: `worldcup`, `seonam`, `seonam5`, `seonam7`, `seonam12`.
- `weekend`: defaults to `true`. Use `weekend=false` to include weekdays too.

The bot stores each chat's subscription in Netlify Blobs. The scheduled monitor checks saved subscriptions every minute and sends alerts back to the subscribed chat.

## Notes

The function opens the Seoul reservation detail page in Chromium so the site's in-page anti-direct-access script can run normally. It checks date availability from the calendar Ajax response. When times are configured, it tries to load the reservation form for the selected date and match the requested time labels. If the form requires login before exposing time slots, the result is marked `unknown` and no time alert is sent.
