const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness(webgl2 = false) {
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
  m.nroots = 2;
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
