import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConformance } from '../../src/conformance/rule-resolver.mjs'

function rule(id, repositoryRef, workspaceRef, quoteStyle) {
  return {
    id,
    object_revision: `${id}:1`,
    rule_class: 'FORMAT',
    source_class: 'EXECUTABLE_CONFIG',
    scope: {
      repository_ref: repositoryRef,
      workspace_identity_ref: workspaceRef,
      paths: { include: ['src/**/*.ts'] },
      languages: ['typescript'],
    },
    epistemic_state: 'VERIFIED',
    binding_state: 'REPOSITORY_DECLARED',
    enforcement_state: 'TOOL_CHECKED',
    mutation_policy: 'FORMAT_ONLY',
    decision: {
      key: 'format.quote_style',
      value: quoteStyle,
    },
    precedence: {
      resolver_family: 'fixture-format',
    },
    lifecycle_state: 'ACTIVE',
  }
}

test('foreign repository/workspace rules cannot leak into the active target', () => {
  const result = resolveConformance({
    target: {
      path: 'src/example.ts',
      language: 'typescript',
      repositoryRef: 'repo:A',
    },
    workspaceIdentityRef: 'WS-A',
    boundedScope: {
      paths: { include: ['src/**/*.ts'] },
      languages: ['typescript'],
    },
    searchCoverage: {
      state: 'BOUNDED_SUFFICIENT',
      ref: 'COV-SCOPE-IDENTITY',
    },
    rules: [
      rule('CR-A', 'repo:A', 'WS-A', 'single'),
      rule('CR-B-FOREIGN', 'repo:B', 'WS-B', 'double'),
    ],
  })

  assert.equal(result.status, 'RESOLVED')
  assert.deepEqual(result.effective_rule_refs, ['CR-A'])
  assert.deepEqual(result.conflicts, [])
})
