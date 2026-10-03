import { describe, expect, it } from 'vitest';
import { handleSolve } from '../src/api/handler.js';
import { sampleRequest, sampleExpected } from './fixtures/sample.js';

describe('handleSolve', () => {
  it('returns the recovered order for the canonical sample', () => {
    const res = handleSolve(sampleRequest);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.data.order).toEqual(sampleExpected.order);
    expect(res.data.missingCountTotal).toBe(sampleExpected.missingTotal);
    for (const ev of res.data.adjacency) expect(ev.satisfied).toBe(true);
  });

  it('maps validation failures to INVALID_REQUEST errors', () => {
    const res = handleSolve({ ...sampleRequest, modulus: 1 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_REQUEST');
  });

  it('maps infeasible instances to the stable business error code with evidence', () => {
    const packets = Array.from({ length: 8 }, (_, i) => ({
      id: i,
      remainder: i % 5,
      timeLower: i === 3 ? 9000 : 0,
      timeUpper: i === 3 ? 9001 : 100,
    }));
    const res = handleSolve({ packets, modulus: 5, countLower: 0, countUpper: 200, minInterval: 1, maxInterval: 20 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect(res.error.evidence).toBeTruthy();
    expect(['seed', 'extension']).toContain((res.error.evidence as { stage: string }).stage);
  });

  it('ignores download order: shuffling input packets yields the same solution', () => {
    const shuffled = {
      ...sampleRequest,
      packets: [...sampleRequest.packets].reverse(),
    };
    const a = handleSolve(sampleRequest);
    const b = handleSolve(shuffled);
    expect(a).toEqual(b);
  });

  it('solves a dormancy-required batch and reports the unique pause', () => {
    const packets = [
      { id: 'p5', remainder: 5, timeLower: 149, timeUpper: 151 },
      { id: 'p0', remainder: 0, timeLower: -1, timeUpper: 1 },
      { id: 'p3', remainder: 3, timeLower: 129, timeUpper: 131 },
      { id: 'p1', remainder: 1, timeLower: 9, timeUpper: 11 },
      { id: 'p4', remainder: 4, timeLower: 139, timeUpper: 141 },
      { id: 'p2', remainder: 2, timeLower: 19, timeUpper: 21 },
    ];
    const res = handleSolve({
      packets,
      modulus: 10,
      countLower: 0,
      countUpper: 10,
      minInterval: 10,
      maxInterval: 10,
      dormancyLower: 50,
      dormancyUpper: 150,
    });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.data.dormancy).toMatchObject({
      duration: 100,
      adjacencyIndex: 2,
      fromId: 'p2',
      toId: 'p3',
    });
    expect(res.data.adjacency.filter((e) => e.dormancy?.carriesDormancy)).toHaveLength(1);
  });

  it('rejects half-provided dormancy bounds as INVALID_REQUEST', () => {
    const res = handleSolve({ ...sampleRequest, dormancyLower: 10 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('INVALID_REQUEST');
  });

  it('marks dormancy status in infeasibility evidence', () => {
    const packets = [
      { id: 'p5', remainder: 5, timeLower: 149, timeUpper: 151 },
      { id: 'p0', remainder: 0, timeLower: -1, timeUpper: 1 },
      { id: 'p3', remainder: 3, timeLower: 129, timeUpper: 131 },
      { id: 'p1', remainder: 1, timeLower: 9, timeUpper: 11 },
      { id: 'p4', remainder: 4, timeLower: 139, timeUpper: 141 },
      { id: 'p2', remainder: 2, timeLower: 19, timeUpper: 21 },
    ];
    const res = handleSolve({
      packets,
      modulus: 10,
      countLower: 0,
      countUpper: 10,
      minInterval: 10,
      maxInterval: 10,
      dormancyLower: 50,
      dormancyUpper: 90,
    });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('NO_CONSISTENT_INTERPRETATION');
    expect((res.error.evidence as { dormancyStatus?: string }).dormancyStatus).toBe('CROSSING');
  });
});
