# X Bookmarks Saver

A Brave (Chromium, Manifest V3) extension that saves your X bookmarks into your own Firestore, including the full text of long posts and complete same-author threads. A separate, Pocket-style web viewer reads, searches and exports them. It does not use the X API: the extension reads the responses X's own web app already loads.

```
x.com tab                                          service worker                    Firestore
┌───────────────────────────────┐                  ┌──────────────────────┐          users/{uid}/x_items/{itemId}
│ hook.js (MAIN world)          │ postMessage      │ IndexedDB (items +   │  REST    ┌───────────────────┐
│  wraps fetch/XHR, copies      │ ───────────────▶ │  queue), merge rules │ ───────▶ │ one doc per post  │
│  Bookmarks / TweetDetail JSON │  content.js:     │  auth + token refresh│ retries  │ or thread         │
└───────────────────────────────┘  parse, per-tab  └──────────────────────┘          └───────────────────┘
                                    post cache, Flow 1/2, toast                               ▲
                                                                    viewer/ (Firebase Hosting)┘
```

- **Flow 1, bookmarks page (`x.com/i/bookmarks`).** Every bookmark X loads is saved as you scroll. **Sync bookmarks** in the popup auto-scrolls at a human pace (1.5–3 s per scroll, randomized). It stops after 10 bookmarks in a row that were already saved, or at the end of the list. Posts that look like part of a thread are saved with `thread_complete: false` and listed under **Needs thread save**.
- **Flow 2, post page (`x.com/<handle>/status/<id>`).** Expand the thread yourself, then save it from the popup button, with **Alt+Shift+S**, or with the **Save thread** button on the page. The extension saves the focal post plus the same-author chain above and below it, from everything loaded on the page, in reply-chain order. Replies from other people are left out. If the item already exists, it is upgraded in place.

## Status of the build milestones

| # | Milestone | Status |
|---|---|---|
| 0 | Spike | **Needs you, in Brave.** It can't run in CI because it needs your Google account, your Firebase project and a logged-in X session. Use **Options → Spike / diagnostics → Run checks** (details below). |
| 1 | Parser + unit tests | Done. The fixtures are synthetic and follow X's late-2026 response shapes. Replace them with real captures (see [Fixtures](#fixtures)). |
| 2 | Storage layer | Done. Tested against fake-indexeddb and an in-memory Firestore that enforces the same preconditions as the real one. |
| 3–5 | Flow 2, Flow 1, popup | Done. Covered by `npm run e2e`: the built extension in Chromium against a fake x.com served from the fixtures. |
| 6 | Viewer + markdown export | Done. Covered by `scripts/viewer-e2e.mjs`, which uses in-memory Firebase fakes. |
| 7 | README | This file. |

### Running the spike (milestone 0)

After setup step 6, open the extension's **Options** page:

1. **(a) Auth.** **Run checks** opens Google sign-in through `launchWebAuthFlow`, then exchanges the Google ID token for a Firebase ID token.
2. **(b) Firestore and rules.** It writes and reads `users/{uid}/x_items/test` over REST. It then checks that an unauthenticated read and a read of another uid's path are both rejected (HTTP 401/403), and deletes the test doc.
3. **(c) Capture.** Open `x.com/i/bookmarks` and any post in other tabs. The **Captured responses** table should show `Bookmarks` and `TweetDetail` counts going up.

