const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness(webgl2 = false, configure) {
  const images = [], revoked = [], uploads = [], deleted = [], requests = [], bufferUploads = [];
  let now = 0, uploadCost = 0;
  class WebGL1 {}
  const gl = webgl2 ? {} : new WebGL1();
  Object.assign(gl, {
    isTexture() {}, isContextLost: () => false, getParameter: () => false,
    createBuffer: () => ({}), bindBuffer() {},
    bufferData(...args) { bufferUploads.push(args[1]); now += uploadCost; }, deleteBuffer() {},
    createTexture: () => ({}), bindTexture() {}, pixelStorei() {}, texParameteri() {},
    texImage2D(...args) { uploads.push(args.at(-1)); now += uploadCost; }, generateMipmap() {},
    deleteTexture(t) { deleted.push(t); },
  });
  const sandbox = {
    console, performance: { now: () => now }, WebGLRenderingContext: WebGL1,
    URL: { createObjectURL: () => `blob:${images.length}`, revokeObjectURL: u => revoked.push(u) },
    document: {
      getElementsByTagName: () => [],
      createElement() { const img = {}; images.push(img); return img; },
    },
    XMLHttpRequest: class {
      constructor() { this.readyState = 1; requests.push(this); }
      open(method, url) { this.url = url; } setRequestHeader() {} send() {}
      abort() { this.readyState = 4; this.onabort?.(); }
      complete(response) {
        this.readyState = 4; this.status = 206; this.response = response; this.onload();
      }
    },
  };
  sandbox.window = sandbox;
  if (configure) configure(gl, sandbox);
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, '../html/js/nexus.js'), 'utf8');
  vm.runInContext(source, sandbox);
  const Nexus = sandbox.Nexus;
  Nexus.beginFrame(gl);
  const context = Nexus.contexts[0];

  function mesh(textureIds = [0, 1, 2], textured = true) {
    const n = textureIds.length + 1, nt = textured ? Math.max(...textureIds) + 2 : 0;
    const b = new ArrayBuffer(n * 44 + (n - 1) * 12 + nt * 68);
    const v = new DataView(b), pb = n * 44, tb = pb + (n - 1) * 12;
    for (let i = 0; i < n; i++) {
      v.setUint32(i * 44, 10 + 2 * i, true);
      v.setUint32(i * 44 + 40, Math.min(i, n - 1), true);
      if (i === n - 1) continue;
      v.setUint16(i * 44 + 4, 3, true); v.setUint16(i * 44 + 6, 1, true);
      v.setUint32(pb + i * 12, n - 1, true);
      v.setUint32(pb + i * 12 + 4, 1, true);
      v.setUint32(pb + i * 12 + 8, textureIds[i], true);
    }
    for (let i = 0; i < nt; i++) v.setUint32(tb + i * 68, 100 + 2 * i, true);
    const m = new Nexus.Mesh();
    Object.assign(m, { nodesCount: n, patchesCount: n - 1, texturesCount: nt,
      vertex: { texCoord: textured }, url: 'fixture.nxs', useIndexedDb: false });
    m.handleIndex(b); m.nroots = 1;
    context.meshes.push(m);
    return m;
  }
  function candidate(m, id, error = 10) {
    m.errors[id] = error; m.frames[id] = context.frame;
    context.candidates.push({ mesh: m, id, error, frame: context.frame, instance: {} });
  }
  function request(m, id, error) { candidate(m, id, error); Nexus.updateCache(gl); }
  function geometry(m, id) { m.georeq[id].complete(new ArrayBuffer(512)); }
  function texture(m, id, width = 4, height = 4) {
    const tex = m.patches[m.nfirstpatch[id] * 3 + 2];
    m.texreq[tex].complete({ size: 512 });
    const img = images.at(-1); Object.assign(img, { width, height }); img.onload();
  }
  function frame() { Nexus.endFrame(gl); }
  function complete(m, id, width, height) {
    geometry(m, id);
    const tex = m.patches[m.nfirstpatch[id] * 3 + 2];
    if (m.texreq[tex]) texture(m, id, width, height);
    frame();
  }
  return { Nexus, gl, context, mesh, candidate, request, geometry, texture, complete,
    images, revoked, uploads, deleted, requests, bufferUploads, sandbox, frame,
    setUploadCost(ms) { uploadCost = ms; } };
}

