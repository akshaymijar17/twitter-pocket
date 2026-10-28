// Shared data shapes. Timestamps are ISO-8601 strings in JS; the Firestore
// codec turns the fields listed in TIMESTAMP_FIELDS into timestampValue.

/** A post as parsed from X's GraphQL responses (or the DOM fallback). */
export interface ParsedPost {
  id: string;
  author_id: string | null;
  author_name: string | null;
  author_handle: string | null;
  text: string;
  created_at: string | null;
  conversation_id: string | null;
  in_reply_to_status_id: string | null;
  in_reply_to_user_id: string | null;
  media: string[];
  quoted: QuotedPost | null;
  unavailable: boolean;
  /** legacy.self_thread.id_str — X sets this on posts that belong to a self-thread. */
  self_thread_id: string | null;
  /** True when the text came from note_tweet (long post). */
  long: boolean;
  /** True when built from the visible page instead of a captured response. */
  from_dom?: boolean;
}

export interface QuotedPost {
  id: string;
  author_handle: string | null;
  text: string;
  url: string;
  unavailable?: boolean;
}

/** A top-level timeline entry in the order X returned it (bookmarks order). */
export interface TimelineEntry {
  entryId: string;
  postId: string;
  sortIndex: string | null;
}

export interface ParseResult {
  operation: string;
  /** Every post found anywhere in the response (module items included). */
  posts: ParsedPost[];
  /** Top-level post entries, in order. For Bookmarks this is the bookmark list. */
  entries: TimelineEntry[];
  /** True when the response had a bottom cursor but no post entries (end of list). */
  empty: boolean;
}

/** A post as stored inside an item document. */
export interface StoredPost {
  id: string;
  text: string;
  created_at: string | null;
  media: string[];
  quoted: QuotedPost | null;
  unavailable: boolean;
}

export type ItemType = 'post' | 'thread';
export type ItemStatus = 'unread' | 'read' | 'archived';

/** Fields the extension owns and may rewrite on upgrade. */
export interface ExtItem {
  id: string;
  type: ItemType;
  thread_complete: boolean;
  author_name: string;
  author_handle: string;
  author_id: string | null;
  url: string;
  created_at: string | null;
  conversation_id: string | null;
  bookmarked_post_id: string;
  bookmarked_at: string | null;
  bookmark_sort_index: string | null;
  post_count: number;
  posts: StoredPost[];
  /** Every post id in the item plus the item id; used to find an item from any of its posts. */
  match_ids: string[];
  preview: string;
  search_text: string;
  search_tokens: string[];
  source: 'x';
  capture_method: 'graphql' | 'dom';
}

/** Full document as it lives in Firestore. */
export interface ItemDoc extends ExtItem {
  saved_at?: string | null;
  created_in_db_at?: string | null;
  status?: ItemStatus;
  favorite?: boolean;
  tags?: string[];
}

/** Fields the extension never overwrites once the document exists. */
export const PRESERVED_FIELDS = ['bookmarked_at', 'status', 'favorite', 'tags', 'created_in_db_at'] as const;

/** Fields written with every extension update (excluding server-timestamp transforms). */
export const EXT_CONTENT_FIELDS: (keyof ExtItem)[] = [
  'type',
  'thread_complete',
  'author_name',
  'author_handle',
  'author_id',
  'url',
  'created_at',
  'conversation_id',
  'bookmarked_post_id',
  'bookmark_sort_index',
  'post_count',
  'posts',
  'match_ids',
  'preview',
  'search_text',
  'search_tokens',
  'source',
  'capture_method',
];

export const TIMESTAMP_FIELDS = new Set(['created_at', 'bookmarked_at', 'saved_at', 'created_in_db_at']);
