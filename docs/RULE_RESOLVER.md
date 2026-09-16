# Rule Resolver prototype

Status: **R9 candidate prototype only**. This implementation does not publish or activate a UPO bundle. The current formal UPO bundle remains whatever the Google Drive Manifest declares.

## Purpose

`resolveConformance()` converts evidence-backed Conformance Rules and Waivers into a target-scoped Resolution for Assembly. It is intentionally narrower than a formatter, linter, policy engine, or build runner: it decides what rules are effective; it does not mutate source files and it does not execute enforcement commands.

The implementation follows the staged UPO-01 v1.5 / UPO-10 v1.1 candidate semantics while remaining subordinate to the current formal UPO release.

## Reuse decision

The prototype uses Node's built-in `path.matchesGlob()` as the path-scope primitive and implements only the UPO-specific semantic layer. No third-party runtime package is required.

Existing generic config resolvers can perform glob-based matching and merge configuration, but they do not model UPO Requirement Authority, Waiver Governance, UNKNOWN preservation, mutation protection, or legal empty resolution. This prototype therefore classifies the implementation as **COMPOSITE_REUSE + SELF_BUILD_GAP**, not a pure greenfield rewrite and not a whole-framework import.

## Prototype-only schema extensions

Executable resolution exposed two gaps in the staged candidate schema. They are explicit here rather than being silently smuggled into the formal protocol.

### `decision`

A free-text `statement` cannot be compared safely by a machine. Rules may therefore add:

```json
{
  "decision": {
    "key": "quotes",
    "value": "single"
  }
}
```

Conflict detection operates only on rules with the same `rule_class + decision.key`. Different values require an explicit override, Requirement-bound priority, or produce `CONFLICT`.

### `APPLICABLE_RULES_WITH_WAIVERS`

The staged candidate permits `NO_APPLICABLE_RULE_IN_BOUND_SCOPE`, but does not represent the distinct case where applicable rules exist and every effective rule is removed by a valid waiver. The prototype therefore adds:

`resolution_basis = APPLICABLE_RULES_WITH_WAIVERS`

This is candidate feedback, not a published protocol state.

## Resolution invariants

- `OBSERVED_PATTERN` / `OBSERVATION_ONLY` never becomes an enforcement rule by majority vote.
- `UNKNOWN` is preserved; it is never converted to `NONE` or `NOT_APPLICABLE` merely because evidence is missing.
- A repository-local waiver cannot waive a `REQUIREMENT_BOUND` rule. That requires `REQUIREMENT_AUTHORIZED` plus `requirement_compatibility = COMPATIBLE`.
- Independent rule families are not resolved by path specificity guesses.
- Explicit override relations are honored.
- `REQUIREMENT_BOUND` decisions outrank contradictory repository-declared decisions; conflicting Requirement-bound decisions remain conflicts unless explicitly governed.
- `GENERATED_DO_NOT_EDIT`, `VENDORED_DO_NOT_EDIT`, `INTENTIONALLY_NONCONFORMING`, `PRESERVE`, and `REVIEW_REQUIRED` protect source surfaces from style-only rewriting.
- A clean empty rule set is `RESOLVED` only when bounded search coverage is explicitly sufficient.
- Resolution never grants write authorization and never executes formatter/linter/autofix commands.

## Minimal API

```js
import { resolveConformance } from './src/conformance/rule-resolver.mjs'

const result = resolveConformance({
  target: {
    path: 'src/service/user.mjs',
    language: 'javascript',
    changeClass: 'GENERATED_GLUE'
  },
  workspaceIdentityRef: 'WS-001@rev-1',
  boundedScope: {
    paths: { include: ['src/**'] }
  },
  searchCoverage: {
    ref: 'SEARCH-001',
    state: 'BOUNDED_SUFFICIENT'
  },
  rules: [],
  waivers: []
})
```

Possible `status` values in this prototype are `RESOLVED`, `PARTIAL`, and `CONFLICT`. The output also includes exact rule/waiver refs, conflicts, unknowns, enforcement backend refs, effective mutation policy, precedence decisions, and a deterministic coding-context fingerprint.

## Verification

Run:

```bash
npm test
```

The test set covers legal empty resolution, partial-search fail-closed behavior, observed-pattern non-promotion, explicit override, cross-family conflict, Requirement priority, unauthorized and authorized waivers, UNKNOWN preservation, protected mutation surfaces, and frozen-scope rejection.

The package declares Node `>=22.20.0` because `path.matchesGlob()` is stable from that Node 22 line. Testing on earlier Node 22 releases may work but uses the API before its stable marker and is not the declared support baseline.
