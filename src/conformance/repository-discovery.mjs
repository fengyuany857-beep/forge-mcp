import { createHash } from 'node:crypto'

export const DISCOVERY_VERSION = '0.1.1-r9-candidate'

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

function normalizePath(value) {
  return String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '')
}

function parseQuotedStrings(value) {
  return [...String(value).matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)]
    .map((match) => match[2].replaceAll('\\\'', "'").replaceAll('\\"', '"'))
}

function balancedSlice(text, openIndex, open = '[', close = ']') {
  let depth = 0
  let quote = null
  let escaped = false
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === open) depth += 1
    else if (char === close) {
      depth -= 1
      if (depth === 0) return text.slice(openIndex, index + 1)
    }
  }
  return null
}

function extractStaticArray(text, key) {
  const match = new RegExp(`\\b${key}\\s*:\\s*\\[`, 'm').exec(text)
  if (!match) return []
  const openIndex = match.index + match[0].lastIndexOf('[')
  const slice = balancedSlice(text, openIndex)
  if (!slice) return []
  return parseQuotedStrings(slice)
}

function candidateId(type, sourcePath, fact) {
  return `DISC-${type}-${sha256(stableSerialize({ sourcePath, fact })).slice(0, 12)}`
}

function makeCandidate(snapshot, artifact, type, sourceClass, fact, locator = 'whole_file') {
  const sourceRef = {
    target_identity: snapshot.target_identity,
    target_revision: snapshot.target_revision,
    path: normalizePath(artifact.path),
    blob_sha: artifact.blob_sha ?? null,
    locator: artifact.locator ?? locator,
    trust_state: 'UNTRUSTED_DATA',
  }
  const core = {
    kind: type.endsWith('WAIVER') ? 'WAIVER_CANDIDATE' : 'RULE_CANDIDATE',
    fact_type: type,
    source_class: sourceClass,
    evidence_state: 'DISCOVERED',
    source_ref: sourceRef,
    fact,
  }
  return {
    id: candidateId(type, sourceRef.path, fact),
    ...core,
    fingerprint: `sha256:${sha256(stableSerialize(core))}`,
  }
}