for (const [name, webgl2, width, height, bytes] of [
  ['WebGL1 NPOT RGBA', false, 3, 5, 60],
  ['WebGL1 power-of-two mipmaps', false, 4, 4, 84],
  ['WebGL2 NPOT mipmaps', true, 3, 5, 72],
  ['rectangular mipmaps', true, 1, 8, 60],
]) {
  test(`accounts for ${name}, releases it, and remembers decoded size`, () => {
    const h = harness(webgl2), m = h.mesh();
    h.request(m, 0); h.complete(m, 0, width, height);
    assert.equal(h.context.pending, 0);
    assert.equal(m.status[0], 1);
    assert.equal(h.context.cacheSize, 66 + bytes);
    assert.equal(m.texsize[0], bytes);
    h.Nexus.flush(h.context, m);
    assert.equal(h.context.cacheSize, 0);
    assert.equal(h.deleted.length, 1);
    h.request(m, 0);
    assert.equal(h.context.cacheSize, 66 + bytes);
  });
}

test('lossless file bytes no longer prevent refinement under the same budget', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.setMaxCacheSize(h.gl, 1100);
  h.request(m, 0); h.complete(m, 0);
  h.request(m, 1); h.complete(m, 1);
  assert.equal(m.status[1], 1);
  assert.equal(h.context.cacheSize, 300);
});

test('rejects an underestimated texture before GPU upload without leaking pending slots', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.setMaxCacheSize(h.gl, 1024);
  h.request(m, 0); h.complete(m, 0, 1024, 1024);
  assert.equal(h.uploads.length, 0);
  assert.equal(m.status[0], 0);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.cacheSize, 0);
  h.request(m, 0);
  assert.equal(h.context.pending, 0); // known oversized texture isn't downloaded repeatedly
});

test('shared atlases are uploaded/charged once and freed after the last reference', () => {
  const h = harness(), m = h.mesh([0, 0, 1]);
  h.request(m, 0); h.request(m, 1);
  assert.equal(h.context.cacheSize, 2 * 66 + 512);
  h.complete(m, 0); h.complete(m, 1);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.context.cacheSize, 2 * 66 + 84);
  assert.equal(h.context.pending, 0);
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.cacheSize, 0);
  assert.equal(h.deleted.length, 1);
});

test('cancels pending image decode after geometry finishes; stale callbacks cannot resurrect a node', () => {
  const h = harness(), m = h.mesh();
  h.request(m, 0); h.geometry(m, 0); m.texreq[0].complete({});
  const old = h.images.at(-1), callback = old.onload;
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.cacheSize, 0);
  assert.equal(old.onload, null);
  h.request(m, 0);
  Object.assign(old, { width: 4, height: 4 }); callback();
  assert.equal(h.uploads.length, 0);
  assert.equal(h.context.pending, 1);
  h.complete(m, 0);
  assert.equal(h.context.pending, 0);
});

test('shared-atlas decode retries once for all waiters and uploads once', () => {
  const h = harness(), m = h.mesh([0, 0, 1]);
  h.request(m, 0); h.request(m, 1);
  h.geometry(m, 0); h.geometry(m, 1);
  assert.equal(h.requests.filter(r => r.responseType === 'blob').length, 1);
  m.texreq[0].complete({ size: 512 }); h.images.at(-1).onerror();
  assert.equal(h.requests.filter(r => r.responseType === 'blob').length, 2);
  h.texture(m, 0); h.frame();
  assert.equal(m.status[0], 1);
  assert.equal(m.status[1], 1);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.downloading, 0);
  assert.equal(m.texref[0], 2);
  assert.equal(h.uploads.length, 1);
});

test('decode failures retry without duplicating texture references or losing a pending slot', () => {
  const h = harness(), m = h.mesh();
  h.request(m, 0); h.geometry(m, 0);
  for (let i = 0; i < 4; i++) {
    m.texreq[0].complete({}); h.images.at(-1).onerror();
  }
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.cacheSize, 0);
  assert.equal(m.texref[0], 0);
  assert.equal(h.revoked.length, 4);
});

test('new camera frames can evict old high-error nodes to load new detail', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.setMaxCacheSize(h.gl, 750);
  h.request(m, 0, 1e6); h.complete(m, 0);
  h.request(m, 1, 1e5); h.complete(m, 1);
  h.Nexus.beginFrame(h.gl);
  h.request(m, 2, 10);
  assert.equal(m.status[0], 1); // keep fallback root
  assert.equal(m.status[1], 0); // stale high error must not pin old view
  assert.ok(m.status[2] > 1);
  assert.ok(h.context.cacheSize <= 750);
  h.complete(m, 2);
  assert.equal(h.context.cacheSize, 300);
});

test('camera movement without a resolution change refreshes traversal priorities', () => {
  const h = harness(), m = h.mesh([0]);
  h.request(m, 0); h.complete(m, 0);
  const i = new h.Nexus.Instance(h.gl);
  Object.assign(i, { mesh: m, context: h.context, mode: 'FILL', currentResolution: 1,
    viewpoint: [0, 0, 10], planes: new Float32Array(24) });
  m.nerrors[0] = 100; m.nspheres[3] = m.nspheres[4] = 1;
  i.traversal();
  const firstError = m.errors[0];
  h.Nexus.beginFrame(h.gl);
  i.sameResolution = true; i.viewpoint[2] = 100;
  i.traversal();
  assert.equal(m.frames[0], h.context.frame);
  assert.ok(m.errors[0] < firstError);
});

