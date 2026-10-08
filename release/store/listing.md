# Chrome Web Store listing — Hermes Browser Control (MV3 MVP)

Paste-ready copy for the Chrome Web Store developer dashboard. Everything here must match
the *shipped* build (`mvp/extension`, version 0.3.0) — re-check after any permission or
behaviour change.

---

## Identity

| Field | Value |
| --- | --- |
| Name (≤45 chars) | `Hermes Browser Control` |
| Short name | `Hermes Control` |
| Category | Productivity (secondary: Developer Tools) |
| Language | English (default) |
| Store URL | _fill after first published review_ |
| Homepage | `https://hermes-agent.nousresearch.com` |
| Support | `https://hermes-agent.nousresearch.com/docs` + support email |
| Privacy policy URL | _public URL of `store/privacy-policy.html` — required, must resolve_ |

## Short description (≤132 characters)

```
Your own Hermes agent in your browser: it opens and drives a tab for you — navigate, click, type, read the page.
```

Alternate (keep the char count in range):

```
Bridge your Hermes agent to your real browser — your tabs, your logins, your machine.
```

## Detailed description

```
Hermes Browser Control connects your own Hermes agent to the browser you actually use —
your profile, your tabs, your logins — and gives it a pair of hands there.

WHAT IT DOES
• Your agent works in a tab it opens for you, inside its own tab group, so its browsing
  never gets mixed into yours.
• It can open tabs, navigate, click, type and read the page, and it hands the results back
  to the agent you already run.
• Sessions are automatic: connect your runtime and the agent is ready; the extension tells
  you, at a glance, whether it is armed and what the connection is doing.
• The extension ships one small page — the human stop: Pause, Reconnect, Kill. It opens
  as a popup right next to the toolbar icon, and there is no second chat window to learn,
  because the agent is the one you already use.

HOW IT WORKS
• Control uses Chrome's own debugging protocol (the same mechanism as DevTools) so clicks
  and typing are real trusted input, not synthetic events.
• A banner-free content-script path covers loopback pages where a debugging session is
  refused.
• The extension talks only to the Hermes runtime you configure — a loopback address on
  your machine by default, or a relay URL you set yourself. Pairing is handled by the
  local native host registered by your Hermes install.
• No account, no sign-up, no developer-operated server. There is no analytics pipeline and
  no upload of your browsing data to us.

SAFETY
• A built-in operation guard refuses sensitive destinations (banking, crypto, password
  managers, email, government/tax, medical, checkout) before any command runs.
• Host permissions are loopback only; the extension does not request access to every site.
• A kill switch tears the agent session and the relay connection down immediately.

WHAT YOU NEED
• A running Hermes runtime (local or remote) — this extension is the client, not the agent.
• Chrome 116 or newer (MV3).

PRIVACY, IN PLAIN WORDS
• Page content is read only in the tab the agent is working in, only while the session is
  live, and only to do what you asked.
• The permission prompt Chrome shows while attached ("…is debugging this browser") is
  expected: it is how the browser tells you an automation session is live. Stop it at any
  time from the control page.
• Full policy: see the privacy policy link on this page.

LIMITATIONS
• Firefox: chat works, tab attach does not.
• Chrome-internal pages (chrome://, the Web Store) cannot be attached — a browser rule,
  not a bug.
```

## "What's new" (release notes field, ≤ limit, per version)

```
0.3.0 — The side panel is gone: the extension is a bridge for your Hermes agent, with one
small control page that opens as a popup from the toolbar icon (Pause / Reconnect / Kill).
Dropped the sidePanel permission, the command box and the pairing form; commands now come
from your runtime over the local relay. Same narrow, loopback-only permissions.
```

## Russian listing (RU locale tab)

Краткое описание (≤132 символа):

```
Ваш Hermes-агент в вашем браузере: сам открывает и ведёт вкладку — переходы, клики, ввод, чтение страницы.
```

Полное описание:

```
Hermes Browser Control подключает вашего собственного Hermes-агента к браузеру, которым вы
реально пользуетесь — ваш профиль, ваши вкладки, ваши логины — и даёт ему там руки.

ЧТО ДЕЛАЕТ
• Агент работает во вкладке, которую открывает сам, в своей группе вкладок: его браузерная
  сессия не смешивается с вашей.
• Он открывает вкладки, переходит по адресам, кликает, печатает, читает страницу и отдаёт
  результат тому агенту, которым вы уже пользуетесь.
• Сессия включается сама: подключили рантайм — агент готов. Расширение показывает, вооружён
  ли агент и что происходит со связью.
• В расширении одна небольшая страница — человеческий стоп: Pause, Reconnect, Kill. Она
  открывается всплывающим окном у иконки. Второго окна чата учить не нужно: агент — тот,
  к которому вы привыкли.

КАК ЭТО РАБОТАЕТ
• Управление идёт через штатный протокол отладки Chrome (тот же механизм, что у DevTools),
  поэтому клики и ввод — настоящие доверенные события.
• Если сессия отладки недоступна, для страниц на localhost работает путь без баннера через
  content script.
• Расширение общается только с тем рантаймом Hermes, который настроили вы: по умолчанию
  адрес на вашей машине, либо relay, который вы задали сами. Пейринг делает локальный
  native host, который регистрирует установка Hermes.
• Ни аккаунта, ни регистрации, ни сервера разработчика. Аналитики нет, ваши данные просмотра
  нам не уходят.

БЕЗОПАСНОСТЬ
• Встроенный страж операций отказывает в чувствительных адресах (банки, крипта, менеджеры
  паролей, почта, госуслуги/налоги, медицина, оплата) до выполнения команды.
• Права хоста — только loopback; расширение не просит доступ ко всем сайтам.
• Кнопка kill мгновенно разрывает сессию агента и связь с рантаймом.

ОГРАНИЧЕНИЯ
• Firefox: чат работает, подключение вкладок — нет.
• Служебные страницы Chrome (chrome://, магазин) подключить нельзя — это правило браузера.
```

## Assets required by the dashboard

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128×128 | in package as `extension/` icon set (see `manifest.json`) |
| Screenshots | 1280×800 (up to 5) | **not captured** — needs a live runtime; shot list + recipe in `store/screenshots.md` |
| Small promo tile | 440×280 | `release/assets/promo-tile-440x280.png` |
| Marquee promo (optional) | 1400×560 | not shipped |
| YouTube video (optional) | URL | not shipped |

Screenshot shot list and capture recipe: `store/screenshots.md`.

## Review-risk notes (read before submitting)

1. **`debugger` permission** — the #1 rejection reason. Justification text and the reviewer
   demo are in `store/permission-justifications.md`. Do not submit without it.
2. **Host permissions** — loopback only (`http://127.0.0.1/*`, `http://localhost/*`). There
   is no broad-host question to answer in this build.
3. **Single purpose** — the listing must describe *one* purpose (agent-driven browser
   control). Do not add unrelated features to the description.
4. **Remote code** — none; every script is in the package, and `verify_package.py` scans for
   it. Keep it that way.
