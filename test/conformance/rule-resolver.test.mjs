import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConformance } from '../../src/conformance/rule-resolver.mjs'

const baseInput = {
  target: { path: 'src/service/user.mjs', language: 'javascript', changeClass: 'GENERATED_GLUE' },
  workspaceIdentityRef: 'WS-001@rev-1',
  boundedScope: { paths: { include: ['**/*.mjs'] } },
  searchCoverage: { ref: 'SEARCH-001', state: 'BOUNDED_SUFFICIENT' },
}

function rule(overrides = {}) {
  return {
    id: 'CR-001',
    object_revision: '1',
    rule_class: 'FORMAT',
    statement: 'Use single quotes',
    source_class: 'EXECUTABLE_CONFIG',
    scope: { paths: { include: ['**/*.mjs'], exclude: [] } },
    epistemic_state: 'VERIFIED',
    binding_state: 'REPOSITORY_DECLARED',
    enforcement_state: 'TOOL_CHECKED',
    enforcement_backend_refs: ['CMD-FORMAT-CHECK'],
    mutation_policy: 'FORMAT_ONLY',
    autofix: { state: 'DETERMINISTIC' },
    precedence: { resolver_family: 'prettier', overrides: [], overridden_by: [] },
    lifecycle_state: 'ACTIVE',
    decision: { key: 'quotes', value: 'single' },
    ...overrides,
  }
}

function waiver(overrides = {}) {
  return {
    id: 'CW-001',
    object_revision: '1',
    rule_ref: 'CR-001',
    scope: { paths: ['src/service/**'], symbols: [], conditions: [] },
    waiver_type: 'EXPLICIT_CONFIG',
    epistemic_state: 'VERIFIED',
    governance_effect: 'REPOSITORY_DECLARED',
    requirement_compatibility: 'COMPATIBLE',
    lifecycle_state: 'ACTIVE',
    ...overrides,
  }
}

test('legal empty resolution requires bounded sufficient coverage', () => {
  const result = resolveConformance(baseInput)
  assert.equal(result.status, 'RESOLVED')
  assert.equal(result.resolution_basis, 'NO_APPLICABLE_RULE_IN_BOUND_SCOPE')
  assert.deepEqual(result.effective_rule_refs, [])
  assert.equal(result.effective_mutation_policy, 'NOT_APPLICABLE')
})

test('partial search cannot masquerade as no applicable rule', () => {
  const result = resolveConformance({ ...baseInput, searchCoverage: { ref: 'SEARCH-P', state: 'PARTIAL' } })
  assert.equal(result.status, 'PARTIAL')
  assert.equal(result.resolution_basis, 'PARTIAL_SEARCH')
  assert.match(result.unknowns.join('\n'), /NO_RULE_CONCLUSION_REQUIRES_BOUNDED_SUFFICIENT_SEARCH/)
})

test('observed pattern is context, not an enforceable rule', () => {
  const observed = rule({
    source_class: 'OBSERVED_PATTERN',
    binding_state: 'OBSERVATION_ONLY',
    decision: { key: 'quotes', value: 'single' },
  })
  const result = resolveConformance({ ...baseInput, rules: [observed] })
  assert.equal(result.status, 'RESOLVED')
  assert.equal(result.resolution_basis, 'NO_APPLICABLE_RULE_IN_BOUND_SCOPE')
  assert.deepEqual(result.observation_rule_refs, ['CR-001'])
  assert.deepEqual(result.effective_rule_refs, [])
})

test('explicit scoped override wins without using generic path specificity', () => {
  const root = rule({ id: 'CR-ROOT', decision: { key: 'quotes', value: 'single' } })
  const nested = rule({
    id: 'CR-NESTED',
    scope: { paths: { include: ['src/service/**'], exclude: [] } },
    decision: { key: 'quotes', value: 'double' },
    precedence: { resolver_family: 'prettier', overrides: ['CR-ROOT'], overridden_by: [] },
  })
  const result = resolveConformance({ ...baseInput, rules: [root, nested] })
  assert.equal(result.status, 'RESOLVED')
  assert.deepEqual(result.effective_rule_refs, ['CR-NESTED'])
  assert.equal(result.precedence_decisions[0].reason, 'EXPLICIT_OVERRIDE')
})

test('cross-family contradictory decisions remain conflict without authority or explicit override', () => {
  const a = rule({ id: 'CR-A', decision: { key: 'quotes', value: 'single' }, precedence: { resolver_family: 'formatter-a' } })
  const b = rule({ id: 'CR-B', decision: { key: 'quotes', value: 'double' }, precedence: { resolver_family: 'formatter-b' } })
  const result = resolveConformance({ ...baseInput, rules: [a, b] })
  assert.equal(result.status, 'CONFLICT')
  assert.equal(result.conflicts[0].type, 'RULE_DECISION_CONFLICT')
})

