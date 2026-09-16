import { createHash } from 'node:crypto'
import { discoverRepositoryConformance } from './repository-discovery.mjs'

export const INSPECTION_VERSION = '0.1.0-r9-candidate'

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
    .join(',')}}`
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function ruleId(label, candidate) {
  return `CR-AUTO-${label}-${sha256(candidate.fingerprint).slice(0, 10)}`
}

function waiverId(label, candidate, ruleRef) {
  return `CW-AUTO-${label}-${sha256(`${candidate.fingerprint}:${ruleRef}`).slice(0, 10)}`
}

function baseScope(snapshot, extra = {}) {
  return {
    repository_ref: snapshot.target_identity,
    workspace_identity_ref: snapshot.workspace_identity_ref,
    ...extra,
  }
}

function baseRule(snapshot, candidate, {
  id,
  ruleClass,
  statement,
  scope,
  enforcementState,
  enforcementBackendRefs,
  mutationPolicy,
  decision,
  resolverFamily,
  overrides = [],
}) {
  return {
    id,
    object_revision: `${snapshot.target_revision}:${candidate.id}`,
    rule_class: ruleClass,
    statement,
    source_class: candidate.source_class,
    scope: baseScope(snapshot, scope),
    epistemic_state: 'VERIFIED',
    binding_state: 'REPOSITORY_DECLARED',
    enforcement_state: enforcementState,
    enforcement_backend_refs: unique(enforcementBackendRefs),
    mutation_policy: mutationPolicy,
    decision,
    precedence: {
      resolver_family: resolverFamily,
      overrides: unique(overrides),
    },
    lifecycle_state: 'ACTIVE',
    discovery_candidate_ref: candidate.id,
    evidence_refs: [candidate.source_ref],
  }
}

function commandRule(snapshot, candidate) {
  const { tool, script, rule_class: ruleClass } = candidate.fact
  const normalizedTool = String(tool).toLowerCase()
  const label = normalizedTool.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '-')
  const format = ruleClass === 'FORMAT'
  return baseRule(snapshot, candidate, {
    id: ruleId(label, candidate),
    ruleClass,
    statement: `Repository declares ${tool} through package script ${script}.`,
    scope: { paths: { include: ['**/*'] } },
    enforcementState: 'DECLARED_CHECK',
    enforcementBackendRefs: [`${candidate.source_ref.path}#scripts.${script}`],
    mutationPolicy: format ? 'FORMAT_ONLY' : 'NORMALIZE',
    decision: {
      key: format ? 'format.backend' : 'lint.backend',
      value: normalizedTool,
    },
    resolverFamily: `package-script:${normalizedTool}`,
  })
}

function languageFromGlobs(globs) {
  const joined = globs.join(' ')
  if (/\.(?:ts|tsx)\b/.test(joined)) return ['typescript']
  if (/\.py\b/.test(joined)) return ['python']
  if (/\.rs\b/.test(joined)) return ['rust']
  return []
}

function eslintScopeRule(snapshot, candidate, eslintBackends) {
  const typeChecked = candidate.fact.type_checked
  const label = typeChecked ? 'ESLINT-TYPECHECKED' : 'ESLINT-SCOPED'
  const languages = languageFromGlobs(candidate.fact.files)
  return baseRule(snapshot, candidate, {
    id: ruleId(label, candidate),
    ruleClass: 'LINT',
    statement: typeChecked
      ? 'Static ESLint flat-config scope enables type-aware linting for the declared file surface.'
      : 'Static ESLint flat-config scope applies to the declared file surface.',
    scope: {
      paths: {
        include: candidate.fact.files,
        exclude: candidate.fact.ignores,
      },
      ...(languages.length > 0 ? { languages } : {}),
    },
    enforcementState: eslintBackends.length > 0 ? 'TOOL_CHECKED' : 'CONFIG_DECLARED',
    enforcementBackendRefs: [candidate.source_ref.path, ...eslintBackends],
    mutationPolicy: 'NORMALIZE',
    decision: {
      key: typeChecked ? 'typescript.type_checked_eslint' : 'lint.scoped_eslint',
      value: typeChecked ? 'enabled' : 'configured',
    },
    resolverFamily: 'eslint-flat-config',
  })
}

function pythonRule(snapshot, candidate, tool, decisionKey, value = tool) {
  const format = tool === 'black' || tool === 'isort' || candidate.fact_type === 'RUFF_FORMAT_CONFIG'
  return baseRule(snapshot, candidate, {
    id: ruleId(tool.toUpperCase(), candidate),
    ruleClass: format ? 'FORMAT' : 'LINT',
    statement: `${tool} is declared in pyproject.toml for Python source.`,
    scope: {
      paths: { include: ['**/*.py'] },
      languages: ['python'],
    },
    enforcementState: 'CONFIG_DECLARED',
    enforcementBackendRefs: [`${candidate.source_ref.path}#${candidate.source_ref.locator}`],
    mutationPolicy: format ? 'FORMAT_ONLY' : 'NORMALIZE',
    decision: { key: decisionKey, value },
    resolverFamily: `pyproject:${tool}`,
  })
}

