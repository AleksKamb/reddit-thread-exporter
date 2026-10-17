/**
 * Thread model.
 *
 * Reddit's JSON is a pair of "Listings" with deeply nested `{ kind, data }` wrappers.
 * This module turns that into a small, documented tree that the exporters (and
 * anyone reading the JSON export) can use without knowing Reddit's internals.
 *
 * @module thread-model
 */

/**
 * @typedef {object} Comment
 * @property {string} id
 * @property {string | null} parentId   Parent comment ID, or `null` for top-level comments.
 * @property {number} depth             0 for top-level comments.
 * @property {string | null} author     `null` when usernames are left out, or for deleted accounts.
 * @property {boolean} isSubmitter      The comment was written by the thread's author (OP).
 * @property {number} score
 * @property {string} createdAt         ISO 8601 timestamp.
 * @property {boolean} edited
 * @property {boolean} isRemoved        The body was deleted or removed; only the replies remain.
 * @property {string} body              Reddit Markdown.
 * @property {string} url
 * @property {Comment[]} replies
 */

/**
 * @typedef {object} Thread
 * @property {string} id
 * @property {string} subreddit
 * @property {string} title
 * @property {string | null} author
 * @property {number} score
 * @property {number | null} upvoteRatio
 * @property {string | null} flair
 * @property {string} createdAt         ISO 8601 timestamp.
 * @property {string} url               Link to the thread on reddit.com.
 * @property {string | null} linkUrl    For link posts: the page the post links to.
 * @property {string} body              Self-text in Reddit Markdown (empty for link posts).
 * @property {{ reported: number, exported: number, hidden: number }} commentCounts
 *   `reported` is Reddit's own count, `exported` what this export contains,
 *   `hidden` comments still behind "load more replies" stubs.
 * @property {Comment[]} comments
 */

/**
 * @typedef {object} NormalizeOptions
 * @property {boolean} [includeUsernames=false]  Keep author names. Off by default for privacy.
 */

const REMOVED_BODIES = new Set(['[deleted]', '[removed]', '[ Removed by Reddit ]']);

/**
 * Converts a raw thread response into a {@link Thread}.
 *
 * @param {unknown} listing              The JSON from `/comments/<id>/.json`: `[postListing, commentListing]`.
 * @param {unknown[]} [extraThings=[]]   Comments loaded later from `/api/morechildren` (see {@link findMoreStubs}).
 * @param {NormalizeOptions} [options]
 * @returns {Thread}
 * @throws {TypeError} When the response is not a thread.
 */
export function normalizeThread(listing, extraThings = [], { includeUsernames = false } = {}) {
  const post = getPostData(listing);
  const author = includeUsernames ? usernameOrNull(post.author) : null;
  const context = { includeUsernames, postAuthor: post.author, hidden: 0 };

  const comments = buildCommentTree(listing[1]?.data?.children ?? [], context);
  graftExtraComments(comments, extraThings, context);

  return {
    id: post.id,
    subreddit: post.subreddit,
    title: post.title ?? '',
    author,
    score: post.score ?? 0,
    upvoteRatio: post.upvote_ratio ?? null,
    flair: post.link_flair_text || null,
    createdAt: toIso(post.created_utc),
    url: `https://www.reddit.com${post.permalink}`,
    linkUrl: post.is_self || !post.url ? null : post.url,
    body: post.selftext ?? '',
    commentCounts: {
      reported: post.num_comments ?? 0,
      exported: countComments(comments),
      hidden: Math.max(0, context.hidden),
    },
    comments,
  };
}

/**
 * Pulls the post (`t3`) out of a thread response.
 *
 * @param {unknown} listing
 * @returns {Record<string, any>}
 * @throws {TypeError}
 */
export function getPostData(listing) {
  const post = Array.isArray(listing) ? listing[0]?.data?.children?.[0] : null;
  if (!post || post.kind !== 't3' || !post.data) {
    throw new TypeError('This response is not a Reddit thread.');
  }
  return post.data;
}

/**
 * Lists the "load more replies" stubs in a thread, so they can be expanded.
 * "Continue this thread" stubs (deep chains with no IDs) are skipped.
 *
 * @param {unknown} listing
 * @param {unknown[]} [extraThings=[]]  Stubs inside already-loaded extra comments are included too.
 * @returns {string[]}  Comment IDs to request from `/api/morechildren`.
 */
