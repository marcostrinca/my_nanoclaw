---
name: add-gdrive-tool
description: Add Google Drive as an MCP tool (search, read, list, fetch files; create, update, delete via the gdrive-write companion) using OneCLI-managed OAuth. Multi-account capable. Mirrors /add-gmail-tool's stub pattern — no raw credentials ever reach the container; OneCLI injects real tokens at request time.
---

# Add Google Drive Tool (OneCLI-native)

This skill wires two stdio MCP servers (`gdrive-read` and `gdrive-write`) into selected agent groups. The MCP servers read stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `*.googleapis.com` / `oauth2.googleapis.com` and swaps the bearer for the real OAuth token from its vault.

Both servers are shipped alongside this `SKILL.md` (`gdrive-read-mcp.ts` + `gdrive-write-mcp.ts`). They're plain Bun scripts — no NPM package to install.

Tools exposed (surfaced to the agent as `mcp__gdrive__<name>` and `mcp__gdrive-write__<name>`):
- **read** (read-only, narrow scope): `search`, `read_file`, `list_files`, `list_in_folder`, `get_metadata`
- **write** (mutating): `create_file`, `update_file`, `delete_file`, `move_file`, `rename_file`, `create_folder`

The two are split deliberately so an agent can be granted read-only by registering only `gdrive` (skip `gdrive-write`).

**Why this pattern:** v2's invariant is that containers never receive raw API keys — OneCLI is the sole credential path. The stub-file pattern satisfies this: the container sees `"onecli-managed"` placeholders, the gateway swaps them in flight. Mirrors `/add-gmail-tool` and `/add-gcal-tool`.

## Phase 1: Pre-flight

### Verify OneCLI has Google Drive connected

```bash
onecli apps get --provider google-drive
```

Expected: `"connection": { "status": "connected" }` with scopes including `drive.readonly`, `drive.file`, and `drive` (for write).

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254/connections?connect=google-drive, click Connect, and sign in with the Google account the agent should act as. Required scopes: `drive.readonly` + `drive.file` (read-only) or add `drive` for full write.

Stop and wait for the user to confirm before continuing.

### Verify stub credentials exist

Stubs live at `~/.gdrive-mcp/` by convention.

```bash
ls -la ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/.gdrive-server-credentials.json 2>&1
```

If both exist and contain `onecli-managed`:

```bash
grep -l onecli-managed ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/.gdrive-server-credentials.json
```

...skip to "Verify mount allowlist".

If either file exists but does **not** contain `onecli-managed`, **STOP** and tell the user — these are real OAuth credentials from a previous non-OneCLI install. Back them up (`cp -rp ~/.gdrive-mcp ~/.gdrive-mcp.realcreds-backup`), then delete the originals before proceeding. After deletion, write the stubs below.

If both files are absent, write them now:

```bash
mkdir -p ~/.gdrive-mcp
cat > ~/.gdrive-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "redirect_uris": ["http://localhost"]
  }
}
EOF
cat > ~/.gdrive-mcp/.gdrive-server-credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file"
}
EOF
chmod 600 ~/.gdrive-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gdrive-mcp` must sit under an `allowedRoots` entry with `allowReadWrite: true`. Add it if absent:

```bash
python3 -c "
import json
p = '$HOME/.config/nanoclaw/mount-allowlist.json'
d = json.load(open(p))
if not any(r.get('path') == '~/.gdrive-mcp' for r in d['allowedRoots']):
    d['allowedRoots'].append({
        'path': '~/.gdrive-mcp',
        'allowReadWrite': True,
        'description': 'Google Drive MCP stub credentials (OneCLI swaps bearers in flight)'
    })
    open(p, 'w').write(json.dumps(d, indent=2))
    print('Added ~/.gdrive-mcp to allowlist')
else:
    print('Already in allowlist')
"
```

Allowlist is cached in memory after first load — restart the host service after this change to apply:

```bash
systemctl --user restart nanoclaw-v2-<install-id>
```

### Check target agent's OneCLI secret-mode

For each agent that will receive Drive tools, confirm OneCLI will inject the Google Drive token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Drive secret:

```bash
onecli agents set-secret-mode --id <agent-id> --mode all
```

## Phase 2: Stage the MCP scripts in shared location

The two scripts ship alongside this `SKILL.md`. Copy them to a shared path that all containers can read from. By convention, place under `container/agent-runner/src/gdrive-mcp/` — the `/app/src/` mount inside every container picks it up RO automatically.

```bash
mkdir -p container/agent-runner/src/gdrive-mcp
cp .claude/skills/add-gdrive-tool/gdrive-read-mcp.ts container/agent-runner/src/gdrive-mcp/
cp .claude/skills/add-gdrive-tool/gdrive-write-mcp.ts container/agent-runner/src/gdrive-mcp/
```

Idempotent — re-running just overwrites with the latest skill version.

## Phase 3: Configure target agent(s)

Ask the user which agent(s) should get Drive. List options:

```bash
bin/ncl groups list
```

For each chosen agent, update its `container_config.mcp_servers` and `additional_mounts` to register the MCPs and mount the stub credentials.

### Compute the new JSON payloads

