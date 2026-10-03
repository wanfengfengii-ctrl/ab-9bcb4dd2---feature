import { describe, expect, it } from 'vitest';
import { validateRequest } from '../src/core/validation.js';
import { SolveError } from '../src/core/types.js';
import { sampleRequest } from './fixtures/sample.js';

const valid = (): typeof sampleRequest => JSON.parse(JSON.stringify(sampleRequest));

describe('validateRequest: dormancy bounds', () => {
  it('accepts the canonical sample without dormancy', () => {
    const req = validateRequest(valid());
    expect(req.dormancy).toBeUndefined();
  });

  it('accepts a positive integer closed dormancy range', () => {
    const b = valid();
    (b as Record<string, unknown>).dormancyLower = 10;
    (b as Record<string, unknown>).dormancyUpper = 100;
    expect(validateRequest(b).dormancy).toEqual({ lower: 10, upper: 100 });
  });

  it.each([
    ['lower only', { dormancyLower: 10 }],
    ['upper only', { dormancyUpper: 100 }],
    ['inverted bounds', { dormancyLower: 100, dormancyUpper: 10 }],
    ['zero lower', { dormancyLower: 0, dormancyUpper: 10 }],
    ['negative upper', { dormancyLower: -5, dormancyUpper: -1 }],
    ['non-integer lower', { dormancyLower: 1.5, dormancyUpper: 10 }],
    ['string upper', { dormancyLower: 1, dormancyUpper: '10' }],
  ])('rejects %s', (_label, extra) => {
    const b = valid() as unknown as Record<string, unknown>;
    Object.assign(b, extra);
    try {
      validateRequest(b);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SolveError).code).toBe('INVALID_REQUEST');
    }
  });
});
