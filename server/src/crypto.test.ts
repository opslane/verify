import { describe, it, expect, vi } from 'vitest';

describe('crypto', () => {
  it('encrypts and decrypts a string', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await import('./crypto.js');

    const plaintext = 'my-secret-password';
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).toMatch(/^[a-f0-9]+:[a-f0-9]+:[a-f0-9]+$/); // iv:ciphertext:authTag
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertexts for same input (unique IV)', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt } = await import('./crypto.js');

    const a = encrypt('same');
    const b = encrypt('same');
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const { encrypt, decrypt } = await import('./crypto.js');

    const ciphertext = encrypt('secret');
    const [iv, data, tag] = ciphertext.split(':');
    const tampered = `${iv}:${'ff' + data.slice(2)}:${tag}`;

    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws if ENCRYPTION_KEY is missing', async () => {
    delete process.env.ENCRYPTION_KEY;
    vi.resetModules();
    await expect(import('./crypto.js')).rejects.toThrow('ENCRYPTION_KEY');
  });
});
