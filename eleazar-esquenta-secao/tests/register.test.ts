import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Plugin, TestBody } from 'claude-code/testing'
import type { CommandRunInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { dolar, freshState, milhar, parseDuration, resetForClear, seedFromResume, tempo } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (args: string): CommandRunInput => ({
  command: 'eleazar', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; startedAt?: () => number; sid?: string | (() => string); model?: string | (() => string); bandText?: string; gate?: () => Promise<void>; steps?: TurnUsage[]; storeGate?: (op: 'get' | 'set' | 'delete', key: string) => Promise<void>; shipped?: true; env?: Record<string, string>; promptCacheTtl?: string } = {}) {
  // These tests were written when the guard refused and keepwarm waited to be asked; this mod ships warn and on. Unless a
  // test asks for the shipped defaults, the guard reads as refuse and keepwarm as turned off, so every upstream path keeps its coverage.
  const upstream = opts.shipped !== true
  if (opts.store) {
    const store = opts.store
    // A read takes its value first and is delivered after the gate, as a reply can arrive late.
    on('store.get', async ($, e) => { const value = upstream && !store.has(e.key) && (e.key === 'guard' || e.key === 'off') ? (e.key === 'guard' ? 'refuse' : true) : store.get(e.key); await opts.storeGate?.('get', e.key); return { value } })
    on('store.set', async ($, e) => { await opts.storeGate?.('set', e.key); store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', async ($, e) => { await opts.storeGate?.('delete', e.key); store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, upstream ? { guard: 'refuse', off: true } : {})
  on('env.get', ($, e) => ({ value: opts.env?.[e.name] }))
  on('config.list', () => ({ value: [
    { key: 'theme', label: 'Theme', kind: 'choice', value: 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false },
    ...(opts.promptCacheTtl ? [{ key: 'promptCacheTtl', label: 'Prompt cache TTL', kind: 'choice', value: opts.promptCacheTtl, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] : []),
  ] }))
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: typeof opts.sid === 'function' ? opts.sid() : opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: (typeof opts.model === 'function' ? opts.model() : opts.model) ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: opts.startedAt?.() ?? START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: [] } }))
  const registered: string[] = []
  on('command.register', ($, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    const u = opts.steps?.shift() ?? null
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: u }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: u }
  })
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [opts.bandText ?? ''] }))
  on('model.fork', async () => {
    forks.push(forks.length)
    if (opts.gate) await opts.gate()
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, registered }
}

const warm: ForkAnswer = { read: 200000, write: 0 }
// A ping that finds nothing to fork leaves the window waiting, with a wake at the cold mark and no further fork.
const nothing: ForkAnswer = { isAnswered: false, reason: 'nothing-to-fork' }
const busy: ForkAnswer = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() }

const hintProps: RenderPropsOf['PromptHint'] = { isDraft: false, isWorking: false, hint: '? for shortcuts' }

// The line's own words: the outer Text holds the icon, the bold label and the dim detail.
const OURS = /^(🔥|🧊|🌡️|💤|⚠️|⏸️) /

