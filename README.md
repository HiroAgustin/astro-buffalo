# astro-buffer

A small Astro integration that shares newly published articles to your connected Buffer channels.
It uses Buffer's experimental `createContentItem` API: one request per article, with a variant for
each channel. No SDK, external database, or browser JavaScript.

## Setup

Build the package with `npm install && npm run build`. Until it is published, install it in a
local Astro project using `npm install /path/to/astro-buffer`.

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
    posts.map((post) => ({
      filePath: post.filePath,
      title: post.data.title,
      url: new URL(`/${post.id}/`, site).href,
    })),
  );
};
```

This endpoint is injected only for publishing builds and removed from the output before any API
requests. It is not a public route during normal builds.

## Publishing

Normal builds and development never publish. Set these environment variables for a publishing build:

| Variable | Purpose |
| --- | --- |
| `BUFFER_PUBLISH=true` | Explicitly enable publishing. |
| `BUFFER_API_KEY` | Buffer personal API key; keep this secret. |
| `BUFFER_ORGANIZATION_ID` | Organization containing the channels to share to. |
| `BUFFER_BASE_REF` | Full commit SHA before the newly added articles. |

Run `astro build` from the exact publishing commit in a Git checkout with the base revision
available. Only added files between that revision and `HEAD` are shared; edits, detected renames,
and archive entries are ignored. Directory paths are relative to the Astro project root.

Each article's production URL must return successfully without a redirect. The integration waits
about five minutes for deployment before failing. Posts use `title + URL` and `shareNow`; Buffer
delivers them automatically. Disconnected and locked channels are reported and excluded.

The announcement contains no media. Networks requiring media or extra metadata may reject it.
Batch input validation is all-or-nothing. Subsequent processing errors can occur after Buffer
creates records; inspect the Buffer dashboard for delivery errors.

On failure, rerun with the same base revision. All history pages are checked for matching article
URLs per channel before creating anything. Existing failed posts, drafts, or approval requests
require attention in Buffer, not replacement posts. Keep their URL text and records intact.
Creation requests are never automatically retried; this is not an exactly-once delivery guarantee.
Run publishing builds serially to avoid races.

Keep publishing separate from preview/PR builds. A production-only GitHub Actions workflow can
invoke `BUFFER_PUBLISH=true astro build` after checking out the publishing commit with
`fetch-depth: 0`. Pass `${{ github.event.before }}` as `BUFFER_BASE_REF` for push events. Serialize
runs with a concurrency group using `queue: max` so newer pushes do not replace pending runs.

## Development

Use Node 26 for the native TypeScript test runner:

```sh
npm ci
npm test
npm run build
npm run format:check
```

References: [Astro Integration API](https://docs.astro.build/en/reference/integrations-reference/)
and [Buffer content items](https://developers.buffer.com/guides/content-items).
