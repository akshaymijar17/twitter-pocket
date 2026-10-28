// In-memory stand-ins for the Firebase modules the viewer imports, used only by
// scripts/viewer-e2e.mjs to exercise the UI without a Firebase project.
const docs = new Map(Object.entries(window.__FAKE_DOCS__ || {}));
window.__writes__ = [];
const listeners = new Set();
const snap = () => ({
  metadata: { fromCache: false },
  docChanges: () => [...docs].map(([id, data]) => ({ type: 'added', doc: { id, data: () => data } })),
});

export const initializeApp = (cfg) => ({ cfg });
export const getAuth = () => ({});
export class GoogleAuthProvider {}
export const onAuthStateChanged = (_a, cb) => setTimeout(() => cb({ uid: 'u1', email: 'me@example.com' }));
export const signInWithPopup = async () => {};
export const signOut = async () => {};

export const initializeFirestore = () => ({});
export const persistentLocalCache = () => ({});
export const persistentMultipleTabManager = () => ({});
export const collection = (...path) => ({ path });
export const doc = (_db, ...path) => ({ id: path.at(-1) });
export const where = (field, op, value) => ({ field, op, value });
export const query = (col, w) => ({ col, w });
export const onSnapshot = (_q, next) => {
  listeners.add(next);
  setTimeout(() => next(snap()));
  return () => listeners.delete(next);
};
export const getDocs = async (q) => {
  window.__serverQueries__ = (window.__serverQueries__ || 0) + 1;
  const hits = [...docs].filter(([, d]) => (d[q.w.field] || []).includes(q.w.value));
  return { docs: hits.map(([id, d]) => ({ id, data: () => d })) };
};
export const updateDoc = async (ref, fields) => {
  window.__writes__.push({ id: ref.id, fields });
  Object.assign(docs.get(ref.id), fields);
};