function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`)
  } catch {
    return raw
  }
}

function parsePackageScripts(snapshot, artifact) {
  const content = String(artifact.content ?? '')
  let scripts = null
  try {
    scripts = JSON.parse(content)?.scripts ?? null
  } catch {
    scripts = null
  }

  if (!scripts) {
    scripts = {}
    const linePattern = /^\s*"([^"]+)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/gm
    for (const match of content.matchAll(linePattern)) {
      scripts[match[1]] = decodeJsonString(match[2])
    }
  }

  const results = []
  for (const [script, commandValue] of Object.entries(scripts)) {
    const command = String(commandValue)
    const checks = [
      ['PRETTIER_COMMAND', 'prettier', /(?:^|[\s;&|])prettier(?:\s|$)[^\n]*--check(?:\s|$)/i, 'FORMAT'],
      ['ESLINT_COMMAND', 'eslint', /(?:^|[\s;&|])eslint(?:\s|$)/i, 'LINT'],
      ['BIOME_COMMAND', 'biome', /(?:^|[\s;&|])biome(?:\s|$)[^\n]*\b(?:check|lint|format)\b/i, 'LINT'],
      ['RUFF_COMMAND', 'ruff', /(?:^|[\s;&|])ruff(?:\s|$)[^\n]*\b(?:check|format)\b/i, 'LINT'],
      ['BLACK_COMMAND', 'black', /(?:^|[\s;&|])black(?:\s|$)[^\n]*--check(?:\s|$)/i, 'FORMAT'],
    ]
    for (const [type, tool, pattern, ruleClass] of checks) {
      if (!pattern.test(command)) continue
      results.push(makeCandidate(
        snapshot,
        artifact,
        type,
        'REPOSITORY_DECLARATION',
        { tool, script, command, rule_class: ruleClass },
        `scripts.${script}`,
      ))
    }
  }
  return results
}

function parseEslintFlatConfig(snapshot, artifact) {
  const content = String(artifact.content ?? '')
  const files = extractStaticArray(content, 'files')
  if (files.length === 0) return []
  const ignores = extractStaticArray(content, 'ignores')
  const typeChecked = /\bproject\s*:\s*true\b/.test(content)
  return [makeCandidate(
    snapshot,
    artifact,
    typeChecked ? 'ESLINT_TYPECHECKED_SCOPE' : 'ESLINT_SCOPED_CONFIG',
    'EXECUTABLE_CONFIG',
    {
      files,
      ignores,
      type_checked: typeChecked,
      static_literal_scope: true,
    },
    'static files/ignores scope',
  )]
}

function parseTomlPrimitive(raw) {
  const value = String(raw).trim()
  if (value.startsWith('[') && value.endsWith(']')) return parseQuotedStrings(value)
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (quoted) return quoted[2]
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function parseTomlSections(content) {
  const sections = new Map()
  let current = null
  for (const line of String(content).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const section = /^\[([^\]]+)\]$/.exec(trimmed)
    if (section) {
      current = section[1]
      if (!sections.has(current)) sections.set(current, {})
      continue
    }
    if (!current) continue
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed)
    if (!pair) continue
    sections.get(current)[pair[1]] = parseTomlPrimitive(pair[2])
  }
  return sections
}

function parsePyproject(snapshot, artifact) {
  const sections = parseTomlSections(artifact.content)
  const results = []
  const black = sections.get('tool.black')
  if (black) {
    results.push(makeCandidate(snapshot, artifact, 'BLACK_CONFIG', 'REPOSITORY_DECLARATION', {
      target_version: black['target-version'] ?? null,
    }, '[tool.black]'))
    if (black['force-exclude']) {
      results.push(makeCandidate(snapshot, artifact, 'BLACK_FORCE_EXCLUDE_WAIVER', 'REPOSITORY_DECLARATION', {
        path: black['force-exclude'],
        applies_to: 'BLACK_CONFIG',
      }, '[tool.black].force-exclude'))
    }
  }

  const isort = sections.get('tool.isort')
  if (isort) {
    results.push(makeCandidate(snapshot, artifact, 'ISORT_CONFIG', 'REPOSITORY_DECLARATION', {
      profile: isort.profile ?? null,
      known_first_party: isort.known_first_party ?? null,
    }, '[tool.isort]'))
  }

  const ruff = sections.get('tool.ruff')
  const ruffLint = sections.get('tool.ruff.lint')
  if (ruff || ruffLint) {
    results.push(makeCandidate(snapshot, artifact, 'RUFF_CONFIG', 'REPOSITORY_DECLARATION', {
      lint: Boolean(ruffLint),
      line_length: ruff?.['line-length'] ?? null,
    }, ruffLint ? '[tool.ruff]+[tool.ruff.lint]' : '[tool.ruff]'))
  }

  const ruffFormat = sections.get('tool.ruff.format')
  if (ruffFormat) {
    results.push(makeCandidate(snapshot, artifact, 'RUFF_FORMAT_CONFIG', 'REPOSITORY_DECLARATION', {
      quote_style: ruffFormat['quote-style'] ?? null,
    }, '[tool.ruff.format]'))
  }

  return results
}

function editorConfigPattern(section) {
  if (section === '*') return '**/*'
  if (section.startsWith('**/')) return section
  if (section.startsWith('**.')) return `**/*.${section.slice(3)}`
  if (!section.includes('/')) return `**/${section}`
  return section
}

function parseEditorConfig(snapshot, artifact) {
  const results = []
  let section = null
  let sectionOrder = -1
  let propertyOrder = 0
  for (const line of String(artifact.content ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed)
    if (sectionMatch) {
      section = sectionMatch[1]
      sectionOrder += 1
      continue
    }
    if (!section) continue
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed)
    if (!pair) continue
    const property = pair[1]
    const value = pair[2].trim()
    const fact = {
      section,
      path_pattern: editorConfigPattern(section),
      property,
      value,
      section_order: sectionOrder,
      property_order: propertyOrder++,
    }
    results.push(makeCandidate(
      snapshot,
      artifact,
      value.toLowerCase() === 'unset' ? 'EDITORCONFIG_UNSET_WAIVER' : 'EDITORCONFIG_PROPERTY',
      'REPOSITORY_DECLARATION',
      fact,
      `[${section}] ${property}`,
    ))
  }
  return results
}

function nearestWorkflowJob(lines, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(lines[cursor])
    if (match && match[1] !== 'jobs') return match[1]
  }
  return null
}

function parseGithubActions(snapshot, artifact) {
  const lines = String(artifact.content ?? '').split(/\r?\n/)
  const seen = new Set()
  const results = []
  const detectors = [
    ['CI_RUSTFMT_CHECK', 'rustfmt', /\brustfmt\s+--check\b/, 'FORMAT', 'rust'],
    ['CI_CLIPPY_CHECK', 'clippy', /\bcargo\s+clippy\b/, 'LINT', 'rust'],
    ['CI_PRETTIER_CHECK', 'prettier', /(?:^|[\s;&|])prettier(?:\s|$)[^\n]*--check(?:\s|$)/, 'FORMAT', null],
    ['CI_ESLINT_CHECK', 'eslint', /(?:^|[\s;&|])eslint(?:\s|$)/, 'LINT', null],
    ['CI_RUFF_CHECK', 'ruff', /(?:^|[\s;&|])ruff(?:\s|$)[^\n]*\bcheck\b/, 'LINT', 'python'],
    ['CI_BLACK_CHECK', 'black', /(?:^|[\s;&|])black(?:\s|$)[^\n]*--check(?:\s|$)/, 'FORMAT', 'python'],
  ]
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*-\s*name\s*:/.test(line)) continue
    for (const [type, tool, pattern, ruleClass, language] of detectors) {
      if (!pattern.test(line)) continue
      const job = nearestWorkflowJob(lines, index)
      const dedupe = `${type}:${job ?? 'unknown'}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      results.push(makeCandidate(snapshot, artifact, type, 'CI_PIPELINE', {
        tool,
        rule_class: ruleClass,
        language,
        job,
        command_line: line.trim(),
      }, job ? `job:${job}` : `line:${index + 1}`))
    }
  }
  return results
}

