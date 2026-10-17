/**
 * Reddit search, used by the `find_threads` agent tool.
 *
 * Builds the same `search.json` request reddit.com's own search page makes, and turns
 * the response into a short list of threads. Pure functions, covered by unit tests.
 *
 * @module reddit-search
 */

import { redditUrl } from './reddit-links.js';

/**
 * @typedef {object} SearchOptions
 * @property {string} query
 * @property {string} [subreddit]  Search only this subreddit (without `r/`).
 * @property {'relevance' | 'top' | 'new' | 'comments'} [sort='relevance']
 * @property {'all' | 'year' | 'month' | 'week' | 'day'} [time='all']
 * @property {number} [limit=10]   1 to 25.
 */

/**
 * @typedef {object} SearchResult
 * @property {string} id
 * @property {string} title
 * @property {string} subreddit
 * @property {string} url
 * @property {number} score
 * @property {number} comments
 * @property {string} createdAt  ISO 8601.
 * @property {string} snippet    Start of the post's text, on one line.
 */

export const SEARCH_SORTS = /** @type {const} */ (['relevance', 'top', 'new', 'comments']);
export const SEARCH_TIMES = /** @type {const} */ (['all', 'year', 'month', 'week', 'day']);
export const MAX_SEARCH_RESULTS = 25;
const MAX_QUERY_LENGTH = 300;
const SNIPPET_LENGTH = 280;

/**
 * Checks and normalises search options coming from an agent.
 *
 * @param {Partial<SearchOptions>} options
 * @returns {Required<SearchOptions>}
 * @throws {TypeError} With a message that can be shown to the agent.
 */
export function validateSearchOptions(options) {
  const query = typeof options?.query === 'string' ? options.query.trim() : '';
  if (!query) throw new TypeError('Give a search query.');
  if (query.length > MAX_QUERY_LENGTH) throw new TypeError(`Keep the query under ${MAX_QUERY_LENGTH} characters.`);

  const subreddit = typeof options.subreddit === 'string' ? options.subreddit.trim().replace(/^\/?r\//i, '') : '';
  if (subreddit && !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) throw new TypeError(`"${subreddit}" isn't a valid subreddit name.`);

  const sort = SEARCH_SORTS.includes(/** @type {any} */ (options.sort)) ? options.sort : 'relevance';
  const time = SEARCH_TIMES.includes(/** @type {any} */ (options.time)) ? options.time : 'all';
  const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.round(Number(options.limit) || 10)));
  return { query, subreddit, sort, time, limit };
}

/**
 * The host-relative search endpoint.
 *
 * @param {Required<SearchOptions>} options  Already validated.
 * @returns {string}
 */
export function searchPath({ query, subreddit, sort, time, limit }) {
  const params = new URLSearchParams({ q: query, sort, t: time, limit: String(limit), type: 'link', raw_json: '1' });
  if (subreddit) params.set('restrict_sr', '1');
  const base = subreddit ? `/r/${encodeURIComponent(subreddit)}/search.json` : '/search.json';
  return `${base}?${params}`;
}

/**
 * Turns a search response (a Listing of posts) into results.
 *
 * @param {unknown} json
 * @returns {SearchResult[]}
 * @throws {TypeError} When the response isn't a listing.
 */
export function parseSearchResults(json) {
  const children = /** @type {any} */ (json)?.data?.children;
  if (!Array.isArray(children)) throw new TypeError('Reddit answered, but not with search results.');

  return children
    .filter((child) => child?.kind === 't3' && child.data)
    .map(({ data }) => ({
      id: data.id,
      title: data.title ?? '',
      subreddit: data.subreddit ?? '',
      url: redditUrl(data.permalink),
      score: data.score ?? 0,
      comments: data.num_comments ?? 0,
      createdAt: typeof data.created_utc === 'number' ? new Date(data.created_utc * 1000).toISOString() : '',
      snippet: toSnippet(data.selftext),
    }))
    .filter((result) => result.url);
}

/** @param {unknown} text */
function toSnippet(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : flat;
}
