import { describe, it, expect } from 'vitest';
import { parseAddress, mapPhoton, mapNominatim, dedupe, normStreet } from '../../src/geocode';

const photonHouse = {
  features: [{
    properties: { housenumber: '83', street: 'Queen Street', suburb: 'Ashfield', state: 'New South Wales', osm_key: 'place', osm_value: 'house' },
    geometry: { coordinates: [151.1250, -33.8880] },
  }, {
    // a bus stop that free-text Photon also returns
    properties: { name: 'Queen St', osm_key: 'highway', osm_value: 'bus_stop', suburb: 'Ashfield', state: 'New South Wales' },
    geometry: { coordinates: [151.1249, -33.8887] },
  }],
};

const nominatimHouse = [{
  lat: '-33.8880', lon: '151.1250', display_name: '83, Queen Street, Ashfield, NSW',
  category: 'building', type: 'house', importance: 0.3,
  address: { house_number: '83', road: 'Queen Street', suburb: 'Ashfield', state: 'New South Wales' },
}];

describe('normStreet', () => {
  it('canonicalises abbreviations for dedupe keys', () => {
    expect(normStreet('83 Queen St')).toBe('83 queen street');
    expect(normStreet('83 Queen St')).toBe(normStreet('83 Queen Street'));
  });
});

describe('parseAddress', () => {
  it('splits a civic address into street + locality for the structured pass', () => {
    expect(parseAddress('83 queen st ashfield')).toEqual({
      isAddress: true, houseNumber: '83', street: '83 queen st', locality: 'ashfield',
    });
  });
  it('keeps the number in the street field with no locality', () => {
    expect(parseAddress('12-14 Pitt St')).toMatchObject({ isAddress: true, street: '12-14 Pitt St', locality: '' });
  });
  it('flags a bare street as not-an-address', () => {
    expect(parseAddress('queen street').isAddress).toBe(false);
  });
});

describe('mapPhoton', () => {
  it('keeps the house number in the name and tags houses', () => {
    const [house, bus] = mapPhoton(photonHouse);
    expect(house).toMatchObject({ name: '83 Queen Street', house: true, importance: 0.9 });
    expect(bus).toMatchObject({ name: 'Queen St', house: false });
  });
  it('is safe on empty/absent input', () => {
    expect(mapPhoton(null)).toEqual([]);
    expect(mapPhoton({})).toEqual([]);
  });
});

describe('mapNominatim', () => {
  it('reconstructs the civic address name from house_number + road', () => {
    expect(mapNominatim(nominatimHouse)[0]).toMatchObject({ name: '83 Queen Street', house: true, importance: 0.9 });
  });
  it('is safe on non-array input', () => {
    expect(mapNominatim(null)).toEqual([]);
    expect(mapNominatim({ error: 'x' })).toEqual([]);
  });
});

describe('dedupe', () => {
  it('collapses the same civic address arriving from multiple providers', () => {
    const merged = dedupe([mapPhoton(photonHouse), mapNominatim(nominatimHouse)]);
    const houses = merged.filter(r => r.house && r.name === '83 Queen Street');
    expect(houses).toHaveLength(1);
    // the distinct bus stop survives
    expect(merged.some(r => !r.house && r.name === 'Queen St')).toBe(true);
  });
  it('keeps distinct nearby non-house places apart (5dp coords)', () => {
    const a = { lat: -33.88801, lng: 151.12501, name: 'Cafe', sub: '', osmKey: '', osmVal: '', house: false, importance: 0.5 };
    const b = { ...a, lat: -33.88805 };
    expect(dedupe([[a, b]])).toHaveLength(2);
  });
  it('drops entries with invalid coordinates', () => {
    const bad = { lat: NaN, lng: 151, name: 'X', sub: '', osmKey: '', osmVal: '', house: false, importance: 0.5 };
    expect(dedupe([[bad as any]])).toHaveLength(0);
  });
});
