/**
 * Mapbox Terrain-RGB tile loader and height provider
 *
 * Fetches terrain-rgb tiles and decodes elevation data
 * Height formula: height = -10000 + ((R * 256 * 256 + G * 256 + B) * 0.1)
 */

export const mapbox_terrain = (function() {

  // Tile size in pixels
  const TILE_SIZE = 256;

  // Convert longitude to tile X coordinate
  function lon2tileX(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  }

  // Convert latitude to tile Y coordinate
  function lat2tileY(lat, zoom) {
    return Math.floor(
      (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)
    );
  }

  // Convert tile X to longitude
  function tileX2lon(x, zoom) {
    return x / Math.pow(2, zoom) * 360 - 180;
  }

  // Convert tile Y to latitude
  function tileY2lat(y, zoom) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // Get the fractional position within a tile for a given lon/lat
  function getFractionalTileCoords(lon, lat, zoom) {
    const x = (lon + 180) / 360 * Math.pow(2, zoom);
    const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);
    return {
      tileX: Math.floor(x),
      tileY: Math.floor(y),
      fracX: x - Math.floor(x),
      fracY: y - Math.floor(y)
    };
  }

  // Decode terrain-rgb pixel to height in meters
  function decodeHeight(r, g, b) {
    return -10000 + ((r * 256 * 256 + g * 256 + b) * 0.1);
  }

  // Tile data cache
  class TileCache {
    constructor(maxSize = 256) {
      this._cache = new Map();
      this._maxSize = maxSize;
      this._accessOrder = [];
    }

    _makeKey(z, x, y) {
      return `${z}/${x}/${y}`;
    }

    get(z, x, y) {
      const key = this._makeKey(z, x, y);
      if (this._cache.has(key)) {
        // Move to end of access order (LRU)
        const idx = this._accessOrder.indexOf(key);
        if (idx > -1) {
          this._accessOrder.splice(idx, 1);
        }
        this._accessOrder.push(key);
        return this._cache.get(key);
      }
      return null;
    }

    set(z, x, y, data) {
      const key = this._makeKey(z, x, y);

      // Evict oldest entries if at capacity
      while (this._cache.size >= this._maxSize && this._accessOrder.length > 0) {
        const oldestKey = this._accessOrder.shift();
        this._cache.delete(oldestKey);
      }

      this._cache.set(key, data);
      this._accessOrder.push(key);
    }

    has(z, x, y) {
      return this._cache.has(this._makeKey(z, x, y));
    }
  }

  // Pending tile loads
  class LoadingTracker {
    constructor() {
      this._pending = new Map();
    }

    _makeKey(z, x, y) {
      return `${z}/${x}/${y}`;
    }

    isLoading(z, x, y) {
      return this._pending.has(this._makeKey(z, x, y));
    }

    getPromise(z, x, y) {
      return this._pending.get(this._makeKey(z, x, y));
    }

    setLoading(z, x, y, promise) {
      this._pending.set(this._makeKey(z, x, y), promise);
    }

    clearLoading(z, x, y) {
      this._pending.delete(this._makeKey(z, x, y));
    }
  }


  /**
   * MapboxTerrainProvider - Main class for accessing Mapbox terrain data
   */
  class MapboxTerrainProvider {
    constructor(params = {}) {
      this._accessToken = new URLSearchParams(location.search).get('token');
      this._zoom = params.zoom || 12;
      this._tileCache = new TileCache(params.cacheSize || 256);
      this._loadingTracker = new LoadingTracker();
      this._heightScale = params.heightScale || 1.0;
      this._canvas = null;
      this._ctx = null;
    }

    set accessToken(token) {
      this._accessToken = token;
    }

    get accessToken() {
      return this._accessToken;
    }

    set zoom(z) {
      this._zoom = Math.max(0, Math.min(15, Math.floor(z)));
    }

    get zoom() {
      return this._zoom;
    }

    set heightScale(scale) {
      this._heightScale = scale;
    }

    get heightScale() {
      return this._heightScale;
    }

    _getTileUrl(z, x, y) {
      return `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${this._accessToken}`;
    }

    _ensureCanvas() {
      if (!this._canvas) {
        this._canvas = document.createElement('canvas');
        this._canvas.width = TILE_SIZE;
        this._canvas.height = TILE_SIZE;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
      }
    }

    /**
     * Load a tile and return its height data as a Float32Array
     */
    async loadTile(z, x, y) {
      // Check cache first
      const cached = this._tileCache.get(z, x, y);
      if (cached) {
        return cached;
      }

      // Check if already loading
      if (this._loadingTracker.isLoading(z, x, y)) {
        return this._loadingTracker.getPromise(z, x, y);
      }

      // Start loading
      const loadPromise = this._fetchAndDecodeTile(z, x, y);
      this._loadingTracker.setLoading(z, x, y, loadPromise);

      try {
        const data = await loadPromise;
        this._tileCache.set(z, x, y, data);
        return data;
      } finally {
        this._loadingTracker.clearLoading(z, x, y);
      }
    }

    async _fetchAndDecodeTile(z, x, y) {
      let url = this._getTileUrl(z, x, y);

      return new Promise(async (resolve, reject) => {
        const blob = await (await fetch(url, {
          mode: 'cors',
          credentials: 'omit' // Necessary for strict COEP
        })).blob();

        url = URL.createObjectURL(blob);
        
        const img = new Image();
        img.crossOrigin = 'anonymous';

        img.onload = () => {
          this._ensureCanvas();
          this._ctx.drawImage(img, 0, 0);
          const imageData = this._ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE);

          // Create height data array
          const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
          const data = imageData.data;

          for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            heights[i] = decodeHeight(r, g, b) * this._heightScale;
          }

          resolve({
            heights: heights,
            width: TILE_SIZE,
            height: TILE_SIZE,
            z: z,
            x: x,
            y: y,
            bounds: {
              west: tileX2lon(x, z),
              east: tileX2lon(x + 1, z),
              north: tileY2lat(y, z),
              south: tileY2lat(y + 1, z)
            }
          });
        };

        img.onerror = (e) => {
          console.error(`Failed to load tile ${z}/${x}/${y}:`, e);
          // Return zero heights on error
          const heights = new Float32Array(TILE_SIZE * TILE_SIZE);
          heights.fill(0);
          resolve({
            heights: heights,
            width: TILE_SIZE,
            height: TILE_SIZE,
            z: z,
            x: x,
            y: y,
            bounds: {
              west: tileX2lon(x, z),
              east: tileX2lon(x + 1, z),
              north: tileY2lat(y, z),
              south: tileY2lat(y + 1, z)
            },
            error: true
          });
        };

        img.src = url;
      });
    }

    /**
     * Get height at a specific lon/lat position
     * Returns a Promise that resolves to the height in meters
     */
    async getHeightAt(lon, lat) {
      const coords = getFractionalTileCoords(lon, lat, this._zoom);
      const tile = await this.loadTile(this._zoom, coords.tileX, coords.tileY);

      // Bilinear interpolation
      const px = coords.fracX * (TILE_SIZE - 1);
      const py = coords.fracY * (TILE_SIZE - 1);

      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
      const y1 = Math.min(y0 + 1, TILE_SIZE - 1);

      const fx = px - x0;
      const fy = py - y0;

      const h00 = tile.heights[y0 * TILE_SIZE + x0];
      const h10 = tile.heights[y0 * TILE_SIZE + x1];
      const h01 = tile.heights[y1 * TILE_SIZE + x0];
      const h11 = tile.heights[y1 * TILE_SIZE + x1];

      // Bilinear interpolation
      const h0 = h00 * (1 - fx) + h10 * fx;
      const h1 = h01 * (1 - fx) + h11 * fx;

      return h0 * (1 - fy) + h1 * fy;
    }

    /**
     * Prefetch tiles for a given bounds
     */
    async prefetchTiles(westLon, southLat, eastLon, northLat, zoom = null) {
      const z = zoom || this._zoom;

      const minX = lon2tileX(westLon, z);
      const maxX = lon2tileX(eastLon, z);
      const minY = lat2tileY(northLat, z); // Note: Y is inverted
      const maxY = lat2tileY(southLat, z);

      const promises = [];
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          promises.push(this.loadTile(z, x, y));
        }
      }

      return Promise.all(promises);
    }

    /**
     * Get tile coordinates for a given lon/lat
     */
    getTileCoords(lon, lat, zoom = null) {
      const z = zoom || this._zoom;
      return {
        z: z,
        x: lon2tileX(lon, z),
        y: lat2tileY(lat, z)
      };
    }

    /**
     * Get the bounds of a tile in lon/lat
     */
    getTileBounds(z, x, y) {
      return {
        west: tileX2lon(x, z),
        east: tileX2lon(x + 1, z),
        north: tileY2lat(y, z),
        south: tileY2lat(y + 1, z)
      };
    }

    /**
     * Check if a tile is cached
     */
    isTileCached(z, x, y) {
      return this._tileCache.has(z, x, y);
    }

    /**
     * Get cached tile data (returns null if not cached)
     */
    getCachedTile(z, x, y) {
      return this._tileCache.get(z, x, y);
    }
  }


  /**
   * HeightGenerator wrapper for use with the terrain system
   * Provides synchronous height access using cached tiles
   */
  class MapboxHeightGenerator {
    constructor(terrainProvider, params = {}) {
      this._provider = terrainProvider;
      this._centerLon = params.centerLon || 0;
      this._centerLat = params.centerLat || 0;
      this._metersPerUnit = params.metersPerUnit || 1;
      this._defaultHeight = params.defaultHeight || 0;
    }

    /**
     * Convert world X/Y to lon/lat
     * Assumes world is centered on centerLon/centerLat
     */
    worldToLonLat(worldX, worldY) {
      // Simple equirectangular approximation
      // At the equator, 1 degree ~ 111320 meters
      const metersPerDegree = 111320;

      const lon = this._centerLon + (worldX * this._metersPerUnit) / (metersPerDegree * Math.cos(this._centerLat * Math.PI / 180));
      const lat = this._centerLat + (worldY * this._metersPerUnit) / metersPerDegree;

      return { lon, lat };
    }

    /**
     * Get height at world position (synchronous - uses cached data)
     * Returns default height if tile not loaded
     */
    Get(x, y, z) {
      const { lon, lat } = this.worldToLonLat(x, y);

      const zoom = this._provider.zoom;
      const coords = getFractionalTileCoords(lon, lat, zoom);
      const tile = this._provider.getCachedTile(zoom, coords.tileX, coords.tileY);

      if (!tile) {
        return [this._defaultHeight, 0]; // Height, weight (0 = not loaded)
      }

      // Bilinear interpolation
      const px = coords.fracX * (TILE_SIZE - 1);
      const py = coords.fracY * (TILE_SIZE - 1);

      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
      const y1 = Math.min(y0 + 1, TILE_SIZE - 1);

      const fx = px - x0;
      const fy = py - y0;

      const h00 = tile.heights[y0 * TILE_SIZE + x0];
      const h10 = tile.heights[y0 * TILE_SIZE + x1];
      const h01 = tile.heights[y1 * TILE_SIZE + x0];
      const h11 = tile.heights[y1 * TILE_SIZE + x1];

      const h0 = h00 * (1 - fx) + h10 * fx;
      const h1 = h01 * (1 - fx) + h11 * fx;
      const height = h0 * (1 - fy) + h1 * fy;

      return [height, 1]; // Height, weight (1 = loaded)
    }
  }

  return {
    MapboxTerrainProvider: MapboxTerrainProvider,
    MapboxHeightGenerator: MapboxHeightGenerator,
    lon2tileX: lon2tileX,
    lat2tileY: lat2tileY,
    tileX2lon: tileX2lon,
    tileY2lat: tileY2lat,
    getFractionalTileCoords: getFractionalTileCoords,
    decodeHeight: decodeHeight,
    TILE_SIZE: TILE_SIZE
  };
})();
