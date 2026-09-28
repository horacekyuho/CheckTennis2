# Check Tennis Bot

Netlify에서 1분마다 `https://kyutennis.netlify.app/`의 예약 API를 확인하고, 조건에 맞는 예약 가능 건이 있으면 텔레그램으로 알려주는 봇입니다.

## 환경 변수

Netlify Site settings 또는 CLI에서 설정하세요. 비밀 값이므로 `netlify.toml`에 넣지 않습니다.

- `TELEGRAM_BOT_TOKEN`: BotFather에서 받은 텔레그램 봇 토큰
- `TELEGRAM_WEBHOOK_SECRET`: 선택 값. webhook 요청 검증용 임의 문자열

## Telegram webhook 설정

배포 후 아래 URL을 호출합니다.

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://YOUR_SITE.netlify.app/api/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

`TELEGRAM_WEBHOOK_SECRET`를 쓰지 않을 경우 `secret_token` 파라미터는 빼도 됩니다.

## 텔레그램 명령어

```text
/set start=8/24 end=9/30 hour=7,18,19,20,21
/set date=8/21,8/23 hour=18,19,20 interval=10
/status
/check
/clear
```

옵션:

- `start`: 시작일. `YYYY-MM-DD`, `YYYY/M/D`, `M/D` 형식을 지원합니다. 연도를 생략하면 올해로 인식합니다.
- `end`: 종료일. 생략하면 `start`가 속한 달의 마지막 날로 자동 설정됩니다. 예: `start=8/24 end=9/30`
- `date`: 지정한 날짜만 조회합니다. 예: `date=8/21,8/23`.
- `hour`: 원하는 시작 시간 목록, 예: `6,7,18,19`
- `interval`: 자동 체크 주기입니다. 최소 1분, 최대 60분입니다. 예: `interval=5`. `interval=1`이면 1분마다 시작한 뒤 약 30초 후 한 번 더 조회합니다.
- `ttl`: 같은 예약 건의 중복 알림을 무시할 시간입니다. 단위는 시간이고, 기본값은 1시간입니다. 예: `ttl=3`
- `weekend`: 생략하거나 `weekend=false`이면 주말을 제외합니다. 주말도 포함하려면 `weekend=true`를 입력하세요.

## 동작 방식

- 설정은 Netlify Blobs의 `subscriptions` store에 저장됩니다.
- 자동 알림은 조건에 맞는 예약 가능 건이 있으면 보냅니다. 같은 예약 건은 `ttl` 시간 안에는 다시 알리지 않습니다.
- `/check`는 중복 여부와 상관없이 현재 조건에 맞는 결과를 즉시 보여줍니다.
- `netlify/functions/check-reservations.ts`는 1분마다 실행되어 background 함수를 호출하고, background 함수는 즉시 조회한 뒤 약 30초 후 한 번 더 조회합니다. 사용자별 `interval` 설정에 맞춰 실제 조회를 건너뜁니다.
- `netlify/functions/telegram.ts`는 텔레그램 명령을 받아 설정을 저장하거나 즉시 조회합니다.
