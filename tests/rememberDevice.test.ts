import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createLocalStore } from '../src/lib/sync/localStore'
import { createVault, decryptNote, encryptNote, unlockWithPassphrase } from '../src/lib/crypto'

describe('remembered device key', () => {
  it('keeps a non-extractable key across a reopen, and forgets it', async () => {
    const { record } = await createVault('correct horse battery staple')
    const key = await unlockWithPassphrase(record, 'correct horse battery staple')
    expect(key.extractable).toBe(false)

    const name = 'remember-test'
    await createLocalStore(name).setDeviceKey({ email: 'me@example.com', key })

    const reopened = createLocalStore(name)
    const saved = await reopened.getDeviceKey()
    expect(saved?.email).toBe('me@example.com')
    expect(saved?.key.extractable).toBe(false)
    // The stored key still decrypts what the original key encrypted.
    const enc = await encryptNote(key, 'id-1', { title: 'T', body: 'B', color: 'default', labels: [] })
    expect((await decryptNote(saved!.key, 'id-1', enc.ciphertext, enc.iv)).title).toBe('T')

    await reopened.setDeviceKey(null)
    expect(await createLocalStore(name).getDeviceKey()).toBeNull()
  }, 30_000)
})
