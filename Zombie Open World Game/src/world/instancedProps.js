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
  for (const m of bucket.meshes) {
    m.instMesh.setMatrixAt(slot, _zeroScaleMat);
    m.instMesh.instanceMatrix.needsUpdate = true;
  }
  bucket.freeSlots.push(slot);
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
    bucket.nextSlot = 0;
    bucket.highWater = 0;
    for (const m of bucket.meshes) {
      m.instMesh.count = 0;
    }
  }
}

/** Preload buckets for a list of model ids so the first spawn doesn't
 *  block on GLB loading. */
export function preloadInstancedProps(ids, scene) {
  return Promise.all(ids.map((id) => prepareBucket(id, scene)));
}
