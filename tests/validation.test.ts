import { describe, expect, it } from 'vitest';
import { validateRequest } from '../src/core/validation.js';
import { SolveError } from '../src/core/types.js';
import { sampleRequest } from './fixtures/sample.js';

const valid = (): typeof sampleRequest => JSON.parse(JSON.stringify(sampleRequest));

describe('validateRequest', () => {
  it('accepts the canonical sample', () => {
    expect(() => validateRequest(valid())).not.toThrow();
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['missing modulus', { ...valid(), modulus: undefined }],
    ['non-integer interval', { ...valid(), minInterval: 1.5 }],
  ])('rejects %s', (_label, body) => {
    expect(() => validateRequest(body)).toThrow(SolveError);
  });

  it('rejects modulus below 2', () => {
    const b = valid();
    b.modulus = 1;
    try {
      validateRequest(b);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as SolveError).code).toBe('INVALID_REQUEST');
    }
  });

  it('rejects inverted count window', () => {
    const b = valid();
    b.countLower = 100;
    b.countUpper = 0;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects negative or inverted sample interval', () => {
    const b1 = valid();
    b1.minInterval = 0;
    expect(() => validateRequest(b1)).toThrow(SolveError);
    const b2 = valid();
    b2.maxInterval = 1;
    b2.minInterval = 5;
    expect(() => validateRequest(b2)).toThrow(SolveError);
  });

  it('rejects packet counts outside 6..14', () => {
    const b = valid();
    b.packets = b.packets.slice(0, 5);
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects duplicate packet ids', () => {
    const b = valid();
    b.packets[1] = { ...b.packets[0] };
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects remainder outside [0, modulus)', () => {
    const b = valid();
    b.packets[0].remainder = 10;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects inverted time intervals', () => {
    const b = valid();
    b.packets[0].timeLower = 100;
    b.packets[0].timeUpper = 0;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects excessively large count search windows', () => {
    const b = valid();
    b.countUpper = b.countLower + 2_000_000;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('accepts a valid dormancy interval', () => {
    const b = valid();
    b.dormancyLower = 40;
    b.dormancyUpper = 60;
    const r = validateRequest(b);
    expect(r.dormancyLower).toBe(40);
    expect(r.dormancyUpper).toBe(60);
  });

  it('accepts the absence of both dormancy fields', () => {
    const r = validateRequest(valid());
    expect(r.dormancyLower).toBeUndefined();
    expect(r.dormancyUpper).toBeUndefined();
  });

  it('rejects a dormancy lower bound without its upper bound (and vice versa)', () => {
    const onlyLower = valid();
    onlyLower.dormancyLower = 10;
    expect(() => validateRequest(onlyLower)).toThrow(SolveError);
    const onlyUpper = valid();
    onlyUpper.dormancyUpper = 10;
    expect(() => validateRequest(onlyUpper)).toThrow(SolveError);
  });

  it('rejects an inverted dormancy interval', () => {
    const b = valid();
    b.dormancyLower = 60;
    b.dormancyUpper = 40;
    expect(() => validateRequest(b)).toThrow(SolveError);
  });

  it('rejects non-positive or non-integer dormancy bounds', () => {
    const zero = valid();
    zero.dormancyLower = 0;
    zero.dormancyUpper = 10;
    expect(() => validateRequest(zero)).toThrow(SolveError);
    const negative = valid();
    negative.dormancyLower = -5;
    negative.dormancyUpper = 10;
    expect(() => validateRequest(negative)).toThrow(SolveError);
    const fractional = valid();
    fractional.dormancyLower = 1.5;
    fractional.dormancyUpper = 10;
    expect(() => validateRequest(fractional)).toThrow(SolveError);
  });
});
