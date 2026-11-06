# Contributing

## Development

Use Node 24 or newer:

```sh
npm ci
npm test
npm run format:check
```

Tests build and exercise the compiled JavaScript shipped to users. Buffer requests are mocked;
no credentials or real social posts are involved. CI runs these checks on Node 24 LTS with Astro 7.

## Releases

From a clean, up-to-date `main` branch, release a fix:

```sh
npm version patch
git push origin main --follow-tags
```

Use `npm version minor` for a feature release. Pushing a `v*` tag triggers the release workflow,
which verifies the tag matches `package.json`, runs tests and formatting, and publishes to npm
with provenance using trusted publishing. It does not announce anything on social networks.
