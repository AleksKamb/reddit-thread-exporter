# Output formats

Every export writes one file per selected format, each containing all exported threads, to `Downloads/Reddit Thread Exporter/`. The default file name is `reddit-threads-<date>-<time>`, and you can set your own under **Options → File name**.

Usernames are left out unless **Include usernames** is on. In that case `author` fields are filled and Markdown shows `u/name`.

## Markdown (`.md`)

Meant for reading, note apps (Obsidian, Notion) and AI tools. Replies are nested lists; multi-line comments stay inside their list item.

```markdown
# Reddit threads

Exported 2026-10-17 with Thread Exporter for Reddit 1.1.0 · 2 threads · 75 comments

## Contents

1. [r/Upwork: Upwork alternatives - other than fiverr or freelancer?](#rupwork-upwork-alternatives---other-than-fiverr-or-freelancer)
2. [r/freelancing: What are some legitimate alternatives to top freelance platforms?](#…)

---

## r/Upwork: Upwork alternatives - other than fiverr or freelancer?

2025-09-20 · 28 points · 48 of 55 comments · [Open on Reddit](https://www.reddit.com/r/Upwork/comments/1nlunhn/…)

The post's text…

### Comments (48)

- 13 points: A top-level comment…
  - **OP** · 4 points: A reply from the person who posted the thread.
  - _1 point · [removed]_
    - 2 points: A reply to a removed comment is kept, so the conversation still makes sense.
```

"48 of 55 comments": Reddit's count includes deleted and removed comments, and comments hidden behind "load more replies". Turn on **Load hidden replies** to fetch those too.

## CSV (`.csv`)

One row for each post and each comment, in the order they appear on Reddit. UTF-8 with a byte-order mark and CRLF line endings, so Excel opens it correctly.

Text cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading `'`, so spreadsheet apps show them as text instead of running them as formulas. Numbers, including negative scores, are left as they are.

| Column | Description |
| --- | --- |
| `type` | `post` or `comment` |
| `thread_id` | Post ID, e.g. `1nlunhn` |
| `subreddit` | Without `r/` |
| `thread_title` | |
| `id` | Post ID for `post` rows, comment ID for `comment` rows |
| `parent_id` | The parent comment's ID, or the post ID for top-level comments |
| `depth` | 0 for top-level comments; empty for posts |
| `author` | Empty unless **Include usernames** is on |
| `is_op` | `true` when the comment was written by the thread's author |
| `score` | |
| `created_at` | ISO 8601, UTC |
| `body` | Reddit Markdown. Removed comments with replies say `[removed]` |
| `url` | Permalink |

## JSON (`.json`)

A clean structure that mirrors the Markdown: threads with nested `replies`.

```jsonc
{
  "exportedAt": "2026-10-17T11:10:25.157Z",
  "exportedWith": "Thread Exporter for Reddit 1.1.0",
  "threadCount": 1,
  "threads": [
    {
      "id": "1nlunhn",
      "subreddit": "Upwork",
      "title": "Upwork alternatives - other than fiverr or freelancer?",
      "author": null,                // filled when "Include usernames" is on
      "score": 28,
      "upvoteRatio": 0.87,
      "flair": null,
      "createdAt": "2025-09-20T10:27:12.000Z",
      "url": "https://www.reddit.com/r/Upwork/comments/1nlunhn/…/",
      "linkUrl": null,               // the linked page, for link posts
      "body": "The post's text…",
      "commentCounts": {
        "reported": 55,              // Reddit's own count
        "exported": 48,              // comments in this file
        "hidden": 3                  // still behind "load more replies"
      },
      "comments": [
        {
          "id": "nf4…",
          "parentId": null,          // null for top-level comments
          "depth": 0,
          "author": null,
          "isSubmitter": false,      // written by the thread's author
          "score": 13,
          "createdAt": "2025-09-20T11:02:40.000Z",
          "edited": false,
          "isRemoved": false,        // true: deleted/removed, kept because it has replies
          "body": "A top-level comment…",
          "url": "https://www.reddit.com/r/Upwork/comments/1nlunhn/…/nf4…/",
          "replies": [ /* same shape */ ]
        }
      ]
    }
  ]
}
```

## Raw Reddit JSON (`.raw.json`)

An array with Reddit's original response for each thread (`[postListing, commentListing]`), exactly as the API returned it. Useful if you need fields the clean JSON leaves out. Comments loaded with **Load hidden replies** are not part of this file; they only appear in the other formats.
