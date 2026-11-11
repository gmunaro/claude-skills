// End to end without real models: frozen plan → register → collect (with a tampered packet) →
// close → tally.mjs → council-table.mjs, with a fake T3 CLI and a temporary HOME.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildPlan } from './council-t3.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))

function fakeCli(root) {
  const bin = path.join(root, 'bin.mjs')
  fs.writeFileSync(bin, `import fs from 'node:fs'
const [, , cmd, sub, id] = process.argv
const responses = JSON.parse(fs.readFileSync(process.env.T3_FAKE_RESPONSES, 'utf8'))
if (cmd !== 'thread' || sub !== 'show' || !responses[id]) { console.error('unknown: ' + process.argv.slice(2).join(' ')); process.exit(1) }
console.log(JSON.stringify(responses[id]))
`)
  if (process.platform === 'win32') {
    const cmd = path.join(root, 't3.cmd')
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${bin}" %*\r\n`)
    return cmd
  }
  const sh = path.join(root, 't3')
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`, { mode: 0o755 })
  return sh
}

const review = (vote) => JSON.stringify({ vote, confidence: 'high', reasons: ['fact from the packet'], what_would_change_my_vote: 'another fact',
  scores: ['A', 'B'].map((option) => ({ option, category: 'risk', score: option === vote ? 9 : 4, gap: 'needs proof' })) })

test('full flow: collect restores the packet, close finishes, tally decides through the normal flow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-e2e-'))
  const round = path.join(root, 'round')
  fs.mkdirSync(round)
  const packets = [1, 2].map((k) => ({ path: path.join(round, `packet-${k}.md`).replaceAll('\\', '/'), prompt: `# Decision ${k}\ncontent ${k}\n` }))
  packets.forEach((p) => fs.writeFileSync(p.path, p.prompt))
  const queried = new Date().toISOString()
  const snapshot = { scale: 'Artificial Analysis Intelligence Index', version: '4', queried_at: queried, models: [
    { slug: 'claude-haiku-5-5-low', aa_id: 'h', name: 'Haiku', value: 40, source: 'https://artificialanalysis.ai/models/h' },
    { slug: 'claude-sonnet-5-5-low', aa_id: 's', name: 'Sonnet', value: 50, source: 'https://artificialanalysis.ai/models/s' }] }
  const plan = buildPlan({ jobs: [{ group: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
    { group: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }, { group: 'free', model: 'x/slow:free', effort: 'default' }],
    runtimeModels: ['x/slow:free'], packets, threadId: 'thread-e2e', phase: 'decision', snapshot })
  plan.created_at = new Date().toISOString()
  const planFile = path.join(round, 'plan-t3.json')
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2))

  const ids = plan.calls.map((c) => c.parameters.clientRequestId)
  const task = (id) => `node:delegated-task:e2e:${id}`
  fs.writeFileSync(path.join(root, 'batch.json'), JSON.stringify(ids.map((id) => ({ clientRequestId: id, taskId: task(id) }))))
  const now = new Date().toISOString()
  const done = { status: 'completed', createdAt: now, updatedAt: now }
  const responses = {
    [`thread:delegated-task:e2e:${ids[0]}`]: { thread: done, messages: [{ role: 'assistant', text: review('A') }] },
    // Sonnet uses packet-2 and finishes after the tampering: it must come out suspect.
    [`thread:delegated-task:e2e:${ids[1]}`]: { thread: { ...done, updatedAt: new Date(Date.now() + 60000).toISOString() }, messages: [{ role: 'assistant', text: '```json\n' + review('A') + '\n```' }] },
    [`thread:delegated-task:e2e:${ids[2]}`]: { thread: { status: 'running', createdAt: now }, messages: [] },
  }
  fs.writeFileSync(path.join(root, 'responses.json'), JSON.stringify(responses))
  const env = { ...process.env, T3CODE_CLI_PATH: fakeCli(root), T3_FAKE_RESPONSES: path.join(root, 'responses.json'),
    USERPROFILE: root, HOME: root }
  const run = (script, args) => execFileSync(process.execPath, [path.join(dir, script), ...args], { env, encoding: 'utf8' })
  const flags = ['--plan', planFile, '--options', 'A,B', '--categories', 'risk']

  run('council-t3.mjs', ['register', '--plan', planFile, '--batch', path.join(root, 'batch.json')])
  fs.writeFileSync(packets[1].path, 'tampered by a participant')

  const c1 = JSON.parse(run('council-t3.mjs', ['collect', ...flags]).trim())
  assert.equal(c1.valid, 2)
  assert.equal(c1.pending, 1)
  assert.equal(c1.packet_changes, 1)
  assert.equal(c1.ready_for_analysis, false)
  assert.equal(fs.readFileSync(packets[1].path, 'utf8'), packets[1].prompt, 'packet restored from the plan')
  const collection = JSON.parse(fs.readFileSync(path.join(round, 'collection.json'), 'utf8'))
  assert.equal(collection.entries.filter((e) => e.suspect).length, 1, 'anyone who used the changed packet and finished later becomes suspect')

  assert.throws(() => run('tally.mjs', flags.slice(0, 4)), /Collection still open/)
  const output = run('council-t3.mjs', ['close', ...flags])
  assert.match(output, /"ready_for_analysis":true/)
  assert.ok(output.includes(task(ids[2])), 'close returns the in-flight taskId for task_cancel')
  const pend = JSON.parse(run('council-t3.mjs', ['pending', '--plan', planFile]))
  assert.equal(pend.pending, 0, 'a closed round does not dispatch the queue')

  const d = JSON.parse(run('tally.mjs', flags.slice(0, 4)))
  assert.equal(d.result, 'decision')
  assert.equal(d.choice, 'A')
  assert.equal(d.quorum.ok, true)
  assert.deepEqual(d.discarded, { canceled: 1 })
  assert.equal(d.suspects, 1)

  run('council-table.mjs', [path.join(round, 'collection.json'), path.join(round, 'table.html')])
  assert.match(fs.readFileSync(path.join(round, 'table.html'), 'utf8'), /suspect/)

  const hist = JSON.parse(fs.readFileSync(path.join(root, '.cache/council/history.json'), 'utf8'))
  const models = Object.values(hist.rounds)[0].models
  assert.deepEqual(models['claude-haiku-5-5'], { group: 'claude', attempts: 1, valid: 1 })
  assert.equal(models['x/slow:free'], undefined, 'canceled does not count in the history')
  fs.rmSync(root, { recursive: true, force: true })
})
