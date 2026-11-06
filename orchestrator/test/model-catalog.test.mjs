import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCatalog, normalizeModel, validateModel, applyProbe, isRoleEligible, CURSOR_PROVIDER,
} from '../lib/model-catalog.mjs'

test('catalog: discovered models are not callable', () => {
  const catalog = buildCatalog({
    config: { models: {} },
    discovery: { providers: { cursor: { models: [{ id: 'cursor-model-x' }] } } },
  })
  const m = catalog.models.find((x) => x.id === 'cursor-model-x')
  assert.equal(m.availability, 'discovered')
  assert.equal(isRoleEligible(m).ok, false)
})

test('catalog: manual unverified model is not top-eligible', () => {
  const m = normalizeModel({ key: 'c1', provider: 'cursor', id: 'c1', tier: 'top' })
  assert.equal(m.identity, 'unverified')
  assert.equal(isRoleEligible(m, { tier: 'top' }).reason, 'unavailable:unknown')
})

test('catalog: only callable + verified + top passes eligibility', () => {
  const m = applyProbe(normalizeModel({ key: 'c1', provider: 'cursor', id: 'c1', tier: 'top' }), {
    ok: true, modelResolved: 'c1', at: '2026-11-06T00:00:00.000Z',
  })
  assert.equal(m.availability, 'callable')
  assert.equal(m.identity, 'verified')
  assert.equal(isRoleEligible(m, { tier: 'top' }).ok, true)
  assert.equal(isRoleEligible(m, { tier: 'advanced' }).ok, false)
})

test('catalog: auth probe becomes blocked and stays unverified', () => {
  const m = applyProbe(normalizeModel({ key: 'c1', provider: 'cursor', id: 'c1' }), { ok: false, error: 'auth' })
  assert.equal(m.availability, 'blocked')
  assert.equal(m.identity, 'unverified')
})

test('catalog: cursor provider manifest is explicit about missing non-interactive discovery', () => {
  assert.equal(CURSOR_PROVIDER.provider, 'cursor')
  assert.equal(CURSOR_PROVIDER.capabilities.non_interactive, false)
  assert.equal(CURSOR_PROVIDER.capabilities.model_list, false)
})

test('catalog: invalid tier is rejected', () => {
  const m = normalizeModel({ key: 'x', provider: 'p', id: 'x', tier: 'bogus' })
  assert.equal(validateModel(m).ok, false)
})
