import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.125/build/three.module.js';
import {GUI} from 'https://cdn.jsdelivr.net/npm/three@0.125/examples/jsm/libs/dat.gui.module.js';
import {controls} from './controls.js';
import {game} from './game.js';
import {flat_terrain} from './flat-terrain.js';

let _APP = null;


class ProceduralTerrain_Demo extends game.Game {
  constructor() {
    super();
  }

  _OnInitialize() {
    this._CreateGUI();

    // Check crossOriginIsolated status for SharedArrayBuffer support
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      console.log('crossOriginIsolated: true - SharedArrayBuffer enabled');
    } else {
      console.warn('crossOriginIsolated: false - SharedArrayBuffer may not work');
      console.warn('Run with: node server.js');
    }

    // Camera position for flat terrain (start above ground looking forward)
    this.graphics_.Camera.position.set(0, 2000, -5000);
    this.graphics_.Camera.lookAt(0, 0, 0);

    this._AddEntity('_terrain', new flat_terrain.FlatTerrainManager({
        camera: this.graphics_.Camera,
        scene: this.graphics_.Scene,
        scattering: this.graphics_._depthPass,
        gui: this._gui,
        guiParams: this._guiParams,
        game: this}), 1.0);

    this._AddEntity('_controls', new controls.FPSControls({
        camera: this.graphics_.Camera,
        scene: this.graphics_.Scene,
        domElement: this.graphics_._threejs.domElement,
        gui: this._gui,
        guiParams: this._guiParams}), 0.0);

    this._totalTime = 0;

    this._LoadBackground();
  }

  _CreateGUI() {
    this._guiParams = {
      general: {
      },
    };
    this._gui = new GUI();

    const generalRollup = this._gui.addFolder('General');
    this._gui.close();
  }

  _LoadBackground() {
    // Sky blue gradient background for flat terrain
    this.graphics_.Scene.background = new THREE.Color(0x87CEEB);
  }

  _OnStep(timeInSeconds) {
  }
}


function _Main() {
  _APP = new ProceduralTerrain_Demo();
}

_Main();
