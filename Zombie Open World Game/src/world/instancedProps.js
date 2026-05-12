/** InstancedMesh-based prop spawner.
 *
 *  Why: every call to `spawnModel(id, ...)` produces a fresh THREE.Group
 *  that becomes its own draw call. A city map with ~30 visible chunks and
 *  3-5 simple props per chunk burns ~75-150 extra draw calls — the bulk of
 *  the per-frame GPU/CPU cost on Outbreak City. For repeated simple props
 *  (cones, lamps, signs, barrels, crates, fences, debris, rocks) we only
 *  need one InstancedMesh per unique internal Mesh of the template. Each
 *  spawn writes its world matrix into a slot — N spawns share one draw
 *  call.
 *
 *  Vehicles stay on the regular spawnModel path (they're far fewer per
 *  chunk and have nested hierarchies — body, wheels, glass — that make
 *  flattening to InstancedMesh awkward; future scope).
 *
 *  Public API:
 *    addPropInstance(modelId, scene, { x, y, z, yaw })  -> Promise<handle|null>
 *    releasePropInstance(handle)                         -> void
 *    getInstanceWorldBox(handle, outBox3?)               -> THREE.Box3
 *    getBucket(modelId)                                  -> bucket | undefined
 *    preloadInstancedProps(ids, scene)                   -> Promise<void>
 */

import * as THREE from "three";
import { getModelDef } from "./modelRegistry.js";
import { loadTemplate } from "./spawnModel.js";

const MAX_INSTANCES_PER_PROP = 256;

// modelId -> bucket. Buckets are created lazily on first spawn and live
// for the entire session — InstancedMeshes are shared across chunks.
const _buckets = new Map();
// modelId -> Promise<bucket>. Caches in-flight bucket prep so concurrent
// spawns of the same id don't double-create the InstancedMeshes.
const _bucketPromises = new Map();

const _identityMat = new THREE.Matrix4();
const _zeroScaleMat = new THREE.Matrix4().makeScale(0, 0, 0);
const _tmpMatrix = new THREE.Matrix4();
const _tmpMatrixB = new THREE.Matrix4();
const _tmpVec3 = new THREE.Vector3();
const _tmpPos = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();
const _axisY = new THREE.Vector3(0, 1, 0);

function removeFreeSlot(bucket, slot) {
  const idx = bucket.freeSlots.indexOf(slot);
  if (idx < 0) return;
  const last = bucket.freeSlots.pop();
  if (idx < bucket.freeSlots.length) bucket.freeSlots[idx] = last;
}

function setBucketCount(bucket, count) {
  bucket.highWater = count;
  for (const m of bucket.meshes) {
    m.instMesh.count = count;
  }
}

function trimReleasedTail(bucket) {
  while (bucket.nextSlot > 0 && bucket.freeSlotSet.has(bucket.nextSlot - 1)) {
    const slot = bucket.nextSlot - 1;
    bucket.freeSlotSet.delete(slot);
    removeFreeSlot(bucket, slot);
    bucket.nextSlot -= 1;
  }
  setBucketCount(bucket, bucket.nextSlot);
}