export function findMoreStubs(listing, extraThings = []) {
  const ids = [];
  const visit = (things) => {
    for (const thing of things ?? []) {
      if (thing?.kind === 'more') {
        ids.push(...(thing.data?.children ?? []).filter((id) => id && id !== '_'));
      } else if (thing?.kind === 't1') {
        visit(thing.data?.replies?.data?.children);
      }
    }
  };
  visit(Array.isArray(listing) ? listing[1]?.data?.children : []);
  visit(extraThings);

  const loaded = new Set(extraThings.filter((t) => t?.kind === 't1').map((t) => t.data.id));
  return [...new Set(ids)].filter((id) => !loaded.has(id));
}

/**
 * Counts comments in a tree, replies included.
 *
 * @param {Comment[]} comments
 * @returns {number}
 */
export function countComments(comments) {
  return comments.reduce((total, comment) => total + 1 + countComments(comment.replies), 0);
}

/**
 * Walks a tree depth-first, the order in which comments appear on Reddit.
 *
 * @param {Comment[]} comments
 * @returns {Generator<Comment>}
 */
export function* walkComments(comments) {
  for (const comment of comments) {
    yield comment;
    yield* walkComments(comment.replies);
  }
}

/* ------------------------------------------------------------------------ */

/**
 * @param {any[]} things
 * @param {{ includeUsernames: boolean, postAuthor: string, hidden: number }} context
 * @returns {Comment[]}
 */
function buildCommentTree(things, context) {
  const comments = [];
  for (const thing of things) {
    if (thing?.kind === 'more') {
      context.hidden += thing.data?.count ?? 0;
      continue;
    }
    if (thing?.kind !== 't1' || !thing.data) continue;

    const comment = toComment(thing.data, context);
    const replies = thing.data.replies;
    comment.replies = replies && typeof replies === 'object' ? buildCommentTree(replies.data?.children ?? [], context) : [];

    // A removed comment is only worth keeping if people replied to it.
    if (!comment.isRemoved || comment.replies.length) comments.push(comment);
  }
  return comments;
}

/**
 * Attaches comments from `/api/morechildren` to their parents. Reddit returns them
 * flat and parent-first, so a single pass with an ID index is enough.
 *
 * @param {Comment[]} roots
 * @param {any[]} extraThings
 * @param {{ includeUsernames: boolean, postAuthor: string, hidden: number }} context
 */
function graftExtraComments(roots, extraThings, context) {
  if (!extraThings.length) return;

  const byId = new Map([...walkComments(roots)].map((comment) => [comment.id, comment]));
  for (const thing of extraThings) {
    if (thing?.kind !== 't1' || !thing.data || byId.has(thing.data.id)) continue;
    // Every comment that comes back was counted once in a stub's `count`. Stubs
    // inside the extra comments only re-count part of their parent stub, so they are ignored.
    context.hidden -= 1;

    const comment = toComment(thing.data, context);
    if (comment.isRemoved) continue;

    const parent = byId.get(comment.parentId);
    if (parent) {
      comment.depth = parent.depth + 1;
      parent.replies.push(comment);
    } else {
      comment.parentId = null;
      comment.depth = 0;
      roots.push(comment);
    }
    byId.set(comment.id, comment);
  }
}

/**
 * @param {Record<string, any>} data  A `t1` thing's `data`.
 * @param {{ includeUsernames: boolean, postAuthor: string }} context
 * @returns {Comment}
 */
function toComment(data, context) {
  const body = (data.body ?? '').trim();
  const isRemoved = REMOVED_BODIES.has(body);
  const parentId = typeof data.parent_id === 'string' && data.parent_id.startsWith('t1_') ? data.parent_id.slice(3) : null;
  return {
    id: data.id,
    parentId,
    depth: data.depth ?? 0,
    author: context.includeUsernames && !isRemoved ? usernameOrNull(data.author) : null,
    isSubmitter: Boolean(data.is_submitter || (data.author && data.author === context.postAuthor && data.author !== '[deleted]')),
    score: data.score ?? 0,
    createdAt: toIso(data.created_utc),
    edited: Boolean(data.edited),
    isRemoved,
    body: isRemoved ? '' : body,
    url: data.permalink ? `https://www.reddit.com${data.permalink}` : '',
    replies: [],
  };
}

/** @param {string | undefined} name */
function usernameOrNull(name) {
  return name && name !== '[deleted]' ? name : null;
}

/** @param {number | undefined} seconds Unix time in seconds. */
function toIso(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : '';
}