Read the existing config (don't clobber other MCPs):

```bash
AGENT_ID=<agent-group-id>
EXISTING_MCP=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT mcp_servers FROM container_configs WHERE agent_group_id='$AGENT_ID';" | head -1)
EXISTING_MOUNTS=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT additional_mounts FROM container_configs WHERE agent_group_id='$AGENT_ID';" | head -1)
```

Merge `gdrive` + `gdrive-write` into `mcp_servers`, merge `~/.gdrive-mcp` into `additional_mounts`. The shape of each entry:

```json
{
  "gdrive": {
    "command": "bun",
    "args": ["run", "/app/src/gdrive-mcp/gdrive-read-mcp.ts"],
    "env": { "GDRIVE_CREDS_DIR": "/workspace/extra/gdrive-mcp" }
  },
  "gdrive-write": {
    "command": "bun",
    "args": ["run", "/app/src/gdrive-mcp/gdrive-write-mcp.ts"],
    "env": { "GDRIVE_CREDS_DIR": "/workspace/extra/gdrive-mcp" }
  }
}
```

Additional mount:

```json
{ "hostPath": "~/.gdrive-mcp", "containerPath": "gdrive-mcp", "readonly": false }
```

Use a small Python helper to merge cleanly:

```bash
python3 <<EOF
import json, subprocess
agent_id = "$AGENT_ID"
db = "data/v2.db"

def query(sql):
    r = subprocess.run(['pnpm', 'exec', 'tsx', 'scripts/q.ts', db, sql], capture_output=True, text=True)
    return r.stdout.strip()

mcp_raw = query(f"SELECT mcp_servers FROM container_configs WHERE agent_group_id='{agent_id}';")
mounts_raw = query(f"SELECT additional_mounts FROM container_configs WHERE agent_group_id='{agent_id}';")

mcp = json.loads(mcp_raw) if mcp_raw else {}
mounts = json.loads(mounts_raw) if mounts_raw else []

mcp['gdrive'] = {
    "command": "bun",
    "args": ["run", "/app/src/gdrive-mcp/gdrive-read-mcp.ts"],
    "env": {"GDRIVE_CREDS_DIR": "/workspace/extra/gdrive-mcp"}
}
mcp['gdrive-write'] = {
    "command": "bun",
    "args": ["run", "/app/src/gdrive-mcp/gdrive-write-mcp.ts"],
    "env": {"GDRIVE_CREDS_DIR": "/workspace/extra/gdrive-mcp"}
}

if not any(m.get('hostPath') == '~/.gdrive-mcp' for m in mounts):
    mounts.append({"hostPath": "~/.gdrive-mcp", "containerPath": "gdrive-mcp", "readonly": False})

mcp_json = json.dumps(mcp).replace("'", "''")
mounts_json = json.dumps(mounts).replace("'", "''")
now = subprocess.run(['date', '-u', '+%Y-%m-%dT%H:%M:%S.%3NZ'], capture_output=True, text=True).stdout.strip()
subprocess.run(['pnpm', 'exec', 'tsx', 'scripts/q.ts', db,
    f"UPDATE container_configs SET mcp_servers='{mcp_json}', additional_mounts='{mounts_json}', updated_at='{now}' WHERE agent_group_id='{agent_id}';"])
print(f"Updated container_config for {agent_id}")
EOF
```

### Restart the agent's container so the new config takes effect

```bash
bin/ncl groups restart --id $AGENT_ID
```

Next message to the agent will respawn with the gdrive MCPs registered.

## Phase 4: Verify

After restart and a fresh inbound message, the agent's running container should:

```bash
docker ps --filter "name=$AGENT_ID" --format '{{.Names}}' | head -1 | xargs -I {} docker top {} | grep gdrive
```

Expected to see:
```
bun run /app/src/gdrive-mcp/gdrive-read-mcp.ts
bun run /app/src/gdrive-mcp/gdrive-write-mcp.ts
```

Tell the user to ask the agent "list my Drive folders" or similar. Verify the call succeeds end-to-end (real folder names returned, not "auth error" or "no credentials").

## Removal

To remove Drive from one agent:

```bash
python3 <<EOF
import json, subprocess
agent_id = "<agent-id>"
db = "data/v2.db"

def query(sql):
    r = subprocess.run(['pnpm', 'exec', 'tsx', 'scripts/q.ts', db, sql], capture_output=True, text=True)
    return r.stdout.strip()

mcp = json.loads(query(f"SELECT mcp_servers FROM container_configs WHERE agent_group_id='{agent_id}';") or '{}')
mounts = json.loads(query(f"SELECT additional_mounts FROM container_configs WHERE agent_group_id='{agent_id}';") or '[]')

mcp.pop('gdrive', None)
mcp.pop('gdrive-write', None)
mounts = [m for m in mounts if m.get('hostPath') != '~/.gdrive-mcp']

mcp_json = json.dumps(mcp)
mounts_json = json.dumps(mounts)
now = subprocess.run(['date','-u','+%Y-%m-%dT%H:%M:%S.%3NZ'], capture_output=True, text=True).stdout.strip()
subprocess.run(['pnpm', 'exec', 'tsx', 'scripts/q.ts', db,
    f"UPDATE container_configs SET mcp_servers='{mcp_json}', additional_mounts='{mounts_json}', updated_at='{now}' WHERE agent_group_id='{agent_id}';"])
EOF
bin/ncl groups restart --id <agent-id>
```

To remove globally (uninstall skill): delete `container/agent-runner/src/gdrive-mcp/` and remove `~/.gdrive-mcp` from the mount allowlist. Existing per-agent configs that still reference it will fail to spawn.
