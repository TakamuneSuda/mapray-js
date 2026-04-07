import mapray from "@mapray/mapray-js";
import maprayui from "@mapray/ui";

import {
  INITIAL_ACTOR_POSITION,
  MODEL_URL,
  MOVE_SPEED,
} from "./config";
import {
  getMovementDirection,
  MOVE_KEY_NAMES,
  translateGeoPoint,
} from "./movement";
import ThreeCharacter from "./ThreeCharacter";

export default class App extends maprayui.StandardUIViewer {
  constructor(container, options = {}) {
    super(container, process.env.MAPRAY_ACCESS_TOKEN, {
      debug_stats: new mapray.DebugStats(),
    });

    this._status = options.status || undefined;
    this._pressed_keys = new Set();
    this._actor_position = { ...INITIAL_ACTOR_POSITION };
    this._on_key_down = (event) => this._updateMoveKey(event, true);
    this._on_key_up = (event) => this._updateMoveKey(event, false);
    this._on_pointer_down = () => this.viewer.canvas_element.focus();

    this._setInitialCamera();

    this._three_scene = new mapray.ThreeCustomScene(this.viewer, {
      anchor_geo_point: this._actor_position,
      dispose: () => this._disposeResources(),
    });
    this._custom_scene = this._three_scene.custom_scene;
    this._character = new ThreeCharacter(
      this.viewer,
      this._three_scene,
      this._actor_position,
      MODEL_URL,
    );

    this._attachInputHandlers();
    this._update_status();
  }

  onUpdateFrame(delta_time) {
    super.onUpdateFrame(delta_time);

    const movement = getMovementDirection(
      this.getCameraAngle().yaw,
      this._pressed_keys,
    );
    const is_running = movement.lengthSq() > 0;

    if (is_running) {
      movement.normalize();

      const distance = MOVE_SPEED * delta_time;
      const east_meters = -movement.x * distance;
      const north_meters = movement.y * distance;

      this._character.translate(east_meters, north_meters);
      this._moveCamera(east_meters, north_meters);
      this._character.setHeading(Math.atan2(movement.x, movement.y));
    }

    this._character.step(delta_time, is_running);
    this._update_status();
  }

  _setInitialCamera() {
    this.setCameraPosition({
      longitude: INITIAL_ACTOR_POSITION.longitude,
      latitude: INITIAL_ACTOR_POSITION.latitude - 0.03,
      height: 1800,
    });
    this.setLookAtPosition({
      longitude: INITIAL_ACTOR_POSITION.longitude,
      latitude: INITIAL_ACTOR_POSITION.latitude,
      height: 50,
    });
  }

  _attachInputHandlers() {
    document.addEventListener("keydown", this._on_key_down, {
      capture: true,
      passive: false,
    });
    document.addEventListener("keyup", this._on_key_up, {
      capture: true,
      passive: false,
    });
    this.viewer.canvas_element.addEventListener(
      "pointerdown",
      this._on_pointer_down,
    );
    this.viewer.canvas_element.focus();
  }

  _moveCamera(east_meters, north_meters) {
    const camera_position = this.getCameraPosition();
    translateGeoPoint(camera_position, east_meters, north_meters);
    this.setCameraPosition(camera_position);
  }

  _updateMoveKey(event, pressed) {
    if (!MOVE_KEY_NAMES.has(event.key)) {
      return;
    }

    if (pressed) {
      this._pressed_keys.add(event.key);
    } else {
      this._pressed_keys.delete(event.key);
    }

    event.preventDefault();
    event.stopPropagation();
  }

  _disposeResources() {
    document.removeEventListener("keydown", this._on_key_down, {
      capture: true,
    });
    document.removeEventListener("keyup", this._on_key_up, { capture: true });
    this.viewer.canvas_element.removeEventListener(
      "pointerdown",
      this._on_pointer_down,
    );

    this._character?.dispose();
  }

  _update_status() {
    if (!this._status) {
      return;
    }

    const character = this._character?.getStatus();
    const camera_position = this.getCameraPosition();
    const camera_angle = this.getCameraAngle();

    this._status.textContent =
      "CustomScene: enabled\n" +
      "Renderer: three.js on shared WebGL2 context via mapray.ThreeCustomScene\n" +
      `Model: ${character?.model_url || MODEL_URL}\n` +
      `Load: ${character?.load_state || "loading"}\n` +
      (character?.load_error ? `Error: ${character.load_error}\n` : "") +
      `Clips: ${character?.available_clips.join(", ") || "(none)"}\n` +
      `Action: ${character?.active_action_name || "(none)"}\n` +
      `Weights: idle ${character?.idle_weight || "-"} / run ${character?.run_weight || "-"}\n` +
      `Times: idle ${character?.idle_time || "-"} / run ${character?.run_time || "-"}\n` +
      `Mixer timeScale: ${character?.mixer_time_scale || "-"}\n` +
      `Actor: ${this._actor_position.longitude.toFixed(5)}, ${this._actor_position.latitude.toFixed(5)}, ${(character?.ground_height ?? 0).toFixed(1)}m\n` +
      `Keys: ${Array.from(this._pressed_keys).join(", ") || "(none)"}\n` +
      "Move: Arrow keys (run)\n\n" +
      `Camera: ${camera_position.longitude.toFixed(5)}, ${camera_position.latitude.toFixed(5)}, ${camera_position.height.toFixed(1)}m\n` +
      `Angle: pitch ${camera_angle.pitch.toFixed(1)} / yaw ${camera_angle.yaw.toFixed(1)} / roll ${camera_angle.roll.toFixed(1)}\n` +
      `Scene count: ${this.viewer.custom_scene_collection.num_scenes}\n` +
      `Visible: ${this._custom_scene.visibility}`;
  }
}
