# astro-buffer

A small Astro integration that shares newly published articles to your connected Buffer channels.
It uses Buffer's experimental `createContentItem` API: one request per article, with a variant for
each channel. No SDK, external database, or browser JavaScript.

## Setup

Requires Astro 7.x and Node 24 or newer. Node 24 LTS is the tested baseline.

Once the package is published to npm, install it in your Astro project:

```sh
npm install astro-buffer
```

Until then, run `npm ci` in this repository and install it in your Astro project with
`npm install /path/to/astro-buffer`. The package's prepare script builds the distribution.

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
      // Optional: omit to use every connected, unlocked channel.
      channelIds: ["your_linkedin_channel_id", "your_bluesky_channel_id"],
      // Optional: use Buffer's posting schedule instead of publishing immediately.
      mode: "addToQueue",
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
requests. It is not injected during normal builds, development, preview, or sync, even if the
publishing flag is present for those non-build commands.

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

Keep publishing separate from preview/PR builds. A production-only GitHub Actions workflow can
invoke `BUFFER_PUBLISH=true astro build` after checking out the publishing commit with
`fetch-depth: 0`. Pass `${{ github.event.before }}` as `BUFFER_BASE_REF` for push events. Serialize
runs with a concurrency group using `queue: max` so newer pushes do not replace pending runs.

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
