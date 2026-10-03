import { describe, expect, it } from 'vitest';
import { handleSolve } from '../src/api/handler.js';
import { sampleRequest, sampleExpected, dormantSampleRequest, dormantSampleExpected } from './fixtures/sample.js';

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
});

describe('handleSolve: dormancy model', () => {
  it('recovers the dormancy pause for the low-battery sample', () => {
    const res = handleSolve(dormantSampleRequest);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(res.data.order).toEqual(dormantSampleExpected.order);
    expect(res.data.dormancy).toBeDefined();
    expect(res.data.dormancy!.duration).toBe(dormantSampleExpected.duration);
    expect(res.data.dormancy!.boundaryIndex).toBe(dormantSampleExpected.boundaryIndex);
    expect(res.data.dormancy!.fromId).toBe(dormantSampleExpected.fromId);
    expect(res.data.dormancy!.toId).toBe(dormantSampleExpected.toId);
    const carrying = res.data.adjacency.filter((ev) => ev.dormancy !== undefined);
    expect(carrying).toHaveLength(1);
    expect(carrying[0].index).toBe(dormantSampleExpected.boundaryIndex);
  });

  it('leaves legacy responses byte-identical when no dormancy fields are given', () => {
    const res = handleSolve(sampleRequest);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect('dormancy' in res.data).toBe(false);
    for (const ev of res.data.adjacency) expect('dormancy' in ev).toBe(false);
  });

  it('rejects a lone dormancy bound and inverted dormancy bounds', () => {
    for (const body of [
      { ...sampleRequest, dormancyLower: 10 },
      { ...sampleRequest, dormancyUpper: 10 },
      { ...sampleRequest, dormancyLower: 60, dormancyUpper: 40 },
      { ...sampleRequest, dormancyLower: 0, dormancyUpper: 10 },
    ]) {
      const res = handleSolve(body);
      expect(res.status).toBe('error');
      if (res.status !== 'error') throw new Error('expected error');
      expect(res.error.code).toBe('INVALID_REQUEST');
    }
  });

  it('returns NO_CONSISTENT_INTERPRETATION with a dormancy status when unsatisfiable', () => {
    // The pause interval [5, 10] cannot explain the D->E silence of the
    // low-battery sample.
    const res = handleSolve({ ...dormantSampleRequest, dormancyLower: 5, dormancyUpper: 10 });
    expect(res.status).toBe('error');
    if (res.status !== 'error') throw new Error('expected error');
    expect(res.error.code).toBe('NO_CONSISTENT_INTERPRETATION');
    const evidence = res.error.evidence as { dormancyStatus?: string } | undefined;
    expect(evidence?.dormancyStatus).toBeDefined();
    expect(['unused', 'crossing', 'used']).toContain(evidence!.dormancyStatus);
  });
});
