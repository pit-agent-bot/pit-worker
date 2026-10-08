import { describe, expect, it } from 'vitest'
import { readmeProblems } from '../src/real-skills'

describe('write-readme local contract', () => {
  it('requires the sections the server verifier checks', () => {
    expect(readmeProblems('# T\n\n## Summary\nx\n\n## Approach\ny\n\n## Next steps\nz\n')).toEqual([])
    expect(readmeProblems('# T\nbody')).toHaveLength(3)
    expect(readmeProblems('no title\n## Summary\n## Approach\n## Next steps\n')).toContain('start with a "# <title>" line')
  })
})
