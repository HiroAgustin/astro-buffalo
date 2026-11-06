# astro-buffalo

Share newly published Astro articles to Buffer using its experimental `createContentItem` API.
One request per article, with a variant for each channel. No SDK, database, or browser JavaScript.

## Setup

Requires Astro 7.x and Node 24 or newer.

```sh
npm install astro-buffalo
```

Configure your article endpoint and source directory in `astro.config.mjs`:

```js
import { defineConfig } from "astro/config";
import buffer from "astro-buffalo";

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

The endpoint is injected only during publishing builds and removed before any API requests.

### Article manifest

The endpoint must return a JSON array with these fields on each article:

| Field | Required | Meaning |
| --- | --- | --- |
| `filePath` | Yes | Source file path relative to the Astro project root, using forward slashes; no absolute paths or `.`/`..` segments. Must match the Git path, e.g. `src/content/blog/hello.md`. |
| `title` | Yes | Non-empty article title, also used as the default announcement. |
| `url` | Yes | Absolute HTTP(S) canonical production URL, without whitespace, credentials, or a fragment. Must match the deployed URL without a redirect. |
| `text` | No | Non-empty custom announcement text; the article URL is always appended. |

An empty array is valid; invalid entries stop the build before any Buffer requests.
Adapt the collection name and routes to your site. Include only public articles, filtering drafts
and future dates if your schema defines them:

```ts
const posts = await getCollection(
  "blog",
  ({ data }) => !data.draft && data.pubDate <= new Date(),
);
```

### Article detection

The integration compares `BUFFER_BASE_REF` with `HEAD`, sharing added articles and committed
drafts becoming public. Ordinary edits, published-article renames, and archive entries are ignored.
Paths are relative to the Astro project root.

For Markdown or MDX drafts, use a top-level YAML boolean `draft: true`. Keep drafts out of your
public routes and manifest. To publish, set it to `false` or remove it and include the article in
the manifest. Renaming a draft during publication is supported; sources still marked as drafts
are never shared.

Quoted strings, custom fields, and schema defaults are not draft flags. Your adapter handles
custom publication rules and future dates; a date passing without a source change does not trigger
an announcement. Blog drafts are not synchronized with Buffer.

### Optional settings

By default, announcements publish immediately to every connected, unlocked channel.
To select channels or use their Buffer posting schedules, add:

```js
channelIds: ["your_linkedin_channel_id", "your_bluesky_channel_id"],
mode: "addToQueue",
```

`channelIds` must be non-empty and contain known IDs. Omit it to use all connected channels.
`mode` supports `shareNow` (default) and `addToQueue`; both use automatic delivery.
Disconnected or locked channels are reported and skipped.

Announcements use `title + "\n\n" + url`. Add `text: post.data.description` to an article's manifest
entry for custom copy; the content item's title stays unchanged. Custom text is trimmed and must
be non-empty. The URL is always appended for duplicate detection.

## Publishing

Your site can be hosted anywhere. GitHub Actions is optional: run the publishing build locally
or in any CI environment with Node 24+ and Git. It needs a Git checkout containing both the
publishing commit (`HEAD`) and `BUFFER_BASE_REF`; source archives without Git history are not enough.
If your host cannot provide these, run publishing separately from deployment.

Normal builds and development never publish. Set these environment variables for a publishing build:

| Variable | Purpose |
| --- | --- |
| `BUFFER_PUBLISH=true` | Explicitly enable publishing. |
| `BUFFER_DRY_RUN=true` | Preview announcements without creating posts (also requires `BUFFER_PUBLISH=true`). |
| `BUFFER_API_KEY` | Buffer personal API key; keep this secret. |
| `BUFFER_ORGANIZATION_ID` | Organization containing the channels to share to. |
| `BUFFER_BASE_REF` | Full commit SHA before the articles were added or changed from draft to published. |

Create a personal API key in Buffer's **Settings → API** with `account:read`, `posts:read`,
and `posts:write` permissions.

Store the key in CI secrets or an ignored `.env` file. The integration reads `process.env`; it
does not load `.env` itself. Find your organization ID using Buffer's
`account { organizations { id name } }` query.

### Preview locally

Add your key and organization ID to an ignored `.env` file:

```dotenv
BUFFER_API_KEY=your_api_key
BUFFER_ORGANIZATION_ID=your_organization_id
```

From the commit publishing the articles, run this POSIX shell command (macOS/Linux). Replace `HEAD^`
with the revision immediately before publication if the changes span multiple commits:

```sh
BUFFER_PUBLISH=true BUFFER_DRY_RUN=true BUFFER_BASE_REF="$(git rev-parse HEAD^)" \
  node --env-file=.env ./node_modules/astro/bin/astro.mjs build
```

Dry runs require credentials and a base revision. They read channels and history, then print the
planned text, missing channels, and mode. They skip deployment checks and all writes; existing
failed posts still cause the run to fail.

### GitHub Actions example

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

### Deployment and retries

Build from the exact publishing commit with the base revision available in Git. Production URLs
must respond successfully without redirects; the integration waits up to five minutes for deployment.
Announcements contain no media, so networks requiring it or extra metadata may reject them.

On failure, rerun with the same base SHA. Every history page is checked for matching URLs per
channel. Existing failed posts, drafts, or approval requests need attention in Buffer rather than
replacement posts; keep their records and URL text intact.

Validation finishes before any API requests, but later failures can occur after records are created.
Inspect Buffer for delivery errors. Creation requests are not retried automatically, and exactly-once
delivery is not guaranteed. Run publishing builds serially to avoid races.

For development and release instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).

References: [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/)
and [Buffer content items](https://developers.buffer.com/guides/content-items).
