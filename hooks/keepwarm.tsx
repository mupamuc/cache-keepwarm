/**
 * cache-keepwarm - Claude Code mod (function hooks, early access)
 *
 * Keeps the prompt cache of an idle session warm. Every main-loop request
 * reads or writes the cache and restarts its lifetime (1 hour on a Claude
 * subscription, 5 minutes on an API key). When the session has been idle long
 * enough that the cache is about to lapse, this mod submits a short service
 * prompt; the model reads the whole prefix from the cache (about 10 % of the
 * input price) and the lifetime starts over. Without it the next prompt would
 * write the whole prefix again (1.25x or 2x the input price).
 *
 *   - one row above the prompt: cache hit rate, time left, and a keepwarm
 *     checkbox; `/keepwarm on|off|status` does the same from the prompt
 *   - off by default; the choice is kept across sessions
 *   - pings only while idle, only inside the last `leadSeconds` before expiry,
 *     never after the cache has already lapsed
 *   - at most `maxPings` pings in a row; any prompt that is not ours resets it
 *   - skips caches smaller than `minTokens`
 *
 * Options (pluginConfigs["cache-keepwarm@skills-dir"].options):
 *   enabled: boolean     keep the cache warm when the checkbox was never used (default false)
 *   ttl: "1h" | "5m"     cache lifetime the session runs with (default 1h)
 *   leadSeconds: number  ping this long before expiry (default 120)
 *   maxPings: number     pings in a row without your own prompt (default 3)
 *   minTokens: number    smallest cached prompt worth keeping (default 20000)
 *   message: string      the service prompt the model receives
 *   band: boolean        the row above the prompt (default true)
 *   status: boolean      a short entry in the status line (default false)
 */
import type { EngineInterface, Register } from 'claude-code'

const COMMAND = 'keepwarm'
const STORE_KEY = 'enabled'
const LAST_KEY = 'last'
const TICK_MS = 5_000
// a ping needs a few seconds to reach the API; closer to expiry it may miss
const SAFETY_MS = 15_000
const DEFAULT_MESSAGE =
  'Service ping from the cache-keepwarm mod to keep the prompt cache warm. ' +
  'Reply with the single word "ok" and do nothing else: no tools, no summary.'

// read: tokens the cache served; tokens: the whole prompt (read + written + uncached)
type Last = { at: number; tokens: number; read: number }
type SavedLast = Last & { session: string }
type Config = {
  enabled: boolean
  ttlMs: number
  leadMs: number
  maxPings: number
  minTokens: number
  message: string
  band: boolean
  status: boolean
}

