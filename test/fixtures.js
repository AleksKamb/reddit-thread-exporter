/**
 * Small, made-up Reddit responses in the same shape as the real API.
 * No real users or posts are used in the tests.
 */

let clock = 1_760_000_000;

/** A `t1` comment thing. */
export function comment(id, body, { score = 1, author = 'user_' + id, replies = [], parent = 't3_post1', depth = 0, isSubmitter = false } = {}) {
  return {
    kind: 't1',
    data: {
      id,
      body,
      score,
      author,
      depth,
      parent_id: parent,
      is_submitter: isSubmitter,
      created_utc: (clock += 60),
      edited: false,
      permalink: `/r/testing/comments/post1/a_test_thread/${id}/`,
      replies: replies.length ? { kind: 'Listing', data: { children: replies } } : '',
    },
  };
}

/** A "load more replies" stub. */
export function more(children, count = children.length) {
  return { kind: 'more', data: { count, children } };
}

/** A whole thread response: `[postListing, commentListing]`. */
export function thread(comments = [], post = {}) {
  return [
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'post1',
              subreddit: 'testing',
              title: 'A test thread',
              author: 'op_user',
              score: 42,
              upvote_ratio: 0.97,
              num_comments: 5,
              created_utc: 1_760_000_000,
              permalink: '/r/testing/comments/post1/a_test_thread/',
              is_self: true,
              url: 'https://www.reddit.com/r/testing/comments/post1/a_test_thread/',
              selftext: 'What do you think?\n\nSecond paragraph.',
              link_flair_text: 'Discussion',
              ...post,
            },
          },
        ],
      },
    },
    { kind: 'Listing', data: { children: comments } },
  ];
}

/** A typical thread: two top-level comments, one with a reply, one removed comment with a reply, one stub. */
export function sampleThread() {
  return thread([
    comment('c1', 'First comment', {
      score: 10,
      replies: [comment('c2', 'A reply\nwith two lines', { score: 3, parent: 't1_c1', depth: 1, author: 'op_user', isSubmitter: true })],
    }),
    comment('c3', '[deleted]', {
      author: '[deleted]',
      replies: [comment('c4', 'Reply to a removed comment', { parent: 't1_c3', depth: 1 })],
    }),
    comment('c5', '[removed]', { author: '[deleted]' }),
    more(['c6', 'c7'], 2),
  ]);
}
