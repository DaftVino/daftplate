# Deploy runbook

Apps Script deployment, in the order that avoids the usual failures. `/gas-deploy` automates this; the runbook is the source it follows.

## 1. Push head

```
clasp push
```

Pushes to the script's head version. Nothing user-facing changes yet — head is served only at the `/dev` URL, and only to accounts with edit access.

## 2. Test at `/dev`

Open the `/dev` URL in an incognito window signed in as the *test* account. A stale login is the most common cause of "my change didn't deploy" — it is usually the wrong account, not the wrong code.

## 3. Update the existing deployment

```
clasp deployments                       # find the production deployment id
clasp deploy -i <deployment-id> -d "vX.Y.Z — <summary>"
```

Updating in place keeps the `/exec` URL stable. `clasp deploy` with no `-i` creates a *new* deployment with a *new* URL — that is the bug, not the fix.

## 4. Verify at `/exec`

Reload the production URL in incognito. If it serves the old code, wait 30s and retry before changing anything: propagation is not instant.

## 5. Archive stale deployments

```
clasp undeploy <old-deployment-id>
```

Keep at most the current deployment plus one rollback target. A long deployment list makes step 3 error-prone.

## Gotchas

- **Auth scope changes** force every user to re-authorize; call it out in the changelog entry.
- **`executeAs: USER_ACCESSING`** means the script runs with the *caller's* permissions — a change here can silently expand or break access.
- **Cookies/third-party blocking** breaks embedded `/exec` iframes in strict browser profiles; test in the target profile, not just yours.
