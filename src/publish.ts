import timers from "node:timers/promises";
import type { AstroIntegrationLogger } from "astro";

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

interface PostHistory {
  posts: {
    edges: { node: BufferPost }[] | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

async function waitForDeployment(url: string, logger: AstroIntegrationLogger) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      if (
        !(error instanceof TypeError) &&
        !(error instanceof Error && error.name === "TimeoutError")
      ) {
        throw error;
      }
      logger.warn(`Cannot reach ${url}: ${error.message}. Retrying.`);
    }
    if (response) {
      if (response.ok && response.url === url) return;
      if (![404, 502, 503, 504].includes(response.status)) {
        throw new Error(`Cannot verify ${url}: HTTP ${response.status}.`);
      }
    }
    logger.info(`Waiting for ${url} to be deployed...`);
    await timers.setTimeout(10_000);
  }
  throw new Error(`${url} is not live yet. Rerun after deployment succeeds.`);
}

async function request<T>(token: string, query: string, variables: object) {
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

interface Article {
  title: string;
  url: string;
  text: string;
  mode: "shareNow" | "addToQueue";
}

export async function publishPosts(
  posts: Article[],
  {
    channelIds,
    dryRun,
    logger,
  }: { channelIds?: string[]; dryRun: boolean; logger: AstroIntegrationLogger },
) {
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
  if (channelIds) {
    const unknown = channelIds.filter((id) => !channels.some((channel) => channel.id === id));
    if (unknown.length) {
      throw new Error(`Unknown Buffer channel IDs: ${unknown.join(", ")}.`);
    }
  }
  const connected = channels.filter((channel) => {
    if (channelIds && !channelIds.includes(channel.id)) return false;
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
    const { posts: page }: PostHistory = await request(
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
        (post) => post.channelId === channel.id && post.text.split(/\s+/).includes(article.url),
      );
      if (shared) {
        if (!["sent", "scheduled", "sending"].includes(shared.status)) {
          failures.push(
            new Error(`Review Buffer post ${shared.id} for "${channel.name}": ${shared.status}.`),
          );
        }
        logger.info(`Already in Buffer: "${article.title}" -> "${channel.name}".`);
        continue;
      }

      pending.push(channel);
    }
    if (!pending.length) continue;

    if (dryRun) {
      logger.info(
        `Dry run: ${JSON.stringify({
          title: article.title,
          text: article.text,
          channels: pending.map(({ id, name }) => ({ id, name })),
          mode: article.mode,
        })}`,
      );
      continue;
    }

    await waitForDeployment(article.url, logger);

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
            text: article.text,
            schedulingType: "automatic",
            mode: article.mode,
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
      [
        "Some Buffer posts need attention; reruns skip existing posts.",
        ...failures.map((error) => error.message),
      ].join("\n"),
    );
  }
}
