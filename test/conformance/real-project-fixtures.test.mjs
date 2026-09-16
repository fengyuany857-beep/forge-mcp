import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { resolveConformance } from '../../src/conformance/rule-resolver.mjs'

const FIXTURE_NAMES = ['nextjs', 'django', 'tokio']

async function loadFixture(name) {
  const url = new URL(`../fixtures/real-projects/${name}.json`, import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

function sorted(values = []) {
  return [...values].sort()
}

for (const fixtureName of FIXTURE_NAMES) {
  const fixture = await loadFixture(fixtureName)

  test(`${fixture.project} fixture is revision-pinned and evidence-addressable`, () => {
    assert.match(fixture.source_snapshot.revision, /^[0-9a-f]{40}$/)
    assert.ok(fixture.source_snapshot.evidence.length > 0)

    for (const evidence of fixture.source_snapshot.evidence) {
      assert.ok(evidence.path)
      assert.match(evidence.blob_sha, /^[0-9a-f]{40}$/)
      assert.ok(evidence.claims.length > 0)
    }
  })

  for (const fixtureCase of fixture.cases) {
    test(`${fixture.project} :: ${fixtureCase.name}`, () => {
      const result = resolveConformance({
        target: fixtureCase.target,
        rules: fixture.rules,
        waivers: fixture.waivers,
        workspaceIdentityRef: fixture.workspace_identity_ref,
        boundedScope: fixture.bounded_scope,
        searchCoverage: fixture.search_coverage,
      })

      assert.equal(result.status, fixtureCase.expected.status)
      assert.equal(result.resolution_basis, fixtureCase.expected.resolution_basis)
      assert.equal(result.effective_mutation_policy, fixtureCase.expected.effective_mutation_policy)
      assert.deepEqual(
        sorted(result.effective_rule_refs),
        sorted(fixtureCase.expected.effective_rule_refs),
      )

      if (fixtureCase.expected.waived_rule_refs) {
        assert.deepEqual(
          sorted(result.waived_rule_refs),
          sorted(fixtureCase.expected.waived_rule_refs),
        )
      }

      assert.deepEqual(result.conflicts, [])
      assert.deepEqual(result.unknowns, [])
      assert.match(result.coding_context_fingerprint, /^sha256:[0-9a-f]{64}$/)
    })
  }
}
