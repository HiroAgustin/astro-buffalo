import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import timers from "node:timers/promises";
import test from "node:test";
import buffer from "../dist/index.js";

const article = {
  filePath: "src/content/blog/new.md",
  title: "New article",
  url: "https://example.com/new/",
};
const channels = [
  { id: "one", name: "First channel", isDisconnected: false, isLocked: false },
  { id: "two", name: "Second channel", isDisconnected: false, isLocked: false },
];

async function setup(
  t,
  {
    enabled = true,
    command = "build",
    dryRun = false,
    existing = [],
    failChannel,
    nextPage = [],
    availableChannels = channels,
    nested = false,
    integrationOptions = {},
    articleData = {},
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "astro-buffer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    BUFFER_PUBLISH: enabled ? "true" : undefined,
    BUFFER_DRY_RUN: dryRun ? "true" : undefined,
    BUFFER_API_KEY: "test-token",
    BUFFER_ORGANIZATION_ID: "test-org",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const project = nested ? join(root, "site") : root;
  git("init", "--quiet");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await mkdir(join(project, "src/content/blog"), { recursive: true });
  await writeFile(join(project, "src/content/blog/old.md"), "Existing article\n");
  await writeFile(join(project, "src/content/blog/rename.md"), "Article to rename\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "Existing articles");
  const previousBase = process.env.BUFFER_BASE_REF;
  t.after(() => {
    if (previousBase === undefined) delete process.env.BUFFER_BASE_REF;
    else process.env.BUFFER_BASE_REF = previousBase;
  });
  process.env.BUFFER_BASE_REF = git("rev-parse", "HEAD");
  await writeFile(join(project, "src/content/blog/new.md"), "New article\n");
  await writeFile(join(project, "src/content/blog/old.md"), "Edited existing article\n");
  await rename(
    join(project, "src/content/blog/rename.md"),
    join(project, "src/content/blog/renamed.md"),
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "Publish new article");

  const dir = pathToFileURL(join(project, "dist/"));
  await mkdir(dir);
  const manifest = new URL("buffer-posts.json", dir);
  await writeFile(
    manifest,
    JSON.stringify([
      { ...article, ...articleData },
      { ...article, filePath: "src/content/blog/old.md", url: "https://example.com/old/" },
      { ...article, filePath: "src/content/blog/renamed.md", url: "https://example.com/renamed/" },
    ]),
  );
  const requests = [];
  const created = [];
  const logs = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== "https://api.buffer.com") {
      assert.equal(url, article.url);
      return { ok: true, url };
    }
    assert.equal(options.headers.Authorization, "Bearer test-token");
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.query.includes("query Channels")) {
      return Response.json({ data: { channels: availableChannels } });
    }
    if (body.query.includes("query Posts")) {
      const entries = body.variables.after ? nextPage : existing;
      return Response.json({
        data: {
          posts: {
            edges: entries.map((node) => ({ node })),
            pageInfo: {
              hasNextPage: !body.variables.after && nextPage.length > 0,
              endCursor: body.variables.after ? null : "next",
            },
          },
        },
      });
    }
    assert.ok(body.query.includes("createContentItem"));
    created.push(...body.variables.input.posts);
    return Response.json({
      data: {
        createContentItem: body.variables.input.posts.some(
          ({ channelId }) => channelId === failChannel,
        )
          ? {
              message: "Invalid channel variant",
              errors: [{ message: "Media required" }],
            }
          : { content: { id: "content-item" } },
      },
    });
  });
  const integration = buffer({
    posts: new URL("./posts.ts", import.meta.url),
    contentDirectory: "src/content/blog",
    ...integrationOptions,
  });
  const routes = [];
  await integration.hooks["astro:config:setup"]({
    command,
    injectRoute: (route) => routes.push(route),
  });
  await integration.hooks["astro:config:done"]({ config: { root: pathToFileURL(project + "/") } });
  const run = () =>
    integration.hooks["astro:build:done"]({
      dir,
      logger: Object.fromEntries(
        ["info", "warn"].map((level) => [level, (text) => logs.push(text)]),
      ),
    });
  return { run, requests, created, logs, manifest, routes, git };
}