describe('hint line', () => {
  test('terminal: on from the first moment, counts down while warm and keeps the engine\'s line', async ($, on) => {
    const surface = 'terminal'
    {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [warm], { shipped: true, bandText: 'esc to interrupt' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface, component: 'PromptHint', props: hintProps })
      expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
      expect((await ui.find({ type: 'Text', text: /^esquentador ligado$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ text: /^esc to interrupt$/ }))?.text).toBe('esc to interrupt')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · reaquece em 50 min')
      expect((await ui.find({ type: 'Text', text: /^ · reaquece/ }))?.props.dimColor).toBe(true)
      // The tick redraws the countdown with no request of its own.
      await clock.advance(20 * MIN + 30 * 1000)
      expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · reaquece em 30 min')
      expect(w.forks.length).toBe(0)
      await clock.advance(29 * MIN)
      expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · reaquece em instantes')
      await clock.advance(MIN)
      expect(w.forks.length).toBe(1)
      expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · reaquece em 50 min')
      // The footer entry from before the line first drew is cleared once the line carries the state.
      expect(w.status.at(-1)).toBe(undefined)
    }
  })

  test('desktop: the app raises the line but shows none of it, so the footer keeps the state and counts down', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [warm], { shipped: true, bandText: 'engine line' })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'desktop', component: 'PromptHint', props: hintProps })
    expect(await ui.find({ type: 'Text', text: OURS })).toBe(undefined)
    expect((await ui.find({ text: /^engine line$/ }))?.text).toBe('engine line')
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    await clock.advance(20 * MIN + 30 * 1000)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 30 min')
    await clock.advance(29 * MIN)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em instantes')
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    expect((await $.command.run(run('status'))).text).toBe('🔥 quente · reaquece em 50 min · janela por mais 5 h 10 min · último aquecimento leu 200k (US$ 0,05)')
  })

  test('on in every session, the footer outlives the window and names what the next message costs', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm, warm, warm, warm], { shipped: true })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Pings every 50 minutes until the six-hour window ends; the last one's hour runs out at 6h50.
    await clock.advance(7 * HOUR)
    expect(w.forks.length).toBe(7)
    expect(w.status.at(-1)).toBe('🧊 cache frio · a próxima mensagem custa US$ 4,01 para reaquecer')
    await $.command.run(run('desligar'))
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('turned off, it says how long the cache stays warm, then what the next message costs', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'terminal', component: 'PromptHint', props: hintProps })
    await $.turn.complete(turn())
    expect((await $.command.run(run('desligar'))).text).toMatch(/^esquentador desligado, nesta e nas próximas sessões/)
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('💤 esquentador desligado · cache quente por mais 1 h')
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('💤 esquentador desligado · cache quente por mais 30 min')
    await clock.advance(40 * MIN)
    // 200,502 tokens at Fable 5.1's $20 per million.
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🧊 cache frio · a próxima mensagem custa US$ 4,01 para reaquecer')
    expect(w.forks.length).toBe(0)
  })

  test('a ping that finds the cache gone says so, and the next message brings it back', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 200000 }], { shipped: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'terminal', component: 'PromptHint', props: hintProps })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toMatch(/^⚠️ esquentador parou · o aquecimento leu 0 e escreveu 200k tokens \(US\$ [\d,]+\): o cache já tinha ido embora; volta depois da sua próxima mensagem$/)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · reaquece em 50 min')
    expect(w.forks.length).toBe(1)
  })

  test('a window that ends before the next ping counts down to its end', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'terminal', component: 'PromptHint', props: hintProps })
    await $.turn.complete(turn())
    await $.command.run(run('10m'))
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · esquentador encerra em 10 min')
  })

  test('a busy API shows the retry, compaction waits for the next message', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [busy, nothing], { shipped: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'terminal', component: 'PromptHint', props: hintProps })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🔥 quente · API ocupada, tentando de novo (1 de 3)')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
  })

  test('a five-minute cache pauses it', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { shipped: true, promptCacheTtl: '5m' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'eleazar-esquenta-secao', surface: 'terminal', component: 'PromptHint', props: hintProps })
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: OURS }))?.text).toBe('⏸️ esquentador pausado · o cache desta conta dura 5 min, e aquecer não segura')
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the footer status`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('90m'))
      expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
      await $.command.run(run('desligar'))
      expect(w.status.at(-1)).toBe(undefined)
    })
  }
})

describe('on by default', () => {
  test('a new install keeps every session warm; desligar holds across sessions until ligar', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    const w = world(on, [warm], { shipped: true, store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('desligar'))
    expect(store.get('off')).toBe(true)
    sid = 'S2'
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(1)
    expect((await $.command.run(run('ligar'))).text).toMatch(/^esquentador ligado em toda sessão/)
    expect(store.has('off')).toBe(false)
    expect(store.get('always')).toBe(true)
  })

  test('the old cache-tax beside it is named once', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true, commands: ['keepwarm', 'cache-tax'] })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.logs.filter(l => l.startsWith('o cache-tax também está instalado'))).toHaveLength(1)
  })
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(tempo(150 * MIN)).toBe('2 h 30 min')
    expect(tempo(2 * HOUR)).toBe('2 h')
    expect(tempo(7 * MIN)).toBe('7 min')
    expect(tempo(20 * 1000)).toBe('menos de 1 min')
    expect(tempo(29 * MIN + 1000, true)).toBe('30 min')
    expect(tempo((15 * 24 + 9) * 60 * MIN)).toBe('15 dias e 9 h')
    expect(tempo(3 * 24 * 60 * MIN)).toBe('3 dias')
    expect(dolar(4.0104)).toBe('US$ 4,01')
    expect(dolar(null)).toBe('valor desconhecido')
    expect(milhar(200502)).toBe('200.502')
    expect(milhar(1234567)).toBe('1.234.567')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/esquentador: o cache esfriou há 2 h\. Esta mensagem reescreve até 200\.502 tokens a US\$ 20 por milhão = US\$ 4,01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('aviso avisar'))
    expect(r.text).toMatch(/aviso em avisar/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Enviando assim mesmo/)
  })

  test('a paid cold write is scored and arms keepwarm for three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/reescrita fria de 201k tokens paga \(US\$ 4,01\)\. Mantendo o cache quente por 3 h/)
    expect(w.status.at(-1)).toMatch(/^🔥 quente · reaquece em 50 min/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Sessão: 1 reescrita fria paga, US\$ 4,01/)
    expect(card.text).toMatch(/Esquentador: ligado, janela por mais 2 h 10 min/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Contexto: 100\.000 tokens/)
    expect(card.text).toMatch(/0 reescritas frias pagas/)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/1 reescrita fria paga/)
    expect((await $.command.run(run('status'))).text).toMatch(/janela por mais 3 h/)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Cache: zerado pela compactação/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/retomando com o cache frio\. A primeira mensagem reescreve 396\.113 tokens, cerca de US\$ 7,92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/o cache-tax também está instalado/)
  })
})

describe('keepwarm', () => {
  test('pings 50 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('6h'))
    expect(r.text).toMatch(/esquentador ligado por 6 h/)
    await $.turn.complete(turn())
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/🔥 quente · reaquece em 50 min/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/esquentador parou · o aquecimento leu 0 e escreveu 180k tokens \(US\$ 3,60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('status'))
    expect(s.text).toMatch(/parou/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('1h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/o cache já estava frio ou a API falhou/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('3m a cada 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('desligar'))
    expect(off.text).toBe('esquentador desligado')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('1h a cada 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('desligar'))
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('1h a cada 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('6h'))
    expect(r.text).toMatch(/^esquentador ligado por 6 h: depois de 50 min parado ele reaquece o cache/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Esquentador: ligado, janela por mais 5 h 10 min, em toda sessão[\s\S]*Último aquecimento: leu 200k tokens, US\$ 0,05/)
    const off = await $.command.run(run('desligar'))
    expect(off.text).toBe('esquentador desligado, nesta e nas próximas sessões, a partir da próxima mensagem de cada uma. /eleazar-ligar religa.')
    expect(store.has('always')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('ligar'))
    expect(r.text).toMatch(/^esquentador ligado em toda sessão: o cache fica quente até 6 h depois da última mensagem/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
  })

  test('always rolls the window forward with each turn, so a long session never outlives it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    // A turn five and a half hours in: a fixed window would end 30m later, before the first ping.
    await clock.advance(5 * HOUR + 30 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 11 * HOUR + 30 * MIN)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Reaquecer frio: US\$ 0,80 para reescrever tudo \(com o cache quente, US\$ 0,04\)/)
    expect(card.text).toMatch(/Compensa: até 20 aquecimentos custam o mesmo que um reaquecimento frio, cerca de 16 h 40 min parado com um a cada 50 min/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('6h a cada 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^🔥 quente · reaquece em instantes/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^⚠️ esquentador parou · o aquecimento leu 75k e escreveu 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^⚠️ esquentador parou · o aquecimento leu 0 e escreveu 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Compensa: até 80 aquecimentos custam o mesmo que um reaquecimento frio, cerca de 2 dias e 18 h parado com um a cada 50 min/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('6h'))
    expect(r.text).toBe('esquentador ligado por 6 h. O cache está frio agora, então o primeiro aquecimento vem 50 min depois da sua próxima mensagem')
    expect(w.status.at(-1)).toBe('🧊 cache frio · a próxima mensagem custa US$ 4,01 para reaquecer')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run(''))
    expect(card.text).toMatch(/Esquentador: ligado, janela por mais 4 h 59 min/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('desligar'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('🧊 cache frio · a próxima mensagem custa US$ 4,01 para reaquecer')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('ligar'))
    expect(r.text).toBe('esquentador ligado em toda sessão: o cache fica quente até 6 h depois da última mensagem; /eleazar-desligar desliga de vez. O cache está frio agora, então o primeiro aquecimento vem 50 min depois da sua próxima mensagem')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and its testing period does not reach the next auto-window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('90m a cada 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('90m a cada 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 3 * HOUR)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('status'))
    expect(r.text).toBe('esquentador desligado')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('1h a cada 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('desligar'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('prices', () => {
  for (const [model, cold, warmTurn, pings] of [
    ['claude-opus-5-5', '1.60', '0.04', 40],
    ['claude-opus-5', '2.00', '0.10', 20],
    ['claude-sonnet-5-5', '0.80', '0.02', 40],
    ['claude-haiku-5-5', '0.20', '0.01', 20],
    ['claude-mythos-5-1', '4.00', '0.05', 80],
    ['claude-opus-4-1-20250805', '6.00', '0.30', 20],
    ['claude-opus-4-20250514', '6.00', '0.30', 20],
    ['claude-opus-4@20250514', '6.00', '0.30', 20],
    ['claude-opus-4-1@20250805', '6.00', '0.30', 20],
    ['anthropic.claude-opus-4-1-20250805-v1:0', '6.00', '0.30', 20],
    ['claude-opus-4-1', '6.00', '0.30', 20],
    ['claude-opus-4-5-20251101', '2.00', '0.10', 20],
    ['claude-opus-4-5@20251101', '2.00', '0.10', 20],
    ['anthropic.claude-opus-4-5-20251101-v1:0', '2.00', '0.10', 20],
    ['claude-opus-4-8', '2.00', '0.10', 20],
    ['claude-3-5-haiku-20241022', '0.32', '0.02', 20],
  ] as const) {
    test(`${model} at 200k tokens is priced from its own row`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { live: { tokens: 200000 } })
      await $.session.start(session)
      await $.turn.complete(turn({ usage: usage({ model }) }))
      const card = await $.command.run(run(''))
      expect(card.text).toMatch(`Reaquecer frio: US$ ${cold.replace('.', ',')} para reescrever tudo (com o cache quente, US$ ${warmTurn.replace('.', ',')})`)
      expect(card.text).toMatch(`Compensa: até ${pings} aquecimentos`)
    })
  }

  test('Haiku 5.5 up to 100k tokens takes the short-prompt row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 100000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5' }) }))
    const card = await $.command.run(run(''))
    expect(card.text).toMatch('Reaquecer frio: US$ 0,02 para reescrever tudo (com o cache quente, US$ 0,00)')
  })
})

describe('keepwarm input', () => {
  for (const args of ['3h a cada 60m', '3h a cada 90m', '3h a cada 2h']) {
    test(`${args} is refused, since it would only fire on a cold cache`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run(args))
      expect(r.text).toBe('"a cada" aceita um período de 1m a 59m')
      expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    })
  }

  test('every 59m pings before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h a cada 59m'))
    await clock.advance(59 * MIN)
    expect(w.forks.length).toBe(1)
  })

  for (const args of ['0m', '0h', '0h0m']) {
    test(`a ${args} window is refused`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      const r = await $.command.run(run(args))
      expect(r.text).toBe('comandos do Eleazar: /eleazar (o estado e os preços), /eleazar-ligar, /eleazar-desligar, /eleazar-status, /eleazar-janela 90m, /eleazar-aviso-avisar, /eleazar-aviso-segurar e /eleazar-aviso-valor 2')
    })
  }

  test('a stored period of an hour or more falls back to 50m', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { store: new Map<string, unknown>([['deadline:S1', START + 3 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('always after /clear', () => {
  test('arms a fresh window under the new session id', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [warm], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('without always, /clear leaves keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('3h'))
    await $.turn.complete(turn())
    await $.classic.SessionStart({ source: 'clear' })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
  })
})

describe('guard by origin', () => {
  for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'observer'] as const) {
    test(`a cold ${kind} prompt is sent and scored, and the next typed prompt is still refused`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const r = await $.prompt.submit({ text: 'agent finished', wait: false, origin: { kind } })
      expect(r.drop).toBe(undefined)
      expect(w.entered).toEqual(['agent finished'])
      expect(w.logs.at(-1)).toMatch(new RegExp(`Enviando assim mesmo, porque esta mensagem \\(${kind}\\) não pode ser reenviada`))
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect((await $.command.run(run(''))).text).toMatch(/Sessão: 1 reescrita fria paga/)
      await $.command.run(run('desligar'))
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^esquentador: o cache esfriou/)
    })
  }

  for (const origin of [
    { kind: 'bridge' }, { kind: 'sdk' }, { kind: 'unclassified' }, { kind: 'slack-ping' },
    { kind: 'channel', server: 'telegram' }, { kind: 'auto-continuation' },
  ] satisfies PromptSubmitInput['origin'][]) {
    test(`a cold ${origin.kind} prompt, which a person may have sent, is refused like a typed one`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      world(on, [])
      await $.session.start(session)
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      expect((await $.prompt.submit({ text: 'hi', wait: false, origin })).drop).toMatch(/^esquentador:/)
    })
  }
})

describe('ping failures', () => {
  test('after a restart with nothing to fork, the window waits for the next turn instead of stopping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>([['deadline:S1', 13 * HOUR]])
    const w = world(on, [{ isAnswered: false, reason: 'nothing-to-fork' }, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 40 * 60, context_tokens: 200000 })
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    expect(store.get('deadline:S1')).toBe(13 * HOUR)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(1)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
  })

  for (const status of [429, 529, 500, null]) {
    test(`an API error ${status} is retried and the loop goes on once a ping lands`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [{ isAnswered: false, reason: 'api-error', status, error: 'rate_limit', usage: usage() }, warm, warm])
      await $.session.start(session)
      await $.turn.complete(turn())
      await $.command.run(run('3h'))
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(1)
      expect(w.status.at(-1)).toBe('🔥 quente · API ocupada, tentando de novo (1 de 3)')
      await clock.advance(MIN)
      expect(w.forks.length).toBe(2)
      expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
      await clock.advance(50 * MIN)
      expect(w.forks.length).toBe(3)
    })
  }

  test('a lasting 429 stops after three retries, before the cache goes cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(57 * MIN)
    expect(w.forks.length).toBe(4)
    expect(w.status.at(-1)).toBe('⚠️ esquentador parou · a API recusou o aquecimento (429), depois de 3 tentativas; /eleazar-ligar para religar')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(4)
  })

  test('a retry that would land within a minute of the cache going cold is not tried', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h a cada 58m'))
    await clock.advance(58 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('⚠️ esquentador parou · a API recusou o aquecimento (429); /eleazar-ligar para religar')
  })
})

describe('stale and late ping results', () => {
  // The tsconfig loads no DOM or Node types; the runtime has a real setTimeout to let a released fork finish.
  const realTimer = globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }
  const settle = () => new Promise<void>(r => { realTimer.setTimeout(r, 20) })
  const gated = () => {
    let release = () => {}
    return { gate: () => new Promise<void>(r => { release = r }), release: () => release() }
  }

  test('a 429 that lands after a compaction schedules no retry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [busy], { gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    g.release()
    await settle()
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
  })

  test('a 429 that lands after /clear with always on leaves the new window alone', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const g = gated()
    const w = world(on, [busy], { store, sid: () => sid, gate: g.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    g.release()
    await settle()
    expect(store.get('deadline:S2')).toBe(START + 50 * MIN + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
  })

  test('nothing to fork that lands after a turn does not hold the next ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const g = gated()
    const w = world(on, [nothing, warm], { gate: async () => { if (w.forks.length === 1) await g.gate() } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await $.turn.complete(turn())
    g.release()
    await settle()
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
  })

  test('a retry whose timer fires inside the last minute is not sent', async ($, on) => {
    let now = START
    const timers: Array<() => void> = []
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('🔥 quente · API ocupada, tentando de novo (1 de 3)')
    // The host slept through the retry's one-minute slot and wakes 30 seconds before the cache goes cold.
    now += 9.5 * 60 * 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toBe('⚠️ esquentador parou · a API recusou o aquecimento (429), depois de 1 tentativa; /eleazar-ligar para religar')
  })
})

describe('price edge cases', () => {
  test('Claude Haiku 3.5 by display name takes the Haiku 3.5 row', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn({ usage: usage({ model: 'Claude Haiku 3.5' }) }))
    expect((await $.command.run(run(''))).text).toMatch('Reaquecer frio: US$ 0,32 para reescrever tudo (com o cache quente, US$ 0,02)')
  })

  test('without step usage, a Haiku 5.5 comeback is priced at the tier of the context it re-sent', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.command.run(run('aviso avisar'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 99000 }) }))
    await clock.advance(2 * HOUR)
    // Two requests summed: the 99k comeback write under 100k, then a step that crossed it.
    await $.turn.complete(turn({ usage: usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 100500 }) }))
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 1 reescrita fria paga, US\$ 0,02/)
  })
})

describe('per-request pricing and window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const haiku = (read: number, write: number) => usage({ model: 'claude-haiku-5-5', cache_read_input_tokens: read, cache_creation_input_tokens: write })
  const step = async ($: Parameters<TestBody>[0], index: number) => {
    for await (const c of $.turn.step({ turnId: 'comeback', index, model: 'claude-haiku-5-5', messageCount: 2 })) void c
  }

  test('a Haiku 5.5 comeback request over 100k is priced at the long tier though the context before was under it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 101000)] })
    await $.session.start(session)
    await $.command.run(run('aviso avisar'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await $.turn.complete(turn({ usage: haiku(0, 101000) }))
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 1 reescrita fria paga, US\$ 0,10/)
  })

  test('a Haiku 5.5 turn whose requests straddle 100k prices each write at its own tier', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [], { steps: [haiku(0, 99000), haiku(99000, 60000)] })
    await $.session.start(session)
    await $.command.run(run('aviso avisar'))
    await $.turn.complete(turn({ usage: haiku(0, 99000) }))
    await clock.advance(2 * HOUR)
    await step($, 0)
    await step($, 1)
    // 99,000 at $0.20 plus 60,000 at $1, against $0.16 for all at $1 or $0.03 for all at $0.20.
    await $.turn.complete(turn({ usage: haiku(99000, 159000) }))
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 1 reescrita fria paga, US\$ 0,08/)
  })

  test('a ping out when /keepwarm extends the window still counts', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await $.command.run(run('6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('pings in flight', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds the first fork until released; later forks answer at once.
  const holdFirst = (w: () => { forks: number[] }) => {
    let release = () => {}
    const gate = async () => { if (w().forks.length === 1) await new Promise<void>(r => { release = r }) }
    return { gate, release: () => release() }
  }

  test('extending the window while a ping is out sends no second ping, and a cold reply then stops it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('6h'))
    await clock.advance(5 * 1000)
    expect(w.forks.length).toBe(1)
    h.release()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/esquentador parou · o aquecimento leu 0 e escreveu 200k/)
  })

  test('a main request while a ping is out supersedes its cold reply', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [{ read: 0, write: 200000 }, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    for await (const c of $.turn.step({ turnId: 'next', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    h.release()
    await settle()
    expect(w.status.at(-1)).not.toMatch(/parou/)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
  })

  test('a turn aborted before any request keeps the reply of a ping that was out', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const h = holdFirst(() => w)
    const w = world(on, [warm, warm], { gate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await clock.advance(MIN)
    await $.turn.complete(turn({ isAborted: true, usage: undefined }))
    h.release()
    await settle()
    expect(w.status.at(-1)).toMatch(/^🔥 quente/)
    // The next ping counts from the ping's own read, not from the aborted turn.
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('ping timing races', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a timer that fires while another ping waits on the clock never sends a second fork', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // Ping B's fork stays out until released, so it is in flight when A resumes.
    let releaseFork = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    now += 50 * MIN
    // Ping A's clock read is held; the extension's own reads go through.
    hold = new Promise<void>(r => { releaseClock = r })
    timers.at(-1)?.()
    await settle()
    await $.command.run(run('6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    releaseFork()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^🔥 quente/)
  })

  test('a superseded reply followed by an early timer still leaves the window armed', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [warm, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('6h'))
    // A long tool call: the turn's first request lands, and the turn does not complete.
    for await (const c of $.turn.step({ turnId: 'long', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    release()
    await settle()
    await clock.advance(2 * 1000)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })
})

describe('retry after a window extension', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands after /keepwarm extends the window waits the full retry delay', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let release = () => {}
    const w = world(on, [busy, warm], { gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { release = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    await clock.advance(50 * MIN)
    await $.command.run(run('6h'))
    release()
    await settle()
    expect(w.status.at(-1)).toMatch(/API ocupada, tentando de novo \(1 de 3\)/)
    // The extension's one-second timer is gone; only the one-minute retry remains.
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(1)
    await clock.advance(30 * 1000)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^🔥 quente/)
  })
})

describe('one timer at a time', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a 429 that lands while /keepwarm is reading the clock leaves one live timer', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    // The extension writes its deadline, then arms; holding the next clock read pauses it inside arm().
    let watch = false
    class Store extends Map<string, unknown> {
      override set(key: string, value: unknown) {
        if (watch && key === 'deadline:S1') holdNext = true
        return super.set(key, value)
      }
    }
    let releaseFork = () => {}
    const w = world(on, [busy, busy, busy, warm], { store: new Store(), gate: async () => { if (w.forks.length === 1) await new Promise<void>(r => { releaseFork = r }) } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    const before = timers.length
    watch = true
    const extension = $.command.run(run('6h'))
    await settle()
    releaseFork()
    await settle()
    releaseClock()
    await extension
    await settle()
    // Two timers were set since the first ping: the retry's, then the extension's. Fire the extension's at
    // one second and the retry's at its minute, a beat apart, as the host would; only a live timer may send.
    expect(timers.length - before).toBe(2)
    now += 1000
    timers[before + 1]?.()
    await settle()
    expect(w.forks.length).toBe(2)
    now += MIN
    timers[before]?.()
    await settle()
    expect(w.forks.length).toBe(2)
  })
})

describe('a paused ping yields to a newer schedule', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a ping paused on the clock does not send after a newer ping set a retry', async ($, on) => {
    let now = START
    let holdNext = false
    let releaseClock = () => {}
    const timers: Array<() => void> = []
    on('clock.now', async () => {
      if (holdNext) {
        holdNext = false
        await new Promise<void>(r => { releaseClock = r })
      }
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(r => { timers.push(() => r({ value: undefined })) }))
    const w = world(on, [busy, busy, busy, busy])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    now += 50 * MIN
    // Ping A pauses on its clock read.
    holdNext = true
    timers.at(-1)?.()
    await settle()
    // The extension sets timer B; B pings, gets a 429 and schedules a one-minute retry.
    await $.command.run(run('6h'))
    now += 1000
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API ocupada, tentando de novo \(1 de 3\)/)
    releaseClock()
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/API ocupada, tentando de novo \(1 de 3\)/)
  })
})

describe('/clear overlapping /keepwarm', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('a window armed while /clear is still running keeps a timer', async ($, on) => {
    let now = START
    let hold: Promise<void> | null = null
    const holdNextRead = () => {
      let release = () => {}
      hold = new Promise<void>(r => { release = r })
      return () => release()
    }
    const timers: Array<() => void> = []
    const waits: number[] = []
    on('clock.now', async () => {
      const h = hold
      hold = null
      if (h) await h
      return { value: now }
    })
    on('clock.after', ($, e) => new Promise<{ value: void }>(r => { waits.push(e.ms); timers.push(() => r({ value: undefined })) }))
    const w = world(on, [warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    now += 50 * MIN
    // Ping A fires and pauses on its clock read.
    const releaseA = holdNextRead()
    timers.at(-1)?.()
    await settle()
    // /clear stops the old window and pauses on its last clock read.
    const releaseClear = holdNextRead()
    const clearing = $.classic.SessionStart({ source: 'clear' })
    await settle()
    // /keepwarm arms a new window meanwhile; then /clear finishes.
    await $.command.run(run('6h'))
    const beforeClearEnds = timers.length
    releaseClear()
    await clearing
    await settle()
    // /clear reset the state before it first awaited, so the window armed meanwhile kept its timer: the wake at the
    // deadline, since the new conversation has no request yet. Nothing is cancelled or set again when /clear ends.
    expect(timers.length).toBe(beforeClearEnds)
    expect(waits.at(-1)).toBe(6 * HOUR)
    // A wakes, finds the schedule changed and a timer in place, and sends nothing.
    releaseA()
    await settle()
    expect(w.forks.length).toBe(0)
    expect(timers.length).toBe(beforeClearEnds)
    // The first turn of the new conversation starts the pings as usual.
    await $.turn.complete(turn())
    now += 50 * MIN
    timers.at(-1)?.()
    await settle()
    expect(w.forks.length).toBe(1)
  })
})

describe('always covers any break up to six hours', () => {
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a window that stopped comes back on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [{ read: 0, write: 200000 }, warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.status.at(-1)).toMatch(/^⚠️ esquentador parou · o aquecimento leu 0/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 50 * MIN + 6 * HOUR)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
  })

  test('a shorter window and a testing period give way to six hours at 50m on the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('90m a cada 2m'))
    expect(store.get('every:S1')).toBe(2 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await clock.advance(49 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('an expired window with a testing period rolls at 50m, not at its old period', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('90m a cada 1m'))
    now += 91 * MIN
    await $.turn.complete(turn())
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🔥 quente · reaquece em 50 min')
  })

  test('the window rolls in the conversation after /clear too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    sid = 'S2'
    await $.classic.SessionStart({ source: 'clear' })
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S2')).toBe(START + 11 * HOUR)
  })

  test('without always a turn never moves the deadline', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('90m'))
    await clock.advance(80 * MIN)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 90 * MIN)
    await clock.advance(10 * MIN)
    expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    expect(w.forks.length).toBe(0)
  })
})

describe('/keepwarm off during a rolling turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })

  test('off wins over the window a finishing turn was opening', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let holdEveryDelete = false
    let release = () => {}
    const storeGate = async (op: 'get' | 'set' | 'delete', key: string) => {
      if (holdEveryDelete && op === 'delete' && key === 'every:S1') {
        holdEveryDelete = false
        await new Promise<void>(r => { release = r })
      }
    }
    const w = world(on, [warm, warm], { store, storeGate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    // The next turn's roll pauses while saving its window; /keepwarm off runs to the end meanwhile.
    holdEveryDelete = true
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('desligar'))).text).toMatch(/^esquentador desligado/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })
})

describe('always, from the PR review', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const alwaysOn = () => new Map<string, unknown>([['always', true]])

  test('a longer window is kept, with its testing period reset to 50m', async ($, on) => {
    mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    const r = await $.command.run(run('48h a cada 2m'))
    expect(r.text).toMatch(/Como está ligado em toda sessão, a sua próxima mensagem estica para pelo menos 6 h, com um aquecimento a cada 50 min$/)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
    expect(store.has('every:S1')).toBe(false)
  })

  test('a 48h window without a testing period is untouched by a turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    await $.command.run(run('48h'))
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 48 * HOUR)
  })

  test('a turn that failed before any response does not open a window over a cold cache', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    // Back after the six-hour window ended; the first request fails for good, with no usage.
    await clock.advance(7 * HOUR)
    const before = w.forks.length
    await $.turn.complete(turn({ usage: undefined }))
    expect(store.has('deadline:S1')).toBe(false)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(before)
  })

  test('the cold-write receipt prints with always on, and the guard promises six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { store: alwaysOn() })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/o esquentador segura o cache por 6 h\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toBe('reescrita fria de 200k tokens paga (US$ 4,00).')
  })

  test('without always the receipt still offers three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/o esquentador segura o cache por 3 h\./)
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^reescrita fria de 200k tokens paga \(US\$ 4,00\)\. Mantendo o cache quente por 3 h/)
  })

  test('/keepwarm off in another session stops this one rolling at its next turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = alwaysOn()
    world(on, [], { store })
    await $.session.start(session)
    // Another session ran /keepwarm off: the shared switch is gone from the store.
    store.delete('always')
    await clock.advance(5 * HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
  })

  test('/keepwarm off that lands while the roll reads the clock wins', async ($, on) => {
    let now = START
    let skip = -1
    let release = () => {}
    on('clock.now', async () => {
      if (skip === 0) {
        skip = -1
        await new Promise<void>(r => { release = r })
      } else if (skip > 0) skip--
      return { value: now }
    })
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = alwaysOn()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 10 * MIN
    // The finishing turn reads the clock once, then the roll reads it again: hold that second read.
    skip = 1
    const finishing = $.turn.complete(turn())
    await settle()
    expect((await $.command.run(run('desligar'))).text).toMatch(/^esquentador desligado/)
    release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    expect(w.forks.length).toBe(0)
  })
})

describe('the shared always switch across a turn', () => {
  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  const holdOnce = (op: 'get' | 'set' | 'delete', key: string) => {
    let armed = false
    let release = () => {}
    const gate = async (o: 'get' | 'set' | 'delete', k: string) => {
      if (armed && o === op && k === key) {
        armed = false
        await new Promise<void>(r => { release = r })
      }
    }
    return { gate, arm: () => { armed = true }, release: () => release() }
  }

  test('/keepwarm off while the turn reads the switch is not undone by the old value', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    h.arm()
    const finishing = $.turn.complete(turn())
    await settle()
    await $.command.run(run('desligar'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect((await $.command.run(run('status'))).text).toBe('esquentador desligado')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('/keepwarm off during a cold-writing turn also stops its three-hour auto-warm', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const h = holdOnce('get', 'always')
    const w = world(on, [warm], { store, storeGate: h.gate })
    await $.session.start(session)
    await $.command.run(run('aviso avisar'))
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    const before = w.forks.length
    h.arm()
    const finishing = $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await settle()
    await $.command.run(run('desligar'))
    h.release()
    await finishing
    await settle()
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('reescrita fria de 200k tokens paga (US$ 4,00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(before)
  })

  test('always turned back on in another session reaches a session that saw it off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    world(on, [], { store })
    await $.session.start(session)
    store.delete('always')
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect((await $.command.run(run(''))).text).not.toMatch(/, em toda sessão/)
    store.set('always', true)
    await clock.advance(HOUR)
    await $.turn.complete(turn())
    expect(store.get('deadline:S1')).toBe(START + 8 * HOUR)
  })
})

describe('/keepwarm off while a turn is running', () => {
  test('a cold write landing after the off does not reopen three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^esquentador:/)
    await $.prompt.submit(prompt('hi'))
    // The paid resend's request is out when /keepwarm off runs, and its turn finishes after.
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.command.run(run('desligar'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.logs.at(-1)).toBe('reescrita fria de 200k tokens paga (US$ 4,00).')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('without an off the same cold write still arms three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    for await (const c of $.turn.step({ turnId: 'comeback', index: 0, model: 'claude-fable-5-1', messageCount: 3 })) void c
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.get('deadline:S1')).toBe(START + 2 * HOUR + 3 * HOUR)
  })
})

describe('a managed plugin above the user tier', () => {
  // Team and Enterprise accounts seat a builtin plugin at the prepend tier whose classic.* and session.compact hooks
  // continue beneath the user tier, so the mod's own hooks on those events never run.
  const managed: Plugin = {
    name: 'managed-sec',
    tier: 'prepend',
    register(on) {
      on('classic.SessionStart', ($, e, next) => next.to(e, 'append'))
      on('session.compact', ($, e, next) => next.to(e, 'append'))
    },
  }
  const end = ($: Parameters<TestBody>[0], sessionId: string, reason: 'clear' | 'resume' = 'clear') => $.session.end({ reason, sessionId, resume: { id: sessionId } })
  const step = async ($: Parameters<TestBody>[0], turnId: string, index: number, messageCount: number) => {
    for await (const c of $.turn.step({ turnId, index, model: 'claude-fable-5-1', messageCount })) void c
  }

  test('/clear reaches the mod through session.end: keepwarm stops, the tally empties and the new id is used', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.get('deadline:S1')).toBe(START + 5 * HOUR)
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    const card = (await $.command.run(run(''))).text
    expect(card).toMatch(/Cache: nenhuma mensagem nesta sessão ainda/)
    expect(card).toMatch(/Sessão: 0 reescritas frias pagas/)
    await $.command.run(run('2h'))
    expect(store.get('deadline:S2')).toBe(START + 4 * HOUR + 50 * MIN)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('always after /clear arms the new conversation under its own id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(store.has('deadline:S1')).toBe(false)
    await $.prompt.submit(prompt('hello'))
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /clear delivered twice, through session.end and the classic start, arms always once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    let started = START
    let sets = 0
    const w = world(on, [warm], { store, sid: () => sid, startedAt: () => started, storeGate: async (op, key) => { if (op === 'set' && key === 'deadline:S2') sets++ } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    started = clock.now()
    await $.classic.SessionStart({ source: 'clear' })
    expect(sets).toBe(1)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    await $.prompt.submit(prompt('hi'))
    expect(sets).toBe(1)
    // The end of a conversation already left changes nothing.
    await end($, 'S1')
    expect(store.get('deadline:S2')).toBe(START + 6 * HOUR)
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a resumed session whose fields never arrive warns once with the price instead of refusing', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs).toEqual([])
    expect((await $.command.run(run(''))).text).toMatch(/Cache: desconhecido, a sessão foi retomada sem a hora da última resposta/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs).toEqual(['retomada com até 200.000 tokens de contexto e sem a hora da última resposta, então o cache pode estar frio. Se estiver, esta mensagem reescreve tudo a US$ 20 por milhão = US$ 4,00.'])
    await $.prompt.submit(prompt('again'))
    expect(w.logs.length).toBe(1)
    // The write it paid is still scored off the context the engine reported.
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(w.logs.at(-1)).toMatch(/^reescrita fria de 200k tokens paga \(US\$ 4,00\)/)
  })

  test('a session first launched under an hour ago cannot be cold, so nothing is said', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs).toEqual([])
    expect((await $.command.run(run(''))).text).toMatch(/Cache: nenhuma mensagem nesta sessão ainda/)
  })

  test('a resumed transcript too young to be cold is warned about once it is old enough', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START + 30 * MIN })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 1800, context_tokens: 200000 })
    expect((await $.command.run(run(''))).text).toMatch(/Cache: sessão retomada sem a hora da última resposta, quente por até mais 30 min/)
    await clock.advance(HOUR)
    expect((await $.command.run(run(''))).text).toMatch(/Cache: desconhecido, a sessão foi retomada sem a hora da última resposta/)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^retomada com até 200\.000 tokens/)
  })

  test('with the resume fields delivered the guard prices the cold send and nothing is said twice', async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    const w = world(on, [], { live: { tokens: 200000 } })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^retomando com o cache frio/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/esfriou há 1 h/)
    expect(w.logs.length).toBe(1)
  })

  test('an in-process resume moves the guard to the new transcript and keeps the window', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let started = START
    const live = { tokens: 200000 }
    const w = world(on, [], { store, sid: () => sid, startedAt: () => started, live })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('3h'))
    await end($, 'S1', 'resume')
    sid = 'S2'
    started = clock.now() - 30 * MIN
    live.tokens = 80000
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 1800, context_tokens: 80000 })
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    const card = (await $.command.run(run(''))).text
    expect(card).toMatch(/Contexto: 80\.000 tokens/)
    expect(card).toMatch(/Sessão: 0 reescritas frias pagas/)
  })

  test('a restored window arms at session.start without the classic event', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 10 * MIN]])
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    await clock.advance(10 * MIN)
    expect(w.status.at(-1)).toBe(undefined)
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('the classic start arriving after session.start leaves one timer and one ping', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:S1', START + 3 * HOUR]])
    const w = world(on, [warm, warm], { store })
    await $.session.start(session)
    await $.classic.SessionStart({ session_id: 'S1', source: 'startup' })
    await $.turn.complete(turn())
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a compaction that never reaches the mod is read off the next request\'s shorter transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'after', 0, 3)
    expect((await $.command.run(run(''))).text).toMatch(/Cache: zerado pela compactação/)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 0 reescritas frias pagas/)
  })

  test('a summary written after a warm request in the same turn is no cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'long', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 150500 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 0 reescritas frias pagas/)
  })

  test('a rewind of a few messages is not a compaction', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'rewound', 0, 38)
    expect((await $.command.run(run(''))).text).toMatch(/Cache: quente/)
  })

  test('a cold write and a compaction in the same turn still score the write', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 10000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await step($, 'comeback', 0, 42)
    await step($, 'comeback', 1, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 210000 }) }))
    expect(w.logs.at(-1)).toMatch(/^reescrita fria de 200k tokens paga \(US\$ 4,00\)/)
  })

  test('a classic clear after a command already seated the new conversation leaves its window alone', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    let sid = 'S1'
    const w = world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await end($, 'S1')
    sid = 'S2'
    await $.command.run(run('2h'))
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    await $.classic.SessionStart({ session_id: 'S2', source: 'clear' })
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
  })

  test('a model switched at an in-process resume prices the new transcript', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START + 3 * HOUR })
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const w = world(on, [], { sid: () => sid, model: () => model, live: { tokens: 200000 } })
    await $.session.start(session)
    // Haiku re-writes these 200k tokens for $0.20, under the shipped $1 floor: a zero floor keeps the line in view.
    await $.command.run(run('aviso 0'))
    await $.turn.complete(turn())
    await end($, 'S1', 'resume')
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toBe('retomada com até 200.000 tokens de contexto e sem a hora da última resposta, então o cache pode estar frio. Se estiver, esta mensagem reescreve tudo a US$ 1 por milhão = US$ 0,20.')
    expect((await $.command.run(run(''))).text).toMatch(/\nModelo: claude-haiku-5-5\n/)
  })

  test('a classic resume ahead of the old conversation\'s end keeps the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const w = world(on, [], { sid: () => sid, live: { tokens: 200000 } })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    await $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect(w.logs.at(-1)).toMatch(/^retomando com o cache frio/)
    await end($, 'S1', 'resume')
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/esfriou há 1 h/)
    expect(w.logs.length).toBe(1)
  })

  test('a window carried through a resume moves to the new id, so off and the old session find the right keys', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    world(on, [], { store, sid: () => sid })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h a cada 2m'))
    expect(store.get('deadline:S1')).toBe(START + 3 * HOUR)
    await end($, 'S1', 'resume')
    sid = 'S2'
    await $.prompt.submit(prompt('hi'))
    expect([...store.keys()].sort()).toEqual(['deadline:S2', 'every:S2'])
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    expect(store.get('every:S2')).toBe(2 * MIN)
    await $.command.run(run('desligar'))
    expect([...store.keys()]).toEqual(['off'])
  })

  const settle = () => new Promise<void>(r => { (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown }).setTimeout(r, 20) })
  // Holds every delete of one key until released, in order, so two ends of the same conversation can be interleaved.
  const holdDeletes = (key: string) => {
    const waiting: Array<() => void> = []
    return {
      gate: async (op: 'get' | 'set' | 'delete', k: string) => { if (op === 'delete' && k === key) await new Promise<void>(r => { waiting.push(r) }) },
      release: () => waiting.shift()?.(),
      held: () => waiting.length,
    }
  }

  test('a session.end that lands while the classic resume is still deleting the old keys cannot wipe the seeded clock', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store: new Map<string, unknown>(), sid: () => sid, live: { tokens: 200000 }, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    sid = 'S2'
    const resuming = $.classic.SessionStart({ session_id: 'S2', source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    await settle()
    expect(held.held()).toBe(1)
    const ending = end($, 'S1', 'resume')
    await settle()
    held.release()
    await resuming
    held.release()
    await ending
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toMatch(/^retomando com o cache frio/)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/esfriou há 1 h/)
    expect(w.logs.length).toBe(1)
  })

  test('an end cut short in its store cleanup has already dropped the old timer and id', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [warm], { store, sid: () => sid, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('3h'))
    const ending = end($, 'S1', 'resume')
    await settle()
    expect(held.held()).toBe(1)
    sid = 'S2'
    // The old conversation's ping is due while its end is still waiting on the store; the transcript it would fork is gone.
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(0)
    await $.prompt.submit(prompt('hi'))
    expect(store.get('deadline:S2')).toBe(START + 3 * HOUR)
    held.release()
    await ending
    expect(store.has('deadline:S1')).toBe(false)
  })

  test('a /keepwarm while the old conversation is still ending waits for the host to report the next id', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    let sid = 'S1'
    let model = 'claude-fable-5-1'
    const held = holdDeletes('deadline:S1')
    const w = world(on, [], { store, sid: () => sid, model: () => model, storeGate: held.gate })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('1h'))
    const ending = end($, 'S1')
    await settle()
    expect(held.held()).toBe(1)
    // The host still answers the old id: the window waits in memory, nothing is written under that id.
    expect((await $.command.run(run('2h'))).text).toMatch(/^esquentador ligado por 2 h/)
    expect(store.get('deadline:S1')).toBe(START + HOUR)
    held.release()
    await ending
    expect(store.size).toBe(0)
    sid = 'S2'
    model = 'claude-haiku-5-5'
    await $.prompt.submit(prompt('hi'))
    expect([...store.keys()]).toEqual(['deadline:S2'])
    expect(store.get('deadline:S2')).toBe(START + 2 * HOUR)
    expect(w.status.at(-1)).toBe('🌡️ esquentador ligado · começa depois da sua próxima mensagem')
    expect((await $.command.run(run(''))).text).toMatch(/\nModelo: claude-haiku-5-5\n/)
  })

  test('a guarded cold send compacted before its first request pays the summary, not a cold write', { plugins: [managed] }, async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { steps: [usage(), usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 })] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toMatch(/^esquentador:/)
    await $.prompt.submit(prompt('hi'))
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await step($, 'comeback', 0, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 150000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 0 reescritas frias pagas/)
  })

  test('a second compaction in one turn does not turn the first summary into a cold write', { plugins: [managed] }, async ($, on) => {
    mock.clock(on, { now: START })
    const summary = usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 120000 })
    const w = world(on, [], { steps: [usage(), usage(), summary, usage(), summary] })
    await $.session.start(session)
    await step($, 'first', 0, 40)
    await $.turn.complete(turn())
    await step($, 'long', 0, 42)
    await step($, 'long', 1, 3)
    await step($, 'long', 2, 15)
    await step($, 'long', 3, 3)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 200000, cache_creation_input_tokens: 241000 }) }))
    expect(w.logs).toEqual([])
    expect(w.status.at(-1)).toBe(undefined)
    expect((await $.command.run(run(''))).text).toMatch(/Sessão: 0 reescritas frias pagas/)
  })
})

describe('dollar guard', () => {
  test('the shipped default warns: a cold send goes through with its price', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('hi'))).drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/esfriou há 2 h\. Esta mensagem reescreve até 200\.502 tokens a US\$ 20 por milhão = US\$ 4,01 .*Enviando assim mesmo; o esquentador segura o cache por 6 h depois\./)
    expect((await $.command.run(run(''))).text).toMatch(/Aviso: só avisa a partir de US\$ 1,00 de reescrita/)
  })

  test('below the dollar floor a cold send passes quietly, even on refuse', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true, model: 'claude-sonnet-5-5' })
    await $.session.start(session)
    await $.command.run(run('aviso segurar'))
    const sonnet = usage({ model: 'claude-sonnet-5-5' })
    await $.turn.complete(turn({ usage: sonnet }))
    await clock.advance(3 * HOUR)
    // 200,502 tokens at $4/MTok is $0.80, under the $1 floor.
    expect((await $.prompt.submit(prompt('cheap'))).drop).toBe(undefined)
    expect(w.logs).toEqual([])
    expect((await $.command.run(run('aviso 0.5'))).text).toMatch(/custaria US\$ 0,50 ou mais/)
    await $.turn.complete(turn({ usage: sonnet }))
    await clock.advance(3 * HOUR)
    expect((await $.prompt.submit(prompt('now'))).drop).toMatch(/^esquentador: .* = US\$ 0,80/)
  })

  test('the floor takes only an amount and is saved', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { store, shipped: true })
    await $.session.start(session)
    expect((await $.command.run(run('aviso lots'))).text).toMatch(/^diga o valor em dólares/)
    expect((await $.command.run(run('aviso $2.50'))).text).toMatch(/US\$ 2,50 ou mais/)
    expect(store.get('guardMin')).toBe(2.5)
    expect(store.has('guard')).toBe(false)
    expect((await $.command.run(run('aviso'))).text).toMatch(/^diga o valor em dólares/)
  })

  test('a saved floor and mode are read back at session start', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { store: new Map<string, unknown>([['guardMin', 3], ['guard', 'refuse']]), shipped: true })
    await $.session.start(session)
    expect((await $.command.run(run(''))).text).toMatch(/Aviso: segura a mensagem uma vez a partir de US\$ 3,00 de reescrita/)
  })

  test('a cold resume under the floor says nothing', async () => {
    expect(seedFromResume(freshState(), { source: 'resume', model: 'claude-sonnet-5-5', context_tokens: 200000, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.8 }, START)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', model: 'claude-sonnet-5-5', context_tokens: 300000, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true }, START)).toMatch(/cerca de US\$ 1,20/)
  })
})

describe('cache lifetime', () => {
  const step = async ($: Parameters<TestBody>[0], turnId: string, model = 'claude-fable-5-1') => {
    for await (const c of $.turn.step({ turnId, index: 0, model, messageCount: 3 })) void c
  }
  const rewrite = usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 })

  test('without a setting or a sign the card assumes one hour', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { shipped: true })
    await $.session.start(session)
    expect((await $.command.run(run(''))).text).toMatch(/Duração do cache: 1 hora \(o padrão do Claude Code/)
  })

  test('promptCacheTtl is read as the declared lifetime', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true, promptCacheTtl: '1h' })
    await $.session.start(session)
    expect(w.logs).toEqual([])
    expect((await $.command.run(run(''))).text).toMatch(/Duração do cache: 1 hora \(definido por promptCacheTtl 1h\)/)
  })

  test('a send twelve minutes after the last that writes the context again pauses keepwarm and reprices the write', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { shipped: true, steps: [rewrite] })
    await $.session.start(session)
    await $.command.run(run('6h'))
    await $.turn.complete(turn())
    await clock.advance(12 * MIN)
    await step($, 'comeback')
    expect(w.logs.at(-1)).toMatch(/dura 5 minutos \(uma mensagem 12 min depois da anterior escreveu o contexto de novo\)/)
    await $.turn.complete(turn({ usage: rewrite }))
    // 200,000 tokens at the five-minute rate, $12.50/MTok on Fable 5.1, and no window opened for it.
    expect(w.logs.at(-1)).toMatch(/^reescrita fria de 200k tokens paga \(US\$ 2,50\)\.$/)
    expect(w.status.at(-1)).toMatch(/esquentador pausado/)
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
    const card = (await $.command.run(run(''))).text
    expect(card).toMatch(/Duração do cache: 5 minutos \(visto: uma mensagem 12 min depois da anterior escreveu o contexto de novo\)/)
    expect(card).toMatch(/Cache: FRIO/)
  })

  test('a declared five minutes gives way to a send that reads the context back twenty minutes later', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { shipped: true, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' }, steps: [usage()] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/dura 5 minutos \(CLAUDE_CODE_PROMPT_CACHE_TTL=5m\)/)
    expect((await $.command.run(run('6h'))).text).toMatch(/^esquentador ligado por 6 h, mas pausado por enquanto: o cache desta conta dura 5 minutos/)
    await $.turn.complete(turn())
    await clock.advance(20 * MIN)
    await step($, 'back')
    expect(w.logs.at(-1)).toMatch(/voltou para 1 hora \(uma mensagem 20 min depois da anterior leu o contexto de volta\)/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/reaquece em 50 min/)
    await clock.advance(50 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the write split, when the host passes it on, settles the lifetime at once', async ($, on) => {
    mock.clock(on, { now: START })
    const split = (five: number, hour: number) => ({ ...usage(), cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } }) as TurnUsage
    const w = world(on, [], { shipped: true, steps: [split(500, 0), split(0, 500)] })
    await $.session.start(session)
    await step($, 'one')
    expect(w.logs.at(-1)).toMatch(/dura 5 minutos \(a última escrita foi para o cache de 5 minutos\)/)
    await $.turn.complete(turn())
    await step($, 'two')
    expect(w.logs.at(-1)).toMatch(/voltou para 1 hora \(a última escrita foi para o cache de 1 hora\)/)
  })

  test('FORCE_PROMPT_CACHING_5M outranks promptCacheTtl, and a cold write on five minutes opens no three-hour window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm], { shipped: true, env: { FORCE_PROMPT_CACHING_5M: '1' }, promptCacheTtl: '1h' })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/dura 5 minutos \(FORCE_PROMPT_CACHING_5M\)/)
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    await $.prompt.submit(prompt('hi'))
    expect(w.logs.at(-1)).toMatch(/esfriou há 5 min\. Esta mensagem reescreve até 200\.502 tokens a US\$ 12,50 por milhão = US\$ 2,51 .*Enviando assim mesmo\.$/)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/^reescrita fria de 201k tokens paga \(US\$ 2,51\)\.$/)
    // Only the window every session gets, paused: pings cannot hold a five-minute cache.
    expect(w.status.at(-1)).toBe('⏸️ esquentador pausado · o cache desta conta dura 5 min, e aquecer não segura')
    await clock.advance(2 * HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('a rewrite after a model switch is no sign of a short cache', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true, steps: [usage({ model: 'claude-opus-5-5', cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 })] })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(12 * MIN)
    await step($, 'switched', 'claude-opus-5-5')
    expect(w.logs).toEqual([])
  })
})

describe('commands under /eleazar', () => {
  const cmd = (command: string, args = ''): CommandRunInput => ({ ...run(args), command })

  test('typing /eleazar lists one command per option', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { shipped: true })
    await $.session.start(session)
    expect(w.registered).toEqual(['eleazar', 'eleazar-ligar', 'eleazar-desligar', 'eleazar-status', 'eleazar-janela', 'eleazar-aviso-avisar', 'eleazar-aviso-segurar', 'eleazar-aviso-valor'])
  })

  test('each option runs as its own command', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    world(on, [], { shipped: true, store })
    await $.session.start(session)
    await $.turn.complete(turn())
    expect((await $.command.run(cmd('eleazar'))).text).toMatch(/^🔥 quente · reaquece em 50 min\nModelo: claude-fable-5-1\n/)
    expect((await $.command.run(cmd('eleazar-status'))).text).toBe('🔥 quente · reaquece em 50 min · janela por mais 6 h')
    expect((await $.command.run(cmd('eleazar-aviso-segurar'))).text).toMatch(/^aviso em segurar/)
    expect(store.get('guard')).toBe('refuse')
    expect((await $.command.run(cmd('eleazar-aviso-avisar'))).text).toMatch(/^aviso em avisar/)
    expect(store.get('guard')).toBe('warn')
    expect((await $.command.run(cmd('eleazar-aviso-valor', '2,50'))).text).toBe('o aviso agora aparece quando reaquecer o cache frio custaria US$ 2,50 ou mais')
    expect(store.get('guardMin')).toBe(2.5)
    expect((await $.command.run(cmd('eleazar-aviso-valor'))).text).toBe('diga o valor em dólares, como /eleazar-aviso-valor 2 ou /eleazar-aviso-valor 2,50')
    expect((await $.command.run(cmd('eleazar-desligar'))).text).toMatch(/^esquentador desligado, nesta e nas próximas sessões/)
    expect(store.get('off')).toBe(true)
    expect((await $.command.run(cmd('eleazar-ligar'))).text).toMatch(/^esquentador ligado em toda sessão/)
    expect(store.has('off')).toBe(false)
  })

  test('/eleazar-janela takes a size and nothing else', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    const ask = 'diga o tamanho da janela, como /eleazar-janela 90m ou /eleazar-janela 2h'
    expect((await $.command.run(cmd('eleazar-janela'))).text).toBe(ask)
    expect((await $.command.run(cmd('eleazar-janela', 'ligar'))).text).toBe(ask)
    expect(store.get('always')).toBe(undefined)
    expect((await $.command.run(cmd('eleazar-janela', '90m a cada 2m'))).text).toMatch(/^esquentador ligado por 1 h 30 min: depois de 2 min parado/)
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(1)
  })
})
