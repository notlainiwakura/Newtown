import { describe, expect, it } from 'vitest';

describe('Newtown buildings', () => {
  it('exposes the expected 3x3 grid', async () => {
    const { BUILDINGS } = await import('../src/commune/buildings.js');
    expect(BUILDINGS.map((building) => building.name)).toEqual([
      'Pub',
      'Station',
      'Abandoned House',
      'Field',
      'Windmill',
      'Locksmith',
      'Mystery Tower',
      'Theater',
      'Square',
    ]);
  });

  it('assigns residents to the intended default starting locations', async () => {
    const { DEFAULT_LOCATIONS } = await import('../src/commune/buildings.js');
    expect(DEFAULT_LOCATIONS).toEqual({
      newtown: 'square',
      neo: 'station',
      plato: 'mystery-tower',
      joe: 'square',
    });
  });
});
