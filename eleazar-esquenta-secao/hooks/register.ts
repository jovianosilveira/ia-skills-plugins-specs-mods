// eleazar-esquenta-secao: the cache-tax mod (karanb192/cache-tax at e4940af) with its state in Portuguese under the prompt
// (the footer entry in the desktop app, the hint line on the terminal), a live countdown to the next ping, and keepwarm on in
// every session unless turned off. Its commands are /eleazar and one /eleazar-<option> per option.
import type { CommandSpec, EngineInterface, Register, TurnUsage } from 'claude-code'

const TTL_MS = 60 * 60 * 1000
// The hint line counts in whole minutes, and redraws when the minute it shows changes.
const MINUTE_MS = 60 * 1000
// The main conversation drops to this lifetime on usage credits, an API key or a cloud provider unless promptCacheTtl says 1h.
const SHORT_TTL_MS = 5 * 60 * 1000
// A five-minute write costs 1.25x the base input price, a one-hour write 2x: 0.625 of the one-hour column.
const SHORT_WRITE_SHARE = 0.625
// A send this far into its context tells which lifetime the cache had; below it the evidence is too thin to act on.
const MIN_EVIDENCE_TOKENS = 20000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_GUARD_MIN = 'guardMin'
const KEY_ALWAYS = 'always'
// Keepwarm runs in every session from the install on; the person turning it off is what this key remembers.
const KEY_OFF = 'off'
// The guard speaks up only when a cold send would re-write at least this many dollars.
const DEFAULT_GUARD_MIN = 1

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'
/** Where the cache lifetime came from: Claude Code's default, a setting or variable, or a request that showed it. */
type TtlSource = 'assumed' | 'declared' | 'observed'
/** The split the API reports for a cache write, which the host may or may not pass on to mods. */
type CacheSplit = { cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } }

