import { createHash } from 'node:crypto'
import { matchesGlob } from 'node:path'

export const RESOLVER_VERSION = '0.1.1-r9-candidate'

const ACTIVE = 'ACTIVE'
const VERIFIED = 'VERIFIED'
const REQUIREMENT_BOUND = 'REQUIREMENT_BOUND'
const REPOSITORY_DECLARED = 'REPOSITORY_DECLARED'
const OBSERVATION_ONLY = 'OBSERVATION_ONLY'

const PROTECTIVE_MUTATION_POLICIES = new Set([
  'GENERATED_DO_NOT_EDIT',
  'VENDORED_DO_NOT_EDIT',
  'INTENTIONALLY_NONCONFORMING',
])

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(',')}}`
}

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(stableSerialize(value)).digest('hex')}`
}

function globMatches(path, pattern) {
  return matchesGlob(normalizePath(path), normalizePath(pattern))
}

function pathScopeMatches(path, pathScope = {}) {
  const include = asArray(pathScope.include ?? pathScope.paths)
  const exclude = asArray(pathScope.exclude)
  if (include.length > 0 && !include.some((pattern) => globMatches(path, pattern))) return false
  if (exclude.some((pattern) => globMatches(path, pattern))) return false
  return true
}

function scalarScopeMatches(actual, expected) {
  if (expected == null || expected === '') return true
  if (actual == null || actual === '') return false
  return actual === expected
}

function listScopeMatches(actual, expected) {
  const list = asArray(expected)
  if (list.length === 0) return true
  if (actual == null) return false
  return list.includes(actual)
}

function conditionsMatch(context, conditions) {
  const list = asArray(conditions)
  return list.every((condition) => {
    if (typeof condition === 'string') return context?.conditions?.includes?.(condition) ?? false
    if (!condition || typeof condition !== 'object') return false
    const actual = context?.[condition.key]
    if ('equals' in condition) return actual === condition.equals
    if ('in' in condition) return asArray(condition.in).includes(actual)
    if ('exists' in condition) return condition.exists ? actual !== undefined : actual === undefined
    return false
  })
}

function scopeMatches(scope = {}, target, context = {}) {
  if (!scalarScopeMatches(target.repositoryRef, scope.repository_ref ?? scope.repositoryRef)) return false
  if (!scalarScopeMatches(target.workspaceIdentityRef, scope.workspace_identity_ref ?? scope.workspaceIdentityRef)) return false
  if (!pathScopeMatches(target.path, scope.paths ?? {})) return false
  if (!listScopeMatches(target.language, scope.languages)) return false
  if (!listScopeMatches(target.fileKind, scope.file_kinds ?? scope.fileKinds)) return false
  if (!listScopeMatches(target.symbol, scope.symbols)) return false
  if (!listScopeMatches(target.changeClass, scope.change_classes ?? scope.changeClasses)) return false
  if (!conditionsMatch(context, scope.conditions)) return false
  return true
}

function waiverScopeMatches(waiver, target, context) {
  const scope = waiver.scope ?? {}
  return scopeMatches(
    {
      paths: { include: scope.paths ?? [] },
      symbols: scope.symbols ?? [],
      conditions: scope.conditions ?? [],
    },
    target,
    context,
  )
}

function boundedTargetMatches(target, boundedScope = {}) {
  if (!boundedScope || Object.keys(boundedScope).length === 0) return false
  return scopeMatches(boundedScope, target, boundedScope.context ?? {})
}

function isRuleCandidate(rule) {
  return rule?.lifecycle_state === ACTIVE && scopeMatches(rule.scope ?? {}, rule.__target, rule.__context)
}

function ruleCanBeEffective(rule) {
  return rule.epistemic_state === VERIFIED &&
    (rule.binding_state === REPOSITORY_DECLARED || rule.binding_state === REQUIREMENT_BOUND)
}

function decisionIdentity(rule) {
  const decision = rule.decision
  if (!decision || typeof decision !== 'object' || !decision.key) return null
  return `${rule.rule_class ?? 'OTHER'}:${decision.key}`
}