test('reserves candidate headroom instead of overshooting the cache limit', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.setMaxCacheSize(h.gl, 700);
  h.request(m, 0, 1e6); h.complete(m, 0);
  h.request(m, 1, 10);
  assert.equal(m.status[1], 0);
  assert.equal(h.context.pending, 0);
  assert.ok(h.context.cacheSize <= 700);
});

test('admission cannot evict the shared atlas included in its headroom calculation', () => {
  const h = harness(), m = h.mesh([0, 0, 0]);
  h.request(m, 1, 1); h.complete(m, 1);
  m.nsize[2] = 200;
  h.Nexus.setMaxCacheSize(h.gl, 300);
  h.request(m, 2, 10);
  assert.equal(m.status[1], 1);
  assert.equal(m.status[2], 0);
  assert.equal(h.context.cacheSize, 150);
});

test('an oversized candidate does not starve smaller candidates', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.setMaxCacheSize(h.gl, 1024);
  m.texsize[0] = 10000;
  h.candidate(m, 0, 100); h.candidate(m, 1, 10); h.Nexus.endFrame(h.gl);
  assert.equal(m.status[0], 0);
  assert.ok(m.status[1] > 1);
});

test('untextured geometry is finite and balances the cache on flush', () => {
  const h = harness(), m = h.mesh([0], false);
  h.request(m, 0); h.geometry(m, 0); h.frame();
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.cacheSize, 42);
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.cacheSize, 0);
});

test('queues geometry and textures until endFrame and reports stage statistics', () => {
  const h = harness(), m = h.mesh();
  h.request(m, 0); h.geometry(m, 0); h.texture(m, 0);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.bufferUploads.length, 0);
  const stats = h.Nexus.getStats(h.gl);
  assert.equal(stats.downloading, 0);
  assert.equal(stats.pending, 1);
  assert.equal(stats.queuedUploads, 2);
  stats.stages.geometryDownload.count = 999;
  assert.equal(h.Nexus.getStats(h.gl).stages.geometryDownload.count, 1);
  h.frame();
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.residentNodes.size, 1);
  assert.equal(h.Nexus.getStats(h.gl).stages.textureUpload.bytes, 84);
  h.Nexus.resetStats(h.gl);
  assert.equal(Object.keys(h.Nexus.getStats(h.gl).stages).length, 0);
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.residentNodes.size, 0);
});

test('upload budget yields between tasks and uses the latest camera priorities', () => {
  const h = harness(), m = h.mesh([0, 1], false);
  h.setUploadCost(5);
  h.request(m, 0, 100); h.request(m, 1, 1);
  h.geometry(m, 0); h.geometry(m, 1);
  h.Nexus.beginFrame(h.gl);
  m.frames[1] = h.context.frame;
  h.frame();
  assert.equal(m.status[1], 1);
  assert.ok(m.status[0] > 1);
  assert.equal(h.context.uploads.length, 1);
  h.frame();
  assert.equal(m.status[0], 1);
  assert.equal(h.context.uploads.length, 0);
});

test('shared textures inherit the newest waiter priority before GPU upload', () => {
  const h = harness(), m = h.mesh([0, 0]);
  h.setUploadCost(5);
  h.request(m, 0, 100); h.request(m, 1, 1);
  h.geometry(m, 0); h.geometry(m, 1); h.texture(m, 0);
  h.Nexus.beginFrame(h.gl);
  m.frames[1] = h.context.frame;
  h.frame(); // geometry for node 1
  assert.equal(h.uploads.length, 0);
  h.frame(); // shared texture ahead of old-view geometry for node 0
  assert.equal(h.uploads.length, 1);
  assert.equal(m.status[1], 1);
  assert.ok(m.status[0] > 1);
  h.frame();
  assert.equal(h.context.pending, 0);
});

test('download slots refill before uploads while processing stays bounded', () => {
  const h = harness(), m = h.mesh(Array.from({ length: 20 }, (_, i) => i), false);
  for (let i = 0; i < 20; i++) h.candidate(m, i);
  h.Nexus.updateCache(h.gl);
  assert.equal(h.context.downloading, 6);
  assert.equal(h.context.pending, 6);
  for (let i = 0; i < 6; i++) h.geometry(m, i);
  assert.equal(h.context.downloading, 6);
  assert.equal(h.context.pending, 12);
  for (let i = 6; i < 12; i++) h.geometry(m, i);
  assert.equal(h.context.downloading, 0);
  assert.equal(h.context.pending, 12);
  assert.equal(m.status[12], 0);
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.downloading, 0);
  assert.equal(h.context.uploads.length, 0);
  assert.equal(h.context.cacheSize, 0);
});