function ciRule(snapshot, candidate) {
  const { tool, rule_class: ruleClass, language, job } = candidate.fact
  const format = ruleClass === 'FORMAT'
  return baseRule(snapshot, candidate, {
    id: ruleId(`CI-${String(tool).toUpperCase()}`, candidate),
    ruleClass,
    statement: `CI job ${job ?? 'unknown'} explicitly executes ${tool}.`,
    scope: {
      paths: { include: language === 'rust' ? ['**/*.rs'] : language === 'python' ? ['**/*.py'] : ['**/*'] },
      ...(language ? { languages: [language] } : {}),
    },
    enforcementState: 'CI_ENFORCED',
    enforcementBackendRefs: [`${candidate.source_ref.path}#${candidate.source_ref.locator}`],
    mutationPolicy: format ? 'FORMAT_ONLY' : 'NORMALIZE',
    decision: {
      key: format ? 'format.backend' : 'lint.backend',
      value: String(tool).toLowerCase(),
    },
    resolverFamily: `ci:${String(tool).toLowerCase()}`,
  })
}

function editorConfigRule(snapshot, candidate, overrides) {
  const property = candidate.fact.property
  return baseRule(snapshot, candidate, {
    id: ruleId(`EDITORCONFIG-${property.toUpperCase().replaceAll('_', '-')}`, candidate),
    ruleClass: 'FORMAT',
    statement: `.editorconfig declares ${property}=${candidate.fact.value} for [${candidate.fact.section}].`,
    scope: { paths: { include: [candidate.fact.path_pattern] } },
    enforcementState: 'CONFIG_DECLARED',
    enforcementBackendRefs: [`${candidate.source_ref.path}#${candidate.source_ref.locator}`],
    mutationPolicy: 'FORMAT_ONLY',
    decision: {
      key: `editorconfig.${property}`,
      value: candidate.fact.value,
    },
    resolverFamily: `editorconfig:${property}`,
    overrides,
  })
}

function simplePathFromBlackExclude(value) {
  const text = String(value ?? '')
  if (!text || /[\\^$*+?()[\]{}|]/.test(text)) return null
  return text.replace(/^\/?/, '')
}

