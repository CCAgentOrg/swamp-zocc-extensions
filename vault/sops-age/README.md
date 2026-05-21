# SOPS + age Vault for Swamp

File-based secret vault encrypted with Mozilla SOPS and age. Store API keys,
tokens, and other secrets encrypted at rest with AES-256-GCM. Zero network
dependency — fully local.

## Why SOPS + age?

- **AES-256-GCM encryption** — industry-standard, auditable
- **Zero network** — no external service, no SaaS, no API calls
- **Git-friendly** — encrypted files are safe to commit
- **SOPS ecosystem** — works with existing `.sops.yaml` configs, CI pipelines,
  and team workflows
- **age keys** — simple, modern encryption with small keyfiles
- **Multiples recipients** — encrypt to multiple age public keys for team
  sharing

## Required Tools

```bash
# Install sops
curl -fsSL https://github.com/mozilla/sops/releases/latest/download/sops-v3.9.0.linux.amd64 \
  -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops

# Install age (Debian/Ubuntu)
apt-get install -y age

# macOS
brew install sops age
```

## Quick Start

### 1. Generate age keypair

```bash
age-keygen -o ~/.secrets/age.key
# Output includes: Public key: age1...
```

### 2. Create and encrypt secrets file

```bash
echo '{"OPENAI_API_KEY": "sk-...", "GITHUB_TOKEN": "ghp_..."}' > ~/.secrets/secrets.json
sops --encrypt --age age1... \
  --input-type json --output-type json \
  --output ~/.secrets/secrets.json ~/.secrets/secrets.json
```

The file is now encrypted on disk. Only someone with the age private key can
decrypt it.

### 3. Install and configure the vault

```bash
# Install the extension
swamp extension pull @cashlessconsumer/sops-age

# Create a vault instance
swamp vault create @cashlessconsumer/sops-age prod \
  --config '{
    "secretsFile": "/home/user/.secrets/secrets.json",
    "ageKeyFile": "/home/user/.secrets/age.key",
    "agePublicKey": "age1..."
  }'
```

### 4. Use in swamp workflows

```yaml
version: 1
models:
  - name: fetch-data
    type: "@cashlessconsumer/duckdb"
    method: import_data
    arguments:
      database: "./data/app.duckdb"
      source: "https://api.example.com/data"
      table: records
    env:
      API_KEY: ${{ vault.get(prod, API_KEY) }}

  - name: publish-report
    type: "@cashlessconsumer/duckdb"
    method: export_data
    dependsOn:
      - fetch-data
    arguments:
      database: "./data/app.duckdb"
      sql: "SELECT * FROM records WHERE processed = false"
      destination: "./output/pending.json"
```

## Vault Commands

```bash
# List all secret keys (values are masked)
swamp vault list-keys prod --json

# Read a specific secret (shows full value with --force)
swamp vault read-secret prod OPENAI_API_KEY --force

# Store a new secret
swamp vault put prod NEW_TOKEN=my_secret_value_123

# Delete a secret via the zo.space dashboard or sops CLI
sops --decrypt /path/to/secrets.json | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.pop('OLD_KEY', None)
json.dump(d, sys.stdout)
" | sops --encrypt --age age1... --input-type json --output-type json --output /path/to/secrets.json /dev/stdin
```

## Configuration Reference

| Field            | Required | Description                                  |
| ---------------- | -------- | -------------------------------------------- |
| `secretsFile`    | Yes      | Path to the SOPS-encrypted JSON file         |
| `ageKeyFile`     | Yes      | Path to the age private key file             |
| `agePublicKey`   | Yes      | age public key (recipient) for encryption    |
| `sopsConfigFile` | No       | Custom `.sops.yaml` path (overrides default) |

## Team Sharing

Encrypt to multiple recipients by editing `.sops.yaml`:

```yaml
keys:
  - age: age1your_key_here...
  - age: age1teammate_key_here...
```

Each recipient can decrypt the file with their own private key. SOPS handles
multi-recipient transparently.

## Security Considerations

- **age key is the crown jewel** — protect `age.key` with strict file
  permissions (`chmod 600`)
- **Never commit `age.key`** — add it to `.gitignore`
- **Encrypted files are safe to commit** — `secrets.json` contains only
  `ENC[AES256_GCM,...]` blobs
- **Rotate keys** by re-encrypting with a new age recipient and removing the old
  one

## License

Apache-2.0