test('flush cancels queued uploads before either GPU allocation', () => {
  const h = harness(), m = h.mesh();
  h.request(m, 0); h.geometry(m, 0); h.texture(m, 0);
  h.Nexus.flush(h.context, m); h.frame();
  assert.equal(h.uploads.length, 0);
  assert.equal(h.bufferUploads.length, 0);
  assert.equal(h.context.uploads.length, 0);
  assert.equal(h.context.downloading, 0);
  assert.equal(h.context.cacheSize, 0);
});

test('picking shares geometry requests and survives cancellation by rendering', async () => {
  const h = harness(), m = h.mesh([0], false);
  h.request(m, 0);
  const request = m.georeq[0];
  const picked = h.Nexus.getNodeBuffer(m, 0);
  assert.equal(h.requests.length, 1);
  h.Nexus.flush(h.context, m);
  assert.equal(request.readyState, 1);
  const bytes = new ArrayBuffer(512);
  request.complete(bytes);
  assert.equal(await picked, bytes);
  h.frame();
  assert.equal(h.bufferUploads.length, 0);
  assert.equal(h.context.pending, 0);
});

test('picking reuses resident uncompressed bytes without modifying attribute order', async () => {
  const h = harness(), m = h.mesh([0]);
  // Exercise the renderer's normal/color reordering in its separate GPU copy.
  m.vertex.normal = m.vertex.color = true;
  m.vsize = 30;
  h.request(m, 0);
  const buffer = new ArrayBuffer(512);
  const original = new Uint8Array(buffer);
  original.forEach((_, i) => { original[i] = i % 251; });
  const expected = original.slice();
  const picked = h.Nexus.getNodeBuffer(m, 0);
  m.georeq[0].complete(buffer); h.texture(m, 0); h.frame();
  assert.equal(await picked, buffer);
  const count = h.requests.length;
  assert.equal(await h.Nexus.getNodeBuffer(m, 0), buffer);
  assert.equal(h.requests.length, count);
  assert.deepEqual(original, expected);
});

test('warm IndexedDB waits for opening and uses numeric geometry/atlas keys', async () => {
  const h = harness(), m = h.mesh([0, 0]);
  const reads = [];
  let opened;
  m.dbReady = new Promise(resolve => { opened = resolve; });
  h.request(m, 1);
  assert.equal(h.requests.length, 0);
  const db = { transaction(store, mode) {
    assert.equal(mode, 'readonly');
    return { objectStore() { return { get(key) {
      reads.push([store, key]);
      const request = { result: store === 'mesh' ? new ArrayBuffer(512) : { size: 512 } };
      queueMicrotask(() => request.onsuccess());
      return request;
    } }; } };
  } };
  m.db = db; opened(db);
  await new Promise(resolve => setImmediate(resolve));
  Object.assign(h.images[0], { width: 4, height: 4 }); h.images[0].onload();
  h.frame();
  assert.equal(m.status[1], 1);
  assert.deepEqual(reads, [['tex', 0], ['mesh', 1]]);
  assert.equal(h.requests.length, 0);
});

test('unavailable IndexedDB and HTTP failures fall back and release request slots', async () => {
  const h = harness(), m = h.mesh([0], false);
  m.db = { transaction() { throw new Error('Database closed'); } };
  h.request(m, 0);
  for (let i = 0; i < 4; i++) {
    const request = m.georeq[0];
    request.readyState = 4; request.status = 503; request.onload();
  }
  assert.equal(m.status[0], 0);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.downloading, 0);
  assert.equal(h.context.cacheSize, 0);
  const picked = h.Nexus.getNodeBuffer(m, 0);
  const request = m.georeq[0];
  request.status = 404; request.onload();
  await assert.rejects(picked, /Geometry download failed/);
});

test('traversal reuses storage and clears pruned nodes before revisiting', () => {
  const h = harness(), m = h.mesh([0, 1], false);
  h.request(m, 0); h.geometry(m, 0); h.frame();
  h.request(m, 1); h.geometry(m, 1); h.frame();
  m.patches[0] = 1; // node 1 is detail beneath the root, not another root
  m.nerrors[0] = m.nerrors[1] = 100;
  m.nspheres[3] = m.nspheres[4] = m.nspheres[8] = m.nspheres[9] = 1;
  const instance = new h.Nexus.Instance(h.gl);
  Object.assign(instance, { mesh: m, context: h.context, mode: 'FILL', currentResolution: 1,
    viewpoint: [0, 0, 10], planes: new Float32Array(24) });
  instance.traversal();
  const arrays = [instance.selected, instance.visited, instance.blocked,
    instance.touched, instance.renderList, instance.visitQueue];
  assert.deepEqual(Array.from(instance.renderList.subarray(0, instance.renderCount)), [0, 1]);
  instance.viewpoint[2] = 1000;
  instance.traversal();
  assert.equal(instance.selected[1], 0);
  assert.deepEqual(Array.from(instance.renderList.subarray(0, instance.renderCount)), [0]);
  instance.viewpoint[2] = 10;
  instance.traversal();
  assert.equal(instance.selected[1], 1);
  arrays.forEach((array, i) => assert.equal(array, [instance.selected, instance.visited,
    instance.blocked, instance.touched, instance.renderList, instance.visitQueue][i]));
});

