import { execFileSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

interface Article {
  filePath: string;
  title: string;
  url: string;
}

export interface BufferOptions {
  posts: URL;
  contentDirectory: string;
}

interface Channel {
  id: string;
  name: string;
  isDisconnected: boolean;
  isLocked: boolean;
}

interface BufferPost {
  id: string;
  text: string;
  channelId: string;
  status: string;
}

async function request<T>(token: string, query: string, variables: object): Promise<T> {
  const response = await fetch("https://api.buffer.com", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    throw new Error(
      `Buffer request failed: HTTP ${response.status}.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ""}`,
    );
  }

  const result: { data?: T; errors?: { message: string }[] } = await response.json();
  if (result.errors?.length) {
    throw new Error(`Buffer: ${result.errors.map((error) => error.message).join("; ")}`);
  }
  if (!result.data) {
    throw new Error("Buffer returned no data.");
  }
  return result.data;
}

export default function buffer({
  posts: entrypoint,
  contentDirectory,
}: BufferOptions): AstroIntegration {
  let root: URL;
  const enabled = process.env.BUFFER_PUBLISH === "true";

  return {
    name: "astro-buffer",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        if (enabled) {
          injectRoute({
            pattern: "/buffer-posts.json",
            entrypoint: fileURLToPath(entrypoint),
            prerender: true,
          });
        }
      },
      "astro:config:done": ({ config }) => {
        root = config.root;
      },
      "astro:build:done": async ({ dir, logger }) => {
        if (!enabled) return;

        const manifest = new URL("buffer-posts.json", dir);
        const articles: Article[] = JSON.parse(await readFile(manifest, "utf8"));
        await unlink(manifest);

        const base = process.env.BUFFER_BASE_REF;
        if (!base || !/^[a-f0-9]{40}$/i.test(base) || /^0+$/.test(base)) {
          throw new Error("Set BUFFER_BASE_REF to the full commit SHA before the new posts.");
        }
        const added = new Set(
          execFileSync(
            "git",
            [
              "diff",
              "--name-only",
              "-z",
              "--diff-filter=A",
              "--find-renames",
              base,
              "HEAD",
              "--",
              contentDirectory,
            ],
            { cwd: fileURLToPath(root), encoding: "utf8" },
          )
            .split("\0")
            .filter(Boolean),
        );
        const posts = articles.filter((article) => added.has(article.filePath));
        if (!posts.length) {
          logger.info("No new blog posts to share.");
          return;
        }

        const token = process.env.BUFFER_API_KEY;
        const organizationId = process.env.BUFFER_ORGANIZATION_ID;
        if (!token || !organizationId) {
          throw new Error("Set BUFFER_API_KEY and BUFFER_ORGANIZATION_ID before publishing.");
        }

        const { channels } = await request<{ channels: Channel[] }>(
          token,
          `query Channels($input: ChannelsInput!) {
            channels(input: $input) { id name isDisconnected isLocked }
          }`,
          { input: { organizationId } },
        );
        const connected = channels.filter((channel) => {
          if (channel.isDisconnected || channel.isLocked) {
            logger.warn(`Cannot publish to "${channel.name}": disconnected or locked in Buffer.`);
            return false;
          }
          return true;
        });
        if (!connected.length) {
          throw new Error("No connected, unlocked Buffer channels found.");
        }

        const existing: BufferPost[] = [];
        let after: string | null = null;
        do {
          const {
            posts: page,
          }: {
            posts: {
              edges: { node: BufferPost }[] | null;
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } = await request(
            token,
            `query Posts($input: PostsInput!, $after: String) {
              posts(input: $input, first: 100, after: $after) {
                edges { node { id text channelId status } }
                pageInfo { hasNextPage endCursor }
              }
            }`,
            {
              input: { organizationId, filter: { channelIds: connected.map(({ id }) => id) } },
              after,
            },
          );
          if (!page.edges) {
            throw new Error("Buffer returned no post history.");
          }
          existing.push(...page.edges.map(({ node }) => node));
          if (
            page.pageInfo.hasNextPage &&
            (!page.pageInfo.endCursor || page.pageInfo.endCursor === after)
          ) {
            throw new Error("Buffer returned an invalid pagination cursor.");
          }
          after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        } while (after);

        const failures: Error[] = [];
        for (const article of posts) {
          const pending: Channel[] = [];
          for (const channel of connected) {
            const shared = existing.find(
              (post) =>
                post.channelId === channel.id && post.text.split(/\s+/).includes(article.url),
            );
            if (shared) {
              if (!["sent", "scheduled", "sending"].includes(shared.status)) {
                failures.push(
                  new Error(
                    `Review Buffer post ${shared.id} for "${channel.name}": ${shared.status}.`,
                  ),
                );
              }
              logger.info(`Already in Buffer: "${article.title}" -> "${channel.name}".`);
              continue;
            }

            pending.push(channel);
          }
          if (!pending.length) continue;

          let live = false;
          const deadline = Date.now() + 300_000;
          while (Date.now() < deadline) {
            const response = await fetch(article.url, {
              method: "HEAD",
              signal: AbortSignal.timeout(10_000),
            });
            if (response.ok && response.url === article.url) {
              live = true;
              break;
            }
            if (response.status !== 404 && response.status !== 503) {
              throw new Error(`Cannot verify ${article.url}: HTTP ${response.status}.`);
            }
            logger.info(`Waiting for ${article.url} to be deployed...`);
            await setTimeout(10_000);
          }
          if (!live) {
            throw new Error(`${article.url} is not live yet. Rerun after deployment succeeds.`);
          }

          const { createContentItem } = await request<{
            createContentItem: {
              content?: { id: string };
              message?: string;
              errors?: { message: string }[];
            };
          }>(
            token,
            `mutation Publish($input: CreateContentItemInput!) {
              createContentItem(input: $input) {
                ... on CreateContentItemSuccess { content { id } }
                ... on CreateContentItemFailure {
                  message
                  errors { ... on MutationError { message } }
                }
              }
            }`,
            {
              input: {
                organizationId,
                title: article.title,
                posts: pending.map(({ id }) => ({
                  channelId: id,
                  text: `${article.title}\n\n${article.url}`,
                  schedulingType: "automatic",
                  mode: "shareNow",
                })),
              },
            },
          );
          if (!createContentItem.content?.id) {
            failures.push(
              new Error(
                `"${article.title}": ${[
                  createContentItem.message ?? "No content item ID returned.",
                  ...(createContentItem.errors ?? []).map(({ message }) => message),
                ].join("; ")}`,
              ),
            );
            continue;
          }
          logger.info(
            `Submitted "${article.title}" to ${pending.length} channels (${createContentItem.content.id}).`,
          );
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Some Buffer posts need attention; reruns skip existing posts.",
          );
        }
      },
    },
  };
}