test('requirement-bound rule outranks conflicting repository-declared rule', () => {
  const repoRule = rule({ id: 'CR-REPO', decision: { key: 'quotes', value: 'single' } })
  const reqRule = rule({
    id: 'CR-REQ',
    binding_state: 'REQUIREMENT_BOUND',
    requirement_refs: ['REQ-001'],
    authority_ref: 'REQ-001@4',
    decision: { key: 'quotes', value: 'double' },
    precedence: { resolver_family: 'requirement' },
  })
  const result = resolveConformance({ ...baseInput, rules: [repoRule, reqRule] })
  assert.equal(result.status, 'RESOLVED')
  assert.deepEqual(result.effective_rule_refs, ['CR-REQ'])
  assert.equal(result.precedence_decisions[0].reason, 'REQUIREMENT_BOUND_PRIORITY')
})

test('repository-local waiver cannot waive a requirement-bound rule', () => {
  const reqRule = rule({
    binding_state: 'REQUIREMENT_BOUND',
    requirement_refs: ['REQ-001'],
    authority_ref: 'REQ-001@4',
  })
  const result = resolveConformance({ ...baseInput, rules: [reqRule], waivers: [waiver()] })
  assert.equal(result.status, 'CONFLICT')
  assert.equal(result.conflicts[0].type, 'WAIVER_AUTHORITY_CONFLICT')
  assert.deepEqual(result.effective_rule_refs, ['CR-001'])
})

test('authorized requirement waiver produces explicit fully-waived resolution', () => {
  const reqRule = rule({
    binding_state: 'REQUIREMENT_BOUND',
    requirement_refs: ['REQ-001'],
    authority_ref: 'REQ-001@4',
  })
  const allowed = waiver({ governance_effect: 'REQUIREMENT_AUTHORIZED' })
  const result = resolveConformance({ ...baseInput, rules: [reqRule], waivers: [allowed] })
  assert.equal(result.status, 'RESOLVED')
  assert.equal(result.resolution_basis, 'APPLICABLE_RULES_WITH_WAIVERS')
  assert.deepEqual(result.effective_rule_refs, [])
  assert.deepEqual(result.waived_rule_refs, ['CR-001'])
})

test('unknown waiver authority remains partial instead of becoming no waiver', () => {
  const reqRule = rule({ binding_state: 'REQUIREMENT_BOUND', requirement_refs: ['REQ-001'] })
  const unknown = waiver({ governance_effect: 'UNKNOWN', requirement_compatibility: 'UNKNOWN' })
  const result = resolveConformance({ ...baseInput, rules: [reqRule], waivers: [unknown] })
  assert.equal(result.status, 'PARTIAL')
  assert.match(result.unknowns.join('\n'), /REQUIREMENT_WAIVER_AUTHORITY_UNKNOWN/)
})

test('generated or intentionally nonconforming protection beats normalization', () => {
  const normalize = rule({ id: 'CR-NORMALIZE', mutation_policy: 'NORMALIZE' })
  const fixture = rule({
    id: 'CR-FIXTURE',
    rule_class: 'TEST_PATTERN',
    statement: 'Fixture must preserve invalid syntax',
    decision: { key: 'fixture-mutation', value: 'preserve-invalid' },
    mutation_policy: 'INTENTIONALLY_NONCONFORMING',
  })
  const result = resolveConformance({ ...baseInput, rules: [normalize, fixture] })
  assert.equal(result.status, 'RESOLVED')
  assert.equal(result.effective_mutation_policy, 'INTENTIONALLY_NONCONFORMING')
})

test('unknown mutation policy prevents clean resolved state', () => {
  const unknown = rule({ mutation_policy: 'UNKNOWN' })
  const result = resolveConformance({ ...baseInput, rules: [unknown] })
  assert.equal(result.status, 'PARTIAL')
  assert.match(result.unknowns.join('\n'), /MUTATION_POLICY_UNKNOWN/)
})

test('target outside frozen scope is not silently resolved', () => {
  const result = resolveConformance({
    ...baseInput,
    target: { ...baseInput.target, path: 'vendor/lib.mjs' },
    boundedScope: { paths: { include: ['src/**'] } },
  })
  assert.equal(result.status, 'PARTIAL')
  assert.deepEqual(result.diagnostics, ['TARGET_OUTSIDE_BOUND_SCOPE'])
})