for (const name of ['raycast.html', 'threejs.html']) {
  test(`${name} drains idle uploads and preserves redraw requests`, () => {
    const html = fs.readFileSync(path.join(__dirname, '../html', name), 'utf8');
    const animate = html.match(/function animate\(\) \{[\s\S]*?\n\}/)[0];
    const calls = [];
    const sandbox = {
      redraw: true, scene: {}, camera: {}, requestAnimationFrame() {}, controls: { update() {} },
      renderer: { getContext: () => ({}), render() { calls.push('render'); }, resetState() { calls.push('reset'); } },
      Nexus: { beginFrame() { calls.push('begin'); }, endFrame() { calls.push('end'); sandbox.redraw = true; } },
    };
    vm.createContext(sandbox);
    vm.runInContext(animate + '\nanimate();', sandbox);
    assert.deepEqual(calls, ['begin', 'render', 'end', 'reset']);
    assert.equal(sandbox.redraw, true);
    calls.length = 0; sandbox.redraw = false;
    vm.runInContext('animate();', sandbox);
    assert.deepEqual(calls, ['end', 'reset']);
    assert.equal(sandbox.redraw, true);
  });
}

function cameraInstance(h, m) {
  const instance = new h.Nexus.Instance(h.gl);
  Object.assign(instance, { mesh: m, context: h.context, mode: 'FILL',
    viewport: new Float32Array(4), viewpoint: new Float32Array(4), planes: new Float32Array(24) });
  for (const name of ['projectionMatrix', 'modelView', 'modelViewInv', 'modelViewProj', 'modelViewProjInv'])
    instance[name] = new Float32Array(16);
  return instance;
}

const THREE = require('../html/js/three.min.js');

test('near and far frustum planes reject geometry outside the camera range', () => {
  const h = harness(), m = h.mesh([0], false), instance = cameraInstance(h, m);
  const camera = new THREE.PerspectiveCamera(60, 1, 1, 100);
  instance.updateView([0, 0, 800, 800], camera.projectionMatrix.elements, new THREE.Matrix4().elements);
  assert.equal(instance.isVisible(0, 0, -0.1, 0.01), false);
  assert.equal(instance.isVisible(0, 0, -5, 0.1), true);
  assert.equal(instance.isVisible(0, 0, -110, 0.1), false);
});

test('orthographic detail follows zoom and object scale, independent of camera distance', () => {
  const h = harness(), m = h.mesh([0], false), instance = cameraInstance(h, m);
  m.nerrors[0] = 0.1;
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 200);
  const view = new THREE.Matrix4().makeTranslation(0, 0, -10);
  instance.updateView([0, 0, 800, 800], camera.projectionMatrix.elements, view.elements);
  assert.ok(Math.abs(instance.currentResolution - 0.005) < 1e-6);
  const error = instance.nodeError(0);
  view.makeTranslation(0, 0, -100);
  instance.updateView([0, 0, 800, 800], camera.projectionMatrix.elements, view.elements);
  assert.ok(Math.abs(instance.nodeError(0) - error) < 1e-5);
  camera.zoom = 2; camera.updateProjectionMatrix();
  instance.updateView([0, 0, 800, 800], camera.projectionMatrix.elements, view.elements);
  assert.ok(Math.abs(instance.nodeError(0) - 2 * error) < 1e-5);
  view.scale(new THREE.Vector3(2, 2, 2));
  instance.updateView([0, 0, 800, 800], camera.projectionMatrix.elements, view.elements);
  assert.ok(Math.abs(instance.nodeError(0) - 4 * error) < 1e-5);
});

