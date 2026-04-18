/**
 * LAINTOWN GAME — A* Pathfinding
 * Finds tile-by-tile paths on the collision map grid.
 * Used by CharacterManager for inter-building walking animation.
 */

/**
 * Find a walkable path between two tile coordinates using A*.
 * @param {number[][]} collision - 2D collision map (0 = walkable, 1 = blocked)
 * @param {number} sx - Start tile X
 * @param {number} sy - Start tile Y
 * @param {number} ex - End tile X
 * @param {number} ey - End tile Y
 * @returns {{x: number, y: number}[]} Ordered array of tiles from start to end, or empty if no path
 */
function findPath(collision, sx, sy, ex, ey) {
  if (sx === ex && sy === ey) return [{ x: sx, y: sy }];

  const rows = collision.length;
  if (!rows) return [];
  const cols = collision[0].length;

  if (sx < 0 || sx >= cols || sy < 0 || sy >= rows) return [];
  if (ex < 0 || ex >= cols || ey < 0 || ey >= rows) return [];
  if (collision[sy][sx] || collision[ey][ex]) return [];

  const DIRS = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];

  function heuristic(x, y) {
    return Math.abs(x - ex) + Math.abs(y - ey);
  }

  const open = [];
  const closed = new Set();
  const gScore = {};
  const cameFrom = {};

  function key(x, y) { return x + ',' + y; }

  const startKey = key(sx, sy);
  gScore[startKey] = 0;
  open.push({ x: sx, y: sy, f: heuristic(sx, sy) });

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) bestIdx = i;
    }
    const current = open.splice(bestIdx, 1)[0];
    const ck2 = key(current.x, current.y);
    if (closed.has(ck2)) continue;
    closed.add(ck2);

    if (current.x === ex && current.y === ey) {
      const path = [];
      let k = key(current.x, current.y);
      while (k !== undefined) {
        const parts = k.split(',');
        path.push({ x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) });
        k = cameFrom[k];
      }
      path.reverse();
      return path;
    }

    const currentG = gScore[ck2];

    for (const dir of DIRS) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;

      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      if (collision[ny][nx]) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentativeG = currentG + 1;

      if (gScore[nk] === undefined || tentativeG < gScore[nk]) {
        gScore[nk] = tentativeG;
        cameFrom[nk] = ck2;
        const f = tentativeG + heuristic(nx, ny);

        let found = false;
        for (let i = 0; i < open.length; i++) {
          if (open[i].x === nx && open[i].y === ny) {
            open[i].f = f;
            found = true;
            break;
          }
        }
        if (!found) {
          open.push({ x: nx, y: ny, f: f });
        }
      }
    }
  }

  return [];
}
