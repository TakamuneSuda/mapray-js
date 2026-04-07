import * as THREE from "three";

import { EARTH_RADIUS } from "./config";

export const MOVE_KEY_NAMES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function getMovementDirection(yaw_degrees, pressed_keys) {
  const input = new THREE.Vector2();

  if (pressed_keys.has("ArrowLeft")) {
    input.x -= 1;
  }
  if (pressed_keys.has("ArrowRight")) {
    input.x += 1;
  }
  if (pressed_keys.has("ArrowUp")) {
    input.y += 1;
  }
  if (pressed_keys.has("ArrowDown")) {
    input.y -= 1;
  }

  if (input.lengthSq() === 0) {
    return input;
  }

  const heading = (yaw_degrees * Math.PI) / 180;
  const forward = new THREE.Vector2(Math.sin(heading), Math.cos(heading));
  const right = new THREE.Vector2(-Math.cos(heading), Math.sin(heading));
  const direction = new THREE.Vector2();
  direction.addScaledVector(right, input.x);
  direction.addScaledVector(forward, input.y);

  return direction;
}

export function translateGeoPoint(position, east_meters, north_meters) {
  position.latitude += metersToLatitude(north_meters);
  position.longitude += metersToLongitude(east_meters, position.latitude);
}

function metersToLatitude(meters) {
  return (meters / EARTH_RADIUS) * (180 / Math.PI);
}

function metersToLongitude(meters, latitude) {
  const cos_lat = Math.cos((latitude * Math.PI) / 180);
  if (Math.abs(cos_lat) < 1e-6) {
    return 0;
  }

  return (meters / (EARTH_RADIUS * cos_lat)) * (180 / Math.PI);
}