export function inspectRepositoryConformance(snapshot = {}, discovery = {}) {
  const replay = discoverRepositoryConformance(snapshot)
  const replayByFingerprint = new Map(replay.candidates.map((candidate) => [candidate.fingerprint, candidate]))
  const base = {
    inspection_version: INSPECTION_VERSION,
    target_identity: snapshot.target_identity ?? null,
    inspected_revision: snapshot.target_revision ?? null,
    workspace_identity_ref: snapshot.workspace_identity_ref ?? null,
    discovery_ref: discovery.search_coverage?.ref ?? null,
    rules: [],
    waivers: [],
    evidence_refs: [],
    unknowns: [],
    rejected_candidate_refs: [],
    status: 'PARTIAL',
    verification_tier: 'STATIC_INSPECTION',
    independence_class: 'SAME_PARSER_RECHECK',
  }

  if (discovery.target_identity !== snapshot.target_identity) base.unknowns.push('DISCOVERY_TARGET_IDENTITY_MISMATCH')
  if (discovery.target_revision !== snapshot.target_revision) base.unknowns.push('DISCOVERY_TARGET_REVISION_MISMATCH')
  if (discovery.workspace_identity_ref !== snapshot.workspace_identity_ref) base.unknowns.push('DISCOVERY_WORKSPACE_IDENTITY_MISMATCH')

  const accepted = []
  for (const candidate of discovery.candidates ?? []) {
    const replayed = replayByFingerprint.get(candidate.fingerprint)
    if (!replayed) {
      base.rejected_candidate_refs.push(candidate.id)
      base.unknowns.push(`CANDIDATE_NOT_REPRODUCIBLE:${candidate.id}`)
      continue
    }
    accepted.push(replayed)
    base.evidence_refs.push(replayed.source_ref)
  }

  const packageBackends = new Map()
  for (const candidate of accepted) {
    if (!candidate.fact_type.endsWith('_COMMAND')) continue
    const tool = candidate.fact.tool
    const refs = packageBackends.get(tool) ?? []
    refs.push(`${candidate.source_ref.path}#scripts.${candidate.fact.script}`)
    packageBackends.set(tool, refs)
  }

  const blackRulesBySource = new Map()
  const editorRulesByProperty = new Map()
  const deferredEditorUnsets = []
  const deferredBlackWaivers = []

  for (const candidate of accepted) {
    switch (candidate.fact_type) {
      case 'PRETTIER_COMMAND':
      case 'ESLINT_COMMAND':
      case 'BIOME_COMMAND':
      case 'RUFF_COMMAND':
      case 'BLACK_COMMAND':
        base.rules.push(commandRule(snapshot, candidate))
        break
      case 'ESLINT_TYPECHECKED_SCOPE':
      case 'ESLINT_SCOPED_CONFIG':
        base.rules.push(eslintScopeRule(snapshot, candidate, packageBackends.get('eslint') ?? []))
        break
      case 'BLACK_CONFIG': { 
        const rule = pythonRule(snapshot, candidate, 'black', 'format.backend')
        base.rules.push(rule)
        blackRulesBySource.set(candidate.source_ref.path, rule.id)
        break
      }
      case 'ISORT_CONFIG':
        base.rules.push(pythonRule(snapshot, candidate, 'isort', 'imports.backend'))
        break
      case 'RUFF_CONFIG':
        base.rules.push(pythonRule(snapshot, candidate, 'ruff', 'lint.backend'))
        break
      case 'RUFF_FORMAT_CONFIG':
        base.rules.push(pythonRule(snapshot, candidate, 'ruff-format', 'format.backend', 'ruff'))
        break
      case 'BLACK_FORCE_EXCLUDE_WAIVER':
        deferredBlackWaivers.push(candidate)
        break
      case 'EDITORCONFIG_PROPERTY': { 
        const prior = editorRulesByProperty.get(candidate.fact.property) ?? []
        const rule = editorConfigRule(snapshot, candidate, prior.map((item) => item.id))
        base.rules.push(rule)
        prior.push(rule)
        editorRulesByProperty.set(candidate.fact.property, prior)
        break
      }
      case 'EDITORCONFIG_UNSET_WAIVER':
        deferredEditorUnsets.push(candidate)
        break
      case 'CI_RUSTFMT_CHECK':
      case 'CI_CLIPPY_CHECK':
      case 'CI_PRETTIER_CHECK':
      case 'CI_ESLINT_CHECK':
      case 'CI_RUFF_CHECK':
      case 'CI_BLACK_CHECK':
        base.rules.push(ciRule(snapshot, candidate))
        break
      default:
        base.unknowns.push(`UNSUPPORTED_DISCOVERED_FACT:${candidate.fact_type}`)
    }
  }

  for (const candidate of deferredBlackWaivers) {
    const ruleRef = blackRulesBySource.get(candidate.source_ref.path)
    const path = simplePathFromBlackExclude(candidate.fact.path)
    if (!ruleRef || !path) {
      base.unknowns.push(`BLACK_FORCE_EXCLUDE_REQUIRES_REVIEW:${candidate.id}`)
      continue
    }
    base.waivers.push({
      id: waiverId('BLACK-EXCLUDE', candidate, ruleRef),
      object_revision: `${snapshot.target_revision}:${candidate.id}`,
      rule_ref: ruleRef,
      scope: { paths: [path] },
      epistemic_state: 'VERIFIED',
      lifecycle_state: 'ACTIVE',
      governance_effect: 'REPOSITORY_DECLARED',
      requirement_compatibility: 'NOT_APPLICABLE',
      discovery_candidate_ref: candidate.id,
      evidence_refs: [candidate.source_ref],
    })
  }

  for (const candidate of deferredEditorUnsets) {
    const priorRules = editorRulesByProperty.get(candidate.fact.property) ?? []
    for (const rule of priorRules) {
      base.waivers.push({
        id: waiverId(`EDITORCONFIG-${candidate.fact.property.toUpperCase()}`, candidate, rule.id),
        object_revision: `${snapshot.target_revision}:${candidate.id}:${rule.id}`,
        rule_ref: rule.id,
        scope: { paths: [candidate.fact.path_pattern] },
        epistemic_state: 'VERIFIED',
        lifecycle_state: 'ACTIVE',
        governance_effect: 'REPOSITORY_DECLARED',
        requirement_compatibility: 'NOT_APPLICABLE',
        discovery_candidate_ref: candidate.id,
        evidence_refs: [candidate.source_ref],
      })
    }
  }

  base.rules.sort((a, b) => a.id.localeCompare(b.id))
  base.waivers.sort((a, b) => a.id.localeCompare(b.id))
  base.evidence_refs = unique(base.evidence_refs.map((ref) => stableSerialize(ref))).map((item) => JSON.parse(item))
  base.status = base.unknowns.length === 0 ? 'VERIFIED' : 'PARTIAL'
  return base
}
