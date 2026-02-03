/**
 * Worker for building terrain mesh geometry from Mapbox tile data
 * Supports variable resolution and world bounds
 */

const _N = { x: 0, y: 0, z: 0 };

function vec3Cross(out, a, b) {
  out.x = a.y * b.z - a.z * b.y;
  out.y = a.z * b.x - a.x * b.z;
  out.z = a.x * b.y - a.y * b.x;
}

function vec3Normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len > 0) {
    v.x /= len;
    v.y /= len;
    v.z /= len;
  }
}

const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

const lerpColor = (c1, c2, t) => ({
  r: lerp(c1.r, c2.r, t),
  g: lerp(c1.g, c2.g, t),
  b: lerp(c1.b, c2.b, t)
});

/**
 * Bilinear interpolation for height sampling
 */
function sampleHeightBilinear(heightData, tileSize, u, v) {
  v = 1 - v;
  u = 1 - u;
  // u, v are in [0, 1]
  const px = u * (tileSize - 1);
  const py = v * (tileSize - 1);

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, tileSize - 1);
  const y1 = Math.min(y0 + 1, tileSize - 1);

  const fx = px - x0;
  const fy = py - y0;

  const h00 = heightData[y0 * tileSize + x0] || 0;
  const h10 = heightData[y0 * tileSize + x1] || 0;
  const h01 = heightData[y1 * tileSize + x0] || 0;
  const h11 = heightData[y1 * tileSize + x1] || 0;

  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;

  return h0 * (1 - fy) + h1 * fy;
}

function samplePixelColor(colorData, tileSize, x, y) {
  const position = (x + y * tileSize) * 3;

  const r = colorData[position] / 255;
  const g = colorData[position + 1] / 255;
  const b = colorData[position + 2] / 255;

  return { r, g, b };
}

function samplePixelBilinear(colorData, tileSize, u, v) {
    v = 1 - v;
    u = 1 - u;
  // u, v are in [0, 1]
  const px = u * (tileSize - 1);
  const py = v * (tileSize - 1);

  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, tileSize - 1);
  const y1 = Math.min(y0 + 1, tileSize - 1);

  const fx = px - x0;
  const fy = py - y0;

  const h00 = samplePixelColor(colorData, tileSize, x0, y0);
  const h10 = samplePixelColor(colorData, tileSize, x1, y0);
  const h01 = samplePixelColor(colorData, tileSize, x0, y1);
  const h11 = samplePixelColor(colorData, tileSize, x1, y1);

  const h0 = lerpColor(h00, h10, fx);
  const h1 = lerpColor(h01, h11, fx);

  return lerpColor(h0, h1, fy);
}

/**
 * Terrain mesh builder for Mapbox tiles
 */
class TileTerrainBuilder {
  constructor() {
    this._params = null;
  }

  init(params) {
    this._params = params;
  }

