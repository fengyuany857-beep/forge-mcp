# Real-project conformance fixtures

These fixtures are bounded, revision-pinned evidence slices used to test the R9 Rule Resolver prototype against different repository rule sources.

They are not complete conformance models of the upstream repositories and must not be interpreted as proof that no other rules exist.

## Next.js

Repository: `vercel/next.js`

Pinned revision: `c709412355acb4d52a66f3febcb9b1e28ec1695b`

Evidence:

- `package.json` blob `10ef5e03ffaa5508e948c58c4af39bbc34650da6`
  - repository scripts include `prettier-check`, `lint-eslint`, `lint`, and `lint-fix`
- `eslint.cli.config.mjs` blob `98389b5f5117134a5c81fdeec5f4411012357930`
  - typed ESLint override applies to `**/*.ts` / `**/*.tsx`
  - the override explicitly ignores selected non-essential surfaces including `test/**/*`

Fixture purpose: verify simultaneous FORMAT + LINT rules and path exclusion inside one executable-config family.

## Django

Repository: `django/django`

Pinned revision: `64edef37e7b419dd584307d84650a192fb47dc4c`

Evidence:

- `pyproject.toml` blob `cb9d0e6b8d3113ded349eaf77a12fd2042420739`
  - `[tool.black]` targets Python 3.12
  - Black `force-exclude` names `tests/test_runner_apps/tagged/tests_syntax_error.py`
  - `[tool.isort]` uses the `black` profile

Fixture purpose: verify that an explicit repository exclusion is represented as a scoped Waiver instead of deleting the underlying rule.

## Tokio

Repository: `tokio-rs/tokio`

Pinned revision: `eb9cdf2ff012ec22d4efd74cf46d04222264cd8e`

Evidence:

- `.github/workflows/ci.yml` blob `6d1960e9b96ef4a432702b2f758c752c7e4dadb1`
  - CI runs a rustfmt check over tracked Rust files with edition 2021
  - CI includes clippy checks and pins the clippy toolchain line in workflow environment

Fixture purpose: verify a CI_PIPELINE-sourced, CI_ENFORCED repository rule rather than a local formatter config file.

## Evidence boundary

A fixture is allowed to assert only claims represented by the pinned evidence above. `BOUNDED_SUFFICIENT` in these files means sufficient for the explicitly modeled fixture slice, not sufficient to conclude global absence of other upstream rules.

If an upstream revision or evidence blob changes, the fixture becomes stale for source-freshness purposes until re-inspected and re-pinned.
