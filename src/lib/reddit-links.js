/**
 * Reddit link parsing.
 *
 * Turns whatever people paste (full URLs, old.reddit links, redd.it short links,
 * bare `/r/<sub>/comments/<id>` paths, mobile share links, comment permalinks)
 * into one canonical {@link ThreadRef} per thread. Pure functions, no browser APIs,
 * so everything here is covered by unit tests.
 *
 * @module reddit-links
 */

/**
 * A reference to one Reddit thread.
 *
 * @typedef {object} ThreadRef
 * @property {'thread' | 'share'} kind  `share` links (`/r/<sub>/s/<code>`) must be resolved before fetching.
 * @property {string} id                Post ID in base36 (`1abc2de`), or the share code for `share` links.
 * @property {string | null} subreddit  Subreddit name without the `r/` prefix, when the link includes it.
 * @property {string | null} slug       URL slug of the title, used as a placeholder title until the thread is fetched.
 * @property {string} url               Canonical https://www.reddit.com URL for the thread or share link.
 */

/**
 * Result of scanning free text or a file for thread links.
 *
 * @typedef {object} ExtractResult
 * @property {ThreadRef[]} refs        Unique threads, in the order they first appear.
 * @property {number} duplicates       Links that pointed at a thread already in `refs`.
 * @property {string[]} notThreads     Reddit links that are not threads (subreddits, user pages, wiki pages…).
 */

const SUBREDDIT = '[A-Za-z0-9_]{1,21}';
const POST_ID = '[A-Za-z0-9]{4,10}';

/** `/r/<sub>/comments/<id>/<slug>/…` or `/comments/<id>/…` */
const THREAD_PATH = new RegExp(`^/(?:r/(${SUBREDDIT})/)?comments/(${POST_ID})(?:/([^/?#]*))?`, 'i');

/** `/r/<sub>/s/<code>`: the share links the Reddit apps produce. */
const SHARE_PATH = new RegExp(`^/r/(${SUBREDDIT})/s/([A-Za-z0-9]+)`, 'i');

/** reddit.com and any subdomain of it (www, old, new, np, m, sh, …). */
const REDDIT_HOST = /^(?:[a-z0-9-]{1,63}\.){0,6}reddit\.com$/i;

/** The official short-link domain: https://redd.it/<id> */
const SHORT_HOST = /^redd\.it$/i;

/**
 * Finds anything that looks like a Reddit link inside free text, CSV cells, JSON or HTML.
 * Commas, quotes, brackets and whitespace end a match, so CSV and Markdown both work.
 * Every repetition is bounded, so a huge or hostile file can't make matching slow.
 */
const LINK_CANDIDATE =
  /(?:https?:\/\/)?(?:[a-z0-9-]{1,63}\.){0,6}(?:reddit\.com|redd\.it)\/[^\s"'<>,;|()[\]{}]{0,500}|(?<![\w./])\/r\/[A-Za-z0-9_]{1,21}\/(?:comments|s)\/[^\s"'<>,;|()[\]{}]{0,500}|(?<![\w./])\/comments\/[A-Za-z0-9]{4,10}[^\s"'<>,;|()[\]{}]{0,500}/gi;

/**
 * Parses a single link or path into a {@link ThreadRef}.
 *
 * @param {string} input  A URL (`https://old.reddit.com/r/…`), a host-relative path (`/r/…/comments/…`) or a short link.
 * @returns {ThreadRef | null}  `null` when the input is not a link to a Reddit thread.
 *
 * @example
 * parseThreadLink('https://old.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/?sort=top');
 * // → { kind: 'thread', id: '1kgwx17', subreddit: 'webdev', slug: 'if_anyone_tried', url: 'https://www.reddit.com/r/webdev/comments/1kgwx17/if_anyone_tried/' }
 */
export function parseThreadLink(input) {
  const url = toUrl(cleanCandidate(input));
  if (!url) return null;

  if (SHORT_HOST.test(url.hostname)) {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && new RegExp(`^${POST_ID}$`).test(id) ? makeThreadRef(id, null, null) : null;
  }
  if (!REDDIT_HOST.test(url.hostname)) return null;

  const thread = THREAD_PATH.exec(url.pathname);
  if (thread) {
    const [, subreddit = null, id, slug = null] = thread;
    return makeThreadRef(id, subreddit, slug || null);
  }

  const share = SHARE_PATH.exec(url.pathname);
  if (share) {
    const [, subreddit, code] = share;
    return {
      kind: 'share',
      id: code,
      subreddit,
      slug: null,
      url: `https://www.reddit.com/r/${subreddit}/s/${code}`,
    };
  }

  return null;
}

/**
 * Scans text (pasted links, a CSV export, a Markdown reading list…) for Reddit thread links.
 * Every column and every line is searched, so the file layout does not matter.
 *
 * @param {string} text
 * @param {Iterable<string>} [knownIds]  IDs already in the queue. Matches count as duplicates.
 * @returns {ExtractResult}
 */
