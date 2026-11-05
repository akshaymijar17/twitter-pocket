// Copy to src/config.ts (gitignored) and fill in. None of these values are
// secrets — Firestore security rules are what protect your data.
export const CONFIG = {
  firebase: {
    // Firebase console → Project settings → General → Your apps → Web app config
    apiKey: '',
    projectId: '',
  },
  // Google Cloud console → APIs & Services → Credentials → OAuth client ID
  // ("Web application"). Its authorized redirect URI must be
  // https://<extension-id>.chromiumapp.org/
  oauthClientId: '',
  // Leave empty so anyone can sign in; each person only ever sees their own
  // data (users/{uid}). Set to one address to make the extension yours only
  // (also tighten firestore.rules for real enforcement).
  allowedEmail: '',
  // Public key from `npm run make-key`; pins the extension ID so the OAuth
  // redirect URI stays the same across reloads. Not a secret.
  manifestKey: '',
  // Default viewer URL (can be changed in the extension's options).
  viewerUrl: '',
};