function parserForArtifact(path) {
  const normalized = normalizePath(path)
  const name = normalized.split('/').at(-1)
  if (name === 'package.json' || name === 'package-scripts.fragment') return parsePackageScripts
  if (/^eslint(?:\.[^.]+)?\.config\.[cm]?[jt]s$/.test(name) || /^eslint\.config\.[cm]?[jt]s$/.test(name)) return parseEslintFlatConfig
  if (name === 'pyproject.toml') return parsePyproject
  if (name === '.editorconfig') return parseEditorConfig
  if (normalized.startsWith('.github/workflows/') || name.endsWith('.workflow.yml') || name.endsWith('.workflow.yaml') || name === 'ci.fragment.yml') return parseGithubActions
  return null
}

export function discoverRepositoryConformance(snapshot = {}) {
  const base = {
    discovery_version: DISCOVERY_VERSION,
    target_identity: snapshot.target_identity ?? null,
    target_revision: snapshot.target_revision ?? null,
    workspace_identity_ref: snapshot.workspace_identity_ref ?? null,
    candidates: [],
    unresolved: [],
    search_coverage: null,
    status: 'PARTIAL',
  }

  if (!snapshot.target_identity) base.unresolved.push('TARGET_IDENTITY_MISSING')
  if (!snapshot.target_revision) base.unresolved.push('TARGET_REVISION_MISSING')
  if (!snapshot.workspace_identity_ref) base.unresolved.push('WORKSPACE_IDENTITY_MISSING')
  if (!Array.isArray(snapshot.artifacts) || snapshot.artifacts.length === 0) {
    base.unresolved.push('DISCOVERY_ARTIFACTS_MISSING')
    return base
  }

  const covered = []
  const uncovered = []
  for (const artifact of snapshot.artifacts) {
    const parser = parserForArtifact(artifact.path)
    if (!parser) {
      uncovered.push(normalizePath(artifact.path))
      continue
    }
    covered.push(normalizePath(artifact.path))
    base.candidates.push(...parser(snapshot, artifact))
  }

  base.candidates.sort((a, b) => a.id.localeCompare(b.id))
  base.search_coverage = {
    ref: `DISC-COV-${sha256(stableSerialize({
      target_identity: snapshot.target_identity,
      target_revision: snapshot.target_revision,
      covered,
      uncovered,
    })).slice(0, 12)}`,
    state: uncovered.length === 0 && base.unresolved.length === 0 ? 'BOUNDED_SUFFICIENT' : 'PARTIAL',
    surfaces_covered: covered,
    surfaces_uncovered: uncovered,
  }
  base.status = base.unresolved.length === 0 && uncovered.length === 0 ? 'DISCOVERED' : 'PARTIAL'
  return base
}