export function extractThreadLinks(text, knownIds = []) {
  const seen = new Set([...knownIds].map((id) => id.toLowerCase()));
  /** @type {ExtractResult} */
  const result = { refs: [], duplicates: 0, notThreads: [] };

  for (const [candidate] of String(text ?? '').matchAll(LINK_CANDIDATE)) {
    const ref = parseThreadLink(candidate);
    if (!ref) {
      result.notThreads.push(cleanCandidate(candidate));
      continue;
    }
    const key = refKey(ref);
    if (seen.has(key)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(key);
    result.refs.push(ref);
  }
  return result;
}

/**
 * The key used to de-duplicate threads. Share links are keyed by their code
 * until they are resolved, after which the real post ID takes over.
 *
 * @param {ThreadRef} ref
 * @returns {string}
 */
export function refKey(ref) {
  return ref.kind === 'share' ? `share:${ref.id.toLowerCase()}` : ref.id.toLowerCase();
}

/**
 * The host-relative JSON endpoint for a thread, as used by reddit.com itself.
 *
 * @param {string} id      Post ID.
 * @param {object} [options]
 * @param {string} [options.sort='confidence']  `confidence` (Best), `top`, `new`, `controversial`, `old` or `qa`.
 * @param {number} [options.limit=500]          Comments per request. 500 is Reddit's ceiling.
 * @returns {string}
 */
export function threadJsonPath(id, { sort = 'confidence', limit = 500 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), sort, raw_json: '1' });
  return `/comments/${encodeURIComponent(id.toLowerCase())}/.json?${params}`;
}

/**
 * The endpoint that returns comments hidden behind "load more replies".
 *
 * @param {string} postId    Post ID (without the `t3_` prefix).
 * @param {string[]} childIds Comment IDs from a `more` stub (max 100 per request).
 * @param {string} [sort='confidence']
 * @returns {string}
 */
export function moreChildrenPath(postId, childIds, sort = 'confidence') {
  const params = new URLSearchParams({
    api_type: 'json',
    link_id: `t3_${postId.toLowerCase()}`,
    children: childIds.join(','),
    sort,
    limit_children: 'false',
    raw_json: '1',
  });
  return `/api/morechildren.json?${params}`;
}

/**
 * Builds a reddit.com URL from a permalink returned by Reddit. Anything that isn't a
 * plain site path (for example `//evil.example` or `@evil.example`) is rejected, so a
 * malformed response can never turn into a link to another site.
 *
 * @param {unknown} permalink  e.g. `/r/webdev/comments/abc123/title/`
 * @returns {string}           The full URL, or an empty string.
 */
export function redditUrl(permalink) {
  return typeof permalink === 'string' && /^\/(?!\/)[^\s\\]*$/.test(permalink) ? `https://www.reddit.com${permalink}` : '';
}

/**
 * Returns `url` only when it is a normal web link (http or https).
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function safeWebUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Turns a title slug into a readable placeholder title.
 *
 * @param {string | null} slug  e.g. `if_anyone_tried_fiver_or_upwork`
 * @returns {string}            e.g. `If anyone tried fiver or upwork`
 */
export function slugToTitle(slug) {
  if (!slug) return '';
  let words = slug;
  try {
    words = decodeURIComponent(slug);
  } catch {
    // Keep the raw slug when it contains a stray `%`.
  }
  words = words.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/**
 * Removes the " : r/sub" and " - Reddit" suffixes Reddit adds to page titles.
 *
 * @param {string} [title]
 * @returns {string}
 */
export function cleanTabTitle(title = '') {
  return title
    .replace(/\s*[-|:]\s*Reddit\s*$/i, '')
    .replace(/\s*[:|-]\s*r\/\w+\s*$/i, '')
    .trim();
}

/* ------------------------------------------------------------------------ */

/**
 * @param {string} id
 * @param {string | null} subreddit
 * @param {string | null} slug
 * @returns {ThreadRef}
 */
function makeThreadRef(id, subreddit, slug) {
  const lowerId = id.toLowerCase();
  const url = subreddit
    ? `https://www.reddit.com/r/${subreddit}/comments/${lowerId}/${slug ? `${slug}/` : ''}`
    : `https://www.reddit.com/comments/${lowerId}/`;
  return { kind: 'thread', id: lowerId, subreddit, slug, url };
}

/** Strips wrapping quotes/brackets and trailing sentence punctuation from a pasted token. */
function cleanCandidate(input) {
  return String(input ?? '')
    .trim()
    .replace(/^[<"'([]+/, '')
    .replace(/[>"')\].,;:!?]+$/, '');
}

/**
 * @param {string} value
 * @returns {URL | null}
 */
function toUrl(value) {
  if (!value) return null;
  try {
    if (value.startsWith('/')) return new URL(value, 'https://www.reddit.com');
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
}