function valuesEqual(a, b) {
  return stableSerialize(a) === stableSerialize(b)
}

function explicitOverride(a, b) {
  return asArray(a.precedence?.overrides).includes(b.id) || asArray(b.precedence?.overridden_by).includes(a.id)
}

function requirementRank(rule) {
  return rule.binding_state === REQUIREMENT_BOUND ? 2 : rule.binding_state === REPOSITORY_DECLARED ? 1 : 0
}

function chooseRulePair(a, b) {
  if (explicitOverride(a, b)) return { winner: a, loser: b, reason: 'EXPLICIT_OVERRIDE' }
  if (explicitOverride(b, a)) return { winner: b, loser: a, reason: 'EXPLICIT_OVERRIDE' }

  const aRank = requirementRank(a)
  const bRank = requirementRank(b)
  if (aRank !== bRank && (aRank === 2 || bRank === 2)) {
    return aRank > bRank
      ? { winner: a, loser: b, reason: 'REQUIREMENT_BOUND_PRIORITY' }
      : { winner: b, loser: a, reason: 'REQUIREMENT_BOUND_PRIORITY' }
  }

  return null
}

function applyPrecedence(rules) {
  const effective = new Map(rules.map((rule) => [rule.id, rule]))
  const conflicts = []
  const precedenceDecisions = []

  const groups = new Map()
  for (const rule of rules) {
    const key = decisionIdentity(rule)
    if (!key) continue
    const bucket = groups.get(key) ?? []
    bucket.push(rule)
    groups.set(key, bucket)
  }

  for (const [decisionKey, group] of groups) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i]
        const b = group[j]
        if (!effective.has(a.id) || !effective.has(b.id)) continue
        if (valuesEqual(a.decision?.value, b.decision?.value)) continue

        const choice = chooseRulePair(a, b)
        if (choice) {
          effective.delete(choice.loser.id)
          precedenceDecisions.push({
            decision_key: decisionKey,
            winner_rule_ref: choice.winner.id,
            overridden_rule_ref: choice.loser.id,
            reason: choice.reason,
          })
          continue
        }

        conflicts.push({
          type: 'RULE_DECISION_CONFLICT',
          decision_key: decisionKey,
          rule_refs: [a.id, b.id],
          resolver_families: [a.precedence?.resolver_family ?? null, b.precedence?.resolver_family ?? null],
          values: [a.decision?.value, b.decision?.value],
        })
      }
    }
  }

  return { effective: [...effective.values()], conflicts, precedenceDecisions }
}

function evaluateWaiver(waiver, rule) {
  if (waiver.epistemic_state !== VERIFIED) {
    return { applies: false, materialUnknown: true, reason: 'WAIVER_NOT_VERIFIED' }
  }

  if (rule.binding_state === REQUIREMENT_BOUND) {
    if (waiver.governance_effect === 'REQUIREMENT_AUTHORIZED' && waiver.requirement_compatibility === 'COMPATIBLE') {
      return { applies: true, materialUnknown: false, reason: 'REQUIREMENT_AUTHORIZED' }
    }
    if (waiver.governance_effect === 'UNKNOWN' || waiver.requirement_compatibility === 'UNKNOWN') {
      return { applies: false, materialUnknown: true, reason: 'REQUIREMENT_WAIVER_AUTHORITY_UNKNOWN' }
    }
    return { applies: false, materialUnknown: false, conflict: true, reason: 'REQUIREMENT_WAIVER_NOT_AUTHORIZED' }
  }

  if (rule.binding_state === REPOSITORY_DECLARED) {
    if (waiver.governance_effect === 'REPOSITORY_DECLARED' || waiver.governance_effect === 'REQUIREMENT_AUTHORIZED') {
      return { applies: true, materialUnknown: false, reason: waiver.governance_effect }
    }
    if (waiver.governance_effect === 'UNKNOWN') {
      return { applies: false, materialUnknown: true, reason: 'REPOSITORY_WAIVER_AUTHORITY_UNKNOWN' }
    }
  }

  return { applies: false, materialUnknown: false, reason: 'WAIVER_NOT_APPLICABLE_TO_BINDING' }
}

