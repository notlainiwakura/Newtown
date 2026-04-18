import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(import.meta.dirname, '..', 'src', 'web', 'public', 'game', 'js', 'pathfinding.js');

function loadFindPath(): (collision: number[][], sx: number, sy: number, ex: number, ey: number) => { x: number; y: number }[] {
  const code = readFileSync(scriptPath, 'utf-8');
  const fn = new Function(code + '\nreturn findPath;');
  return fn() as ReturnType<typeof loadFindPath>;
}

describe('A* Pathfinding', () => {
  const openGrid = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ];

  it('finds a straight-line path on an open grid', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 0, 0, 4, 0);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1);
    }
  });

  it('navigates around a wall', () => {
    const findPath = loadFindPath();
    const grid = [
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    const path = findPath(grid, 0, 0, 4, 0);
    expect(path.length).toBeGreaterThan(0);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 4, y: 0 });
    for (const tile of path) {
      expect(grid[tile.y][tile.x]).toBe(0);
    }
  });

  it('returns empty array when no path exists', () => {
    const findPath = loadFindPath();
    const grid = [
      [0, 1, 0],
      [1, 1, 1],
      [0, 1, 0],
    ];
    const path = findPath(grid, 0, 0, 2, 2);
    expect(path).toEqual([]);
  });

  it('returns single-element path when start equals end', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 2, 2, 2, 2);
    expect(path).toEqual([{ x: 2, y: 2 }]);
  });

  it('only uses cardinal directions (no diagonals)', () => {
    const findPath = loadFindPath();
    const path = findPath(openGrid, 0, 0, 3, 3);
    expect(path.length).toBeGreaterThan(0);
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1);
    }
    expect(path.length).toBe(7);
  });

  it('returns empty for out-of-bounds coordinates', () => {
    const findPath = loadFindPath();
    expect(findPath(openGrid, -1, 0, 4, 4)).toEqual([]);
    expect(findPath(openGrid, 0, 0, 99, 99)).toEqual([]);
  });

  it('returns empty when start or end tile is blocked', () => {
    const findPath = loadFindPath();
    const grid = [
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 1],
    ];
    expect(findPath(grid, 0, 0, 2, 2)).toEqual([]);
    expect(findPath(grid, 1, 0, 0, 0)).toEqual([]);
  });
});
