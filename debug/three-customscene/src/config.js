export const INITIAL_ACTOR_POSITION = {
  longitude: 138.747793,
  latitude: 35.307012,
  height: 0,
};

export const MODEL_URL =
  new URLSearchParams(window.location.search).get("model") ||
  "https://threejs.org/examples/models/gltf/Soldier.glb";

export const MOVE_SPEED = 600;
export const MODEL_SCALE = 300;
export const MODEL_HEIGHT_OFFSET = 0;
export const MODEL_UP_ROTATION_X = Math.PI * 0.5;
export const MODEL_HEADING_OFFSET = 0;
export const EARTH_RADIUS = 6378137;
