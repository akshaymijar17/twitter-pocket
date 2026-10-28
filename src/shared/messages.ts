// Message shapes between the content script, popup, options page and service worker.

import type { ExtItem } from './types';

export const HOOK_TAG = '__x_bookmarks_saver__';

/** Posted by the MAIN-world hook to the isolated content script. */
export interface HookMessage {
  source: typeof HOOK_TAG;
  op: string;
  url: string;
  json: unknown;
}

export type ToBackground =
  | { type: 'bookmarks'; items: ExtItem[]; fallback: boolean }
  | { type: 'saveThread'; item: ExtItem; fallback: boolean }
  | { type: 'captured'; op: string; posts: number; json?: unknown }
  | { type: 'getStatus' }
  | { type: 'signIn' }
  | { type: 'signOut' }
  | { type: 'syncNow' }
  | { type: 'spike' };

export interface BookmarksReply {
  /** Per item, in order: was the bookmarked post already saved before this capture? */
  known: boolean[];
}

export interface SaveThreadReply {
  ok: boolean;
  error?: string;
  postCount?: number;
  threadComplete?: boolean;
  existed?: boolean;
  signedIn?: boolean;
}

export interface StatusReply {
  signedIn: boolean;
  email: string | null;
  total: number;
  incomplete: number;
  pending: number;
  lastSyncAt: string | null;
  lastError: string | null;
  needsThreadSave: { id: string; url: string; author_handle: string; preview: string }[];
  viewerUrl: string;
}

/** Popup / service worker → content script. */
export type ToContent = { type: 'getPageState' } | { type: 'startSync' } | { type: 'stopSync' } | { type: 'saveThread' };

export interface PageState {
  page: 'bookmarks' | 'post' | 'other';
  captures: number;
  cached: number;
  sync: SyncState;
}

export interface SyncState {
  running: boolean;
  scrolls: number;
  saved: number;
  knownRun: number;
  stoppedReason: string | null;
}

export interface Settings {
  debug: boolean;
  viewerUrl: string;
}

export const STOP_AFTER_KNOWN = 10;
