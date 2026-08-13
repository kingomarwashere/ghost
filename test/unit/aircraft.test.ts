import { describe, it, expect } from 'vitest';
import {
  tagPolice, toPlane, bboxToPointRadius, POLICE_HEX,
  type AdsbAircraft,
} from '../../src/data/police-aircraft';

describe('tagPolice', () => {
  it('tags a known allow-list hex with its operator', () => {
    const t = tagPolice({ hex: '7c4ced' }); // VH-PHB, NSW PolAir
    expect(t.police).toBe(true);
    expect(t.operator).toMatch(/NSW Police/);
  });

  it('is case-insensitive and strips the ~ (TIS-B) prefix on hex', () => {
    expect(tagPolice({ hex: '7C4EF2' }).police).toBe(true);   // VIC, upper-case
    expect(tagPolice({ hex: '~7c4ced' }).police).toBe(true);  // TIS-B prefixed
  });

  it('heuristically tags VH-PH / VH-PV regos not yet in the allow-list', () => {
    expect(tagPolice({ hex: 'abc123', r: 'VH-PHZ' })).toMatchObject({ police: true, operator: 'NSW Police (PolAir)' });
    expect(tagPolice({ hex: 'abc124', r: 'VH-PVX' })).toMatchObject({ police: true, operator: 'Victoria Police Air Wing' });
  });

  it('tags a POLAIR callsign', () => {
    expect(tagPolice({ hex: 'def456', flight: 'POLAIR21 ' }).police).toBe(true);
  });

  it('tags the expanded multi-state allow-list with correct operators', () => {
    expect(tagPolice({ hex: '7caedf' }).operator).toMatch(/QLD Police/);   // VH-8TT
    expect(tagPolice({ hex: '7c7180' }).operator).toMatch(/WA Police/);    // VH-WPE
    expect(tagPolice({ hex: '7c2496' }).operator).toMatch(/SAPOL/);        // VH-HIG
    expect(tagPolice({ hex: '7c79fd' }).operator).toMatch(/NT Police/);    // VH-YDR
    expect(tagPolice({ hex: '7cb08f' }).operator).toMatch(/Federal/);      // VH-85T
    expect(tagPolice({ hex: '7c151d' }).operator).toMatch(/QGAir/);        // VH-EGF
  });

  it('does NOT tag an ordinary airliner', () => {
    const t = tagPolice({ hex: '7c6db2', r: 'VH-VKA', flight: 'QFA123', t: 'B738' });
    expect(t.police).toBe(false);
    expect(t.operator).toBeNull();
  });

  it('does NOT treat the military dbFlags bit as police', () => {
    // military ≠ police; police fly civil regos and are matched by hex/rego/callsign
    expect(tagPolice({ hex: '7cf7c0', dbFlags: 1 }).police).toBe(false);
  });
});

describe('toPlane', () => {
  it('maps the ADSBx shape to the slim browser shape and carries police tagging', () => {
    const ac: AdsbAircraft = {
      hex: '7c4ced', flight: 'POLAIR ', r: 'VH-PHB', t: 'AS50',
      lat: -33.87, lon: 151.2, alt_baro: 1500, gs: 92.4, track: 270, category: 'A7',
    };
    const p = toPlane(ac)!;
    expect(p).toMatchObject({
      hex: '7c4ced', lng: 151.2, lat: -33.87, alt: 1500, gs: 92, track: 270,
      flight: 'POLAIR', reg: 'VH-PHB', type: 'AS50', police: true,
    });
  });

  it('drops aircraft without a position', () => {
    expect(toPlane({ hex: 'x', flight: 'GHOST1' })).toBeNull();
  });

  it('treats a grounded ("ground") altitude as null', () => {
    const p = toPlane({ hex: 'x', lat: -33, lon: 151, alt_baro: 'ground' })!;
    expect(p.alt).toBeNull();
  });
});

describe('bboxToPointRadius', () => {
  it('centres on the box and returns a radius covering it, capped at 250 NM', () => {
    // ~Sydney metro box
    const r = bboxToPointRadius(-34.1, 150.9, -33.7, 151.4);
    expect(r.lat).toBeCloseTo(-33.9, 5);
    expect(r.lon).toBeCloseTo(151.15, 5);
    expect(r.radiusNm).toBeGreaterThan(0);
    expect(r.radiusNm).toBeLessThanOrEqual(250);
  });

  it('caps a continent-sized box at the 250 NM API limit', () => {
    const r = bboxToPointRadius(-44, 112, -10, 154); // most of Australia
    expect(r.radiusNm).toBe(250);
  });
});

describe('POLICE_HEX allow-list', () => {
  it('keys are lower-case hex so runtime lookups match', () => {
    for (const k of Object.keys(POLICE_HEX)) expect(k).toBe(k.toLowerCase());
  });
});
