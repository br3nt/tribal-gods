/**
 * Screen-space picking (ui/picking.ts) with a real three.js camera: the
 * close, low-pitch hero shot is where tall silhouettes poke out of the
 * viewport, and they must stay clickable.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TILE } from '../src/config';
import { CAMERA } from '../src/render/look';
import { buildingAtScreen, pickAtScreen, probeScreen, unitAtScreen } from '../src/ui/picking';
import type { View } from '../src/ui/project';
import { flatWorld } from './helpers';

const VP = { width: 1280, height: 720 };

/** The camera rig's pose at zoom 0 (closest, lowest pitch), looking at tile (tx, tz). */
function closeView(map: View['map'], tx: number, tz: number, yaw = 0): View {
  const target = new THREE.Vector3(tx * TILE, 2, tz * TILE);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, VP.width / VP.height, CAMERA.near, CAMERA.far);
  const dist = CAMERA.distMin;
  const pitch = CAMERA.pitchMin;
  camera.position.set(target.x + Math.sin(yaw) * dist * Math.cos(pitch), target.y + dist * Math.sin(pitch), target.z + Math.cos(yaw) * dist * Math.cos(pitch));
  camera.lookAt(target.x, target.y + 1.5, target.z);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera, target, map };
}

describe('screen picking up close', () => {
  it('a Watchtower whose roof is above the viewport is still clickable on its walls', () => {
    const w = flatWorld();
    const tower = w.spawnBuilding('player', 'tower', 40, 43, { complete: true });
    const view = closeView(w.map, 40, 40);
    const roof = probeScreen(view, 40, 43, 7, VP)!;
    expect(roof.y).toBeLessThan(-200); // the scenario: roof far above the top edge
    const door = probeScreen(view, 40, 43, 1, VP)!;
    expect(door.y).toBeGreaterThan(0);
    expect(door.y).toBeLessThan(VP.height);
    expect(buildingAtScreen(view, w.buildings, door.x, door.y, VP)?.id).toBe(tower.id);
  });

  it('a person whose head is above the viewport is still clickable on the body', () => {
    const w = flatWorld();
    // On a knoll close to the camera, the head rises past the top edge.
    for (let z = 40; z <= 46; z++) for (let x = 37; x <= 43; x++) w.map.heights[z * 128 + x] = 6;
    const u = w.spawn('warden', 'player', 40, 43.5);
    const view = closeView(w.map, 40, 40);
    const head = probeScreen(view, u.x, u.z, 2.8, VP)!;
    const foot = probeScreen(view, u.x, u.z, 0, VP)!;
    expect(head.y).toBeLessThan(0);
    expect(foot.y).toBeGreaterThan(0);
    expect(foot.y).toBeLessThan(VP.height);
    expect(unitAtScreen(view, w.units, foot.x, foot.y - 5, () => true, VP)?.id).toBe(u.id);
  });

  it('points behind the camera are rejected', () => {
    const w = flatWorld();
    const view = closeView(w.map, 40, 40);
    expect(probeScreen(view, 40, 52, 0, VP)).toBeNull();
  });

  it('a person standing in front of a hall wins only where the cursor is over the person', () => {
    const w = flatWorld();
    const hall = w.spawnBuilding('player', 'wardenHall', 40, 40, { complete: true });
    const u = w.spawn('brave', 'player', 41.5, 43.2);
    const view = closeView(w.map, 40, 44, 0);
    view.camera.position.y += 6; // a little higher so the whole hall is in view
    view.camera.lookAt(view.target);
    view.camera.updateMatrixWorld();
    const body = probeScreen(view, u.x, u.z, 1.1, VP)!;
    expect(pickAtScreen(view, w.units, w.buildings, body.x, body.y, () => true, VP).unit?.id).toBe(u.id);
    // On the hall's wall away from the person: the hall.
    const wall = probeScreen(view, 38.5, 42.5, 3, VP)!;
    const hit = pickAtScreen(view, w.units, w.buildings, wall.x, wall.y, () => true, VP);
    expect(hit.unit).toBeNull();
    expect(hit.building?.id).toBe(hall.id);
  });

  it('a person behind a hall is not picked through its walls', () => {
    const w = flatWorld();
    const hall = w.spawnBuilding('player', 'wardenHall', 40, 40, { complete: true });
    const u = w.spawn('brave', 'player', 40, 36.8);
    const view = closeView(w.map, 40, 44, 0);
    view.camera.position.y += 6;
    view.camera.lookAt(view.target);
    view.camera.updateMatrixWorld();
    const body = probeScreen(view, u.x, u.z, 1.1, VP)!;
    const hit = pickAtScreen(view, w.units, w.buildings, body.x, body.y, () => true, VP);
    expect(hit.unit).toBeNull();
    expect(hit.building?.id).toBe(hall.id);
  });
});
