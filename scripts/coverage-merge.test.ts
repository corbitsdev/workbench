import { describe, expect, test } from 'bun:test'

import { aggregate, formatSummary, parseLcov } from './coverage-merge.ts'

const LCOV_A = `TN:
SF:/repo/packages/a/src/index.ts
FNF:4
FNH:4
LF:10
LH:9
end_of_record
`

const LCOV_B = `TN:
SF:/repo/packages/b/src/index.ts
FNF:2
FNH:1
LF:10
LH:1
end_of_record
SF:/repo/packages/b/src/other.ts
FNF:0
FNH:0
LF:0
LH:0
end_of_record
`

describe('parseLcov', () => {
  test('extracts per-file line and function counts', () => {
    const records = parseLcov(LCOV_A)
    expect(records).toEqual([
      { file: '/repo/packages/a/src/index.ts', linesFound: 10, linesHit: 9, fnFound: 4, fnHit: 4 },
    ])
  })

  test('parses multiple records in one file', () => {
    const records = parseLcov(LCOV_B)
    expect(records).toHaveLength(2)
    expect(records[1]).toEqual({
      file: '/repo/packages/b/src/other.ts',
      linesFound: 0,
      linesHit: 0,
      fnFound: 0,
      fnHit: 0,
    })
  })

  test('ignores empty input', () => {
    expect(parseLcov('')).toEqual([])
    expect(parseLcov('\n\n')).toEqual([])
  })
})

describe('aggregate', () => {
  test('sums line and function counts across all records', () => {
    const records = [...parseLcov(LCOV_A), ...parseLcov(LCOV_B)]
    const summary = aggregate(records)
    expect(summary.linesFound).toBe(20)
    expect(summary.linesHit).toBe(10)
    expect(summary.fnFound).toBe(6)
    expect(summary.fnHit).toBe(5)
    expect(summary.linePct).toBeCloseTo(50, 5)
    expect(summary.fnPct).toBeCloseTo(83.3333, 3)
  })

  test('reports 100% when nothing is found (avoids divide-by-zero)', () => {
    const summary = aggregate([])
    expect(summary.linePct).toBe(100)
    expect(summary.fnPct).toBe(100)
    expect(summary.linesFound).toBe(0)
  })
})

describe('formatSummary', () => {
  test('renders the aggregate line and function percentages', () => {
    const summary = aggregate(parseLcov(LCOV_A))
    const out = formatSummary(summary)
    expect(out).toContain('90.00%')
    expect(out).toContain('9/10')
  })
})