let cfg: Config = {
  enabled: false,
  ttlMs: 60 * 60_000,
  leadMs: 120_000,
  maxPings: 3,
  minTokens: 20_000,
  message: DEFAULT_MESSAGE,
  band: true,
  status: false,
}
let last: Last | undefined
let sessionId = ''
let busy = false
let pending = false
let pings = 0
let switchedOn: boolean | undefined
let timer: { cancel: () => void } | undefined
let drawnKey = ''

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// minutes while there are minutes, seconds at the end: the row redraws only when this text changes
function fmtLeft(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.ceil(ms / 1000)}s`
}

function isOn(): boolean {
  return switchedOn ?? cfg.enabled
}

// short on purpose: the status line and the checkbox already name the plugin
function describe(now: number): string {
  if (!last) return 'on'
  if (last.tokens < cfg.minTokens) return `skip <${fmtTokens(cfg.minTokens)}`
  if (now >= last.at + cfg.ttlMs) return 'lapsed'
  if (pings >= cfg.maxPings) return `${pings}/${cfg.maxPings} wait`
  return `${fmtTime(last.at + cfg.ttlMs - cfg.leadMs)} · ${pings}/${cfg.maxPings}`
}

// the /keepwarm reply, read once, can say it in words
function explain(now: number): string {
  if (!isOn()) return 'off'
  if (!last) return 'on, waiting for the first request'
  if (last.tokens < cfg.minTokens) return `on, ${fmtTokens(last.tokens)} cached is below ${fmtTokens(cfg.minTokens)}: no ping`
  if (now >= last.at + cfg.ttlMs) return 'on, the cache already lapsed: no ping'
  if (pings >= cfg.maxPings) return `on, ${pings}/${cfg.maxPings} pings used, waiting for your prompt`
  return `on, next ping at ${fmtTime(last.at + cfg.ttlMs - cfg.leadMs)}, ${pings}/${cfg.maxPings} used`
}

function cacheText(now: number): string {
  if (!last) return 'cache: no request yet'
  const left = last.at + cfg.ttlMs - now
  const hit = last.tokens > 0 ? Math.round((last.read / last.tokens) * 100) : 0
  return `cache ${hit}% · ${left > 0 ? fmtLeft(left) : 'lapsed'}`
}

function cacheColor(now: number): string | undefined {
  if (!last) return undefined
  const left = last.at + cfg.ttlMs - now
  return left <= 0 ? 'red' : left <= cfg.leadMs ? 'yellow' : 'green'
}

function refresh($: EngineInterface) {
  const now = Date.now()
  if (cfg.status) $.ui.status(isOn() ? describe(now) : undefined)
  const key = `${isOn()}|${cacheText(now)}|${describe(now)}`
  if (key !== drawnKey) {
    drawnKey = key
    $.ui.invalidate('ui.render')
  }
}

async function setOn($: EngineInterface, on: boolean) {
  switchedOn = on
  pings = 0
  await $.store.set(STORE_KEY, on)
  refresh($)
}

async function maybePing($: EngineInterface) {
  if (!isOn() || busy || pending || !last) return
  if (last.tokens < cfg.minTokens || pings >= cfg.maxPings) return
  const now = Date.now()
  const expires = last.at + cfg.ttlMs
  if (now < expires - cfg.leadMs || now > expires - SAFETY_MS) return
  pending = true
  pings += 1
  $.ui.toast(`keepwarm: ping ${pings}/${cfg.maxPings} keeps ${fmtTokens(last.tokens)} tokens cached`)
  try {
    await $.prompt.submit({ text: cfg.message })
  } catch (err) {
    pending = false
    $.ui.log(`cache-keepwarm: ping not sent: ${err}`)
  }
  refresh($)
}

export const register: Register = (on, options) => {
  const ttlMs = options.ttl === '5m' ? 5 * 60_000 : 60 * 60_000
  cfg = {
    enabled: options.enabled === true,
    ttlMs,
    leadMs: Math.min(num(options.leadSeconds, 120) * 1000, ttlMs / 2),
    maxPings: Math.floor(num(options.maxPings, 3)),
    minTokens: num(options.minTokens, 20_000),
    message: typeof options.message === 'string' && options.message.trim() ? options.message : DEFAULT_MESSAGE,
    band: options.band !== false,
    status: options.status === true,
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    last = undefined
    busy = false
    pending = false
    pings = 0
    drawnKey = ''
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    switchedOn = typeof stored === 'boolean' ? stored : undefined
    // an app restart or a resume reloads the mod: the same session keeps its cache, so keep counting from it
    sessionId = await $.session.id().catch(() => '')
    const saved = (await $.store.get(LAST_KEY).catch(() => undefined)) as SavedLast | undefined
    if (saved && sessionId && saved.session === sessionId && typeof saved.at === 'number' && typeof saved.tokens === 'number') {
      last = { at: saved.at, tokens: saved.tokens, read: typeof saved.read === 'number' ? saved.read : 0 }
    }
    await $.command
      .register({
        name: COMMAND,
        description: 'Keep the prompt cache warm while idle: on, off or status',
        argumentHint: '[on|off|status]',
        immediate: true,
      })
      .catch(err => $.ui.log(`cache-keepwarm: /${COMMAND} not registered: ${err}`))
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      refresh($)
      void maybePing($)
    })
    refresh($)
    return r
  })

  on('session.end', async ($, e, next) => {
    last = undefined
    pending = false
    pings = 0
    if (e.reason !== 'clear') {
      timer?.cancel()
      timer = undefined
    }
    return next(e)
  })

  // any prompt that reaches this hook is not ours: $.prompt.submit skips the calling hook
  on('prompt.submit', async ($, e, next) => {
    pings = 0
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    busy = true
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const at = Date.now()
    const r = yield* next(e)
    const u = r.usage
    if (u && u.cache_read_input_tokens + u.cache_creation_input_tokens > 0) {
      last = {
        at,
        tokens: u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens,
        read: u.cache_read_input_tokens,
      }
      pending = false
      if (sessionId) void $.store.set(LAST_KEY, { session: sessionId, ...last }).catch(() => undefined)
      refresh($)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      busy = false
      pending = false
      refresh($)
    }
    return r
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') await setOn($, arg === 'on')
    return { text: explain(Date.now()) }
  })

  // one row: cache state on the left, the keepwarm checkbox on the right
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.band || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = Date.now()
    const label = isOn() ? `[x] keepwarm ${describe(now)}` : '[ ] keepwarm'
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={cacheColor(now)}>●</Text>
        <Text dimColor>{cacheText(now)}</Text>
        <Button key="toggle" plain label={label} dimColor={!isOn()} onPress={() => setOn($, !isOn())} />
      </Box>
    )
  })
}
