import { describe, expect, it } from 'vitest'
import { barFrame, topSlices } from './render-charts.js'

describe('topSlices', () => {
  it('keeps the top entries and groups the remainder into "Other"', () => {
    const result = topSlices(
      [
        ['a', 5],
        ['b', 3],
        ['c', 2],
        ['d', 1],
      ],
      2,
    )
    expect(result).toEqual({ labels: ['a', 'b', 'Other'], values: [5, 3, 3] })
  })

  it('drops non-positive values and sorts descending', () => {
    expect(
      topSlices([
        ['a', 0],
        ['b', 5],
        ['c', -2],
      ]),
    ).toEqual({ labels: ['b'], values: [5] })
  })

  it('omits the "Other" slice when everything fits', () => {
    expect(
      topSlices(
        [
          ['a', 2],
          ['b', 1],
        ],
        5,
      ),
    ).toEqual({ labels: ['a', 'b'], values: [2, 1] })
  })
})

describe('barFrame', () => {
  it('scales the frame height tier with the number of bars', () => {
    expect(barFrame(1)).toBe('bars-sm')
    expect(barFrame(3)).toBe('bars-sm')
    expect(barFrame(4)).toBe('bars-md')
    expect(barFrame(6)).toBe('bars-md')
    expect(barFrame(7)).toBe('bars-lg')
    expect(barFrame(10)).toBe('bars-lg')
    expect(barFrame(11)).toBe('bars-xl')
  })
})