If any row says FAIL, stop there and fix it (see [Troubleshooting](#troubleshooting)) before relying on the extension.

## Setup

You need Node 20+ and the Firebase CLI (`npm i -g firebase-tools`).

```bash
npm install
```

### 1. Firebase project

Create a new Firebase project. It is separate from the Pocket clone, and the free Spark plan is enough.

- **Firestore Database → Create database → production mode.** Never use test mode, not even briefly. The Firebase config shipped in the extension is not a secret, and the rules are the only protection.
- **Authentication → Sign-in method → Google → Enable.**
- **Project settings → General → Your apps → Add app → Web.** Copy `apiKey`, `authDomain`, `projectId` and `appId`.

### 2. Pin the extension ID

The OAuth redirect URI contains the extension ID, so the ID must not change between reloads:

```bash
npm run make-key
```

This prints a public key, the resulting extension ID, and the redirect URI `https://<extension-id>.chromiumapp.org/`. The key goes into the manifest's `key` field, and a fixed key means a fixed ID. It is a public key, so it is not secret, and the private half is not needed for an unpacked extension.

### 3. Google OAuth client

In the Google Cloud console for the **same** project (Firebase projects are Google Cloud projects), go to **APIs & Services → Credentials**:

- Open the OAuth client named **"Web client (auto created by Google Service)"**. It is already trusted by Firebase Auth. Under **Authorized redirect URIs**, add `https://<extension-id>.chromiumapp.org/` and save.
- If you would rather create a new OAuth client ID of type **Web application**, also add its client ID under Firebase **Authentication → Sign-in method → Google → Allowlist client IDs from external projects**. Otherwise Firebase rejects the token with `INVALID_IDP_RESPONSE`.
- If the OAuth consent screen is in *Testing* mode, add your Google account as a test user.

Why not `chrome.identity.getAuthToken`? It needs a Google account signed into the browser itself, which Brave doesn't support. `launchWebAuthFlow` works in Brave.

### 4. Config files

```bash
cp src/config.example.ts src/config.ts      # extension (gitignored)
cp viewer/config.example.js viewer/config.js  # viewer (gitignored)
```

In `src/config.ts`, set `firebase.apiKey`, `firebase.projectId`, `oauthClientId`, `manifestKey` (from step 2), and optionally `allowedEmail` and `viewerUrl`. In `viewer/config.js`, set the web app config from step 1.

### 5. Deploy the security rules (before the first write)

```bash
firebase login
firebase use --add            # pick the new project
npm run deploy:rules          # firestore.rules + firestore.indexes.json
```

The rules give each signed-in user read/write access to `users/{their uid}/**` and deny everything else. To also lock the database to your account, edit `firestore.rules`: the commented-out lines add `request.auth.token.email == "you@gmail.com"`. `firestore.indexes.json` turns off indexing for the large fields (`posts`, `search_text`, `preview`), which keeps writes cheap.

### 6. Build and load in Brave

```bash
npm run build                 # → dist/
```

1. Open `brave://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `dist/`.
2. Check that the ID shown matches the one from step 2. **Options** also shows the ID and the redirect URI.
3. Click the toolbar icon, then **Sign in**.
4. Reload any x.com tabs that were open before you installed the extension.

For development, use `npm run watch` and click reload on the extension card.

### Viewer

```bash
npm run deploy:viewer         # bundles viewer/ → viewer/public, deploys to Firebase Hosting
```

Open `https://<project>.web.app`. `*.web.app` and `*.firebaseapp.com` are authorized for sign-in by default. Put that URL in the extension's options (or in `viewerUrl`) so **Open viewer** works. To run the viewer locally, use `npm run build:viewer && firebase serve --only hosting`.

The viewer offers:

- **List and filters.** A list sorted by date bookmarked or date posted, with filters for status (unread / read / archive / all), type, author, favorites, and incomplete threads.
- **Search.** All words are substring-matched over a locally cached copy (Firestore's persistent cache), so a word from the middle of any post in a thread finds the item. A single word is also run as an `array-contains` query on `search_tokens`.
- **Reading view.** Numbered posts, the bookmarked post marked, quoted posts inline, media links, and a link back to X.
- **Actions.** Read, archive, favorite, and edit tags. These are the only fields the viewer writes.
- **Export.** One item as `.md`, or **export all** as a zip of markdown files, which is your backup.

## Permissions

| Permission | Why |
|---|---|
| `https://x.com/*`, `https://twitter.com/*` | Run the capture hook and content script on X, and let the popup talk to the X tab. |
| `https://firestore.googleapis.com/*` | Write and read your items over the Firestore REST API. |
| `https://identitytoolkit.googleapis.com/*` | Exchange the Google ID token for a Firebase session (`accounts:signInWithIdp`). |
| `https://securetoken.googleapis.com/*` | Refresh the Firebase ID token, which expires hourly. |
| `identity` | `chrome.identity.launchWebAuthFlow` for Google sign-in. |
| `storage` | Keeps the Firebase refresh token, settings, and capture counters. The saves themselves live in IndexedDB. |
| `downloads` | Only for the debug setting, which saves raw X responses to `Downloads/x-bookmarks-debug/`. |
| `alarms` | Retries queued saves every minute. MV3 service workers sleep and get no reliable "back online" event. |

`scripting` and `activeTab` are not needed: content scripts are declared in the manifest, and the host permissions cover X.

## How saving works

- **Capture.** `hook.js` runs in the page's own context at `document_start` and wraps `fetch` and `XMLHttpRequest`. It copies responses whose GraphQL operation is `Bookmarks`, `BookmarkSearchTimeline`, `BookmarkFolderTimeline`, `TweetDetail`, `TweetResultByRestId`, or anything else with "Bookmark" in its name, and posts them to the content script. The content script parses them and keeps a per-tab map of every post seen in this page session. That map is how Flow 2 assembles a thread across several "Show more" requests.
- **Fallback.** If nothing was captured (e.g. the page loaded before the hook), the extension reads `article[data-testid="tweet"]` from the page instead. The toast says so, because long posts may be cut off.
- **Parser.** `src/shared/parser.ts` holds every assumption about X's response shapes:
  - It walks `instructions[] → entries[]`, conversation modules (`items[]`) and `TimelineAddToModule`, plus a deep scan for any `tweet_results` as a safety net.
  - It unwraps `TweetWithVisibilityResults`, and records `TweetTombstone` and unavailable posts as `[unavailable]`.
  - It prefers `note_tweet` text, expands t.co links, strips media links and the quote permalink, and decodes HTML entities.
  - It reads the author from `.legacy` or `.core`, and picks the highest-bitrate mp4 for video.
- **Local first.** Every save goes into IndexedDB (`items` plus a `queue`) before anything else, so saves made offline or signed out are never lost. The queue is pushed to Firestore with exponential backoff (5 s doubling to 30 min, with jitter), and is retried after sign-in and every minute.
- **Merge on upgrade.** Before writing, the worker finds the existing doc by `match_ids` (all post ids in the item) using `array-contains-any`, merges, and writes:
  - only the changed extension-owned fields, through an update mask;
  - with an `updateTime` precondition, so a concurrent edit from the viewer is never overwritten (it re-reads and retries instead).

  `bookmarked_at`, `status`, `favorite`, `tags` and `created_in_db_at` are never in the mask once the doc exists. `bookmarked_at` is filled only while it is still null. New docs are created with `exists: false`, server timestamps for `saved_at` and `created_in_db_at`, and the viewer defaults `status: "unread"`, `favorite: false`, `tags: []`. Items over 900 KB log a warning.
- **Item id.** For a thread, the item id is the thread root's id; otherwise it is the post's own id. A bookmarked self-reply gets its `conversation_id` (the thread root) as its id. When a later full save finds a doc under a different id, it upgrades that doc in place, because ids never change. `bookmarked_post_id` records which post you bookmarked.

## Data model

`users/{uid}/x_items/{itemId}` uses the fields from the spec (`id`, `type`, `thread_complete`, `author_name`, `author_handle`, `url`, `created_at`, `bookmarked_post_id`, `bookmarked_at`, `saved_at`, `created_in_db_at`, `post_count`, `posts[]`, `preview`, `search_text`, `search_tokens`, `source`, `status`, `favorite`, `tags`). A few extras support the merge and the viewer:

| Field | Purpose |
|---|---|
| `match_ids` | Item id plus every post id. Used to find an item from any of its posts. |
| `bookmark_sort_index` | X's `sortIndex` for the bookmark entry. It is time-ordered, so the viewer sorts "date bookmarked" correctly even for a first sync that sees hundreds of bookmarks at once. |
| `author_id`, `conversation_id` | Raw ids, useful for re-assembly. |
| `capture_method` | `"graphql"`, or `"dom"` if the fallback was used, so you know to re-save. |

The Pocket clone stores `links/{id}` with `savedAt`, `folder`, `isRead` and `tags`. This project is separate, with its own Firebase project and viewer, and only `tags` has the same meaning.

## Testing

```bash
npm test                      # unit tests: parser, thread assembly, merge, queue, REST client, auth refresh, markdown
npm run typecheck
npm run e2e                   # builds, loads dist/ in Chromium against a fake x.com (needs Playwright)
node scripts/viewer-e2e.mjs   # viewer UI with Firebase replaced by in-memory fakes (needs Playwright)
```

### Fixtures

`tests/fixtures/*.json` come from `tests/fixtures/generate.mjs`. They are synthetic, follow X's response shapes, and cover:

- a normal post, a long (`note_tweet`) post and a quote post;
- a self-reply wrapped in `TweetWithVisibilityResults`;
- a tombstone;
- a self-thread with ancestors, descendants, another person's reply, and the author's answer to it;
- a "Show more" `TimelineAddToModule`;
- a deleted post in the middle of a thread.

To test against reality, turn on **Options → Debug**, browse your bookmarks and a few threads, and copy files from `Downloads/x-bookmarks-debug/` into `tests/fixtures/`. Add a test for anything new. When X changes a shape, the fix belongs in `src/shared/parser.ts` only.

## Troubleshooting

| Problem | What to do |
|---|---|
| `redirect_uri_mismatch` | The redirect URI on the OAuth client must match **Options → OAuth setup values** exactly, trailing slash included. |
| `INVALID_IDP_RESPONSE` / `invalid audience` | The OAuth client isn't trusted by Firebase. Use the auto-created web client, or add yours to the Google provider's allowlist (step 3). |
| Spike shows unauthenticated read as 200 | Your rules are open. Deploy `firestore.rules` now. |
| Nothing captured on X | Reload the X tab after installing or reloading the extension. If the hook loaded too late, the fallback reads the page and the toast tells you. |
| Queue never drains | The popup shows the last sync error. **Sync now** retries immediately. |

## Out of scope (v1)

- Downloading media into Firebase Storage (only links are saved).
- Auto-expanding threads.
- AI summaries or tagging.
