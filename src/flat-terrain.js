/**
 * Flat terrain system using Mapbox terrain-rgb tiles
 * Replaces the spherical planet terrain with a flat world
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.125/build/three.module.js';

import {mapbox_terrain} from './mapbox-terrain.js';
import {terrain_chunk} from './terrain-chunk.js';
import {terrain_shader} from './terrain-shader.js';

export const flat_terrain = (function() {

  const _NUM_WORKERS = 7;

  // Default location: Swiss Alps (Matterhorn area)
  const DEFAULT_CENTER_LAT = 45.9763;
  const DEFAULT_CENTER_LON = 7.6586;

  // Meters per world unit (1 unit = 1 meter)
  const METERS_PER_UNIT = 1;

  // Meters per degree at equator
  const METERS_PER_DEGREE = 111320;

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


  /**
   * Simple 2D quadtree for flat terrain LOD
   */
  class QuadTreeNode {
    constructor(x, y, size, level) {
      this.x = x;
      this.y = y;
      this.size = size;
      this.level = level;
      this.children = null;
    }

    subdivide() {
      const halfSize = this.size / 2;
      this.children = [
        new QuadTreeNode(this.x, this.y, halfSize, this.level + 1),
        new QuadTreeNode(this.x + halfSize, this.y, halfSize, this.level + 1),
        new QuadTreeNode(this.x, this.y + halfSize, halfSize, this.level + 1),
        new QuadTreeNode(this.x + halfSize, this.y + halfSize, halfSize, this.level + 1)
      ];
      return this.children;
    }

    get center() {
      return {
        x: this.x + this.size / 2,
        y: this.y + this.size / 2
      };
    }

    get key() {
      return `${this.x}/${this.y}/${this.size}`;
    }
  }


  /**
   * Flat terrain chunk - represents a single terrain tile
   */
  class FlatTerrainChunk {
    constructor(params) {
      this._params = params;
      this._mesh = null;
      this._geometry = null;
      this._visible = false;
      this._rebuildData = null;

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
    set params(p) { this._params = p; }

    get rebuildData() { return this._rebuildData; }

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

      this._rebuildData = {
        positions: data.positions,
        normals: data.normals,
        colours: data.colours,
        coords: data.coords,
        indices: data.indices
      };
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
      // Update mesh position relative to camera (floating origin)
      // Vertices are in absolute world coordinates, so just offset by -cameraPosition
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

    setWireframe(enabled) {
      this._params.material.wireframe = enabled;
    }
  }


  /**
   * Main terrain manager for flat Mapbox terrain
   */
  class FlatTerrainManager {
    constructor(params) {
      this._params = params;
      this._chunks = {};
      this._oldChunks = [];
      this._chunkPool = {};

      // Geographic center
      this._centerLon = DEFAULT_CENTER_LON;
      this._centerLat = DEFAULT_CENTER_LAT;

      // Terrain settings
      this._chunkSize = 1000; // meters
      this._maxChunkSize = 16000; // meters
      this._resolution = 64; // vertices per side
      this._viewDistance = 8000; // meters
      this._heightScale = 1.0;

      // Mapbox
      this._mapboxToken = '';
      this._mapboxZoom = 12;
      this._terrainProvider = null;

      // Chunk loading throttling
      this._loadingChunks = 0;
      this._maxConcurrentLoads = 4; // Limit concurrent chunk loads

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
        zoom: this._mapboxZoom,
        heightScale: this._heightScale,
        cacheSize: 512
      });
    }

    _initGui() {
      const gui = this._params.gui;
      const guiParams = this._params.guiParams;

      guiParams.mapbox = {
        accessToken: this._mapboxToken,
        zoom: this._mapboxZoom,
        centerLat: this._centerLat,
        centerLon: this._centerLon,
        heightScale: this._heightScale,
        viewDistance: this._viewDistance,
        wireframe: false
      };

      const folder = gui.addFolder('Mapbox Terrain');

      folder.add(guiParams.mapbox, 'accessToken').name('Access Token').onFinishChange((v) => {
        this._mapboxToken = v;
        this._terrainProvider.accessToken = v;
        this._rebuildAllChunks();
      });

      folder.add(guiParams.mapbox, 'zoom', 1, 15, 1).name('Tile Zoom').onChange((v) => {
        this._mapboxZoom = v;
        this._terrainProvider.zoom = v;
        this._rebuildAllChunks();
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

      folder.add(guiParams.mapbox, 'viewDistance', 1000, 50000).name('View Distance').onChange((v) => {
        this._viewDistance = v;
      });

      folder.add(guiParams.mapbox, 'wireframe').name('Wireframe').onChange((v) => {
        this._material.wireframe = v;
      });

      folder.open();
    }

    _rebuildAllChunks() {
      // Clear all chunks and rebuild
      for (const key in this._chunks) {
        this._oldChunks.push(this._chunks[key]);
      }
      this._chunks = {};
    }

    /**
     * Convert world position to lon/lat
     */
    worldToLonLat(worldX, worldY) {
      const metersPerDegree = METERS_PER_DEGREE * Math.cos(this._centerLat * Math.PI / 180);
      const lon = this._centerLon + worldX / metersPerDegree;
      const lat = this._centerLat + worldY / METERS_PER_DEGREE;
      return { lon, lat };
    }

    /**
     * Convert lon/lat to world position
     */
    lonLatToWorld(lon, lat) {
      const metersPerDegree = METERS_PER_DEGREE * Math.cos(this._centerLat * Math.PI / 180);
      const worldX = (lon - this._centerLon) * metersPerDegree;
      const worldY = (lat - this._centerLat) * METERS_PER_DEGREE;
      return { x: worldX, y: worldY };
    }

    /**
     * Get the set of chunk keys that should be visible for a given camera position
     * Uses a fixed grid - chunks are at fixed world positions (multiples of chunkSize)
     */
    _getVisibleChunkKeys(cameraPos) {
      const keys = new Set();
      const chunkSize = this._chunkSize;
      const viewDist = this._viewDistance;

      // Calculate grid range around camera
      const minX = Math.floor((cameraPos.x - viewDist) / chunkSize) * chunkSize;
      const maxX = Math.floor((cameraPos.x + viewDist) / chunkSize) * chunkSize;
      const minZ = Math.floor((cameraPos.z - viewDist) / chunkSize) * chunkSize;
      const maxZ = Math.floor((cameraPos.z + viewDist) / chunkSize) * chunkSize;

      // Add all chunks within view distance
      for (let x = minX; x <= maxX; x += chunkSize) {
        for (let z = minZ; z <= maxZ; z += chunkSize) {
          // Check if chunk center is within view distance
          const centerX = x + chunkSize / 2;
          const centerZ = z + chunkSize / 2;
          const dist = Math.sqrt(
            (centerX - cameraPos.x) ** 2 +
            (centerZ - cameraPos.z) ** 2
          );

          if (dist < viewDist + chunkSize) {
            keys.add(`${x}/${z}/${chunkSize}`);
          }
        }
      }

      return keys;
    }

    /**
     * Create a terrain chunk at a fixed grid position
     */
    async _createChunkAtGrid(x, z, size) {
      const node = { x, y: z, size, key: `${x}/${z}/${size}` };

      // Calculate bounds in lon/lat
      const sw = this.worldToLonLat(x, z);
      const ne = this.worldToLonLat(x + size, z + size);

      // Prefetch required tiles
      await this._terrainProvider.prefetchTiles(sw.lon, sw.lat, ne.lon, ne.lat);

      // Get height data for this chunk
      const heightData = await this._getHeightDataForChunk(node);

      // Create chunk params
      const chunkParams = {
        group: this._group,
        material: this._material,
        worldPosition: new THREE.Vector3(x + size / 2, 0, z + size / 2),
        size: size,
        resolution: this._resolution,
        node: node
      };

      // Create chunk
      const chunk = new FlatTerrainChunk(chunkParams);
      chunk.hide();

      // Send to worker for mesh building
      const workerParams = {
        size: size,
        resolution: this._resolution,
        heightData: heightData,
        worldX: x,
        worldY: z
      };

      return new Promise((resolve) => {
        this._workerPool.enqueue(
          { subject: 'build_chunk', params: workerParams },
          (result) => {
            if (result.subject === 'build_chunk_result') {
              chunk.rebuildFromData(result.data);
            }
            resolve({ chunk, key: node.key });
          }
        );
      });
    }

    /**
     * Get height data grid for a chunk
     * Uses parallel fetching for better performance
     */
    async _getHeightDataForChunk(node) {
      const resolution = this._resolution + 1;
      const heights = new Float32Array(resolution * resolution);

      // Build array of height fetch promises
      const promises = [];
      const indices = [];

      for (let y = 0; y < resolution; y++) {
        for (let x = 0; x < resolution; x++) {
          const worldX = node.x + (x / (resolution - 1)) * node.size;
          const worldZ = node.y + (y / (resolution - 1)) * node.size;
          const { lon, lat } = this.worldToLonLat(worldX, worldZ);

          indices.push(y * resolution + x);
          promises.push(
            this._terrainProvider.getHeightAt(lon, lat).catch(() => 0)
          );
        }
      }

      // Fetch all heights in parallel
      const results = await Promise.all(promises);

      // Assign results to heights array
      for (let i = 0; i < results.length; i++) {
        heights[indices[i]] = results[i];
      }

      return heights;
    }

    /**
     * Update terrain chunks based on camera position
     * Called every frame by the entity system (synchronous)
     */
    Update(deltaTime) {
      const cameraPos = this._params.camera.position;

      // Get set of chunk keys that should be visible
      const visibleKeys = this._getVisibleChunkKeys(cameraPos);

      // Find chunks to remove (outside view distance and not loading)
      const chunksToRemove = [];
      for (const key in this._chunks) {
        if (!visibleKeys.has(key)) {
          const chunkData = this._chunks[key];
          // Only remove if chunk is fully loaded (keep showing while loading)
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

      // Find chunks to create
      const chunksToCreate = [];
      for (const key of visibleKeys) {
        if (!this._chunks[key]) {
          chunksToCreate.push(key);
        }
      }

      // Sort by distance to camera (prioritize closer chunks)
      chunksToCreate.sort((a, b) => {
        const [ax, az] = a.split('/').map(Number);
        const [bx, bz] = b.split('/').map(Number);
        const distA = Math.sqrt((ax + this._chunkSize/2 - cameraPos.x) ** 2 + (az + this._chunkSize/2 - cameraPos.z) ** 2);
        const distB = Math.sqrt((bx + this._chunkSize/2 - cameraPos.x) ** 2 + (bz + this._chunkSize/2 - cameraPos.z) ** 2);
        return distA - distB;
      });

      // Create new chunks (limited concurrent loads)
      for (const key of chunksToCreate) {
        if (this._loadingChunks >= this._maxConcurrentLoads) break;

        // Parse key to get grid position
        const [x, z, size] = key.split('/').map(Number);

        // Mark as pending
        this._chunks[key] = { pending: true, key };
        this._loadingChunks++;

        // Start async chunk creation
        this._createChunkAtGrid(x, z, size).then(({ chunk, key }) => {
          this._loadingChunks--;
          if (this._chunks[key]) {
            this._chunks[key] = { chunk, key, pending: false };
            chunk.show();
          } else {
            // Chunk was removed while building (camera moved away)
            chunk.destroy();
          }
        }).catch(err => {
          this._loadingChunks--;
          console.error('Error creating chunk:', err);
          delete this._chunks[key];
        });
      }

      // Update all visible chunks (both loading and loaded)
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
    FlatTerrainChunk: FlatTerrainChunk,
    QuadTreeNode: QuadTreeNode
  };
})();
