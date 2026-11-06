# astro-buffer

A small Astro integration that shares newly published articles to your connected Buffer channels.
It uses Buffer's experimental `createContentItem` API: one request per article, with a variant for
each channel. No SDK, external database, or browser JavaScript.

## Setup

Requires Astro 7.x and Node 24 or newer. Node 24 LTS is the tested baseline.

Install it in your Astro project:

```sh
npm install astro-buffer
```

Configure Astro with an endpoint that lists your articles, and the directory containing their
source files:

```js
import { defineConfig } from "astro/config";
import buffer from "astro-buffer";

export default defineConfig({
  site: "https://example.com",
  integrations: [
    buffer({
      posts: new URL("./src/buffer-posts.ts", import.meta.url),
      contentDirectory: "src/content/blog",
    }),
  ],
});
```

In `src/buffer-posts.ts`, adapt your content collection and public routes:

```ts
import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error("Configure site before publishing.");
  const posts = await getCollection("blog");
  return Response.json(
    posts.map((post) => {
      if (!post.filePath) throw new Error(`Missing source path for "${post.id}".`);
      return {
        filePath: post.filePath,
        title: post.data.title,
        url: new URL(`/${post.id}/`, site).href,
      };
    }),
  );
};
```

This endpoint is injected only for publishing builds and removed from the output before any API
requests. It is not injected during normal builds, development, preview, or sync, even if the
publishing flag is present for those non-build commands.

### Article manifest

The endpoint must return a JSON array with these fields on each article:

| Field | Required | Meaning |
| --- | --- | --- |
| `filePath` | Yes | Source file path relative to the Astro project root, using forward slashes; no absolute paths or `.`/`..` segments. Must match the Git path, e.g. `src/content/blog/hello.md`. |
| `title` | Yes | Non-empty article title, also used as the default announcement. |
| `url` | Yes | Absolute HTTP(S) canonical production URL, without whitespace, credentials, or a fragment. Must match the deployed URL without a redirect. |
| `text` | No | Non-empty custom announcement text; the article URL is always appended. |

An empty array is valid. Invalid entries stop the build before any Buffer requests.
Adapt the example's collection name and URL construction to your site's routes. Only include
articles that are public and ready to share: filter drafts and future-dated posts in your adapter.
For example, if your collection defines `draft` and `pubDate`:

```ts
const posts = await getCollection(
  "blog",
  ({ data }) => !data.draft && data.pubDate <= new Date(),
);
```

Git detection only considers added files, not later edits. Removing a draft flag or reaching a
future publication date will not automatically announce a previously committed file.

### Optional settings

The default is to publish immediately to every connected, unlocked channel. To select accounts
or use their existing Buffer posting schedules, add these options to `buffer()`:

```js
channelIds: ["your_linkedin_channel_id", "your_bluesky_channel_id"],
mode: "addToQueue",
```

An explicit channel list must be non-empty and contain known channel IDs. Omit it to use all
connected channels. The only supported modes are `shareNow` (default) and `addToQueue`.

Each article may also include an optional `text` string in the endpoint response. It replaces
the title in the announcement, but not the content item's title. For example:

```js
{
  filePath: post.filePath,
  title: post.data.title,
  url: new URL(`/${post.id}/`, site).href,
  text: post.data.description,
}
```

The integration always appends a blank line and the canonical article URL, preserving duplicate
detection. Omit `text` to keep the title + URL default. Provided text must be non-empty; surrounding
whitespace is trimmed. Dry runs show the same announcement text as publishing.

## Publishing

Normal builds and development never publish. Set these environment variables for a publishing build:

| Variable | Purpose |
| --- | --- |
| `BUFFER_PUBLISH=true` | Explicitly enable publishing. |
| `BUFFER_DRY_RUN=true` | Preview announcements without creating posts (also requires `BUFFER_PUBLISH=true`). |
| `BUFFER_API_KEY` | Buffer personal API key; keep this secret. |
| `BUFFER_ORGANIZATION_ID` | Organization containing the channels to share to. |
| `BUFFER_BASE_REF` | Full commit SHA before the newly added articles. |

Create a personal API key in Buffer's **Settings → API**, selecting only `account:read`,
`posts:read`, and `posts:write`. The integration reads channels, checks post history for duplicates,
and creates announcements; it does not manage account or channel settings.

