import { db } from './db';

// Logout teardown. A SPARC'd tool is BYO-credentials and often shared on one
// machine, so logging out must leave nothing of the previous user behind:
// otherwise their local drafts (keyed by bucket/upload, not by identity) would
// surface — and worse, a draft could be synced stamped with the next user's
// identity. Keybindings are retained in endpoint + access-key scoped profiles,
// so another user cannot inherit them. S3 is canonical; anything unsynced here is
// either pushed first or explicitly discarded by the caller before this runs.

/** Wipe all of this browser's local tagger data, then reload onto the connect
 *  gate. The caller has already nulled the connection (`disconnect`), so the
 *  reload rebuilds every in-memory store clean. */
export async function resetLocalState(): Promise<void> {
  await Promise.all([
    db.drafts.clear(),
    db.uploads.clear(),
    db.sessions.clear(),
    db.syncJournals.clear(),
  ]);
  location.reload();
}