test('LOD hysteresis retains recent detail and resets when switching to an equal-sized mesh', () => {
  const h = harness(), m = h.mesh([0, 1], false);
  h.request(m, 0); h.geometry(m, 0); h.frame();
  h.request(m, 1); h.geometry(m, 1); h.frame();
  m.patches[0] = 1;
  const instance = cameraInstance(h, m);
  let detailError = 2.1;
  instance.nodeError = id => id === 0 ? 10 : detailError;
  instance.traversal(); assert.equal(instance.selected[1], 1);
  detailError = 1.8;
  instance.traversal(); assert.equal(instance.selected[1], 1);
  detailError = 1.6;
  instance.traversal(); assert.equal(instance.selected[1], 0);
  detailError = 1.8;
  instance.traversal(); assert.equal(instance.selected[1], 0);
  detailError = 2.1;
  instance.traversal(); assert.equal(instance.selected[1], 1);
  const other = h.mesh([0, 1], false);
  h.request(other, 0); h.geometry(other, 0); h.frame();
  h.request(other, 1); h.geometry(other, 1); h.frame();
  other.patches[0] = 1;
  instance.mesh = other; detailError = 1.8;
  instance.traversal();
  assert.equal(instance.selected[1], 0);
  assert.equal(instance.selectionEpoch, 1);
});

test('all roots remain selectable even below the detail threshold', () => {
  const h = harness(), m = h.mesh([0, 1], false);
  for (let id = 0; id < 2; id++) { h.request(m, id); h.geometry(m, id); h.frame(); }
  m.nroots = 2;
  const instance = cameraInstance(h, m);
  instance.nodeError = () => 0.01;
  instance.traversal();
  assert.equal(instance.selected[0], 1);
  assert.equal(instance.selected[1], 1);
});

test('moving frames limit adaptive error and settling restores the requested quality', () => {
  const h = harness();
  for (let i = 0; i < 100; i++) h.Nexus.beginFrame(h.gl, 2, true);
  assert.equal(h.context.currentError, 6);
  h.Nexus.beginFrame(h.gl, 2, false);
  assert.equal(h.context.currentError, h.context.targetError);
  h.Nexus.beginFrame(h.gl, NaN, true);
  assert.equal(h.context.currentError, h.context.targetError);
});

test('large refinement textures wait until movement stops but initial root coverage uploads', () => {
  const h = harness(), m = h.mesh();
  h.Nexus.beginFrame(h.gl, 60, true);
  h.request(m, 0); h.complete(m, 0, 2048, 2048);
  assert.equal(m.status[0], 1);
  h.request(m, 1); h.geometry(m, 1); h.texture(m, 1, 2048, 2048);
  const charged = h.context.cacheSize;
  assert.ok(charged > 2 * 2048 * 2048 * 4);
  h.frame();
  assert.equal(h.uploads.length, 1);
  assert.equal(h.Nexus.getStats(h.gl).deferredUploads, 1);
  assert.ok(m.status[1] > 1);
  h.Nexus.beginFrame(h.gl, 60, false); h.frame();
  assert.equal(h.uploads.length, 2);
  assert.equal(m.status[1], 1);
  assert.equal(h.context.cacheSize, charged);
});

test('moving frames use a smaller upload budget', () => {
  const h = harness(), m = h.mesh([0, 1], false);
  h.setUploadCost(0.75);
  h.Nexus.beginFrame(h.gl, 60, true);
  for (let id = 0; id < 2; id++) { h.request(m, id); h.geometry(m, id); }
  h.frame();
  assert.equal(h.context.uploads.length, 1);
  h.Nexus.beginFrame(h.gl, 60, false); h.frame();
  assert.equal(h.context.uploads.length, 0);
});

test('stale queued detail releases processing slots for the new view', () => {
  const h = harness(), m = h.mesh(Array.from({ length: 14 }, (_, i) => i), false);
  h.request(m, 0); h.geometry(m, 0); h.frame();
  for (let id = 1; id <= 12; id++) { h.request(m, id); h.geometry(m, id); }
  assert.equal(h.context.pending, 12);
  for (let frame = 0; frame < 3; frame++) h.Nexus.beginFrame(h.gl, 60, true);
  h.candidate(m, 13, 100); h.frame();
  assert.equal(m.status[0], 1);
  for (let id = 1; id <= 12; id++) assert.equal(m.status[id], 0);
  assert.ok(m.status[13] > 1);
  assert.equal(h.context.pending, 1);
});

test('ImageBitmap decoding is retained, flipped explicitly, and closed after upload', async () => {
  let options, closed = 0;
  const bitmap = { width: 4, height: 4, close() { closed++; } };
  const h = harness(false, (gl, sandbox) => {
    sandbox.createImageBitmap = (blob, value) => { options = value; return Promise.resolve(bitmap); };
  });
  h.sandbox.createImageBitmap = undefined;
  const m = h.mesh();
  h.request(m, 0); h.geometry(m, 0); m.texreq[0].complete({ size: 512 });
  await Promise.resolve();
  assert.equal(options.imageOrientation, 'flipY');
  assert.equal(h.images.length, 0);
  assert.equal(h.context.cacheSize, 150);
  h.frame();
  assert.equal(h.uploads[0], bitmap);
  assert.equal(closed, 1);
  assert.equal(m.status[0], 1);
  h.Nexus.flush(h.context, m);
  assert.equal(closed, 1);
});

