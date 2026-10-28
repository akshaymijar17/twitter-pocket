// Google sign-in for Brave: chrome.identity.getAuthToken needs a browser-level
// Google account, which Brave lacks, so we run the OAuth flow ourselves with
// launchWebAuthFlow, then trade the Google ID token for a Firebase session
// through the Identity Toolkit REST API.

export interface Session {
  uid: string;
  email: string | null;
  idToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
}

export interface AuthConfig {
  apiKey: string;
  oauthClientId: string;
  allowedEmail?: string;
}

export interface SessionStore {
  load(): Promise<Session | null>;
  save(s: Session | null): Promise<void>;
}

export const chromeSessionStore: SessionStore = {
  async load() {
    const { session } = await chrome.storage.local.get('session');
    return (session as Session) ?? null;
  },
  async save(s) {
    if (s) await chrome.storage.local.set({ session: s });
    else await chrome.storage.local.remove('session');
  },
};

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class AuthError extends Error {}

export class Auth {
  private refreshing: Promise<Session | null> | null = null;

  constructor(
    private cfg: AuthConfig,
    private store: SessionStore = chromeSessionStore,
    private fetchFn: typeof fetch = (...a) => fetch(...a),
    private now: () => number = Date.now,
  ) {}

  /** Opens Google's consent screen and returns the Google ID token. */
  async googleIdToken(interactive = true): Promise<{ idToken: string; redirectUri: string }> {
    const redirectUri = chrome.identity.getRedirectURL();
    const nonce = crypto.randomUUID();
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.cfg.oauthClientId);
    url.searchParams.set('response_type', 'id_token');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('prompt', 'select_account');
    const result = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive });
    if (!result) throw new AuthError('sign-in was cancelled');
    const params = new URLSearchParams(new URL(result).hash.slice(1));
    const idToken = params.get('id_token');
    if (!idToken) throw new AuthError(params.get('error') ?? 'no id_token in the OAuth response');
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.nonce !== nonce) throw new AuthError('OAuth nonce mismatch');
    return { idToken, redirectUri };
  }

  /** Exchanges a Google ID token for a Firebase session. */
  async exchange(googleIdToken: string, requestUri: string): Promise<Session> {
    const res = await this.fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${this.cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
        requestUri,
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new AuthError(`Firebase sign-in failed: ${j?.error?.message ?? res.status}`);
    if (this.cfg.allowedEmail && j.email?.toLowerCase() !== this.cfg.allowedEmail.toLowerCase()) {
      throw new AuthError(`${j.email} is not the allowed account`);
    }
    const s: Session = {
      uid: j.localId,
      email: j.email ?? null,
      idToken: j.idToken,
      refreshToken: j.refreshToken,
      expiresAt: this.now() + Number(j.expiresIn ?? 3600) * 1000,
    };
    await this.store.save(s);
    return s;
  }

  async signIn(): Promise<Session> {
    const { idToken, redirectUri } = await this.googleIdToken(true);
    return this.exchange(idToken, redirectUri);
  }

  async signOut(): Promise<void> {
    await this.store.save(null);
  }

  async session(): Promise<Session | null> {
    return this.store.load();
  }

  /** A valid Firebase ID token, refreshed when it is within 5 minutes of expiry. Null when signed out. */
  async idToken(): Promise<string | null> {
    const s = await this.store.load();
    if (!s) return null;
    if (s.expiresAt - REFRESH_MARGIN_MS > this.now()) return s.idToken;
    const fresh = await this.refresh();
    return fresh?.idToken ?? null;
  }

  async refresh(): Promise<Session | null> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<Session | null> {
    const s = await this.store.load();
    if (!s) return null;
    const res = await this.fetchFn(`https://securetoken.googleapis.com/v1/token?key=${this.cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A revoked or expired refresh token means signed out; network trouble does not.
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        await this.store.save(null);
        return null;
      }
      throw new AuthError(`token refresh failed: ${res.status}`);
    }
    const next: Session = {
      ...s,
      uid: j.user_id ?? s.uid,
      idToken: j.id_token,
      refreshToken: j.refresh_token ?? s.refreshToken,
      expiresAt: this.now() + Number(j.expires_in ?? 3600) * 1000,
    };
    await this.store.save(next);
    return next;
  }
}
