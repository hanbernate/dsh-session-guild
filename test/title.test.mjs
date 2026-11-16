/**
 * Quest title rules: the `title` argument, its legacy aliases, and the byte
 * budget that gives up the workspace attribution before the title itself.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { questLabel } from '../lib/records.js'
import { questSessionTitle } from '../lib/sessions.js'

const sizeOf = text => Buffer.byteLength(text, 'utf8')

test('questLabel prefers title, accepts description, then the first quest line', () => {
  assert.equal(questLabel({ quest: 'q', title: '  修复下载按钮  ' }), '修复下载按钮', 'the title is trimmed')
  assert.equal(questLabel({ quest: 'q', title: 't', description: 'legacy' }), 't', 'title wins over the legacy label')
  assert.equal(questLabel({ quest: 'q', description: 'legacy' }), 'legacy', 'old tool calls keep their label')
  assert.equal(questLabel({ quest: 'q', title: '   ' }), 'q', 'a blank title falls back to the quest')
  assert.equal(questLabel({ quest: 'first line\nsecond line' }), 'first line', 'only the first quest line is used')
  assert.equal(questLabel({ task: 'old task' }), 'old task', 'the pre-rename quest parameter still rebuilds')
  assert.equal(questLabel(undefined), '')
})

test('a title that fits keeps the full attribution', () => {
  assert.equal(questSessionTitle('下载按钮', 'alpha', 80), '📜 下载按钮 (from alpha)')
})

test('a long title shortens the attribution instead of being cut', () => {
  const label = '修'.repeat(20)
  const full = `📜 ${label} (from dsh-workspace-guild)`
  assert.ok(sizeOf(full) > 80)
  const title = questSessionTitle(label, 'dsh-workspace-guild', 80)
  assert.equal(title, `📜 ${label} (from dsh-…)`, 'the workspace name gives way')
  assert.equal(sizeOf(title), 80)
})

test('the attribution is dropped when too little of it would remain', () => {
  const label = '修'.repeat(22)
  const title = questSessionTitle(label, 'alpha', 80)
  assert.equal(title, `📜 ${label}`, 'no dangling (from …)')
})

test('the title itself is cut only after the attribution is gone', () => {
  const label = '修'.repeat(30)
  const title = questSessionTitle(label, 'alpha', 80)
  assert.ok(title.startsWith('📜 修'), 'the marker and title lead')
  assert.ok(title.endsWith('…'), 'the cut is marked')
  assert.equal(sizeOf(title), 80)
})

test('the fitted title never exceeds the byte budget', () => {
  const labels = ['下载按钮', '修'.repeat(12), '修'.repeat(26), 'a'.repeat(200), '🎉🎉🎉🎉🎉']
  const sources = ['alpha', 'dsh-workspace-guild', '一个很长很长的工作区名字']
  for (const label of labels) {
    for (const source of sources) {
      for (const budget of [40, 60, 80, 120]) {
        const title = questSessionTitle(label, source, budget)
        assert.ok(sizeOf(title) <= budget, `${title} fits ${budget}`)
        assert.ok(title.startsWith('📜 '), 'the quest marker survives')
      }
    }
  }
})
