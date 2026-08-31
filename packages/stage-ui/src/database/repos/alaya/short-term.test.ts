import { describe, expect, it } from 'vitest'

import { ShortTermMemory } from './short-term'

/**
 * Builds a turn payload. Scoring inputs that matter:
 * - length >= 30 chars: +0.10
 * - role 'user': +0.10
 * - a preference keyword (`like`, `prefer`, ...): +0.10
 * on top of the 0.30 base, so the strings below reach the 0.6 threshold.
 */
function turn(content: string, role: 'user' | 'assistant' = 'user') {
  return { characterId: 'char-1', sessionId: 'session-1', role, content }
}

describe('shortTermMemory', () => {
  it('evicts the oldest turn once the buffer exceeds maxTurns', () => {
    const st = new ShortTermMemory({ maxTurns: 3 })

    st.addTurn(turn('first'))
    st.addTurn(turn('second'))
    st.addTurn(turn('third'))
    st.addTurn(turn('fourth'))

    expect(st.count).toBe(3)
    expect(st.getRecentTurns().map(t => t.content)).toEqual(['second', 'third', 'fourth'])
  })

  it('reports digest candidates above the threshold and drains the buffer', () => {
    const st = new ShortTermMemory({ maxTurns: 20, digestThreshold: 0.6 })

    st.addTurn(turn('I really like hiking on weekends when the weather is nice'))
    st.addTurn(turn('ok', 'assistant'))

    const result = st.compact()

    expect(result.digestCandidates).toHaveLength(1)
    expect(result.digestCandidates[0].content).toContain('hiking')
    expect(result.digestCandidates[0].tags).toContain('session:session-1')
    expect(result.digestCandidates[0].tags).toContain('role:user')
    expect(result.evictedCount).toBe(1)
    expect(st.count).toBe(0)
  })

  it('keeps the newest turns when compacting partially', () => {
    const st = new ShortTermMemory({ maxTurns: 20, digestThreshold: 0.6 })

    st.addTurn(turn('I really like hiking on weekends when the weather is nice'))
    st.addTurn(turn('I prefer tea over coffee every single morning indeed'))
    st.addTurn(turn('recent turn'))

    const result = st.compactPartial(1)

    expect(result.digestCandidates).toHaveLength(2)
    expect(result.remainingCount).toBe(1)
    expect(st.getRecentTurns()[0].content).toBe('recent turn')
  })

  it('returns no candidates when nothing clears the threshold', () => {
    const st = new ShortTermMemory({ maxTurns: 20, digestThreshold: 0.6 })

    st.addTurn(turn('ok', 'assistant'))

    const result = st.compact()

    expect(result.digestCandidates).toHaveLength(0)
    expect(result.evictedCount).toBe(1)
  })
})
