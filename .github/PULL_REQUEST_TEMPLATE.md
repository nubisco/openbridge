## Summary

Describe what changed and why.

## Contributor License Agreement (CLA)

- [ ] I have read [`docs/CLA-INDIVIDUAL.md`](../docs/CLA-INDIVIDUAL.md) and I agree to its terms for this contribution.
- [ ] I confirm I am legally entitled to submit this contribution under the CLA.

Required confirmation statement (do not remove):

"I agree to the Nubisco Individual CLA and submit this contribution under those terms."

## Change Type

- [ ] Bug fix
- [ ] New feature (daemon, API, dashboard)
- [ ] New or updated package API (`@openbridge/*`)
- [ ] Plugin SDK change
- [ ] Homebridge compatibility change
- [ ] Documentation update
- [ ] Refactor / maintenance
- [ ] CI / tooling change

## Testing Performed

List commands you ran and results:

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm build`

## Documentation

- [ ] I updated documentation where needed
- [ ] No documentation changes were required

## Breaking Changes

- [ ] This PR introduces a breaking change (plugin API, config schema, HTTP API, or SDK)
- [ ] This PR does not introduce a breaking change

If breaking, describe the change and migration steps:

## Checklist

- [ ] Changes are focused and minimal
- [ ] Plugin lifecycle contracts (`setup / start / stop`) are preserved or documented as changed
- [ ] Sensitive values (tokens, keys, pairing data) are not included in code, docs, or logs
- [ ] CLA confirmation above is complete and accurate