function resolveMutationPolicy(rules) {
  const policies = [...new Set(rules.map((rule) => rule.mutation_policy).filter(Boolean))]
  if (policies.length === 0) return { policy: 'NOT_APPLICABLE', unknown: false, inputs: [] }
  if (policies.includes('UNKNOWN')) return { policy: 'UNKNOWN', unknown: true, inputs: policies }

  const material = policies.filter((policy) => policy !== 'NOT_APPLICABLE')
  if (material.length === 0) return { policy: 'NOT_APPLICABLE', unknown: false, inputs: policies }
  if (material.length === 1) return { policy: material[0], unknown: false, inputs: policies }

  const protective = material.filter((policy) => PROTECTIVE_MUTATION_POLICIES.has(policy))
  if (protective.length === 1) return { policy: protective[0], unknown: false, inputs: policies }
  if (protective.length > 1) return { policy: 'REVIEW_REQUIRED', unknown: false, inputs: policies }
  if (material.includes('PRESERVE')) return { policy: 'PRESERVE', unknown: false, inputs: policies }
  if (material.includes('REVIEW_REQUIRED')) return { policy: 'REVIEW_REQUIRED', unknown: false, inputs: policies }
  if (material.includes('FORMAT_ONLY')) return { policy: 'FORMAT_ONLY', unknown: false, inputs: policies }
  return { policy: 'NORMALIZE', unknown: false, inputs: policies }
}

function coverageIsSufficient(searchCoverage) {
  return searchCoverage?.state === 'BOUNDED_SUFFICIENT' && Boolean(searchCoverage?.ref)
}

