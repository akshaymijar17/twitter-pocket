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
  // Optional: refuse to sign in with any other Google account. The real
  // enforcement is the email check in firestore.rules.
  allowedEmail: '',
  // Public key from `npm run make-key`; pins the extension ID so the OAuth
  // redirect URI stays the same across reloads. Not a secret.
  manifestKey: '',
  // Default viewer URL (can be changed in the extension's options).
  viewerUrl: '',
};
