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
 *   - off by default: `/keepwarm on` (kept across sessions) or the `enabled` option
 *   - pings only while idle, only inside the last `leadSeconds` before expiry,
 *     never after the cache has already lapsed
 *   - at most `maxPings` pings in a row; any prompt that is not ours resets it
 *   - skips caches smaller than `minTokens`
 *
 * Options (pluginConfigs["cache-keepwarm@skills-dir"].options):
 *   enabled: boolean     keep the cache warm when /keepwarm was never used (default false)
 *   ttl: "1h" | "5m"     cache lifetime the session runs with (default 1h)
 *   leadSeconds: number  ping this long before expiry (default 120)
 *   maxPings: number     pings in a row without your own prompt (default 3)
 *   minTokens: number    smallest cached prompt worth keeping (default 20000)
 *   message: string      the service prompt the model receives
 */
import type { EngineInterface, Register } from 'claude-code'

const COMMAND = 'keepwarm'
const STORE_KEY = 'enabled'
const TICK_MS = 5_000
// a ping needs a few seconds to reach the API; closer to expiry it may miss
const SAFETY_MS = 15_000
const DEFAULT_MESSAGE =
  'Service ping from the cache-keepwarm mod to keep the prompt cache warm. ' +
  'Reply with the single word "ok" and do nothing else: no tools, no summary.'

type Last = { at: number; tokens: number }

let last: Last | undefined
let busy = false
let pending = false
let pings = 0
let switchedOn: boolean | undefined
let timer: { cancel: () => void } | undefined

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

type Config = { enabled: boolean; ttlMs: number; leadMs: number; maxPings: number; minTokens: number; message: string }

let cfg: Config = {
  enabled: false,
  ttlMs: 60 * 60_000,
  leadMs: 120_000,
  maxPings: 3,
  minTokens: 20_000,
  message: DEFAULT_MESSAGE,
}

function isOn(): boolean {
  return switchedOn ?? cfg.enabled
}

// short on purpose: the status line already names the plugin
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

function refresh($: EngineInterface) {
  $.ui.status(isOn() ? describe(Date.now()) : undefined)
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
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    last = undefined
    busy = false
    pending = false
    pings = 0
    const stored = await $.store.get(STORE_KEY).catch(() => undefined)
    switchedOn = typeof stored === 'boolean' ? stored : undefined
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
      last = { at, tokens: u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens }
      pending = false
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
    if (arg === 'on' || arg === 'off') {
      switchedOn = arg === 'on'
      pings = 0
      await $.store.set(STORE_KEY, switchedOn)
      refresh($)
    }
    return { text: explain(Date.now()) }
  })
}