test('cancelled and over-budget bitmaps close without reaching the GPU', async () => {
  for (const cancelBeforeDecode of [true, false]) {
    let resolve, closed = 0;
    const h = harness(false, (gl, sandbox) => {
      sandbox.createImageBitmap = () => new Promise(done => { resolve = done; });
    });
    const m = h.mesh();
    h.Nexus.setMaxCacheSize(h.gl, 1024);
    h.request(m, 0); h.geometry(m, 0); m.texreq[0].complete({ size: 512 });
    if (cancelBeforeDecode) h.Nexus.flush(h.context, m);
    resolve({ width: 1024, height: 1024, close() { closed++; } });
    await Promise.resolve(); h.frame();
    assert.equal(closed, 1);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.context.cacheSize, 0);
    assert.equal(h.context.pending, 0);
  }
});

test('ImageBitmap rejection uses the image fallback without another download', async () => {
  const h = harness(false, (gl, sandbox) => {
    sandbox.createImageBitmap = () => Promise.reject(new Error('Unsupported decoder'));
  });
  const m = h.mesh();
  h.request(m, 0); h.geometry(m, 0); m.texreq[0].complete({ size: 512 });
  await Promise.resolve();
  assert.equal(h.images.length, 1);
  Object.assign(h.images[0], { width: 4, height: 4 }); h.images[0].onload(); h.frame();
  assert.equal(m.status[0], 1);
  assert.equal(h.requests.filter(r => r.responseType === 'blob').length, 1);
  assert.equal(h.revoked.length, 1);
});

function renderingHarness(apiMode = 'native') {
  const state = { vao: {}, array: {}, texture: {}, flip: false, index: new Map(),
    pointers: [], removed: [], parameters: [], draws: 0, failDraw: false };
  const host = { vao: state.vao, array: state.array, texture: state.texture, indices: {} };
  state.index.set(host.vao, host.indices);
  const h = harness(apiMode === 'native', (gl) => {
    for (const key of ['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'ARRAY_BUFFER_BINDING',
      'ELEMENT_ARRAY_BUFFER_BINDING', 'TEXTURE_BINDING_2D', 'UNPACK_FLIP_Y_WEBGL',
      'TEXTURE_MIN_FILTER', 'LINEAR_MIPMAP_LINEAR', 'LINEAR', 'TEXTURE_2D']) gl[key] = key;
    const vao = { create: () => ({}), bind: value => { state.vao = value; },
      remove: value => { state.removed.push(value); } };
    if (apiMode === 'native') Object.assign(gl, { VERTEX_ARRAY_BINDING: 'vao',
      createVertexArray: vao.create, bindVertexArray: vao.bind, deleteVertexArray: vao.remove });
    if (apiMode === 'extension') Object.assign(gl, {
      createVertexArray() { throw new Error('Partial native API must not be used'); },
      bindVertexArray() { throw new Error('Partial native API must not be used'); },
    });
    gl.getExtension = name => name === 'EXT_texture_filter_anisotropic'
      ? { MAX_TEXTURE_MAX_ANISOTROPY_EXT: 'max-aniso', TEXTURE_MAX_ANISOTROPY_EXT: 'aniso' }
      : name === 'OES_vertex_array_object' && apiMode === 'extension'
        ? { VERTEX_ARRAY_BINDING_OES: 'vao', createVertexArrayOES: vao.create,
          bindVertexArrayOES: vao.bind, deleteVertexArrayOES: vao.remove } : null;
    gl.getParameter = key => ({ vao: state.vao, ARRAY_BUFFER_BINDING: state.array,
      ELEMENT_ARRAY_BUFFER_BINDING: state.index.get(state.vao), TEXTURE_BINDING_2D: state.texture,
      UNPACK_FLIP_Y_WEBGL: state.flip, 'max-aniso': 16 })[key];
    gl.bindBuffer = (target, value) => {
      if (target === gl.ARRAY_BUFFER) state.array = value;
      else state.index.set(state.vao, value);
    };
    gl.bindTexture = (target, value) => { state.texture = value; };
    gl.pixelStorei = (key, value) => { state.flip = value; };
    gl.texParameteri = gl.texParameterf = (...args) => state.parameters.push(args);
    gl.getVertexAttrib = () => false;
    gl.vertexAttribPointer = (...args) => state.pointers.push(args);
    gl.enableVertexAttribArray = gl.disableVertexAttribArray = gl.activeTexture = () => {};
    gl.drawElements = () => { state.draws++; if (state.failDraw) throw new Error('Draw failed'); };
  });
  return Object.assign(h, { state, host });
}

