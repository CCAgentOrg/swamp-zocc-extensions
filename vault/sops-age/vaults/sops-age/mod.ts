// SOPS + age Vault Extension for Swamp
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4";

/** Configuration schema for the SOPS + age vault provider. */
const ConfigSchema = z.object({
  /** Path to the SOPS-encrypted JSON secrets file. */
  secretsFile: z.string().describe(
    "Path to the SOPS-encrypted JSON file containing secrets.",
  ),
  /** Path to the age private key file used for decryption. */
  ageKeyFile: z.string().describe(
    "Path to the age private key file for decryption.",
  ),
  /** The age public key (recipient) used for encryption. */
  agePublicKey: z.string().describe(
    "age public key (recipient) for encryption.",
  ),
  /** Optional path to a custom .sops.yaml configuration file. */
  sopsConfigFile: z.string().optional().describe(
    "Path to .sops.yaml (optional, overrides default config discovery).",
  ),
});

/**
 * Provider that stores and retrieves secrets from a SOPS-encrypted JSON file.
 *
 * Encryption uses Mozilla SOPS with age as the KMS backend. Secrets at rest
 * are AES-256-GCM encrypted. The provider delegates encrypt/decrypt to the
 * `sops` CLI and requires both `sops` and `age` to be installed.
 */
export class SopsAgeVaultProvider {
  private readonly secretsFile: string;
  private readonly ageKeyFile: string;
  private readonly agePublicKey: string;
  private readonly name: string;

  constructor(
    name: string,
    config: z.output<typeof ConfigSchema>,
  ) {
    this.name = name;
    this.secretsFile = config.secretsFile;
    this.ageKeyFile = config.ageKeyFile;
    this.agePublicKey = config.agePublicKey;
  }

  /** Returns the vault instance name. */
  getName(): string {
    return this.name;
  }

  /**
   * Retrieve a secret value by key.
   * @param secretKey - The secret key to look up.
   * @returns The decrypted secret value.
   * @throws {Error} If the key does not exist or decryption fails.
   */
  async get(secretKey: string): Promise<string> {
    const secrets = await this.#decrypt();
    if (!(secretKey in secrets)) {
      throw new Error(`Secret not found: ${secretKey}`);
    }
    return secrets[secretKey];
  }

  /**
   * Store a secret value. Overwrites existing keys.
   * @param secretKey - The secret key to store.
   * @param secretValue - The plaintext value to encrypt and store.
   * @throws {Error} If encryption fails.
   */
  async put(secretKey: string, secretValue: string): Promise<void> {
    const secrets = await this.#decrypt();
    secrets[secretKey] = secretValue;
    await this.#encrypt(secrets);
  }

  /**
   * List all secret keys in the vault (values not included).
   * @returns Sorted array of key names.
   * @throws {Error} If decryption fails.
   */
  async list(): Promise<string[]> {
    const secrets = await this.#decrypt();
    return Object.keys(secrets).sort();
  }

  async #decrypt(): Promise<Record<string, string>> {
    const raw = await this.#exec(
      `sops --decrypt --input-type json --output-type json "${this.secretsFile}"`,
    );
    return JSON.parse(raw);
  }

  async #encrypt(data: Record<string, string>): Promise<void> {
    const plain = `${this.secretsFile}.plain.tmp`;
    Deno.writeTextFileSync(plain, JSON.stringify(data, null, 2));
    try {
      await this.#exec(
        `sops --encrypt --age ${this.agePublicKey} --input-type json --output-type json --output "${this.secretsFile}" "${plain}"`,
      );
    } finally {
      try {
        Deno.removeSync(plain);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async #exec(cmd: string): Promise<string> {
    const proc = new Deno.Command("sh", {
      args: ["-c", cmd],
      env: { ...Deno.env.toObject(), SOPS_AGE_KEY_FILE: this.ageKeyFile },
      stdout: "piped",
      stderr: "piped",
    });
    const result = await proc.output();
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`sops command failed: ${stderr}`);
    }
    return new TextDecoder().decode(result.stdout);
  }
}

/**
 * SOPS + age vault extension for swamp.
 *
 * File-based secret vault encrypted with Mozilla SOPS and age.
 * Secrets are stored as AES-256-GCM encrypted JSON on disk.
 *
 * @example
 * ```yaml
 * # .swamp.yaml
 * vaults:
 *   - name: my-secrets
 *     type: "@zocc/sops-age"
 *     config:
 *       secretsFile: "/path/to/secrets.json"
 *       ageKeyFile: "/path/to/age.key"
 *       agePublicKey: "age1..."
 * ```
 *
 * @example
 * ```bash
 * swamp vault create @cashlessconsumer/sops-age prod \
 *   --config '{"secretsFile":"/data/secrets.json","ageKeyFile":"/data/age.key","agePublicKey":"age1..."}'
 *
 * swamp vault list-keys prod --json
 * swamp vault read-secret prod API_KEY --force
 * swamp vault put prod NEW_KEY=new_value
 * ```
 */
export const vault = {
  type: "@zocc/sops-age",
  name: "SOPS + age",
  description:
    "File-based secret vault encrypted with Mozilla SOPS and age. Secrets are stored as AES-256-GCM encrypted JSON on disk. Zero network dependency — fully local.",
  configSchema: ConfigSchema,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): SopsAgeVaultProvider => {
    const parsed = ConfigSchema.parse(config);
    return new SopsAgeVaultProvider(name, parsed);
  },
};
