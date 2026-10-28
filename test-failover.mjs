// Unit test for the gateway's 429 failover + pool discovery.
// Stubs globalThis.fetch so nothing leaves the machine.
const calls = []
let plan = () => 429

const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const key = init?.headers?.['x-goog-api-key']
  calls.push({ url: String(url), key })
  const verdict = plan(calls.length, key)
  if (verdict === 429) {
    return new Response(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }), {
      status: 429, headers: { 'content-type': 'application/json' },
    })
  }
  if (verdict === 503) {
    return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), {
      status: 503, headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

process.env.GEMINI_API_KEY_1 = 'K1'
process.env.GEMINI_API_KEY_2 = 'K2'
process.env.GEMINI_API_KEY_3 = 'K3'
process.env.GEMINI_API_KEY_4 = 'K4'
process.env.GEMINI_API_KEY_5 = 'K5'

const { default: worker } = await import('./src/worker.mjs')

const body = JSON.stringify({ model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'hi' }] })
const call = () => worker.fetch(new Request('https://x/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body,
}))

let pass = 0, fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok  ', name) } else { fail++; console.log('  FAIL', name, extra) }
}

// 1. pool discovery: 5 keys configured -> up to 5 attempts
calls.length = 0; plan = () => 429
let r = await call()
check('all-429 walks the whole pool (5 attempts)', calls.length === 5, `got ${calls.length}`)
check('all-429 surfaces 429 to the caller', r.status === 429, `got ${r.status}`)
check('attempts use distinct keys', new Set(calls.map((c) => c.key)).size === 5,
  JSON.stringify(calls.map((c) => c.key)))

// 2. failover succeeds when a later key has budget
calls.length = 0; plan = (n) => (n < 3 ? 429 : 200)
r = await call()
check('429 then success returns 200', r.status === 200, `got ${r.status}`)
check('stopped as soon as a key worked', calls.length === 3, `got ${calls.length}`)

// 3. 503 must NOT be retried (it consumes quota)
calls.length = 0; plan = () => 503
r = await call()
check('503 is NOT retried - exactly one upstream call', calls.length === 1, `got ${calls.length}`)
check('503 passes through to the caller', r.status === 503, `got ${r.status}`)

globalThis.fetch = realFetch
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
