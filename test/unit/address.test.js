const addr = require('../../public/lib/address.js');
const { normalizeStreet, leadingNumber, parseAddressQuery, candidateHouseMatches, scoreResult } = addr;

describe('normalizeStreet', () => {
  it('expands street-type abbreviations to a canonical form', () => {
    expect(normalizeStreet('83 Queen St')).toBe('83 queen street');
    expect(normalizeStreet('12 Smith Rd')).toBe('12 smith road');
    expect(normalizeStreet('5 Ocean Pde')).toBe('5 ocean parade');
  });
  it('makes an abbreviated query equal its full-word result', () => {
    expect(normalizeStreet('83 queen st')).toBe(normalizeStreet('83 Queen Street'));
    expect(normalizeStreet('1 george ave')).toBe(normalizeStreet('1 George Avenue'));
  });
  it('strips punctuation and collapses whitespace', () => {
    expect(normalizeStreet('83  Queen   St.,')).toBe('83 queen street');
  });
});

describe('leadingNumber', () => {
  it('reads a plain house number', () => expect(leadingNumber('83 Queen St')).toBe('83'));
  it('reads a unit/street form', () => expect(leadingNumber('2/83 Queen St')).toBe('2/83'));
  it('reads a range', () => expect(leadingNumber('12-14 Pitt St')).toBe('12-14'));
  it('reads an alpha suffix', () => expect(leadingNumber('12a Smith Rd')).toBe('12a'));
  it('is empty when there is no leading number', () => expect(leadingNumber('Queen Street')).toBe(''));
});

describe('parseAddressQuery', () => {
  it('flags a number-led query as an address and splits street/locality', () => {
    const p = parseAddressQuery('83 queen st ashfield');
    expect(p.isAddress).toBe(true);
    expect(p.houseNumber).toBe('83');
    expect(p.street).toBe('queen street');
    expect(p.locality).toBe('ashfield');
  });
  it('handles a range with no locality', () => {
    const p = parseAddressQuery('12-14 Pitt St');
    expect(p).toMatchObject({ isAddress: true, houseNumber: '12-14', street: 'pitt street', locality: '' });
  });
  it('treats a bare street name as a non-address', () => {
    const p = parseAddressQuery('queen street');
    expect(p.isAddress).toBe(false);
  });
});

describe('candidateHouseMatches', () => {
  const parsed = parseAddressQuery('83 queen st');
  it('matches a house result with the same number', () => {
    expect(candidateHouseMatches({ name: '83 Queen Street', house: true }, parsed)).toBe(true);
  });
  it('rejects a different number', () => {
    expect(candidateHouseMatches({ name: '85 Queen Street', house: true }, parsed)).toBe(false);
  });
  it('rejects a non-house result', () => {
    expect(candidateHouseMatches({ name: 'Queen Street', house: false }, parsed)).toBe(false);
  });
});

describe('scoreResult — address mode', () => {
  const near = { lat: -33.888, lng: 151.125 };
  // The civic address the user wants, ~2km away.
  const house = { name: '83 Queen Street', sub: 'Ashfield, NSW', house: true, importance: 0.85, lat: -33.888, lng: 151.100 };
  // A nearby bus stop / POI 80m away that shares the street tokens.
  const busStop = { name: 'Queen Street', sub: 'Ashfield', house: false, importance: 0.7, lat: -33.8887, lng: 151.125 };
  const q = '83 queen st ashfield';

  it('ranks the correct house above a much closer bus stop', () => {
    expect(scoreResult(house, q, near)).toBeGreaterThan(scoreResult(busStop, q, near));
  });
  it('handles abbreviation mismatch (st vs Street) without penalty', () => {
    const full = scoreResult(house, '83 queen street ashfield', near);
    const abbr = scoreResult(house, '83 queen st ashfield', near);
    expect(abbr).toBeCloseTo(full, 5);
  });
  it('keeps every score within [0,1] even with all boosts', () => {
    const fav = scoreResult(house, q, { ...near, isFav: true });
    expect(fav).toBeLessThanOrEqual(1);
    expect(fav).toBeGreaterThanOrEqual(0);
  });
  it('down-weights a POI when the user clearly typed an address', () => {
    const poi = { name: 'Queen Street Cafe', sub: 'Ashfield', house: false, importance: 0.6, lat: near.lat, lng: near.lng };
    expect(scoreResult(house, q, near)).toBeGreaterThan(scoreResult(poi, q, near));
  });
});

describe('scoreResult — place/POI mode', () => {
  const near = { lat: -33.888, lng: 151.125 };
  it('rewards proximity when no house number is typed', () => {
    const a = { name: 'Central Cafe', house: false, importance: 0.5, lat: -33.8885, lng: 151.125 }; // ~60m
    const b = { name: 'Central Cafe', house: false, importance: 0.5, lat: -33.95, lng: 151.20 };    // far
    expect(scoreResult(a, 'central cafe', near)).toBeGreaterThan(scoreResult(b, 'central cafe', near));
  });
});
