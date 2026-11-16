# @local/dsh-user-data-backup

Composition-only bundle: inserts the two data-management plugins into a profile.

- `@deepseek-ai/dsh-user-data-backup` (host) — `/api/user-data.*` routes: export, import
  preview, import apply, remote list, sync list/push/bundle.
- `@deepseek-ai/dsh-client-ui-settings-user-data` (client) — the 数据管理 section inside
  设置.

Both packages stay in F:/maple/deepseek-harness and are linked into the profile, so
rebuilding them (pnpm run build:artifacts) updates the installed plugin.

## Install (already done for the desktop profile)

```sh
cd ~/.dsh/profiles/desktop
# package.json: dependencies + dsh.profile.bundles already list @local/dsh-user-data-backup
node <pnpm>/bin/pnpm.mjs install --prefer-offline
```

Restart the app afterwards: the loader composes bundles at process start.

## Remove

```sh
cd ~/.dsh/profiles/desktop
node -e "const fs=require('fs');const p='package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));
delete j.dependencies['@local/dsh-user-data-backup'];
delete j.dependencies['@deepseek-ai/dsh-user-data-backup'];
delete j.dependencies['@deepseek-ai/dsh-client-ui-settings-user-data'];
j.dsh.profile.bundles=j.dsh.profile.bundles.filter(b=>b!=='@local/dsh-user-data-backup');
fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
node <pnpm>/bin/pnpm.mjs install --prefer-offline
```