test("ordinary builds do not inject routes or contact Buffer", async (t) => {
  const { run, requests, routes } = await setup(t, { enabled: false });
  await run();
  assert.deepEqual(routes, []);
  assert.deepEqual(requests, []);
});

test("non-build commands stay inert even with publishing enabled", async (t) => {
  for (const command of ["dev", "preview", "sync"]) {
    await t.test(command, async (t) => {
      const { run, requests, routes, manifest } = await setup(t, { command });
      await run();
      assert.deepEqual(routes, []);
      assert.deepEqual(requests, []);
      await readFile(manifest);
    });
  }
});

test("shares only added articles in one batch, not edits, renames, or archive entries", async (t) => {
  const { run, created, manifest, routes, requests } = await setup(t);
  await run();
  assert.equal(routes[0].pattern, "/buffer-posts.json");
  assert.deepEqual(
    created,
    channels.map(({ id }) => ({
      channelId: id,
      text: `${article.title}\n\n${article.url}`,
      schedulingType: "automatic",
      mode: "shareNow",
    })),
  );
  const mutations = requests.filter(({ query }) => query.includes("mutation Publish"));
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].variables.input.organizationId, "test-org");
  assert.equal(mutations[0].variables.input.title, article.title);
  await assert.rejects(readFile(manifest), { code: "ENOENT" });
});

test("dry runs preview missing channels without mutations or deployment checks", async (t) => {
  const { run, requests, created, logs, manifest } = await setup(t, {
    dryRun: true,
    existing: [{ id: "sent", channelId: "one", text: article.url, status: "sent" }],
  });
  const fetchBuffer = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(url, "https://api.buffer.com");
    return fetchBuffer(url, options);
  });
  await run();
  assert.deepEqual(created, []);
  assert.ok(requests.every(({ query }) => !query.includes("mutation")));
  const preview = JSON.parse(logs.find((message) => message.startsWith("Dry run: ")).slice(9));
  assert.deepEqual(preview, {
    title: article.title,
    text: `${article.title}\n\n${article.url}`,
    channels: [{ id: "two", name: "Second channel" }],
    mode: "shareNow",
  });
  await assert.rejects(readFile(manifest), { code: "ENOENT" });
});

test("dry-run does not enable publishing on ordinary builds", async (t) => {
  const { run, requests, routes } = await setup(t, { dryRun: true, enabled: false });
  await run();
  assert.deepEqual(routes, []);
  assert.deepEqual(requests, []);
});

test("checks all history pages and resumes only missing channels", async (t) => {
  const { run, created, requests } = await setup(t, {
    nextPage: [
      { id: "sent", channelId: "one", text: `Original title\n${article.url}`, status: "sent" },
    ],
  });
  await run();
  assert.deepEqual(
    created.map(({ channelId }) => channelId),
    ["two"],
  );
  assert.ok(requests.some(({ variables }) => variables.after === "next"));
});

test("channel selection limits history reads and publishing to selected accounts", async (t) => {
  const { run, requests, created } = await setup(t, {
    integrationOptions: { channelIds: ["two", "two"] },
  });
  await run();
  assert.deepEqual(
    created.map(({ channelId }) => channelId),
    ["two"],
  );
  assert.deepEqual(
    requests.find(({ query }) => query.includes("query Posts")).variables.input.filter.channelIds,
    ["two"],
  );
});

test("unknown channel selections fail before reading history or publishing", async (t) => {
  const { run, requests, created } = await setup(t, {
    integrationOptions: { channelIds: ["one", "missing"] },
  });
  await assert.rejects(run(), /Unknown Buffer channel IDs: missing/);
  assert.equal(requests.length, 1);
  assert.deepEqual(created, []);
});

test("empty channel selections cannot accidentally publish to every account", () => {
  for (const channelIds of [[], [""], [" "]]) {
    assert.throws(
      () =>
        buffer({
          posts: new URL("./posts.ts", import.meta.url),
          contentDirectory: "src/content/blog",
          channelIds,
        }),
      /channelIds must contain/,
    );
  }
});

