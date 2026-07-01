# OpenRecapper deployment notes

This repository is the public OpenRecapper source (`origin` = `The-Yak-Collective/openrecapper`). The Hetzner production bot is deployed from this VM to `/opt/openrecapper` on host `hetzner-yak`.

## Deployment target

- SSH host: `hetzner-yak` (configured in `~/.ssh/config`)
- Remote app directory: `/opt/openrecapper`
- Remote runtime entrypoint: `node dist/index.js`
- systemd service: `openrecapper`
- Environment file: `/opt/openrecapper/.env`
- Production recordings live under `/opt/openrecapper/recordings`

Do not commit or copy `.env`, recording files, or other production secrets/artifacts back into git.

## Source and branch hygiene

- Normal feature/PR work should branch from `origin/main`.
- `deploy/openrecapper-yc` is legacy/deployment history. Do not use it as a base for public repo PR branches unless explicitly asked.
- Before deployment, verify what is being deployed:
  ```bash
  git status --short --branch
  git log --oneline --decorate --max-count=8
  npm run build
  npm test
  ```

## Standard deployment from this VM

1. Build locally:
   ```bash
   npm run build
   npm test
   ```

2. Check the production service and make sure no recording is active:
   ```bash
   ssh hetzner-yak 'systemctl is-active openrecapper; find /opt/openrecapper/recordings -maxdepth 2 -name session.active -print 2>/dev/null | head'
   ```

3. Back up the current deployed build:
   ```bash
   ssh hetzner-yak 'ts=$(date -u +%Y%m%dT%H%M%SZ); cp -a /opt/openrecapper/dist /opt/openrecapper/dist.backup.$ts; echo /opt/openrecapper/dist.backup.$ts'
   ```

4. Deploy the compiled build only:
   ```bash
   rsync -az --delete dist/ hetzner-yak:/opt/openrecapper/dist/
   ```

5. Restart and verify:
   ```bash
   ssh hetzner-yak 'systemctl restart openrecapper && sleep 3 && systemctl status openrecapper --no-pager -l | sed -n "1,80p"'
   ```

6. If needed, inspect recent logs:
   ```bash
   ssh hetzner-yak 'journalctl -u openrecapper -n 120 --no-pager'
   ```

## Rollback

If a deployment fails immediately, restore the latest backup and restart:

```bash
ssh hetzner-yak 'latest=$(ls -td /opt/openrecapper/dist.backup.* | head -1); rm -rf /opt/openrecapper/dist; cp -a "$latest" /opt/openrecapper/dist; systemctl restart openrecapper; systemctl status openrecapper --no-pager -l | sed -n "1,80p"'
```

## Notes

- Deploying `dist/` updates production code but does not push git branches or create GitHub PRs.
- If dependencies or runtime config change, update `/opt/openrecapper/package*.json` and run install on the server intentionally; the standard flow above only updates compiled JS.