  /**
   * Build terrain mesh from Mapbox tile data
   */
  buildTile() {
    const {
      resolution,
      heightData,
      colorData,
      tileSize,
      worldMinX, worldMaxX,
      worldMinZ, worldMaxZ,
      heightScale
    } = this._params;

    const gridSize = resolution + 1;
    const worldWidth = worldMaxX - worldMinX;
    const worldDepth = worldMaxZ - worldMinZ;

    // Generate positions and other attributes
    const positions = new Float32Array(gridSize * gridSize * 3);
    const colors = new Float32Array(gridSize * gridSize * 3);
    const coords = new Float32Array(gridSize * gridSize * 3);

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const idx = (gy * gridSize + gx) * 3;

        // Normalized coordinates [0, 1]
        const u = gx / resolution;
        const v = gy / resolution;

        // Sample height from tile data with bilinear interpolation
        const height = sampleHeightBilinear(heightData, tileSize, u, v) * heightScale;

        // World position
        const posX = worldMinX + u * worldWidth;
        const posZ = worldMinZ + v * worldDepth;

        positions[idx] = posX;
        positions[idx + 1] = height;
        positions[idx + 2] = posZ;

        // Coords for texturing
        coords[idx] = posX;
        coords[idx + 1] = height;
        coords[idx + 2] = posZ;

        // Color based on height
        // const color = this._getTerrainColor(height);
        // colors[idx] = color.r;
        // colors[idx + 1] = color.g;
        // colors[idx + 2] = color.b;
        const color = lerpColor(
          samplePixelBilinear(colorData, tileSize, u, v),
          this._getTerrainColor(height),
          0
        );
        
        colors[idx] = color.r;
        colors[idx + 1] = color.g;
        colors[idx + 2] = color.b;
      }
    }

    // Generate indices
    const indices = this._generateIndices(resolution);

    // Generate normals
    const normals = this._generateNormals(positions, indices, gridSize);

    // Create SharedArrayBuffers for transfer
    const bytesInFloat32 = 4;
    const bytesInUint32 = 4;

    const positionsBuffer = new Float32Array(new SharedArrayBuffer(bytesInFloat32 * positions.length));
    const normalsBuffer = new Float32Array(new SharedArrayBuffer(bytesInFloat32 * normals.length));
    const colorsBuffer = new Float32Array(new SharedArrayBuffer(bytesInFloat32 * colors.length));
    const coordsBuffer = new Float32Array(new SharedArrayBuffer(bytesInFloat32 * coords.length));
    const indicesBuffer = new Uint32Array(new SharedArrayBuffer(bytesInUint32 * indices.length));

    positionsBuffer.set(positions);
    normalsBuffer.set(normals);
    colorsBuffer.set(colors);
    coordsBuffer.set(coords);
    indicesBuffer.set(indices);

    return {
      positions: positionsBuffer,
      normals: normalsBuffer,
      colours: colorsBuffer,
      coords: coordsBuffer,
      indices: indicesBuffer
    };
  }

  /**
   * Generate triangle indices for the grid
   */
  _generateIndices(resolution) {
    const gridSize = resolution + 1;
    const indices = [];

    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        const topLeft = y * gridSize + x;
        const topRight = topLeft + 1;
        const bottomLeft = (y + 1) * gridSize + x;
        const bottomRight = bottomLeft + 1;

        // First triangle
        indices.push(topLeft, bottomLeft, topRight);
        // Second triangle
        indices.push(topRight, bottomLeft, bottomRight);
      }
    }

    return indices;
  }

  /**
   * Generate smooth normals from positions and indices
   */
  _generateNormals(positions, indices, gridSize) {
    const normals = new Float32Array(positions.length);
    const _V1 = { x: 0, y: 0, z: 0 };
    const _V2 = { x: 0, y: 0, z: 0 };
    const _V3 = { x: 0, y: 0, z: 0 };

    // Accumulate face normals to vertices
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i] * 3;
      const i1 = indices[i + 1] * 3;
      const i2 = indices[i + 2] * 3;

      _V1.x = positions[i0];
      _V1.y = positions[i0 + 1];
      _V1.z = positions[i0 + 2];

      _V2.x = positions[i1];
      _V2.y = positions[i1 + 1];
      _V2.z = positions[i1 + 2];

      _V3.x = positions[i2];
      _V3.y = positions[i2 + 1];
      _V3.z = positions[i2 + 2];

      // Edge vectors
      const e1 = { x: _V2.x - _V1.x, y: _V2.y - _V1.y, z: _V2.z - _V1.z };
      const e2 = { x: _V3.x - _V1.x, y: _V3.y - _V1.y, z: _V3.z - _V1.z };

      // Cross product for face normal
      vec3Cross(_N, e1, e2);

      // Accumulate to all three vertices
      normals[i0] += _N.x;
      normals[i0 + 1] += _N.y;
      normals[i0 + 2] += _N.z;

      normals[i1] += _N.x;
      normals[i1 + 1] += _N.y;
      normals[i1 + 2] += _N.z;

      normals[i2] += _N.x;
      normals[i2 + 1] += _N.y;
      normals[i2 + 2] += _N.z;
    }

    // Normalize all normals
    for (let i = 0; i < normals.length; i += 3) {
      _N.x = normals[i];
      _N.y = normals[i + 1];
      _N.z = normals[i + 2];
      vec3Normalize(_N);
      normals[i] = _N.x;
      normals[i + 1] = _N.y;
      normals[i + 2] = _N.z;
    }

    return normals;
  }

  /**
   * Get terrain color based on height
   */
  _getTerrainColor(absoluteHeight) {
    // Color stops (height in meters)
    const waterLevel = 0;
    const beachLevel = 10;
    const grassLevel = 500;
    const forestLevel = 1500;
    const rockLevel = 2500;
    const snowLevel = 3500;

    // Colors
    const deepWater = { r: 0.1, g: 0.2, b: 0.5 };
    const shallowWater = { r: 0.2, g: 0.4, b: 0.6 };
    const beach = { r: 0.85, g: 0.83, b: 0.65 };
    const grass = { r: 0.3, g: 0.6, b: 0.2 };
    const forest = { r: 0.2, g: 0.4, b: 0.15 };
    const rock = { r: 0.5, g: 0.45, b: 0.4 };
    const snow = { r: 0.95, g: 0.95, b: 0.97 };

    const h = absoluteHeight;

    if (h < waterLevel) {
      const t = Math.max(0, Math.min(1, (h + 100) / 100));
      return lerpColor(deepWater, shallowWater, t);
    } else if (h < beachLevel) {
      const t = h / beachLevel;
      return lerpColor(shallowWater, beach, t);
    } else if (h < grassLevel) {
      const t = (h - beachLevel) / (grassLevel - beachLevel);
      return lerpColor(beach, grass, t);
    } else if (h < forestLevel) {
      const t = (h - grassLevel) / (forestLevel - grassLevel);
      return lerpColor(grass, forest, t);
    } else if (h < rockLevel) {
      const t = (h - forestLevel) / (rockLevel - forestLevel);
      return lerpColor(forest, rock, t);
    } else if (h < snowLevel) {
      const t = (h - rockLevel) / (snowLevel - rockLevel);
      return lerpColor(rock, snow, t);
    } else {
      return snow;
    }
  }
}

// Worker instance
const _builder = new TileTerrainBuilder();

// Handle messages
self.onmessage = (msg) => {
  if (msg.data.subject === 'build_tile') {
    _builder.init(msg.data.params);
    const result = _builder.buildTile();
    self.postMessage({ subject: 'build_tile_result', data: result });
  }
};
