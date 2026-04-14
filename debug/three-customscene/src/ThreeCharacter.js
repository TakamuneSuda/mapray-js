import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import {
  MODEL_HEADING_OFFSET,
  MODEL_HEIGHT_OFFSET,
  MODEL_SCALE,
  MODEL_UP_ROTATION_X,
} from "./config";
import { translateGeoPoint } from "./movement";

export default class ThreeCharacter {
  constructor(viewer, three_scene, actor_position, model_url) {
    this._viewer = viewer;
    this._three_scene = three_scene;
    this._actor_position = actor_position;
    this._model_url = model_url;

    this._ground_height = 0;
    this._load_state = "loading";
    this._load_error = undefined;
    this._mixer = undefined;
    this._model = undefined;
    this._model_root = new THREE.Group();
    this._model_transform_root = new THREE.Group();
    this._active_action = undefined;
    this._idle_action = undefined;
    this._run_action = undefined;
    this._available_clips = [];
    this._heading = 0;

    this._setupScene();
    this._loadModel();
    this.updateAnchor();
  }

  step(delta_seconds, is_running) {
    this._setLocomotionState(is_running);
    this.updateAnchor();
    this._model_root.rotation.z = this._heading + MODEL_HEADING_OFFSET;

    if (this._mixer) {
      this._mixer.update(delta_seconds);
    }
  }

  translate(east_meters, north_meters) {
    translateGeoPoint(this._actor_position, east_meters, north_meters);
  }

  setHeading(heading) {
    this._heading = heading;
  }

  updateAnchor() {
    this._ground_height = this._viewer.getElevation(
      this._actor_position.latitude,
      this._actor_position.longitude,
    );
    this._actor_position.height = this._ground_height;
    this._three_scene.setAnchorGeoPoint(this._actor_position);
  }

  dispose() {
    if (this._mixer) {
      this._mixer.stopAllAction();
      this._mixer = undefined;
    }

    if (!this._model) {
      return;
    }

    this._model.traverse((object) => {
      if (!object.isMesh) {
        return;
      }

      object.geometry?.dispose?.();

      const { material } = object;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else {
        material?.dispose?.();
      }
    });
  }

  getStatus() {
    return {
      model_url: this._model_url,
      load_state: this._load_state,
      load_error: this._load_error,
      available_clips: this._available_clips,
      active_action_name: this._active_action?._clip?.name || "(none)",
      idle_weight: this._formatActionWeight(this._idle_action),
      run_weight: this._formatActionWeight(this._run_action),
      idle_time: this._formatActionTime(this._idle_action),
      run_time: this._formatActionTime(this._run_action),
      mixer_time_scale: this._mixer ? this._mixer.timeScale.toFixed(2) : "-",
      actor_position: this._actor_position,
      ground_height: this._ground_height,
    };
  }

  _setupScene() {
    const scene = this._three_scene.scene;
    const root = this._three_scene.root;

    const hemisphere_light = new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.2);
    hemisphere_light.position.set(0, 0, 20);

    const directional_light = new THREE.DirectionalLight(0xffffff, 1.8);
    directional_light.position.set(-8, -6, 18);

    const axes = new THREE.AxesHelper(120);
    axes.frustumCulled = false;

    this._model_transform_root.rotation.x = MODEL_UP_ROTATION_X;
    this._model_transform_root.position.z = MODEL_HEIGHT_OFFSET;
    this._model_transform_root.scale.setScalar(MODEL_SCALE);

    root.add(hemisphere_light);
    root.add(directional_light);
    root.add(axes);
    root.add(this._model_root);
    this._model_root.add(this._model_transform_root);

    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  }

  _loadModel() {
    const loader = new GLTFLoader();

    loader.load(
      this._model_url,
      (gltf) => {
        this._model = gltf.scene;
        this._model.traverse((object) => {
          object.frustumCulled = false;
        });

        this._model_transform_root.add(this._model);

        if (gltf.animations.length > 0) {
          this._available_clips = gltf.animations.map(
            (animation) => animation.name,
          );
          this._mixer = new THREE.AnimationMixer(this._model);
          this._idle_action = this._findAction(gltf.animations, "idle", 0);
          this._run_action = this._findAction(gltf.animations, "run", 1);
          this._activateBaseActions();
          this._setLocomotionState(false);
        }

        this._load_state = "loaded";
      },
      undefined,
      (error) => {
        this._load_state = "error";
        this._load_error =
          error instanceof Error ? error.message : String(error);
      },
    );
  }

  _findAction(animations, keyword, fallback_index) {
    const clip =
      animations.find((animation) =>
        animation.name.toLowerCase().includes(keyword),
      ) ||
      animations[fallback_index] ||
      animations[0];

    return clip ? this._mixer.clipAction(clip) : undefined;
  }

  _activateBaseActions() {
    for (const action of [this._idle_action, this._run_action]) {
      if (!action) {
        continue;
      }

      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);
      action.play();
    }
  }

  _setLocomotionState(is_running) {
    this._setWeight(this._idle_action, is_running ? 0 : 1);
    this._setWeight(this._run_action, is_running ? 1 : 0);
    this._active_action = is_running ? this._run_action : this._idle_action;
  }

  _setWeight(action, weight) {
    if (!action) {
      return;
    }

    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(weight);
  }

  _formatActionWeight(action) {
    return action ? action.getEffectiveWeight().toFixed(2) : "-";
  }

  _formatActionTime(action) {
    return action ? action.time.toFixed(2) : "-";
  }
}