/** Build the InstancedMesh buckets for a model id and add them to the scene. */
async function prepareBucket(modelId, scene) {
  if (_buckets.has(modelId)) return _buckets.get(modelId);
  if (_bucketPromises.has(modelId)) return _bucketPromises.get(modelId);

  const def = getModelDef(modelId);
  if (!def) return null;

  const promise = (async () => {
    const template = await loadTemplate(modelId);
    if (!template) return null;

    // Apply def.scale to a temporary clone so the local offset matrices we
    // bake in include the registry scale. We then compute autoground from
    // the same clone. Both happen ONCE per modelId.
    const prepRoot = template.clone(true);
    if (def.scale && def.scale !== 1) prepRoot.scale.setScalar(def.scale);

    let groundY = 0;
    if (def.autoGround !== false) {
      const grBox = new THREE.Box3().setFromObject(prepRoot);
      if (isFinite(grBox.min.y)) groundY = -grBox.min.y;
    }
    if (def.yOffset) groundY += def.yOffset;

    // Apply ground offset directly into the prep root so subsequent
    // `updateMatrixWorld()` bakes it into every descendant's world matrix.
    prepRoot.position.y = groundY;
    prepRoot.updateMatrixWorld(true);

    // Collect every internal Mesh. For each one, capture:
    //   - geometry (shared with the InstancedMesh)
    //   - material (shared with the InstancedMesh)
    //   - localOffsetMatrix = mesh.matrixWorld relative to prepRoot.matrixWorld
    // The instance's final world matrix is then:
    //     spawnMatrix * localOffsetMatrix
    // which reproduces the full hierarchy without nested Object3D updates.
    const meshes = [];
    const rootInvMat = new THREE.Matrix4().copy(prepRoot.matrixWorld).invert();
    let templateBox = null;
    prepRoot.traverse((obj) => {
      if (!obj.isMesh) return;
      const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      const geom = obj.geometry;
      if (!geom || !mat) return;
      const localOffset = new THREE.Matrix4().multiplyMatrices(rootInvMat, obj.matrixWorld);
      const instMesh = new THREE.InstancedMesh(geom, mat, MAX_INSTANCES_PER_PROP);
      instMesh.count = 0;
      // Outbreak-City clutter doesn't cast shadows (matches spawnPropAt).
      instMesh.castShadow = false;
      instMesh.receiveShadow = !!def.shadow;
      // Frustum culling on an InstancedMesh is whole-bucket: a single
      // off-camera prop would hide every other instance. Disable it so
      // visible instances stay rendered.
      instMesh.frustumCulled = false;
      instMesh.userData.modelId = modelId;
      instMesh.userData.isInstancedPropBucket = true;
      scene.add(instMesh);

      // Local-space bbox contribution for collider/vision math. Apply the
      // local offset to a fresh copy of the geometry's bbox so multi-part
      // meshes (e.g. a barrel body + lid) merge into one tight AABB.
      if (!geom.boundingBox) geom.computeBoundingBox();
      const meshBox = geom.boundingBox.clone().applyMatrix4(localOffset);
      if (!templateBox) templateBox = meshBox;
      else templateBox.union(meshBox);

      meshes.push({ instMesh, localOffsetMatrix: localOffset });
    });

    if (meshes.length === 0) return null;
    if (!templateBox) templateBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());

    const bucket = {
      modelId,
      def,
      meshes,
      freeSlots: [],
      freeSlotSet: new Set(),
      nextSlot: 0,
      highWater: 0,
      groundY,
      templateBox,
      firstSpawnDelivered: false,
    };
    _buckets.set(modelId, bucket);
    _bucketPromises.delete(modelId);
    return bucket;
  })();

  _bucketPromises.set(modelId, promise);
  return promise;
}

/** Spawn a single instance of `modelId` at (x, y, z) with `yaw` radians. */
export async function addPropInstance(modelId, scene, { x = 0, y = 0, z = 0, yaw = 0 } = {}) {
  const bucket = await prepareBucket(modelId, scene);
  if (!bucket) return null;

  let slot;
  if (bucket.freeSlots.length > 0) {
    slot = bucket.freeSlots.pop();
    bucket.freeSlotSet.delete(slot);
  } else if (bucket.nextSlot < MAX_INSTANCES_PER_PROP) {
    slot = bucket.nextSlot++;
  } else {
    // Bucket is full. Refuse the spawn rather than over-writing an active
    // instance. The caller falls back gracefully (the prop just doesn't
    // appear, exactly like a budget cap).
    return null;
  }

  // Build the spawn matrix once, then multiply by each mesh's local offset.
  // The yaw rotation is around world-Y; position places the model at the
  // requested world coords; def-driven scale is already baked into the
  // local offset matrices during prepareBucket.
  _tmpMatrix.makeRotationY(yaw);
  _tmpMatrix.setPosition(x, y, z);

  for (const m of bucket.meshes) {
    _tmpMatrixB.multiplyMatrices(_tmpMatrix, m.localOffsetMatrix);
    m.instMesh.setMatrixAt(slot, _tmpMatrixB);
    m.instMesh.instanceMatrix.needsUpdate = true;
    if (slot >= m.instMesh.count) m.instMesh.count = slot + 1;
  }
  if (slot >= bucket.highWater) bucket.highWater = slot + 1;

  const firstSpawn = !bucket.firstSpawnDelivered;
  bucket.firstSpawnDelivered = true;

  return {
    bucket,
    slot,
    spawnMatrix: _tmpMatrix.clone(),
    firstSpawn,
  };
}

