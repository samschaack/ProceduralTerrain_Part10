/**
 * Flat terrain system using Mapbox terrain-rgb tiles with LOD
 * Uses Mapbox tile pyramid directly as quadtree for seamless LOD
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.125/build/three.module.js';

import {mapbox_terrain} from './mapbox-terrain.js';
import {terrain_shader} from './terrain-shader.js';

export const flat_terrain = (function() {

  const _NUM_WORKERS = 7;

  // Default location: Swiss Alps (Matterhorn area)
  const DEFAULT_CENTER_LAT = 45.9763;
  const DEFAULT_CENTER_LON = 7.6586;

  // Earth circumference at equator in meters
  const EARTH_CIRCUMFERENCE = 40075016.686;

  let _workerIds = 0;

  /**
   * Worker thread wrapper
   */
  class WorkerThread {
    constructor(workerPath) {
      this._worker = new Worker(workerPath, { type: 'module' });
      this._worker.onmessage = (e) => this._onMessage(e);
      this._resolve = null;
      this._id = _workerIds++;
    }

    _onMessage(e) {
      const resolve = this._resolve;
      this._resolve = null;
      if (resolve) resolve(e.data);
    }

    get id() { return this._id; }

    postMessage(msg, resolve) {
      this._resolve = resolve;
      this._worker.postMessage(msg);
    }
  }

  /**
   * Worker pool for parallel chunk building
   */
  class WorkerPool {
    constructor(size, workerPath) {
      this._workers = Array.from({ length: size }, () => new WorkerThread(workerPath));
      this._free = [...this._workers];
      this._busy = {};
      this._queue = [];
    }

    get busy() {
      return this._queue.length > 0 || Object.keys(this._busy).length > 0;
    }

    get queueLength() {
      return this._queue.length;
    }

    enqueue(workItem, resolve) {
      this._queue.push([workItem, resolve]);
      this._pump();
    }

    _pump() {
      while (this._free.length > 0 && this._queue.length > 0) {
        const worker = this._free.pop();
        this._busy[worker.id] = worker;

        const [workItem, workResolve] = this._queue.shift();

        worker.postMessage(workItem, (result) => {
          delete this._busy[worker.id];
          this._free.push(worker);
          workResolve(result);
          this._pump();
        });
      }
    }
  }


  // ============== Tile Math Utilities ==============

  /**
   * Convert longitude to tile X at given zoom
   */
  function lon2tileX(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
  }

  /**
   * Convert latitude to tile Y at given zoom
   */
  function lat2tileY(lat, zoom) {
    const latRad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * Math.pow(2, zoom));
  }

  /**
   * Convert tile X to longitude (west edge)
   */
  function tileX2lon(x, zoom) {
    return x / Math.pow(2, zoom) * 360 - 180;
  }

  /**
   * Convert tile Y to latitude (north edge)
   */
  function tileY2lat(y, zoom) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  /**
   * Get tile bounds in lon/lat
   */
  function getTileBounds(z, x, y) {
    return {
      west: tileX2lon(x, z),
      east: tileX2lon(x + 1, z),
      north: tileY2lat(y, z),
      south: tileY2lat(y + 1, z)
    };
  }

  /**
   * Get approximate tile size in meters at given latitude and zoom
   */
  function getTileSizeMeters(lat, zoom) {
    const metersPerTile = EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return metersPerTile;
  }


  /**
   * Flat terrain chunk - represents a single Mapbox tile
   */
  class FlatTerrainChunk {
    constructor(params) {
      this._params = params;
      this._mesh = null;
      this._geometry = null;
      this._visible = false;

      this._init();
    }

    _init() {
      this._geometry = new THREE.BufferGeometry();
      this._mesh = new THREE.Mesh(this._geometry, this._params.material);
      this._mesh.castShadow = false;
      this._mesh.receiveShadow = true;
      this._mesh.frustumCulled = false;

      this._params.group.add(this._mesh);
    }

    get params() { return this._params; }

    rebuildFromData(data) {
      this._geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.positions, 3));
      this._geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
      this._geometry.setAttribute('color', new THREE.Float32BufferAttribute(data.colours, 3));
      this._geometry.setAttribute('coords', new THREE.Float32BufferAttribute(data.coords, 3));
      this._geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));

      this._geometry.attributes.position.needsUpdate = true;
      this._geometry.attributes.normal.needsUpdate = true;
      this._geometry.attributes.color.needsUpdate = true;
      this._geometry.attributes.coords.needsUpdate = true;

      this._geometry.computeBoundingBox();
      this._geometry.computeBoundingSphere();
    }

    show() {
      if (!this._visible) {
        this._mesh.visible = true;
        this._visible = true;
      }
    }

    hide() {
      if (this._visible) {
        this._mesh.visible = false;
        this._visible = false;
      }
    }

    update(cameraPosition) {
      // Floating origin - offset mesh by negative camera position
      this._mesh.position.set(
        -cameraPosition.x,
        -cameraPosition.y,
        -cameraPosition.z
      );
    }

    destroy() {
      this._params.group.remove(this._mesh);
      this._geometry.dispose();
    }
  }


  /**
   * Main terrain manager using Mapbox tile pyramid for LOD
   */
  class FlatTerrainManager {
    constructor(params) {
      this._params = params;
      this._chunks = {};

      // Geographic center (world origin)
      this._centerLon = DEFAULT_CENTER_LON;
      this._centerLat = DEFAULT_CENTER_LAT;

      // LOD settings
      this._minZoom = 8;      // Farthest tiles (largest)
      this._maxZoom = 14;     // Nearest tiles (smallest, most detailed)
      this._lodFactor = 1.5;  // Distance multiplier for LOD transitions
      this._resolution = 64;  // Vertices per tile edge
      this._heightScale = 1.0;

      // Mapbox
      this._mapboxToken = '';
      this._terrainProvider = null;

      // Chunk loading throttling
      this._loadingChunks = 0;
      this._maxConcurrentLoads = 6;

      this._init();
    }

    _init() {
      this._initWorkerPool();
      this._initMaterial();
      this._initTerrainProvider();
      this._initGui();

      this._group = new THREE.Group();
      this._params.scene.add(this._group);
    }

    _initWorkerPool() {
      this._workerPool = new WorkerPool(_NUM_WORKERS, 'src/flat-terrain-worker.js');
    }

    _initMaterial() {
      const loader = new THREE.TextureLoader();
      const noiseTexture = loader.load('./resources/simplex-noise.png');
      noiseTexture.wrapS = THREE.RepeatWrapping;
      noiseTexture.wrapT = THREE.RepeatWrapping;

      this._material = new THREE.RawShaderMaterial({
        uniforms: {
          noiseMap: { value: noiseTexture },
          logDepthBufFC: {
            value: 2.0 / (Math.log(this._params.camera.far + 1.0) / Math.LN2)
          }
        },
        vertexShader: terrain_shader.VS,
        fragmentShader: terrain_shader.PS,
        side: THREE.FrontSide
      });
    }

    _initTerrainProvider() {
      this._terrainProvider = new mapbox_terrain.MapboxTerrainProvider({
        accessToken: this._mapboxToken,
        zoom: this._maxZoom,  // Provider uses max zoom for fetching
        heightScale: this._heightScale,
        cacheSize: 1024
      });
    }

    _initGui() {
      const gui = this._params.gui;
      const guiParams = this._params.guiParams;

      guiParams.mapbox = {
        accessToken: this._mapboxToken,
        minZoom: this._minZoom,
        maxZoom: this._maxZoom,
        lodFactor: this._lodFactor,
        centerLat: this._centerLat,
        centerLon: this._centerLon,
        heightScale: this._heightScale,
        wireframe: false
      };

      const folder = gui.addFolder('Mapbox Terrain');

      folder.add(guiParams.mapbox, 'accessToken').name('Access Token').onFinishChange((v) => {
        this._mapboxToken = v;
        this._terrainProvider.accessToken = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'minZoom', 1, 12, 1).name('Min Zoom (far)').onChange((v) => {
        this._minZoom = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'maxZoom', 8, 15, 1).name('Max Zoom (near)').onChange((v) => {
        this._maxZoom = v;
        this._terrainProvider.zoom = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'lodFactor', 0.5, 3.0).name('LOD Factor').onChange((v) => {
        this._lodFactor = v;
      });

      folder.add(guiParams.mapbox, 'centerLat', -85, 85).name('Center Latitude').onChange((v) => {
        this._centerLat = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'centerLon', -180, 180).name('Center Longitude').onChange((v) => {
        this._centerLon = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'heightScale', 0.1, 5).name('Height Scale').onChange((v) => {
        this._heightScale = v;
        this._terrainProvider.heightScale = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'wireframe').name('Wireframe').onChange((v) => {
        this._material.wireframe = v;
      });

      folder.open();
    }

    _rebuildAllChunks() {
      // Destroy all existing chunks
      for (const key in this._chunks) {
        if (this._chunks[key].chunk) {
          this._chunks[key].chunk.destroy();
        }
      }
      this._chunks = {};
    }

    /**
     * Convert world position (meters from center) to lon/lat
     */
    worldToLonLat(worldX, worldZ) {
      const metersPerDegreeLon = EARTH_CIRCUMFERENCE * Math.cos(this._centerLat * Math.PI / 180) / 360;
      const metersPerDegreeLat = EARTH_CIRCUMFERENCE / 360;

      const lon = this._centerLon + worldX / metersPerDegreeLon;
      const lat = this._centerLat + worldZ / metersPerDegreeLat;
      return { lon, lat };
    }

    /**
     * Convert lon/lat to world position (meters from center)
     */
    lonLatToWorld(lon, lat) {
      const metersPerDegreeLon = EARTH_CIRCUMFERENCE * Math.cos(this._centerLat * Math.PI / 180) / 360;
      const metersPerDegreeLat = EARTH_CIRCUMFERENCE / 360;

      const worldX = (lon - this._centerLon) * metersPerDegreeLon;
      const worldZ = (lat - this._centerLat) * metersPerDegreeLat;
      return { x: worldX, z: worldZ };
    }

    /**
     * Get the set of tiles that should be visible using quadtree LOD
     * Returns Map of key -> {z, x, y, bounds, worldBounds}
     */
    _getVisibleTiles(cameraPos) {
      const tiles = new Map();
      const cameraLonLat = this.worldToLonLat(cameraPos.x, cameraPos.z);

      // Start with tiles at minimum zoom level around the camera
      const startZoom = this._minZoom;
      const centerTileX = lon2tileX(cameraLonLat.lon, startZoom);
      const centerTileY = lat2tileY(cameraLonLat.lat, startZoom);

      // Check tiles in a radius around the center tile at min zoom
      const radius = 3;  // Check 7x7 grid at min zoom
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          const tileX = centerTileX + dx;
          const tileY = centerTileY + dy;

          // Skip invalid tiles
          if (tileY < 0 || tileY >= Math.pow(2, startZoom)) continue;

          this._subdivideOrAddTile(startZoom, tileX, tileY, cameraPos, tiles);
        }
      }

      return tiles;
    }

    /**
     * Recursively subdivide tile or add it to visible set
     */
    _subdivideOrAddTile(z, x, y, cameraPos, tiles) {
      const bounds = getTileBounds(z, x, y);

      // Convert tile bounds to world coordinates
      const sw = this.lonLatToWorld(bounds.west, bounds.south);
      const ne = this.lonLatToWorld(bounds.east, bounds.north);

      const worldBounds = {
        minX: sw.x,
        maxX: ne.x,
        minZ: sw.z,
        maxZ: ne.z
      };

      // Calculate tile center in world coords
      const tileCenterX = (worldBounds.minX + worldBounds.maxX) / 2;
      const tileCenterZ = (worldBounds.minZ + worldBounds.maxZ) / 2;

      // Distance from camera to tile center
      const distance = Math.sqrt(
        (tileCenterX - cameraPos.x) ** 2 +
        (tileCenterZ - cameraPos.z) ** 2
      );

      // Tile size in meters
      const tileSize = Math.abs(worldBounds.maxX - worldBounds.minX);

      // LOD decision: subdivide if close enough and not at max zoom
      const lodThreshold = tileSize * this._lodFactor;
      const shouldSubdivide = distance < lodThreshold && z < this._maxZoom;

      // Check if tile is too far (rough culling)
      const maxViewDistance = getTileSizeMeters(this._centerLat, this._minZoom) * 4;
      if (distance > maxViewDistance) {
        return;  // Skip this tile entirely
      }

      if (shouldSubdivide) {
        // Subdivide into 4 child tiles at next zoom level
        const childZ = z + 1;
        const childX = x * 2;
        const childY = y * 2;

        this._subdivideOrAddTile(childZ, childX, childY, cameraPos, tiles);
        this._subdivideOrAddTile(childZ, childX + 1, childY, cameraPos, tiles);
        this._subdivideOrAddTile(childZ, childX, childY + 1, cameraPos, tiles);
        this._subdivideOrAddTile(childZ, childX + 1, childY + 1, cameraPos, tiles);
      } else {
        // Add this tile to visible set
        const key = `${z}/${x}/${y}`;
        tiles.set(key, { z, x, y, bounds, worldBounds });
      }
    }

    /**
     * Create a terrain chunk for a Mapbox tile
     */
    async _createTileChunk(z, x, y, worldBounds) {
      const key = `${z}/${x}/${y}`;

      // Load the tile height data
      const tileData = await this._terrainProvider.loadTile(z, x, y);

      // Create chunk params
      const chunkParams = {
        group: this._group,
        material: this._material,
        tileKey: key,
        zoom: z,
        tileX: x,
        tileY: y
      };

      const chunk = new FlatTerrainChunk(chunkParams);
      chunk.hide();

      // Send to worker for mesh building
      const workerParams = {
        resolution: this._resolution,
        heightData: tileData.heights,
        tileSize: 256,  // Mapbox tiles are 256x256
        worldMinX: worldBounds.minX,
        worldMaxX: worldBounds.maxX,
        worldMinZ: worldBounds.minZ,
        worldMaxZ: worldBounds.maxZ,
        heightScale: this._heightScale
      };

      return new Promise((resolve) => {
        this._workerPool.enqueue(
          { subject: 'build_tile', params: workerParams },
          (result) => {
            if (result.subject === 'build_tile_result') {
              chunk.rebuildFromData(result.data);
            }
            resolve({ chunk, key });
          }
        );
      });
    }

    /**
     * Update terrain - called every frame
     */
    Update(deltaTime) {
      const cameraPos = this._params.camera.position;

      // Get the set of tiles that should be visible
      const visibleTiles = this._getVisibleTiles(cameraPos);

      // Find chunks to remove
      const chunksToRemove = [];
      for (const key in this._chunks) {
        if (!visibleTiles.has(key)) {
          const chunkData = this._chunks[key];
          if (chunkData.chunk && !chunkData.pending) {
            chunksToRemove.push(key);
          }
        }
      }

      // Remove old chunks
      for (const key of chunksToRemove) {
        const chunkData = this._chunks[key];
        if (chunkData.chunk) {
          chunkData.chunk.destroy();
        }
        delete this._chunks[key];
      }

      // Find tiles to create (sorted by zoom level descending - higher detail first)
      const tilesToCreate = [];
      for (const [key, tileInfo] of visibleTiles) {
        if (!this._chunks[key]) {
          tilesToCreate.push({ key, ...tileInfo });
        }
      }

      // Sort by zoom (higher zoom = more detail = prioritize) and distance
      tilesToCreate.sort((a, b) => {
        // Prioritize higher zoom levels
        if (b.z !== a.z) return b.z - a.z;

        // Then by distance
        const distA = Math.sqrt(
          ((a.worldBounds.minX + a.worldBounds.maxX) / 2 - cameraPos.x) ** 2 +
          ((a.worldBounds.minZ + a.worldBounds.maxZ) / 2 - cameraPos.z) ** 2
        );
        const distB = Math.sqrt(
          ((b.worldBounds.minX + b.worldBounds.maxX) / 2 - cameraPos.x) ** 2 +
          ((b.worldBounds.minZ + b.worldBounds.maxZ) / 2 - cameraPos.z) ** 2
        );
        return distA - distB;
      });

      // Create new chunks (limited concurrent loads)
      for (const tile of tilesToCreate) {
        if (this._loadingChunks >= this._maxConcurrentLoads) break;

        this._chunks[tile.key] = { pending: true, key: tile.key };
        this._loadingChunks++;

        this._createTileChunk(tile.z, tile.x, tile.y, tile.worldBounds)
          .then(({ chunk, key }) => {
            this._loadingChunks--;
            if (this._chunks[key]) {
              this._chunks[key] = { chunk, key, pending: false };
              chunk.show();
            } else {
              chunk.destroy();
            }
          })
          .catch(err => {
            this._loadingChunks--;
            console.error('Error creating tile chunk:', err);
            delete this._chunks[tile.key];
          });
      }

      // Update all visible chunks
      for (const key in this._chunks) {
        const data = this._chunks[key];
        if (data.chunk && !data.pending) {
          data.chunk.update(cameraPos);
        }
      }
    }

    destroy() {
      for (const key in this._chunks) {
        if (this._chunks[key].chunk) {
          this._chunks[key].chunk.destroy();
        }
      }
      this._chunks = {};
      this._params.scene.remove(this._group);
    }
  }

  return {
    FlatTerrainManager: FlatTerrainManager,
    FlatTerrainChunk: FlatTerrainChunk
  };
})();