function drawInstance(h, m) {
  const instance = cameraInstance(h, m);
  instance.viewpoint[2] = 10; instance.currentResolution = 1;
  instance.attributes = { position: 0, normal: -1, color: -1, uv: -1, map: 0 };
  instance.selected = new Uint8Array(m.nodesCount); instance.selected[0] = 1;
  instance.renderList = new Uint32Array([0]); instance.renderCount = 1;
  return instance;
}

for (const api of ['native', 'extension']) {
  test(`${api} VAOs cache shader layouts, restore host state, and release on eviction`, () => {
    const h = renderingHarness(api), m = h.mesh([0], false);
    h.request(m, 0); h.geometry(m, 0); h.frame();
    assert.equal(h.state.array, h.host.array);
    assert.equal(h.state.index.get(h.host.vao), h.host.indices);
    const instance = drawInstance(h, m);
    instance.renderNodes(); instance.renderNodes();
    assert.equal(h.state.pointers.length, 1);
    assert.equal(h.state.draws, 2);
    assert.equal(h.state.vao, h.host.vao);
    assert.equal(h.state.array, h.host.array);
    assert.equal(h.state.index.get(h.host.vao), h.host.indices);
    instance.attributes.position = 4; instance.renderNodes();
    assert.equal(h.state.pointers.length, 2);
    m.vbo[0] = {}; instance.renderNodes();
    assert.equal(h.state.removed.length, 2);
    assert.equal(h.state.pointers.length, 3);
    h.state.failDraw = true;
    assert.throws(() => instance.renderNodes(), /Draw failed/);
    assert.equal(h.state.vao, h.host.vao);
    assert.equal(h.state.array, h.host.array);
    h.Nexus.flush(h.context, m);
    assert.equal(h.state.removed.length, 3);
    assert.equal(m.vertexArrays.size, 0);
  });
}

test('drawing remains available without vertex array support', () => {
  const h = renderingHarness('none'), m = h.mesh([0], false);
  h.request(m, 0); h.geometry(m, 0); h.frame();
  const instance = drawInstance(h, m);
  instance.renderNodes(); instance.renderNodes();
  assert.equal(h.state.draws, 2);
  assert.equal(h.state.pointers.length, 2);
  assert.equal(h.context.vertexArray, null);
});

test('texture uploads preserve host bindings and select trilinear/capped anisotropic filtering', () => {
  const h = renderingHarness(), m = h.mesh([0]);
  h.request(m, 0); h.complete(m, 0);
  assert.equal(h.state.texture, h.host.texture);
  assert.equal(h.state.flip, false);
  assert.equal(h.state.array, h.host.array);
  assert.equal(h.state.index.get(h.host.vao), h.host.indices);
  assert.ok(h.state.parameters.some(([, key, value]) => key === 'TEXTURE_MIN_FILTER' && value === 'LINEAR_MIPMAP_LINEAR'));
  assert.ok(h.state.parameters.some(([, key, value]) => key === 'aniso' && value === 4));
});

test('Three.js adapter caches shader locations while refreshing sampler units and viewport', () => {
  const source = fs.readFileSync(path.join(__dirname, '../html/js/nexus_three.js'), 'utf8');
  const adapter = source.slice(source.indexOf('const shaderBindings'), source.indexOf('NexusObject.prototype ='));
  const program = {}, fallbackProgram = {}, sampler = {};
  let attributes = 0, uniforms = 0, currentProgramReads = 0, mapUnit = 0, width = 800, calls = 0;
  const gl = { CURRENT_PROGRAM: 1,
    getParameter() { currentProgramReads++; return fallbackProgram; },
    getAttribLocation() { return attributes++; },
    getUniformLocation() { uniforms++; return sampler; },
    getUniform() { return mapUnit; },
  };
  const instance = { isReady: true, attributes: {}, mesh: { face: { index: true } },
    updateView(viewport) { this.lastViewport = Array.from(viewport); }, render() { calls++; } };
  const material = { size: 1 };
  let currentProgram = program;
  const renderer = { getContext: () => gl, getSize: size => size.set(width, 600),
    properties: { get: () => ({ currentProgram: { program: currentProgram } }) } };
  const camera = { projectionMatrix: { elements: [] } };
  const object = { visible: true, modelViewMatrix: { elements: [] } };
  const sandbox = { THREE };
  vm.createContext(sandbox); vm.runInContext(adapter, sandbox);
  const render = () => sandbox.onAfterRender.call(object, renderer, {}, camera, { instance }, material, null);
  render(); mapUnit = 3; width = 1000; render();
  assert.equal(attributes, 4); assert.equal(uniforms, 3);
  assert.equal(currentProgramReads, 0);
  assert.equal(instance.attributes.map, 3);
  assert.deepEqual(instance.lastViewport, [0, 0, 1000, 600]);
  currentProgram = null; render();
  assert.equal(currentProgramReads, 1);
  assert.equal(attributes, 8);
  object.visible = false; render();
  assert.equal(calls, 3);
});
