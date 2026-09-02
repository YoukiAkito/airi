import type { CompactResult, ShortTermMemoryOptions, ShortTermTurn } from '../../database/repos/alaya'
import type { AlayaSnapshot, MemoryEntry, MemoryInput, MemoryQuery, MemorySearchResult } from '../../database/repos/alaya/types'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { createAlayaMemory, ShortTermMemory } from '../../database/repos/alaya'

/**
 * Short-term buffer capacity.
 *
 * Doubles as the drain threshold: `addTurn()` compacts as soon as the buffer
 * reaches this size, because `ShortTermMemory` silently evicts the oldest
 * turn on the next insert.
 */
const SHORT_TERM_BUFFER_MAX_TURNS = 20

/**
 * Relevance prefetch budget. `prepareContext()` runs on the chat send path,
 * so a hung IndexedDB query must degrade within this window instead of
 * blocking the outgoing message.
 */
const PREPARE_CONTEXT_TIMEOUT_MS = 800

/**
 * Short-term buffer configuration.
 *
 * Shared by the lazy initializer and `connect()` so that rebuilding the
 * buffer on a namespace switch always yields identical settings.
 */
const SHORT_TERM_MEMORY_OPTIONS: ShortTermMemoryOptions = {
  maxTurns: SHORT_TERM_BUFFER_MAX_TURNS,
  digestThreshold: 0.6,
}

/**
 * Pinia store wrapping the AlayaMemory driver.
 *
 * Provides reactive state for memory management in the settings UI
 * and orchestrates memory operations for the active character.
 */
