const ENCRYPTED_PREFIX = "enc:v1";

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encryptionKeySecret(): string | null {
  const key = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", secretBytes);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function isEncryptedSecret(value: string | undefined | null): boolean {
  return Boolean(value && value.startsWith(`${ENCRYPTED_PREFIX}:`));
}

export async function encryptSecret(value: string): Promise<string> {
  const keySecret = encryptionKeySecret();
  if (!keySecret) {
    return value;
  }

  const key = await deriveAesKey(keySecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const cipherBytes = new Uint8Array(encrypted);

  return `${ENCRYPTED_PREFIX}:${base64Encode(iv)}:${base64Encode(cipherBytes)}`;
}

export async function decryptSecret(value: string): Promise<string> {
  if (!isEncryptedSecret(value)) {
    return value;
  }

  const keySecret = encryptionKeySecret();
  if (!keySecret) {
    throw new Error(
      "PROVIDER_TOKEN_ENCRYPTION_KEY is required to decrypt stored provider tokens",
    );
  }

  const [prefix, ivB64, cipherB64] = value.split(":");
  if (prefix !== ENCRYPTED_PREFIX || !ivB64 || !cipherB64) {
    throw new Error("Malformed encrypted secret value");
  }

  const key = await deriveAesKey(keySecret);
  const iv = base64Decode(ivB64);
  const cipherBytes = base64Decode(cipherB64);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);

  return new TextDecoder().decode(plainBuffer);
}