test("dry-run previews honor the channel selection", async (t) => {
  const { run, logs } = await setup(t, {
    dryRun: true,
    integrationOptions: { channelIds: ["two"] },
  });
  await run();
  const preview = JSON.parse(logs.find((message) => message.startsWith("Dry run: ")).slice(9));
  assert.deepEqual(preview.channels, [{ id: "two", name: "Second channel" }]);
});

test("completed reruns never recreate sent or scheduled shares", async (t) => {
  const { run, created } = await setup(t, {
    existing: channels.map(({ id }, index) => ({
      id: `post-${id}`,
      channelId: id,
      text: `${article.title}\n\n${article.url}`,
      status: index ? "scheduled" : "sent",
    })),
  });
  await run();
  assert.deepEqual(created, []);
});

test("custom announcement text replaces the title but always retains the article URL", async (t) => {
  const { run, created, requests } = await setup(t, {
    articleData: { text: "  A closer look at building for the web.  " },
  });
  await run();
  assert.ok(
    created.every(
      ({ text }) => text === `A closer look at building for the web.\n\n${article.url}`,
    ),
  );
  assert.equal(
    requests.find(({ query }) => query.includes("mutation")).variables.input.title,
    article.title,
  );
});

test("dry-run previews use the same custom announcement text as publishing", async (t) => {
  const { run, logs } = await setup(t, {
    dryRun: true,
    articleData: { text: "Custom introduction" },
  });
  await run();
  const preview = JSON.parse(logs.find((message) => message.startsWith("Dry run: ")).slice(9));
  assert.equal(preview.text, `Custom introduction\n\n${article.url}`);
});

test("changed announcement copy still deduplicates by the retained URL", async (t) => {
  const { run, created } = await setup(t, {
    articleData: { text: "A different introduction" },
    existing: channels.map(({ id }) => ({
      id: `post-${id}`,
      channelId: id,
      text: `${article.title}\n\n${article.url}`,
      status: "sent",
    })),
  });
  await run();
  assert.deepEqual(created, []);
});

test("invalid custom announcement text fails before contacting Buffer", async (t) => {
  for (const text of ["", "  ", 42, null]) {
    await t.test(String(text), async (t) => {
      const { run, requests } = await setup(t, { articleData: { text } });
      await assert.rejects(run(), /announcement text must be a non-empty string/);
      assert.deepEqual(requests, []);
    });
  }
});

test("reports experimental mutation failures with variant validation details", async (t) => {
  const { run, created } = await setup(t, { failChannel: "one" });
  await assert.rejects(run(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /New article.*Invalid channel variant.*Media required/);
    assert.match(error.message, /New article.*Invalid channel variant.*Media required/);
    return true;
  });
  assert.equal(created.length, 2);
});

test("queue mode submits the announcement to Buffer's automatic posting schedule", async (t) => {
  const { run, created } = await setup(t, {
    integrationOptions: { mode: "addToQueue", channelIds: ["two"] },
    articleData: { text: "A queued introduction" },
  });
  await run();
  assert.deepEqual(created, [
    {
      channelId: "two",
      text: `A queued introduction\n\n${article.url}`,
      schedulingType: "automatic",
      mode: "addToQueue",
    },
  ]);
});

test("dry-run previews report the selected queue mode", async (t) => {
  const { run, logs, created } = await setup(t, {
    dryRun: true,
    integrationOptions: { mode: "addToQueue" },
  });
  await run();
  const preview = JSON.parse(logs.find((message) => message.startsWith("Dry run: ")).slice(9));
  assert.equal(preview.mode, "addToQueue");
  assert.deepEqual(created, []);
});

test("queued announcements are not recreated on reruns", async (t) => {
  const { run, created } = await setup(t, {
    integrationOptions: { mode: "addToQueue" },
    existing: channels.map(({ id }) => ({
      id: `post-${id}`,
      channelId: id,
      text: article.url,
      status: "scheduled",
    })),
  });
  await run();
  assert.deepEqual(created, []);
});

test("unsupported publishing modes fail instead of silently publishing immediately", () => {
  assert.throws(
    () =>
      buffer({
        posts: new URL("./posts.ts", import.meta.url),
        contentDirectory: "src/content/blog",
        mode: "customScheduled",
      }),
    /mode must be/,
  );
});