Store the key in your CI secret store or an ignored local `.env` file. Load local environment
variables before running Astro; the integration reads `process.env` and does not load `.env`
itself. Find your organization ID with Buffer's `account { organizations { id name } }` query
and use the ID of the organization containing your channels.

### Preview locally

Add your key and organization ID to an ignored `.env` file:

```dotenv
BUFFER_API_KEY=your_api_key
BUFFER_ORGANIZATION_ID=your_organization_id
```

From the commit adding the articles, run this POSIX shell command (macOS/Linux). Replace `HEAD^`
with the revision immediately before your new articles if they span multiple commits:

```sh
BUFFER_PUBLISH=true BUFFER_DRY_RUN=true BUFFER_BASE_REF="$(git rev-parse HEAD^)" \
  node --env-file=.env ./node_modules/astro/bin/astro.mjs build
```

This prints the planned text, missing target channels, and mode without creating posts.
It still reads Buffer channels and history. Nothing is announced by an ordinary `npm run build`.

Run `astro build` from the exact publishing commit in a Git checkout with the base revision
available. Only added files between that revision and `HEAD` are shared; edits, detected renames,
and archive entries are ignored. Directory paths are relative to the Astro project root.

Each article's production URL must return successfully without a redirect. The integration waits
about five minutes for deployment before failing. Posts use `title + URL` unless custom text is
provided. The default `mode: "shareNow"` publishes immediately; `mode: "addToQueue"` uses the next
available slot in each channel's Buffer posting schedule. Both use automatic delivery.
Disconnected and locked channels are reported and excluded.

The announcement contains no media. Networks requiring media or extra metadata may reject it.
Batch input validation is all-or-nothing. Subsequent processing errors can occur after Buffer
creates records; inspect the Buffer dashboard for delivery errors.

On failure, rerun with the same base revision. All history pages are checked for matching article
URLs per channel before creating anything. Existing failed posts, drafts, or approval requests
require attention in Buffer, not replacement posts. Keep their URL text and records intact.
Creation requests are never automatically retried; this is not an exactly-once delivery guarantee.
Run publishing builds serially to avoid races.

Dry runs still require credentials and a base revision. They read channels and post history,
report only missing announcements, and skip deployment checks and all Buffer mutations. Existing
failed posts still require attention and cause the run to fail.

### GitHub Actions

After installing the package and committing your lockfile, save this as
`.github/workflows/buffer.yml`. Configure a `BUFFER_API_KEY` repository secret and a
`BUFFER_ORGANIZATION_ID` repository variable. Adjust the branch and content path for your site.
Your normal production deployment must run separately; the integration waits for article URLs
to become available before creating announcements.

```yaml
name: Share new articles

on:
  push:
    branches: [main]
    paths: ["src/content/blog/**"]
  workflow_dispatch:
    inputs:
      base_ref:
        description: Full commit SHA before the new articles (reuse when retrying)
        required: true

permissions:
  contents: read

concurrency:
  group: buffer-publishing
  queue: max

jobs:
  publish:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
      - run: npm ci
      - run: node ./node_modules/astro/bin/astro.mjs build
        env:
          BUFFER_PUBLISH: "true"
          BUFFER_API_KEY: ${{ secrets.BUFFER_API_KEY }}
          BUFFER_ORGANIZATION_ID: ${{ vars.BUFFER_ORGANIZATION_ID }}
          BUFFER_BASE_REF: ${{ github.event.before || inputs.base_ref }}
```

For a CI preview, add `BUFFER_DRY_RUN: "true"` to the final step's environment. Keep publishing
out of pull-request and preview deployment workflows. For retries, use manual dispatch with
the original base SHA; do not replace it with the current commit.

## Development

Use Node 24 or newer. Tests exercise the compiled JavaScript that
ships to users, not TypeScript source:

```sh
npm ci
npm test
npm run build
npm run format:check
```

CI runs the build, tests, and formatting check on Node 24 LTS with Astro 7.
Buffer requests are mocked; no credentials or real social posts are involved.

References: [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/)
and [Buffer content items](https://developers.buffer.com/guides/content-items).