export type State = {
  hasHint: boolean
  statusCleared: boolean
  tickGen: number
  oldWarned: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  guardMin: number
  ttl: number
  ttlSource: TtlSource
  ttlWhy: string
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

/** A span as a person says it: "38 min", "2 h 5 min", "3 dias e 4 h". A countdown rounds up, so it never reads zero before it fires. */
export function tempo(ms: number, up = false): string {
  const total = Math.max(0, up ? Math.ceil(ms / 60000) : Math.round(ms / 60000))
  if (total < 1) return 'menos de 1 min'
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)} dias${h % 24 ? ` e ${h % 24} h` : ''}`
  if (h > 0) return `${h} h${m ? ` ${m} min` : ''}`
  return `${m} min`
}

export function dolar(usd: number | null): string {
  return usd == null ? 'valor desconhecido' : 'US$ ' + usd.toFixed(2).replace('.', ',')
}

export function milhar(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

function porMilhao(rate: number): string {
  return `US$ ${rate.toFixed(2).replace('.', ',').replace(/,00$/, '')} por milhão`
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function shortTtl(s: State): boolean {
  return s.ttl < TTL_MS
}

/** The cache-write rate the main conversation pays at its current lifetime. */
function writeRate(s: State, price: [number, number, number]): number {
  return shortTtl(s) ? price[1] * SHORT_WRITE_SHARE : price[1]
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * writeRate(s, price) / 1e6 : null
}

/** Whether a cold send is worth a word: its re-write price against the guard's floor, or the token floor where no price is known. */
function worthGuarding(s: State, usd: number | null = coldUsd(s)): boolean {
  return usd == null ? s.ctx >= BIG_TOKENS : usd >= s.guardMin
}

function ttlText(s: State): string {
  const life = shortTtl(s) ? '5 minutos' : '1 hora'
  const how = s.ttlSource === 'assumed' ? 'o padrão do Claude Code na assinatura' : `${s.ttlSource === 'declared' ? 'definido por' : 'visto:'} ${s.ttlWhy}`
  return `${life} (${how})`
}

function rateText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? porMilhao(writeRate(s, price)) : 'o preço de escrita do cache'
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= s.ttl
}

function guardText(s: State, now: number): string {
  const warm = warmUsd(s)
  return `o cache esfriou há ${tempo(now - s.lastRequestAt - s.ttl)}. Esta mensagem reescreve ` +
    `até ${milhar(s.ctx)} tokens a ${rateText(s)} = ${dolar(coldUsd(s))}` +
    (warm == null ? '' : ` (com o cache quente sairia ${dolar(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  const usd = typeof e.estimated_cache_write_usd === 'number' ? e.estimated_cache_write_usd : coldUsd(s)
  if (e.prompt_cache_likely_expired !== true || !worthGuarding(s, usd)) return null
  return `retomando com o cache frio. A primeira mensagem reescreve ${milhar(s.ctx)} tokens, cerca de ${dolar(usd)}. Se só precisa das conclusões, /clear e cole um resumo.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= s.ttl
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  return `retomada com até ${milhar(s.ctx)} tokens de contexto e sem a hora da última resposta, então o cache pode estar frio. ` +
    `Se estiver, esta mensagem reescreve tudo a ${rateText(s)} = ${dolar(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

export type Hint = { icon: string; label: string; detail: string }

/** The state in a person's words: an icon, a few bold words and what comes next. The hint line draws it in every state. */
export function hint(s: State, now: number): Hint {
  const back = s.always ? 'volta depois da sua próxima mensagem' : '/eleazar-ligar para religar'
  if (s.stopped) return { icon: '⚠️', label: 'esquentador parou', detail: `${s.stopped}; ${back}` }
  const open = s.deadline > now
  if (open && shortTtl(s)) return { icon: '⏸️', label: 'esquentador pausado', detail: 'o cache desta conta dura 5 min, e aquecer não segura' }
  if (isCold(s, now)) {
    const usd = coldUsd(s)
    return { icon: '🧊', label: 'cache frio', detail: usd == null ? 'a próxima mensagem reescreve o cache' : `a próxima mensagem custa ${dolar(usd)} para reaquecer` }
  }
  const left = s.lastRequestAt && !s.compacted ? s.lastRequestAt + s.ttl - now : 0
  if (!open && !s.always) return { icon: '💤', label: 'esquentador desligado', detail: left > 0 ? `cache quente por mais ${tempo(left, true)}` : back }
  if (!open || !s.lastRequestAt || s.compacted || s.waitForTurn) return { icon: '🌡️', label: 'esquentador ligado', detail: 'começa depois da sua próxima mensagem' }
  if (s.retries) return { icon: '🔥', label: 'quente', detail: `API ocupada, tentando de novo (${s.retries} de ${MAX_RETRIES})` }
  const next = s.lastRequestAt + s.every
  if (s.deadline <= next) return { icon: '🔥', label: 'quente', detail: `esquentador encerra em ${tempo(s.deadline - now, true)}` }
  return { icon: '🔥', label: 'quente', detail: next - now <= MINUTE_MS ? 'reaquece em instantes' : `reaquece em ${tempo(next - now, true)}` }
}

/** The footer entry, the one place the desktop app shows a mod's state: whenever keepwarm is on in every session, a window is
 *  open or it stopped; turned off with no window, the footer is left empty. */
function statusText(s: State, now: number): string | undefined {
  if (!s.stopped && !(s.deadline > now) && !s.always) return undefined
  const h = hint(s, now)
  return `${h.icon} ${h.label} · ${h.detail}`
}

/** /eleazar-status: the footer's words with the window's end and the last ping's figure. */
function statusLine(s: State, now: number): string | undefined {
  const text = statusText(s, now)
  if (!text || s.stopped || !(s.deadline > now)) return text
  const last = s.last ? ` · último aquecimento leu ${fmtTok(s.last.read)} (${dolar(s.last.usd)})` : ''
  return `${text} · janela por mais ${tempo(s.deadline - now)}${last}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasHint) redraw($, s)
  else $.ui.status(statusText(s, now))
  // The countdown realigns to the state that just changed.
  tick($, s, now)
}

/** Keeps the countdown moving: a sleep until the words on screen next change, none while they cannot. A sleep, not a timer, so
 *  the ping's timer stays the only one; each new schedule makes the sleeps before it wake to nothing. */
function tick($: EngineInterface, s: State, now: number) {
  const gen = ++s.tickGen
  const wait = untilChange(s, now)
  if (wait != null) void onTick($, s, gen, wait)
}

async function onTick($: EngineInterface, s: State, gen: number, wait: number) {
  try {
    await $.clock.sleep(wait)
  } catch {
    return
  }
  if (gen === s.tickGen) updateStatus($, s, await $.clock.now())
}

/** How long until the words change by time alone: the next whole minute of a countdown, the moment a warm cache with no number
 *  shown goes cold, or null where only an event changes them (a cold or idle session sleeps not at all). Mirrors hint's branches;
 *  paused, waiting and retrying are redrawn by the ping's own timer. */
function untilChange(s: State, now: number): number | null {
  if (s.stopped || !s.lastRequestAt || s.compacted || isCold(s, now)) return null
  if (s.deadline > now) return shortTtl(s) || s.waitForTurn || s.retries ? null : toMinute(Math.min(s.lastRequestAt + s.every, s.deadline) - now)
  const left = s.lastRequestAt + s.ttl - now
  return s.always ? left : toMinute(left)
}

function toMinute(ms: number): number {
  return Math.max(1000, ms % MINUTE_MS || MINUTE_MS)
}

/** Redraws the hint line. The footer entry written before the line first drew is cleared, once, so the state shows in one place. */
function redraw($: EngineInterface, s: State) {
  if (!s.statusCleared) {
    s.statusCleared = true
    $.ui.status(undefined)
  }
  $.ui.invalidate('ui.render')
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    await $.store.delete(KEY_ALWAYS)
    await $.store.set(KEY_OFF, true)
  }
  updateStatus($, s, await $.clock.now())
}

/** Keepwarm is on in every session unless the person turned it off; turning it back on writes always over the off. */
async function alwaysOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get(KEY_ALWAYS)) === true || (await $.store.get(KEY_OFF)) !== true
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or an /eleazar-desligar there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A ping every period cannot hold a five-minute cache: the window only waits for its end, or for a one-hour write.
  if (shortTtl(s)) s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  // A cold window still needs expiry cleanup, but must not send a model request.
  else if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + s.ttl - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (shortTtl(s) || isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + s.ttl - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `o aquecimento falhou (${sent.err instanceof Error ? sent.err.message : String(sent.err)})`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'o Claude Code não enviou o aquecimento: o cache já estava frio ou a API falhou')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `a API recusou o aquecimento${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'o aquecimento foi interrompido'
      : 'o aquecimento voltou sem resposta'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + s.ttl - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `o aquecimento leu ${fmtTok(u.cache_read_input_tokens)} e escreveu ${fmtTok(u.cache_creation_input_tokens)} tokens (${dolar(usd)}): o cache já tinha ido embora`)
  s.lastRequestAt = now
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? `, depois de ${n} ${n === 1 ? 'tentativa' : 'tentativas'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

function pausedText(s: State): string {
  return `pausado por enquanto: o cache desta conta dura 5 minutos (${s.ttlWhy}), e aquecer a cada ${tempo(s.every)} não segura. Coloque promptCacheTtl em "1h" para usar o esquentador`
}

function coldNowText(s: State): string {
  return `O cache está frio agora, então o primeiro aquecimento vem ${tempo(s.every)} depois da sua próxima mensagem`
}

function armedText(s: State, now: number, windowMs: number): string {
  if (shortTtl(s)) return `esquentador ligado por ${tempo(windowMs)}, mas ${pausedText(s)}`
  if (isCold(s, now)) return `esquentador ligado por ${tempo(windowMs)}. ${coldNowText(s)}`
  return `esquentador ligado por ${tempo(windowMs)}: depois de ${tempo(s.every)} parado ele reaquece o cache, que volta a ser lido em vez de reescrito`
}

function truthy(v: unknown): boolean {
  return typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

/** The lifetime the settings ask for, in Claude Code's own order of precedence; null when nothing is set and the billing path decides. */
async function declaredTtl($: EngineInterface, rows: Array<{ key: string; value?: unknown }>): Promise<[number, string] | null> {
  if (truthy(await $.env.get('FORCE_PROMPT_CACHING_5M'))) return [SHORT_TTL_MS, 'FORCE_PROMPT_CACHING_5M']
  const env = await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')
  if (env === '5m' || env === '1h') return [env === '5m' ? SHORT_TTL_MS : TTL_MS, `CLAUDE_CODE_PROMPT_CACHE_TTL=${env}`]
  const setting = rows.find(row => row.key === 'promptCacheTtl')?.value
  if (setting === '5m' || setting === '1h') return [setting === '5m' ? SHORT_TTL_MS : TTL_MS, `promptCacheTtl ${setting}`]
  if (truthy(await $.env.get('ENABLE_PROMPT_CACHING_1H'))) return [TTL_MS, 'ENABLE_PROMPT_CACHING_1H']
  return null
}

/** Records the main cache's lifetime and says so when it changes. What a request showed outranks what a setting asks for. */
function setTtl($: EngineInterface, s: State, ttl: number, source: TtlSource, why: string) {
  if (source === 'declared' && s.ttlSource === 'observed') return
  const was = s.ttl
  s.ttl = ttl
  s.ttlSource = source
  s.ttlWhy = why
  if (was === ttl) return
  $.ui.log(ttl < TTL_MS
    ? `o cache desta conta dura 5 minutos (${why}): o aviso conta qualquer pausa acima de 5 minutos, e o esquentador não aquece até o cache voltar para 1 hora. Coloque promptCacheTtl em "1h" para ficar em 1 hora.`
    : `o cache voltou para 1 hora (${why}); o esquentador volta a segurar.`)
}

/** What the main conversation's cache really got: the write split when the host passes it on, or else a request sent five to sixty
 *  minutes after the last one, which a one-hour cache answers by reading the context back and a five-minute one by writing it again. */
function observeTtl($: EngineInterface, s: State, u: TurnUsage, gap: number, prevCtx: number, sameModel: boolean) {
  const split = (u as TurnUsage & CacheSplit).cache_creation
  const after = tempo(gap)
  if ((split?.ephemeral_1h_input_tokens ?? 0) > 0) return setTtl($, s, TTL_MS, 'observed', 'a última escrita foi para o cache de 1 hora')
  if ((split?.ephemeral_5m_input_tokens ?? 0) > 0) return setTtl($, s, SHORT_TTL_MS, 'observed', 'a última escrita foi para o cache de 5 minutos')
  if (!sameModel || prevCtx < MIN_EVIDENCE_TOKENS || gap < SHORT_TTL_MS || gap >= TTL_MS) return
  // Most of the context, not just the system prompt another session in this folder may have kept warm.
  if (u.cache_read_input_tokens >= 0.8 * prevCtx) return setTtl($, s, TTL_MS, 'observed', `uma mensagem ${after} depois da anterior leu o contexto de volta`)
  if (u.cache_creation_input_tokens >= 0.5 * prevCtx) setTtl($, s, SHORT_TTL_MS, 'observed', `uma mensagem ${after} depois da anterior escreveu o contexto de novo`)
}

// An /eleazar-desligar after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

// The desktop draws command output in a proportional font, so each line is "Rótulo: valor" rather than aligned columns.
function card(s: State, now: number): string {
  const lines: string[] = []
  const h = hint(s, now)
  lines.push(`${h.icon} ${h.label} · ${h.detail}`)
  lines.push(`Modelo: ${s.lastModel ?? 'ainda não visto'}`)
  if (s.compacted) lines.push('Cache: zerado pela compactação, esperando a próxima mensagem')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'Cache: desconhecido, a sessão foi retomada sem a hora da última resposta' : `Cache: sessão retomada sem a hora da última resposta, quente por até mais ${tempo(s.resumedAt + s.ttl - now)}`)
  else if (!s.lastRequestAt) lines.push('Cache: nenhuma mensagem nesta sessão ainda')
  else if (isCold(s, now)) lines.push(`Cache: FRIO, a última mensagem foi há ${tempo(now - s.lastRequestAt)}`)
  else lines.push(`Cache: quente por mais ${tempo(s.lastRequestAt + s.ttl - now, true)}`)
  lines.push(`Duração do cache: ${ttlText(s)}`)
  lines.push(`Contexto: ${milhar(s.ctx)} tokens`)
  lines.push(`Reaquecer frio: ${dolar(coldUsd(s))} para reescrever tudo (com o cache quente, ${dolar(warmUsd(s))})`)
  const window = s.deadline > now ? `ligado, janela por mais ${tempo(s.deadline - now)}` : s.stopped ? `parou: ${s.stopped}` : s.always ? 'ligado, começa depois da sua próxima mensagem' : 'desligado'
  lines.push(`Esquentador: ${window}${s.always ? ', em toda sessão (/eleazar-desligar desliga de vez)' : ' (/eleazar-ligar liga em toda sessão)'}`)
  if (s.last) lines.push(`Último aquecimento: leu ${fmtTok(s.last.read)} tokens, ${dolar(s.last.usd)}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`Compensa: até ${pings} aquecimentos custam o mesmo que um reaquecimento frio, cerca de ${tempo(pings * s.every)} parado com um a cada ${tempo(s.every)}`)
  const mode = s.guard === 'refuse' ? 'segura a mensagem uma vez' : 'só avisa'
  const other = s.guard === 'refuse' ? '/eleazar-aviso-avisar só mostra o preço' : '/eleazar-aviso-segurar para a mensagem uma vez'
  lines.push(`Aviso: ${mode} a partir de ${dolar(s.guardMin)} de reescrita (${other}; /eleazar-aviso-valor 2 muda o piso)`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  const n = s.misses.length
  lines.push(`Sessão: ${n} ${n === 1 ? 'reescrita fria paga' : 'reescritas frias pagas'}, ${dolar(paid)}`)
  return lines.join('\n')
}

/** The cache-tax mod this one grew from, still installed beside it: two guards and two timers on one cache. Checked again at the
 *  first turn, since a plugin seated above this one registers its commands after this one's session start. */
async function warnIfOld($: EngineInterface, s: State) {
  if (s.oldWarned) return
  const names = (await $.command.list()).map(c => c.name)
  if (!names.some(n => n === 'keepwarm' || n === 'cache-tax' || n === 'cache-tax:status')) return
  s.oldWarned = true
  $.ui.log('o cache-tax também está instalado, então cada pausa recebe dois avisos e dois aquecimentos. Desinstale o cache-tax: o esquentador já faz o que ele fazia.')
}

// One command per option, all starting with /eleazar, so typing /eleazar lists every option with its line.
export const COMMANDS: CommandSpec[] = [
  { name: 'eleazar', description: 'Eleazar, o esquenta-sessão: o estado do cache e os preços' },
  { name: 'eleazar-ligar', description: 'Liga o Eleazar nesta sessão e nas próximas' },
  { name: 'eleazar-desligar', description: 'Desliga o Eleazar nesta sessão e nas próximas' },
  { name: 'eleazar-status', description: 'O estado do Eleazar numa linha só' },
  { name: 'eleazar-janela', description: 'Mantém o cache quente por uma janela de tempo', argumentHint: '[90m | 2h] [a cada 2m]' },
  { name: 'eleazar-aviso-avisar', description: 'A mensagem com o cache frio passa, com o preço mostrado (o padrão)' },
  { name: 'eleazar-aviso-segurar', description: 'A mensagem com o cache frio é segurada uma vez; mandou de novo, ela passa' },
  { name: 'eleazar-aviso-valor', description: 'A partir de quantos dólares de reescrita o aviso aparece (o padrão é 1)', argumentHint: '[dólares, como 2 ou 2,50]' },
]

const USAGE = 'comandos do Eleazar: /eleazar (o estado e os preços), /eleazar-ligar, /eleazar-desligar, /eleazar-status, /eleazar-janela 90m, /eleazar-aviso-avisar, /eleazar-aviso-segurar e /eleazar-aviso-valor 2'

export function words(args: string | undefined): string[] {
  return String(args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
}

// Every /eleazar command lands here as words: /eleazar-desligar as "desligar", /eleazar-aviso-valor 2 as "aviso 2". /eleazar
// itself still takes them typed out after it.
async function runCommand($: EngineInterface, s: State, words: string[]): Promise<{ text: string }> {
  await reseat($, s)
  const now = await $.clock.now()
  if (!words.length) return { text: card(s, now) }
  if (words[0] === 'desligar') {
    const wasAlways = s.always
    await stop($, s, null, true)
    return { text: wasAlways ? 'esquentador desligado, nesta e nas próximas sessões, a partir da próxima mensagem de cada uma. /eleazar-ligar religa.' : 'esquentador desligado' }
  }
  if (words[0] === 'ligar') {
    s.always = true
    await $.store.set(KEY_ALWAYS, true)
    await $.store.delete(KEY_OFF)
    await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const cold = shortTtl(s) ? `. Mas está ${pausedText(s)}` : isCold(s, now) ? `. ${coldNowText(s)}` : ''
    return { text: `esquentador ligado em toda sessão: o cache fica quente até ${tempo(DEFAULT_WINDOW_MS)} depois da última mensagem; /eleazar-desligar desliga de vez${cold}` }
  }
  if (words[0] === 'status') return { text: statusLine(s, now) ?? 'esquentador desligado' }
  if (words[0] === 'aviso') {
    if (words[1] === 'avisar' || words[1] === 'segurar') {
      s.guard = words[1] === 'segurar' ? 'refuse' : 'warn'
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'aviso em segurar: uma mensagem com o cache frio é segurada uma vez com o preço, e o reenvio passa' : 'aviso em avisar: a mensagem com o cache frio passa, com o preço mostrado' }
    }
    const m = /^(?:us)?\$?(\d+(?:[.,]\d+)?)$/.exec(words[1] ?? '')
    if (!m) return { text: 'diga o valor em dólares, como /eleazar-aviso-valor 2 ou /eleazar-aviso-valor 2,50' }
    s.guardMin = Number(m[1].replace(',', '.'))
    await $.store.set(KEY_GUARD_MIN, s.guardMin)
    return { text: `o aviso agora aparece quando reaquecer o cache frio custaria ${dolar(s.guardMin)} ou mais` }
  }
  const window = parseDuration(words[0])
  if (!window) return { text: USAGE }
  // "a cada 2m" is a testing knob and lasts only for the window it was given with.
  let every = PING_AFTER_MS
  if (words[1] === 'a' && words[2] === 'cada') {
    const period = parseDuration(words[3] ?? '')
    // A period of the cache's whole hour or more would fire only once the cache is already cold.
    if (period == null || period < MIN_PING_MS || period >= TTL_MS) return { text: '"a cada" aceita um período de 1m a 59m' }
    every = period
  }
  await startWindow($, s, window, every)
  const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
  return { text: armedText(s, now, window) + (rolls ? `. Como está ligado em toda sessão, a sua próxima mensagem estica para pelo menos ${tempo(DEFAULT_WINDOW_MS)}, com um aquecimento a cada ${tempo(PING_AFTER_MS)}` : '') }
}

export function freshState(): State {
  return {
    hasHint: false, statusCleared: false, tickGen: 0, oldWarned: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'warn', guardMin: DEFAULT_GUARD_MIN, ttl: TTL_MS, ttlSource: 'assumed', ttlWhy: '', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
  }
}

export const register: Register = on => {
  const s = freshState()

  // The dim line under the prompt, bottom left, on the terminal: the state, then whatever the engine draws there. The desktop
  // app raises this line too but shows nothing a mod draws in it (seen 3 Nov 2026), so there the footer entry keeps the state.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const rest = await next(e)
    if (e.surface !== 'terminal') return rest
    // Module memory, not engine state: the next status update or tick moves the state here and clears the footer entry.
    s.hasHint = true
    const h = hint(s, await $.clock.now())
    const { Box, Text } = $.ui.resolve(e)
    return Box({ flexDirection: 'row', flexWrap: 'wrap', children: [
      Text({ children: [`${h.icon} `, Text({ bold: true, children: [h.label] }), Text({ dimColor: true, children: [` · ${h.detail}`] })] }),
      Text({ children: ['   '] }),
      rest,
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const rows = await $.config.list()
    // Until a request shows which lifetime the cache got, the settings say what was asked for.
    const declared = await declaredTtl($, rows)
    if (declared) setTtl($, s, declared[0], 'declared', declared[1])
    const now = await seat($, s)
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    const savedMin = await $.store.get(KEY_GUARD_MIN)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'refuse' ? 'refuse' : 'warn'
    s.guardMin = typeof savedMin === 'number' && savedMin >= 0 ? savedMin : DEFAULT_GUARD_MIN
    s.always = await alwaysOn($)
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    for (const c of COMMANDS) await $.command.register({ ...c, immediate: true })
    await warnIfOld($, s)
    updateStatus($, s, now)
    return r
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    if (e.source === 'clear') return r
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'eleazar' }, ($, e) => runCommand($, s, words(e.args)))
  on('command.run', { command: 'eleazar-ligar' }, $ => runCommand($, s, ['ligar']))
  on('command.run', { command: 'eleazar-desligar' }, $ => runCommand($, s, ['desligar']))
  on('command.run', { command: 'eleazar-status' }, $ => runCommand($, s, ['status']))
  on('command.run', { command: 'eleazar-janela' }, ($, e) => {
    const w = words(e.args)
    return w.length && parseDuration(w[0]) ? runCommand($, s, w) : { text: 'diga o tamanho da janela, como /eleazar-janela 90m ou /eleazar-janela 2h' }
  })
  on('command.run', { command: 'eleazar-aviso-avisar' }, $ => runCommand($, s, ['aviso', 'avisar']))
  on('command.run', { command: 'eleazar-aviso-segurar' }, $ => runCommand($, s, ['aviso', 'segurar']))
  on('command.run', { command: 'eleazar-aviso-valor' }, ($, e) => runCommand($, s, ['aviso', ...words(e.args).slice(0, 1)]))

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    await reseat($, s)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && worthGuarding(s)) $.ui.log(unknownText(s))
      return next(e)
    }
    if (!isCold(s, now) || !worthGuarding(s)) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || unattended) {
      const hold = shortTtl(s) ? '.' : `; o esquentador segura o cache por ${tempo(holdMs(s))} depois.`
      $.ui.log(`${guardText(s, now)} Enviando assim mesmo${unattended ? `, porque esta mensagem (${e.origin.kind}) não pode ser reenviada` : ''}${hold}`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    const hold = shortTtl(s) ? '.' : `, e o esquentador segura o cache por ${tempo(holdMs(s))}.`
    return { drop: `esquentador: ${guardText(s, now)} Envie de novo para pagar${hold} Ou /clear e comece de uma nota.` }
  })

  on('turn.step', async function* ($, e, next) {
    // What the cache looked like when this request went out, for telling its lifetime from its answer.
    let gap = 0
    let prevCtx = 0
    let prevModel: string | null = null
    if (!e.agentId) {
      await reseat($, s)
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      const at = await $.clock.now()
      gap = s.lastRequestAt ? at - s.lastRequestAt : 0
      prevCtx = s.ctx
      prevModel = s.lastModel
      s.lastRequestAt = at
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const model = u.model || e.model
      // Read first, so a comeback that shows a five-minute cache is priced at the five-minute rate.
      observeTtl($, s, u, gap, prevCtx, !prevModel || !model || prevModel.toLowerCase() === model.toLowerCase())
      const price = priceOf(model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * writeRate(s, price) / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /eleazar-desligar or /eleazar-ligar changes the shared switch, so every such turn reads it.
    if (e.usage) {
      await warnIfOld($, s)
      const shared = await alwaysOn($)
      if (s.offs === offs) s.always = shared
      if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * writeRate(s, price) / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        // A five-minute cache is past holding with pings: the window would only send forks that read nothing.
        const extend = !shortTtl(s) && s.deadline < now + AUTO_WARM_MS && s.offs === offs
        if (extend) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
        $.ui.log(`reescrita fria de ${fmtTok(write)} tokens paga (${dolar(usd)}).` +
          (extend ? ` Mantendo o cache quente por ${tempo(AUTO_WARM_MS)} para não pagar de novo hoje; /eleazar-desligar para parar.` : ''))
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
    s.steps = 0
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
      s.ctx = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
