# Release Playbook

This document is a practical checklist for publishing the next version after `0.1.0`.

## 1) Pre-check

Run the full pre-release verification:

```bash
npm run release:check
```

This executes:

- TypeScript build
- Auto-fix diagnostics
- End-to-end acceptance check (`/health` + `/chat`)

## 2) Update version

For a patch release (for example `0.1.0` -> `0.1.1`):

```bash
npm version patch
```

For minor/major releases:

```bash
npm version minor
# or
npm version major
```

## 3) Update changelog

Append the new version section to `CHANGELOG.md` before publishing.

Recommended format:

```md
## 0.1.1

- Fix ...
- Improve ...
```

## 4) Publish to npm

```bash
npm publish --access public --registry https://registry.npmjs.org
```

If 2FA is required, pass OTP:

```bash
npm publish --access public --registry https://registry.npmjs.org --otp=<CODE>
```

## 5) Verify published metadata

```bash
npm view openclaw-cursor-mcp version --registry https://registry.npmjs.org
npm view openclaw-cursor-mcp dist-tags --registry https://registry.npmjs.org
```

## 6) Push git tags and commits

```bash
git push
git push --tags
```
