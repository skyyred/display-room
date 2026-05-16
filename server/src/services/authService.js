export function authenticateJoin({ displayName }) {
  // TODO: replace with LDAP validation for production.
  if (!displayName || displayName.length < 2) {
    return { ok: false, error: 'Display name must be at least 2 characters.' };
  }
  return { ok: true, user: { displayName } };
}
