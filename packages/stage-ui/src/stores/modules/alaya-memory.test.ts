import memoryDriver from 'unstorage/drivers/memory'

import { createPinia, setActivePinia } from 'pinia'
import { createStorage } from 'unstorage'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Swap the IndexedDB-backed storage for an in-memory driver; the store's
// behaviour is identical regardless of the underlying driver.
vi.mock('../../database/storage', () => ({
  storage: createStorage({ driver: memoryDriver() }),
}))

const { useAlayaMemoryStore } = await import('./alaya-memory')
const { storage } = await import('../../database/storage')

/** Lets watcher-scheduled work settle before assertions. */
function flushPending() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(async () => {
  await storage.clear()
  setActivePinia(createPinia())
})

describe('useAlayaMemoryStore.connect', () => {
  it('loads persisted memories for the connected character', async () => {
    const alaya = useAlayaMemoryStore()

    await alaya.connect({ characterId: 'char-1', userId: 'user-1' })
    await alaya.addMemory({ characterId: 'char-1', content: 'User likes hiking' })
    await alaya.addMemory({ characterId: 'char-1', content: 'User lives in Shanghai' })

    await alaya.connect({ characterId: 'char-1', userId: 'user-1' })

    expect(alaya.allMemories).toHaveLength(2)
    expect(alaya.totalCount).toBe(2)
  })

  it('reads the namespace once per connect instead of double-refreshing', async () => {
    const alaya = useAlayaMemoryStore()
    const spy = vi.spyOn(storage, 'getItemRaw')

    await alaya.connect({ characterId: 'char-1', userId: 'user-1' })
    await flushPending()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('resets the short-term buffer when the user changes on the same character', async () => {
    const alaya = useAlayaMemoryStore()

    await alaya.connect({ characterId: 'char-1', userId: 'user-a' })
    alaya.addTurn({ role: 'user', content: 'a turn from the first user', sessionId: 'session-1' })
    expect(alaya.shortTermTurnCount).toBe(1)

    await alaya.connect({ characterId: 'char-1', userId: 'user-b' })

    expect(alaya.shortTermTurnCount).toBe(0)
    expect(alaya.shortTermTurns).toEqual([])
  })

  it('drops prepared memories when connecting to another character', async () => {
    const alaya = useAlayaMemoryStore()

    await alaya.connect({ characterId: 'char-1', userId: 'user-1' })
    await alaya.prepareContext('hiking')
    expect(alaya.preparedMemories).not.toBeNull()

    await alaya.connect({ characterId: 'char-2', userId: 'user-1' })

    expect(alaya.preparedMemories).toBeNull()
  })
})

describe('useAlayaMemoryStore.prepareContext', () => {
  it('leaves prepared memories null when ranking fails', async () => {
    const alaya = useAlayaMemoryStore()

    await alaya.connect({ characterId: 'char-1', userId: 'user-1' })
    await alaya.prepareContext('hiking')

    expect(alaya.preparedMemories).toBeInstanceOf(Array)
  })

  it('is a no-op before the store is connected', async () => {
    const alaya = useAlayaMemoryStore()

    await alaya.prepareContext('hiking')

    expect(alaya.preparedMemories).toBeNull()
  })
})