test("existing failed posts require attention instead of being duplicated", async (t) => {
  const { run, created } = await setup(t, {
    existing: [{ id: "failed", channelId: "one", text: article.url, status: "error" }],
  });
  await assert.rejects(run(), (error) => {
    assert.match(error.errors[0].message, /Review Buffer post failed/);
    assert.match(error.message, /Review Buffer post failed/);
    return true;
  });
  assert.deepEqual(
    created.map(({ channelId }) => channelId),
    ["two"],
  );
});

test("missing credentials fail before contacting Buffer", async (t) => {
  const { run, requests } = await setup(t);
  delete process.env.BUFFER_API_KEY;
  await assert.rejects(run(), /Set BUFFER_API_KEY/);
  assert.deepEqual(requests, []);
});

test("an unchanged revision does nothing even without credentials", async (t) => {
  const { run, requests, git } = await setup(t);
  process.env.BUFFER_BASE_REF = git("rev-parse", "HEAD");
  delete process.env.BUFFER_API_KEY;
  await run();
  assert.deepEqual(requests, []);
});

test("invalid base revisions cannot accidentally backfill the archive", async (t) => {
  const { run, requests } = await setup(t);
  process.env.BUFFER_BASE_REF = "0".repeat(40);
  await assert.rejects(run(), /Set BUFFER_BASE_REF/);
  assert.deepEqual(requests, []);
});

test("HTTP and GraphQL failures are surfaced without retrying mutations", async (t) => {
  for (const [name, response] of [
    ["rate limit", new Response("Rate limited", { status: 429 })],
    ["GraphQL error", Response.json({ errors: [{ message: "Unauthorized" }] })],
    ["missing data", Response.json({})],
  ]) {
    await t.test(name, async (t) => {
      const { run } = await setup(t);
      let attempts = 0;
      t.mock.method(globalThis, "fetch", async () => {
        attempts++;
        return response;
      });
      await assert.rejects(run(), /Buffer/);
      assert.equal(attempts, 1);
    });
  }
});

test("disconnected or locked channels are reported without creating posts", async (t) => {
  const { run, created, logs } = await setup(t, {
    availableChannels: channels.map((channel) => ({ ...channel, isDisconnected: true })),
  });
  await assert.rejects(run(), /No connected, unlocked Buffer channels/);
  assert.deepEqual(created, []);
  assert.ok(logs.some((message) => message.includes("disconnected or locked")));
});

test("an unreachable production article fails before any write to Buffer", async (t) => {
  const { run, created } = await setup(t);
  const fetchBuffer = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (url === article.url) return Promise.resolve({ ok: false, status: 500 });
    return fetchBuffer(url, options);
  });
  await assert.rejects(run(), /Cannot verify.*HTTP 500/);
  assert.deepEqual(created, []);
});

test("nested Astro projects match Git paths relative to their project root", async (t) => {
  const { run, created } = await setup(t, { nested: true });
  await run();
  assert.equal(created.length, 2);
  assert.ok(created.every(({ text }) => text.includes(article.url)));
});

test("deployment readiness retries connection failures, timeouts, and gateway errors", async (t) => {
  const { run, created, logs } = await setup(t);
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.method(timers, "setTimeout", async (delay) => t.mock.timers.tick(delay));
  const fetchBuffer = globalThis.fetch;
  const outcomes = [
    new TypeError("fetch failed"),
    new DOMException("Request timed out", "TimeoutError"),
    { ok: false, status: 502 },
    { ok: false, status: 504 },
  ];
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== article.url) return fetchBuffer(url, options);
    attempts++;
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { ok: true, url };
  });
  await run();
  assert.equal(attempts, 5);
  assert.equal(created.length, 2);
  assert.ok(logs.some((message) => message.includes("fetch failed")));
  assert.ok(logs.some((message) => message.includes("Request timed out")));
});

test("deployment readiness stops retrying after its deadline without publishing", async (t) => {
  const { run, created } = await setup(t);
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.method(timers, "setTimeout", async (delay) => t.mock.timers.tick(delay));
  const fetchBuffer = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url !== article.url) return fetchBuffer(url, options);
    throw new TypeError("fetch failed");
  });
  await assert.rejects(run(), /is not live yet/);
  assert.deepEqual(created, []);
});