/** Release a previously-spawned instance. The slot is returned to the
 *  free list and reused by the next addPropInstance call. */
export function releasePropInstance(handle) {
  if (!handle) return;
  const { bucket, slot } = handle;
  if (bucket.freeSlotSet.has(slot)) return;
  for (const m of bucket.meshes) {
    m.instMesh.setMatrixAt(slot, _zeroScaleMat);
    m.instMesh.instanceMatrix.needsUpdate = true;
  }
  bucket.freeSlots.push(slot);
  bucket.freeSlotSet.add(slot);
  trimReleasedTail(bucket);
}

/** Compute the world-space AABB of a single instance. Used by the static-
 *  collider registration in main.js. Writes into `out` if provided. */
export function getInstanceWorldBox(handle, out) {
  const box = out || new THREE.Box3();
  if (!handle) {
    box.makeEmpty();
    return box;
  }
  box.copy(handle.bucket.templateBox).applyMatrix4(handle.spawnMatrix);
  return box;
}

/** Lookup a bucket by id (returns undefined if not yet prepared). */
export function getBucket(modelId) {
  return _buckets.get(modelId);
}

/** Called by main.js on full world reset (e.g. map switch). Marks every
 *  bucket as needing to re-register its vision blockers on next spawn,
 *  since main.js wipes the visionBlockers array as part of its reset. */
export function resetInstancedPropsForNewWorld() {
  for (const bucket of _buckets.values()) {
    bucket.firstSpawnDelivered = false;
    // Drop any lingering instances so freed slots are available again.
    bucket.freeSlots.length = 0;
    bucket.freeSlotSet.clear();
    bucket.nextSlot = 0;
    setBucketCount(bucket, 0);
  }
  for (const bucket of _templateBuckets.values()) {
    bucket.firstSpawnDelivered = false;
    bucket.freeSlots.length = 0;
    bucket.freeSlotSet.clear();
    bucket.nextSlot = 0;
    setBucketCount(bucket, 0);
  }
}

// ────────────────────────────────────────────────────────────────────────
//   Template-based instancing — same machinery as addPropInstance but the
//   caller passes an already-loaded THREE.Object3D template directly. Used
//   for the city building library (cityBuildingTemplates) since those are
//   loaded by a custom path (loadCityBuildingLibrary) instead of through
//   the model registry. Buildings also have a per-instance uniform scale
//   that the prop pipeline doesn't need.
// ────────────────────────────────────────────────────────────────────────

const MAX_TEMPLATE_INSTANCES = 64;

// template root Object3D -> bucket. WeakMap so a discarded template's
// bucket can be GC'd; in practice templates live forever once loaded.
const _templateBuckets = new Map();

