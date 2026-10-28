// Minimal Firestore REST client. Short-lived HTTP calls suit an MV3 service
// worker, which can be stopped at any time.

import { TIMESTAMP_FIELDS } from '../shared/types';

type FsValue = Record<string, any>;

export function encodeValue(v: unknown, key = ''): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return TIMESTAMP_FIELDS.has(key) ? { timestampValue: v } : { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => encodeValue(x)) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  throw new Error(`cannot encode ${typeof v}`);
}

export function encodeFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = encodeValue(v, k);
  return out;
}

export function decodeValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue).toISOString();
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}

export function decodeFields(fields: Record<string, FsValue>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

export interface RemoteDoc {
  id: string;
  name: string;
  updateTime: string;
  data: Record<string, any>;
}

export class FirestoreError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type WriteOp =
  | {
      kind: 'create';
      id: string;
      data: Record<string, unknown>;
      serverTimestamps: string[];
    }
  | {
      kind: 'update';
      id: string;
      data: Record<string, unknown>;
      fields: string[];
      updateTime: string;
      serverTimestamps: string[];
    };

export interface WriteStatus {
  ok: boolean;
  /** gRPC code: 0 ok, 5 not found, 6 already exists, 9 failed precondition, 7 permission denied. */
  code: number;
  message?: string;
}

export class FirestoreClient {
  constructor(
    private projectId: string,
    private getToken: () => Promise<string | null>,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  get root(): string {
    return `projects/${this.projectId}/databases/(default)/documents`;
  }

  collectionPath(uid: string): string {
    return `${this.root}/users/${uid}/x_items`;
  }

  private async call(method: string, path: string, body?: unknown, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) {
      const token = await this.getToken();
      if (!token) throw new FirestoreError(401, 'UNAUTHENTICATED', 'signed out');
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await this.fetchFn(`https://firestore.googleapis.com/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = Array.isArray(json) ? json[0]?.error : json.error;
      throw new FirestoreError(res.status, err?.status ?? String(res.status), err?.message ?? res.statusText);
    }
    return json;
  }

  async getDoc(uid: string, id: string, auth = true): Promise<RemoteDoc | null> {
    try {
      const d = await this.call('GET', `${this.collectionPath(uid)}/${encodeURIComponent(id)}`, undefined, auth);
      return toRemote(d);
    } catch (e) {
      if (e instanceof FirestoreError && e.status === 404) return null;
      throw e;
    }
  }

  /** Items whose match_ids contain any of `ids` (at most 30 per query). */
  async findByMatchIds(uid: string, ids: string[]): Promise<RemoteDoc[]> {
    const unique = [...new Set(ids)];
    const out = new Map<string, RemoteDoc>();
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const res = await this.call('POST', `${this.root}/users/${uid}:runQuery`, {
        structuredQuery: {
          from: [{ collectionId: 'x_items' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'match_ids' },
              op: 'ARRAY_CONTAINS_ANY',
              value: { arrayValue: { values: chunk.map((s) => ({ stringValue: s })) } },
            },
          },
          limit: 20,
        },
      });
      for (const r of res as any[]) if (r.document) out.set(r.document.name, toRemote(r.document));
    }
    return [...out.values()];
  }

  /** Non-atomic batch: each write succeeds or fails on its own. */
  async batchWrite(uid: string, ops: WriteOp[]): Promise<WriteStatus[]> {
    if (ops.length === 0) return [];
    const writes = ops.map((op) => {
      const name = `${this.collectionPath(uid)}/${op.id}`;
      const w: any = {
        update: { name, fields: encodeFields(op.data) },
        updateTransforms: op.serverTimestamps.map((fieldPath) => ({ fieldPath, setToServerValue: 'REQUEST_TIME' })),
      };
      if (op.kind === 'create') {
        w.currentDocument = { exists: false };
      } else {
        w.updateMask = { fieldPaths: op.fields };
        w.currentDocument = { updateTime: op.updateTime };
      }
      return w;
    });
    const res = await this.call('POST', `${this.root}:batchWrite`, { writes });
    return (res.status ?? []).map((s: any) => ({ ok: !s.code, code: s.code ?? 0, message: s.message }));
  }

  /** Unconditional overwrite; diagnostics only. */
  async setRaw(uid: string, id: string, data: Record<string, unknown>): Promise<void> {
    await this.call('PATCH', `${this.collectionPath(uid)}/${encodeURIComponent(id)}`, { fields: encodeFields(data) });
  }

  async deleteDoc(uid: string, id: string): Promise<void> {
    await this.call('DELETE', `${this.collectionPath(uid)}/${encodeURIComponent(id)}`);
  }

  /** Raw request for the spike/diagnostics page. */
  async rawGet(path: string, token: string | null): Promise<number> {
    const res = await this.fetchFn(`https://firestore.googleapis.com/v1/${this.root}/${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.status;
  }
}

function toRemote(d: any): RemoteDoc {
  const name: string = d.name;
  return { id: decodeURIComponent(name.slice(name.lastIndexOf('/') + 1)), name, updateTime: d.updateTime, data: decodeFields(d.fields ?? {}) };
}