export function resolveConformance({
  target,
  rules = [],
  waivers = [],
  workspaceIdentityRef,
  boundedScope,
  searchCoverage,
  context = {},
} = {}) {
  const normalizedTarget = {
    ...target,
    path: normalizePath(target?.path),
    repositoryRef: target?.repositoryRef ?? target?.repository_ref ?? null,
    workspaceIdentityRef: target?.workspaceIdentityRef ?? target?.workspace_identity_ref ?? workspaceIdentityRef ?? null,
  }
  const base = {
    resolver_version: RESOLVER_VERSION,
    target_locator: normalizedTarget,
    workspace_identity_ref: workspaceIdentityRef ?? null,
    rule_snapshot_refs: [],
    applicable_waiver_refs: [],
    effective_rule_refs: [],
    observation_rule_refs: [],
    waived_rule_refs: [],
    conflicts: [],
    unknowns: [],
    diagnostics: [],
    precedence_decisions: [],
    enforcement_backend_refs: [],
    effective_mutation_policy: 'UNKNOWN',
    resolution_basis: 'UNKNOWN',
    search_coverage_ref: searchCoverage?.ref ?? null,
    coding_context_fingerprint: null,
    status: 'PARTIAL',
  }

  if (!normalizedTarget.path) {
    return { ...base, unknowns: ['TARGET_PATH_MISSING'], diagnostics: ['TARGET_PATH_MISSING'] }
  }
  if (!workspaceIdentityRef) {
    return { ...base, unknowns: ['WORKSPACE_IDENTITY_MISSING'], diagnostics: ['WORKSPACE_IDENTITY_MISSING'] }
  }
  if (!boundedTargetMatches(normalizedTarget, boundedScope)) {
    return { ...base, diagnostics: ['TARGET_OUTSIDE_BOUND_SCOPE'], resolution_basis: 'PARTIAL_SEARCH' }
  }

  const applicable = []
  const observations = []
  const unverifiedApplicable = []

  for (const sourceRule of rules) {
    const rule = { ...sourceRule, __target: normalizedTarget, __context: context }
    if (!isRuleCandidate(rule)) continue
    base.rule_snapshot_refs.push({ id: rule.id, object_revision: rule.object_revision ?? null })

    if (rule.source_class === 'OBSERVED_PATTERN' || rule.binding_state === OBSERVATION_ONLY) {
      observations.push(rule)
      continue
    }

    if (!ruleCanBeEffective(rule)) {
      unverifiedApplicable.push(rule)
      continue
    }
    applicable.push(rule)
  }

  base.observation_rule_refs = observations.map((rule) => rule.id)
  if (unverifiedApplicable.length > 0) {
    base.unknowns.push(...unverifiedApplicable.map((rule) => `RULE_NOT_EFFECTIVE:${rule.id}`))
  }

  const waivedRuleIds = new Set()
  const waiverConflicts = []

  for (const rule of applicable) {
    for (const waiver of waivers) {
      if (waiver.lifecycle_state !== ACTIVE || waiver.rule_ref !== rule.id) continue
      if (!waiverScopeMatches(waiver, normalizedTarget, context)) continue
      base.applicable_waiver_refs.push({ id: waiver.id, object_revision: waiver.object_revision ?? null })
      const evaluation = evaluateWaiver(waiver, rule)
      if (evaluation.applies) {
        waivedRuleIds.add(rule.id)
        base.waived_rule_refs.push(rule.id)
      } else if (evaluation.materialUnknown) {
        base.unknowns.push(`${evaluation.reason}:${waiver.id}:${rule.id}`)
      } else if (evaluation.conflict) {
        waiverConflicts.push({
          type: 'WAIVER_AUTHORITY_CONFLICT',
          waiver_ref: waiver.id,
          rule_ref: rule.id,
          reason: evaluation.reason,
        })
      } else {
        base.diagnostics.push(`${evaluation.reason}:${waiver.id}:${rule.id}`)
      }
    }
  }

  const unwaived = applicable.filter((rule) => !waivedRuleIds.has(rule.id))
  const precedence = applyPrecedence(unwaived)
  base.precedence_decisions = precedence.precedenceDecisions
  base.conflicts = [...waiverConflicts, ...precedence.conflicts]
  base.effective_rule_refs = precedence.effective.map((rule) => rule.id)

  const mutation = resolveMutationPolicy(precedence.effective)
  base.effective_mutation_policy = mutation.policy
  if (mutation.unknown) base.unknowns.push('MUTATION_POLICY_UNKNOWN')

  base.enforcement_backend_refs = [...new Set(
    precedence.effective.flatMap((rule) => asArray(rule.enforcement_backend_refs)),
  )]

  if (base.conflicts.length > 0) {
    base.status = 'CONFLICT'
    base.resolution_basis = applicable.length > 0 ? 'APPLICABLE_RULES' : 'UNKNOWN'
  } else if (base.unknowns.length > 0) {
    base.status = 'PARTIAL'
    base.resolution_basis = 'PARTIAL_SEARCH'
  } else if (applicable.length > 0 && waivedRuleIds.size === applicable.length) {
    // Prototype extension: staged v1.5 has no legal basis for a fully-waived empty effective set.
    base.status = 'RESOLVED'
    base.resolution_basis = 'APPLICABLE_RULES_WITH_WAIVERS'
    base.effective_mutation_policy = 'NOT_APPLICABLE'
  } else if (applicable.length > 0) {
    base.status = 'RESOLVED'
    base.resolution_basis = 'APPLICABLE_RULES'
  } else if (coverageIsSufficient(searchCoverage)) {
    base.status = 'RESOLVED'
    base.resolution_basis = 'NO_APPLICABLE_RULE_IN_BOUND_SCOPE'
    base.effective_mutation_policy = 'NOT_APPLICABLE'
  } else {
    base.status = 'PARTIAL'
    base.resolution_basis = searchCoverage?.state === 'PARTIAL' ? 'PARTIAL_SEARCH' : 'UNKNOWN'
    base.unknowns.push('NO_RULE_CONCLUSION_REQUIRES_BOUNDED_SUFFICIENT_SEARCH')
  }

  base.coding_context_fingerprint = fingerprint({
    target: normalizedTarget,
    workspaceIdentityRef,
    effectiveRuleRefs: base.effective_rule_refs,
    waivedRuleRefs: base.waived_rule_refs,
    mutationPolicy: base.effective_mutation_policy,
    enforcementBackendRefs: base.enforcement_backend_refs,
    resolutionBasis: base.resolution_basis,
  })

  return base
}