function createTemplateBucket(template, scene) {
  template.updateMatrixWorld(true);
  const rootInvMat = new THREE.Matrix4().copy(template.matrixWorld).invert();
  let templateBox = null;
  const meshes = [];
  template.traverse((obj) => {
    if (!obj.isMesh) return;
    const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
    const geom = obj.geometry;
    if (!geom || !mat) return;
    const localOffset = new THREE.Matrix4().multiplyMatrices(rootInvMat, obj.matrixWorld);
    const instMesh = new THREE.InstancedMesh(geom, mat, MAX_TEMPLATE_INSTANCES);
    instMesh.count = 0;
    // City buildings are huge multi-mesh GLBs and dominate the shadow-
    // map rasterization cost when needsUpdate fires. Disabling castShadow
    // on the bucket eliminates that cost wholesale — visually the
    // buildings still receive shadows from zombies/vehicles/players, and
    // their own footprint sits on darker ambient ground anyway because
    // the sun in this game sits high. This is the single biggest GPU
    // saving on Outbreak City after the InstancedMesh switch itself.
    instMesh.castShadow = false;
    instMesh.receiveShadow = obj.receiveShadow !== false;
    // Bucket-wide frustum culling is unsafe — a single visible instance
    // would hide all others. The bucket's effective bbox covers the
    // entire world anyway once a few chunks have spawned buildings.
    instMesh.frustumCulled = false;
    instMesh.userData.isInstancedTemplateBucket = true;
    scene.add(instMesh);

    if (!geom.boundingBox) geom.computeBoundingBox();
    const meshBox = geom.boundingBox.clone().applyMatrix4(localOffset);
    if (!templateBox) templateBox = meshBox;
    else templateBox.union(meshBox);

    meshes.push({ instMesh, localOffsetMatrix: localOffset });
  });
  if (meshes.length === 0) return null;
  if (!templateBox) templateBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());

  return {
    template,
    meshes,
    freeSlots: [],
    freeSlotSet: new Set(),
    nextSlot: 0,
    highWater: 0,
    templateBox,
    firstSpawnDelivered: false,
  };
}

/** Synchronous spawn of a single instance of an already-loaded template
 *  at (x, y, z) with `yaw` radians around Y and `scale` uniform scale.
 *  Replaces `template.clone(true)` for hot-path spawn sites — the
 *  per-chunk city-building loop previously did a full deep clone of each
 *  building's GLB hierarchy (multi-ms per call) and that was the
 *  remaining "stutter only on Outbreak City" source. */
export function addTemplateInstance(template, scene, { x = 0, y = 0, z = 0, yaw = 0, scale = 1 } = {}) {
  if (!template) return null;
  let bucket = _templateBuckets.get(template);
  if (!bucket) {
    bucket = createTemplateBucket(template, scene);
    if (!bucket) return null;
    _templateBuckets.set(template, bucket);
  }

  let slot;
  if (bucket.freeSlots.length > 0) {
    slot = bucket.freeSlots.pop();
    bucket.freeSlotSet.delete(slot);
  } else if (bucket.nextSlot < MAX_TEMPLATE_INSTANCES) {
    slot = bucket.nextSlot++;
  } else {
    return null;
  }

  // compose(position, quaternion, scale) — buildings vary scale per
  // instance (random height target), so we can't bake scale into the
  // local offsets at bucket-creation time.
  _tmpPos.set(x, y, z);
  _tmpQuat.setFromAxisAngle(_axisY, yaw);
  _tmpScale.setScalar(scale);
  _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);

  for (const m of bucket.meshes) {
    _tmpMatrixB.multiplyMatrices(_tmpMatrix, m.localOffsetMatrix);
    m.instMesh.setMatrixAt(slot, _tmpMatrixB);
    m.instMesh.instanceMatrix.needsUpdate = true;
    if (slot >= m.instMesh.count) m.instMesh.count = slot + 1;
  }
  if (slot >= bucket.highWater) bucket.highWater = slot + 1;

  const firstSpawn = !bucket.firstSpawnDelivered;
  bucket.firstSpawnDelivered = true;

  return {
    bucket,
    slot,
    spawnMatrix: _tmpMatrix.clone(),
    firstSpawn,
  };
}

/** Preload buckets for a list of model ids so the first spawn doesn't
 *  block on GLB loading. */
export function preloadInstancedProps(ids, scene) {
  return Promise.all(ids.map((id) => prepareBucket(id, scene)));
}