export const useAlayaMemoryStore = defineStore('alaya-memory', () => {
  // ------------------------------------------------------------------
  // Core instances — lazy-initialized on first `connect()` call
  // ------------------------------------------------------------------

  let driver: ReturnType<typeof createAlayaMemory> | null = null
  let latestSearchRequestId = 0
  let latestRefreshRequestId = 0
  let latestPrepareRequestId = 0

  /**
   * Session-scoped short-term memory buffer.
   *
   * Created per-connect(), so switching characters creates a fresh
   * short-term buffer for the new conversation context.
   */
  let shortTerm: ShortTermMemory | null = null

  /** Guards against overlapping opportunistic compactions. */
  let compactingShortTerm = false

  function ensureShortTerm(): ShortTermMemory {
    if (!shortTerm) {
      shortTerm = new ShortTermMemory(SHORT_TERM_MEMORY_OPTIONS)
    }
    return shortTerm
  }

  let driverUid: string | null = null

  function ensureDriver(uid: string) {
    if (!driver || driverUid !== uid) {
      driver = createAlayaMemory({ userId: uid })
      driverUid = uid
    }
    return driver
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  const characterId = ref<string | null>(null)
  const userId = ref<string>('default')

  const allMemories = ref<MemoryEntry[]>([])
  const searchResults = ref<MemorySearchResult[]>([])

  /**
   * Memories ranked by relevance to the message about to be sent.
   *
   * Populated by `prepareContext()`. Runtime context providers are
   * synchronous, so this cache is what lets them serve relevance-ranked
   * results instead of a plain recency list.
   */
  const preparedMemories = ref<MemorySearchResult[] | null>(null)
  const searchQuery = ref('')
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const totalCount = ref(0)
  const snapshot = ref<AlayaSnapshot | null>(null)

  // Short-term state
  const shortTermTurnCount = ref(0)
  const shortTermTurns = ref<ShortTermTurn[]>([])

  // ------------------------------------------------------------------
  // Derived
  // ------------------------------------------------------------------

  const isConnected = computed(() => characterId.value !== null && driver !== null)
  const isEmpty = computed(() => allMemories.value.length === 0)
  const displayedMemories = computed(() =>
    searchQuery.value.trim()
      ? searchResults.value
      : allMemories.value.map(e => ({ entry: e, score: 1.0 } as MemorySearchResult)),
  )

  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  // NOTE: there is deliberately no `watch(characterId, refresh)` here.
  // `characterId` is only ever assigned inside `connect()`, which awaits
  // `refresh()` itself. A watcher would fire *in addition* to that call and
  // double every IndexedDB read on a character switch — so do not re-add it.
  // Same-character user switches are covered by the unconditional refresh
  // at the end of `connect()`, which the watcher would never have caught.

  async function connect(opts: { characterId: string, userId?: string }) {
    // Capture the previous namespace BEFORE mutating userId. Reading it
    // afterwards compares the new value against itself, which silently
    // turns the user-switch branch below into dead code.
    const oldUserId = userId.value
    const oldCharacterId = characterId.value

    if (opts.userId)
      userId.value = opts.userId

    // Initialize driver and short-term memory before setting characterId
    ensureDriver(userId.value)

    // Reset the short-term buffer when the character or user namespace
    // changes.  Otherwise a compactSession() could ingest user A's
    // buffered turns into user B's long-term memories.
    if (opts.characterId !== oldCharacterId || userId.value !== oldUserId) {
      shortTerm = new ShortTermMemory(SHORT_TERM_MEMORY_OPTIONS)
      shortTermTurnCount.value = 0
      shortTermTurns.value = []
    }

    // Clear stale data before exposing the new characterId, so
    // synchronous consumers (context provider) never see the
    // previous namespace's cached memories during the refresh gap.
    allMemories.value = []
    preparedMemories.value = null
    characterId.value = opts.characterId

    // Always await refresh so synchronous consumers (context provider)
    // see populated allMemories on the first read.
    if (driver) {
      await refresh()
    }
  }

  async function refresh() {
    const d = driver
    if (!d || !characterId.value)
      return

    // Serialise concurrent refreshes the same way `search()` does. Rapid
    // character switching can leave two refreshes in flight, and without
    // this the older response would clobber the newer namespace's state.
    const requestId = ++latestRefreshRequestId

    isLoading.value = true
    error.value = null
    try {
      // Single IndexedDB read — totalCount and snapshot are derived
      // in-memory from the returned entries, avoiding 3 separate reads.
      const entries = await d.getAll(characterId.value)

      if (requestId !== latestRefreshRequestId)
        return

      allMemories.value = entries
      totalCount.value = entries.length

      // Populate snapshot from the loaded entries
      if (entries.length === 0) {
        snapshot.value = {
          characterId: characterId.value,
          totalEntries: 0,
          newestEntryAt: null,
          oldestEntryAt: null,
        }
      }
      else {
        const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt)
        snapshot.value = {
          characterId: characterId.value,
          totalEntries: entries.length,
          oldestEntryAt: sorted[0].createdAt,
          newestEntryAt: sorted[sorted.length - 1].createdAt,
        }
      }

      // If there is an active search query, re-run it to refresh search results
      if (searchQuery.value.trim()) {
        await search(searchQuery.value) // re-run search with same query
      }
      else {
        searchResults.value = []
      }
    }
    catch (e) {
      if (requestId === latestRefreshRequestId)
        error.value = `Failed to load memories: ${String(e)}`
    }
    finally {
      // Only the newest refresh owns the loading flag, otherwise a stale
      // one would clear it while its successor is still reading.
      if (requestId === latestRefreshRequestId)
        isLoading.value = false
    }
  }

  // ------------------------------------------------------------------
  // CRUD
  // ------------------------------------------------------------------

  async function addMemory(input: MemoryInput): Promise<MemoryEntry> {
    const d = driver
    if (!d)
      throw new Error('Alaya driver not initialized')

    error.value = null
    try {
      const entry = await d.ingest({
        characterId: input.characterId || characterId.value!,
        content: input.content,
        source: input.source ?? 'manual',
        tags: input.tags,
        type: input.type,
      })
      await refresh()
      return entry
    }
    catch (e) {
      error.value = `Failed to add memory: ${String(e)}`
      throw e
    }
  }

  async function deleteMemory(entryId: string) {
    const d = driver
    if (!d || !characterId.value)
      throw new Error('Not connected')

    error.value = null
    try {
      await d.forget(characterId.value, entryId)
      await refresh()
    }
    catch (e) {
      error.value = `Failed to delete memory: ${String(e)}`
      throw e
    }
  }

  async function clearAllMemories() {
    const d = driver
    if (!d || !characterId.value)
      throw new Error('Not connected')

    error.value = null
    try {
      await d.forgetAll(characterId.value)
      await refresh()
    }
    catch (e) {
      error.value = `Failed to clear memories: ${String(e)}`
      throw e
    }
  }

  async function updateMemory(
    entry: MemoryEntry,
    patch: Partial<Pick<MemoryEntry, 'content' | 'importance' | 'tags' | 'type'>>,
  ): Promise<MemoryEntry> {
    const d = driver
    if (!d)
      throw new Error('Alaya driver not initialized')

    error.value = null
    try {
      const updated = await d.update(entry, patch)
      await refresh()
      return updated
    }
    catch (e) {
      error.value = `Failed to update memory: ${String(e)}`
      throw e
    }
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------

  async function search(query: string) {
    const d = driver
    if (!d || !characterId.value)
      throw new Error('Not connected')

    // Bump request id to track the latest search
    const requestId = ++latestSearchRequestId

    searchQuery.value = query
    isLoading.value = true
    error.value = null

    try {
      const q: MemoryQuery = {
        characterId: characterId.value,
        limit: 50,
      }
      if (query.trim()) {
        q.text = query.trim()
      }
      const results = await d.query(q)

      // Only update state if this is still the most recent search
      if (requestId === latestSearchRequestId) {
        searchResults.value = results
      }
    }
    catch (e) {
      if (requestId === latestSearchRequestId) {
        error.value = `Search failed: ${String(e)}`
      }
    }
    finally {
      if (requestId === latestSearchRequestId) {
        isLoading.value = false
      }
    }
  }

  async function clearSearch() {
    searchQuery.value = ''
    searchResults.value = []
  }

  // ------------------------------------------------------------------
  // Context preparation
  // ------------------------------------------------------------------

  /**
   * Rank long-term memories against `query` and cache them for the next
   * synchronous context read.
   *
   * Runtime context providers must return synchronously, so relevance
   * ranking happens before the turn starts (see `chat.ts#ingest`).
   * Best-effort by design: on failure the cache is cleared so the provider
   * falls back to recency ordering instead of serving stale results.
   */
  async function prepareContext(query: string): Promise<void> {
    const d = driver
    if (!d || !characterId.value)
      return

    const requestId = ++latestPrepareRequestId

    try {
      const q: MemoryQuery = {
        characterId: characterId.value,
        limit: 10,
      }
      const trimmed = query.trim()
      if (trimmed)
        q.text = trimmed

      // A hung IndexedDB query must never block the chat send path. Race the
      // relevance search against a short timeout and degrade on expiry.
      const results = await Promise.race([
        d.query(q),
        new Promise<null>(resolve => setTimeout(resolve, PREPARE_CONTEXT_TIMEOUT_MS, null)),
      ])

      if (requestId === latestPrepareRequestId)
        preparedMemories.value = results
    }
    catch {
      // A ranking failure must never block or degrade the outgoing message.
      if (requestId === latestPrepareRequestId)
        preparedMemories.value = null
    }
  }

  // ------------------------------------------------------------------
  // Housekeeping
  // ------------------------------------------------------------------

  async function runHousekeeping() {
    const d = driver
    if (!d || !characterId.value)
      throw new Error('Not connected')

    isLoading.value = true
    error.value = null
    try {
      await d.housekeep(characterId.value)
      await refresh()
    }
    catch (e) {
      error.value = `Housekeeping failed: ${String(e)}`
    }
    finally {
      isLoading.value = false
    }
  }

  // ------------------------------------------------------------------
  // Short-Term Memory
  // ------------------------------------------------------------------

  /**
   * Record a turn into the short-term buffer.
   *
   * Call this from the chat pipeline each time the user or assistant
   * sends a message. The turn is appended to the in-memory buffer and
   * reactive state is updated for UI consumption.
   */
  function addTurn(opts: { content: string, role: ShortTermTurn['role'], sessionId?: string }) {
    const st = ensureShortTerm()

    const turn = st.addTurn({
      characterId: characterId.value!,
      sessionId: opts.sessionId ?? 'default',
      role: opts.role,
      content: opts.content,
    })

    shortTermTurnCount.value = st.count
    shortTermTurns.value = st.getRecentTurns()

    // ShortTermMemory silently evicts the oldest turn once the buffer is
    // full. Drain into long-term memory as soon as the buffer is saturated,
    // so turns are scored and digested before any of them can be dropped.
    if (st.count >= SHORT_TERM_BUFFER_MAX_TURNS)
      void compactSessionQuietly()

    return turn
  }

  /** Get recent turns for LLM context injection. */
  function getRecentContext(n?: number): ShortTermTurn[] {
    return ensureShortTerm().getRecentTurns(n)
  }

  /**
   * Compact the short-term buffer and auto-digest high-signal turns
   * into the long-term memory pool.
   *
   * Should be called at session end or periodically for long sessions.
   */
  async function compactSession(): Promise<CompactResult> {
    const st = ensureShortTerm()

    const beforeTurns = st.getRecentTurns()
    const result = st.compact()

    // Auto-digest: write high-scoring candidates to long-term memory
    if (result.digestCandidates.length > 0 && driver) {
      try {
        await driver.ingestAll(result.digestCandidates)
        // Refresh only after successful ingestion, not inside the catch
      }
      catch (e) {
        // Restore short-term buffer only if ingestion failed
        for (const turn of beforeTurns) {
          st.addTurn({ ...turn, sessionId: turn.sessionId ?? 'default' })
        }
        error.value = `Auto-digest failed, short-term buffer restored: ${String(e)}`
        throw e
      }
      // Now refresh, but if it fails we should not restore (memories already committed)
      try {
        await refresh()
      }
      catch (refreshErr) {
        error.value = `Failed to refresh after digest: ${String(refreshErr)}`
        // Do not restore short-term buffer here
        throw refreshErr
      }
    }

    shortTermTurnCount.value = st.count
    shortTermTurns.value = st.getRecentTurns()

    return result
  }

  /**
   * Compact without letting a storage failure escape.
   *
   * For callers that cannot await (buffer-full drain, session switch).
   * `compactSession()` restores the buffer and records `error` on failure,
   * so swallowing the rejection here loses no information.
   */
  async function compactSessionQuietly(): Promise<void> {
    if (compactingShortTerm)
      return

    compactingShortTerm = true
    try {
      await compactSession()
    }
    catch {
      // Already surfaced through `error` by compactSession().
    }
    finally {
      compactingShortTerm = false
    }
  }

  /** Build a compact context string from short-term turns. */
  function buildShortTermContext(maxTurns?: number): string | null {
    return ensureShortTerm().buildContext(maxTurns)
  }

  /** Clear short-term buffer without digesting. */
  function clearShortTerm(): void {
    ensureShortTerm().clear()
    shortTermTurnCount.value = 0
    shortTermTurns.value = []
  }

  // ------------------------------------------------------------------
  // Context building (read-only, no side effects)
  // ------------------------------------------------------------------

  function buildContext(results: MemorySearchResult[]): string | null {
    return driver?.buildContext(results) ?? null
  }

  function buildCompactContext(results: MemorySearchResult[]): string | null {
    return driver?.buildCompactContext(results) ?? null
  }

  // ------------------------------------------------------------------

  return {
    characterId,
    userId,
    allMemories,
    searchResults,
    preparedMemories,
    searchQuery,
    isLoading,
    error,
    totalCount,
    snapshot,
    shortTermTurnCount,
    shortTermTurns,
    isConnected,
    isEmpty,
    displayedMemories,
    connect,
    refresh,
    addMemory,
    deleteMemory,
    clearAllMemories,
    updateMemory,
    search,
    clearSearch,
    prepareContext,
    runHousekeeping,
    addTurn,
    getRecentContext,
    compactSession,
    compactSessionQuietly,
    buildShortTermContext,
    clearShortTerm,
    buildContext,
    buildCompactContext,
  }
})
