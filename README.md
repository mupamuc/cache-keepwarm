# cache-keepwarm

Мод для Claude Code, который не дает кэшу промпта истечь, пока сессия простаивает. За пару минут до истечения кэша мод отправляет в чат короткое служебное сообщение. Модель читает контекст из кэша, и срок жизни кэша начинается заново.

[English below](#english)

## Зачем

Claude Code кэширует начало промпта: системные инструкции, файлы, историю разговора. На подписке Claude кэш живет 1 час, на API-ключе 5 минут, и каждый запрос, который его читает, продлевает срок. По [документации Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) чтение из кэша стоит 0,1 цены обычного ввода, запись в кэш на 1 час стоит 2x, на 5 минут 1,25x.

Пример: контекст 150 тыс. токенов, вы ушли на обед. Без мода первое сообщение после перерыва заново запишет весь контекст, это 300 тыс. токенов в пересчете на обычный ввод. Пинг мода прочитает его из кэша за 15 тыс. и короткий ответ «ok». Один пинг примерно в 20 раз дешевле перезаписи.

Пинг выгоден, только если вы вернетесь. Поэтому мод выключен по умолчанию и делает не больше 3 пингов подряд, потом кэш истекает сам.

## Установка

Нужен Claude Code 2.1.259 или новее: моды работают на функциональных хуках, это ранний доступ. Мод проверен в Claude Code 2.1.287, в настольном приложении флаг не понадобился. Если мод не загрузился, задайте переменную `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

macOS, Linux, Git Bash:

```bash
git clone --depth 1 https://github.com/mupamuc/cache-keepwarm ~/.claude/skills/cache-keepwarm
```

Windows PowerShell:

```powershell
git clone --depth 1 https://github.com/mupamuc/cache-keepwarm "$HOME\.claude\skills\cache-keepwarm"
```

Мод подключится в новой сессии. Обновление: `git pull` в этой папке. Удаление: удалить папку.

## Как пользоваться

| Команда | Что делает |
| --- | --- |
| `/keepwarm on` | включает мод, выбор сохраняется между сессиями |
| `/keepwarm off` | выключает |
| `/keepwarm status` | показывает, когда будет пинг и сколько пингов осталось |

Пока мод включен, в строке состояния видно `cache-keepwarm 14:52 · 0/3`: время следующего пинга и сколько пингов подряд уже было. Перед пингом приходит уведомление, сам пинг виден в чате как сообщение от мода.

## Правила пинга

Мод отправляет пинг, только если выполнены все условия:

- мод включен;
- сессия простаивает, модель ничего не делает;
- до истечения кэша осталось меньше `leadSeconds`, но кэш еще жив (пинг позже чем за 15 секунд до истечения может не успеть);
- в кэше не меньше `minTokens` токенов;
- после вашего последнего сообщения было меньше `maxPings` пингов.

Мод запоминает время последнего запроса вместе с id сессии. После перезапуска приложения или `--resume` той же сессии отсчет продолжается, ждать вашего сообщения не нужно.

Ваше сообщение, уведомление фоновой задачи или сообщение другой сессии сбрасывает счетчик пингов. Запросы субагентов мод не учитывает: у них свой кэш.

## Настройки

| Параметр | По умолчанию | Смысл |
| --- | --- | --- |
| `enabled` | `false` | включен ли мод, если `/keepwarm` еще ни разу не вызывали |
| `ttl` | `1h` | срок кэша: `1h` на подписке, `5m` на API-ключе, у облачного провайдера, при оплате по использованию |
| `leadSeconds` | `120` | за сколько секунд до истечения слать пинг, не больше половины срока |
| `maxPings` | `3` | сколько пингов подряд без вашего сообщения |
| `minTokens` | `20000` | кэш меньше этого дешево пересоздать, его мод не трогает |
| `message` | пусто | свой текст пинга, пусто значит встроенный |

В терминальной версии параметры меняются через `/config`. В настольном приложении их задают в `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "cache-keepwarm@skills-dir": {
      "options": { "ttl": "5m", "maxPings": 2 }
    }
  }
}
```

## Проверка

04.10.2026, Claude Code 2.1.286, настольное приложение для Windows, подписка Claude, контекст около 190 тыс. токенов. Мод отправил три пинга подряд примерно раз в час. Модель на каждый ответила одним «ok» без вызова инструментов. После третьего пинга мод остановился (`3/3 wait`). Доля попаданий в кэш после пингов была 100 %, то есть контекст ни разу не записывался заново.

Восстановление отсчета после перезапуска приложения в живой сессии пока не проверено.

## Ограничения

- Мод работает, пока сессия открыта. Закрытое приложение или спящий компьютер пинг не отправят.
- Пинг и ответ «ok» остаются в истории разговора, по несколько десятков токенов на каждый пинг.
- Мод работает только в Claude Code: моды используют API функциональных хуков Claude Code.
- Мод не знает, когда вы вернетесь. Если не вернетесь, `maxPings` пингов потрачены зря.
- API модов в раннем доступе и может измениться между версиями Claude Code.

## Вместе с prompt-cache-control

Чтобы видеть состояние кэша, поставьте мод [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control) из каталога [claude-code-templates](https://github.com/davila7/claude-code-templates). Он показывает над полем ввода долю попаданий в кэш и отсчет до истечения. Сам он ничего не отправляет, только показывает и напоминает. cache-keepwarm делает то, о чем тот напоминает.

```bash
npx claude-code-templates@latest --mod observability/prompt-cache-control
```

Команда ставит мод в папку текущего проекта. Чтобы он работал во всех проектах, перенесите папку `.claude/skills/prompt-cache-control` в `~/.claude/skills/`.

## Авторы и благодарности

- cache-keepwarm: [mupamuc](https://github.com/mupamuc), написан вместе с Claude Code.
- Идея и правила срока кэша взяты из [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control): автор каталога [davila7](https://github.com/davila7), доработки [onokatio](https://github.com/onokatio), лицензия MIT.
- Цены и поведение кэша: [Prompt caching, документация Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## English

**cache-keepwarm** is a Claude Code mod that keeps the prompt cache of an idle session warm. Shortly before the cache lapses (1 hour on a Claude subscription, 5 minutes on an API key) it submits a short service prompt; the model reads the context from the cache at 0.1x the input price, and the cache lifetime restarts. Without it, your next message would write the whole context again at 2x (1-hour cache) or 1.25x (5-minute cache).

Off by default. `/keepwarm on|off|status`. It pings only while the session is idle, only inside the last `leadSeconds` before expiry, never after the cache has lapsed, at most `maxPings` (default 3) times in a row; your own prompt resets the count.

Install: `git clone --depth 1 https://github.com/mupamuc/cache-keepwarm ~/.claude/skills/cache-keepwarm`, then start a new session. Requires Claude Code 2.1.259+ (function hooks, early access).

Companion mod for watching the cache: [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control) by [davila7](https://github.com/davila7) and contributors, MIT.

## Лицензия

MIT, см. [LICENSE](LICENSE).
