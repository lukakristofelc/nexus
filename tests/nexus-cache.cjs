const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function harness(webgl2 = false) {
  const images = [], revoked = [], uploads = [], deleted = [];
  class WebGL1 {}
  const gl = webgl2 ? {} : new WebGL1();
  Object.assign(gl, {
    isTexture() {}, isContextLost: () => false, getParameter: () => false,
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, deleteBuffer() {},
    createTexture: () => ({}), bindTexture() {}, pixelStorei() {}, texParameteri() {},
    texImage2D(...args) { uploads.push(args.at(-1)); }, generateMipmap() {},
    deleteTexture(t) { deleted.push(t); },
  });
  const sandbox = {
    console, WebGLRenderingContext: WebGL1,
    URL: { createObjectURL: () => `blob:${images.length}`, revokeObjectURL: u => revoked.push(u) },
    document: {
      getElementsByTagName: () => [],
      createElement() { const img = {}; images.push(img); return img; },
    },
    XMLHttpRequest: class {
      constructor() { this.readyState = 1; }
      open() {} setRequestHeader() {} send() {}
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
    m.texreq[id].complete({});
    const img = images.at(-1); Object.assign(img, { width, height }); img.onload();
  }
  function complete(m, id, width, height) { geometry(m, id); texture(m, id, width, height); }
  return { Nexus, gl, context, mesh, candidate, request, geometry, texture, complete,
    images, revoked, uploads, deleted };
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

test('a failed shared-atlas request completes if another node already uploaded it', () => {
  const h = harness(), m = h.mesh([0, 0, 1]);
  h.request(m, 0); h.request(m, 1);
  h.geometry(m, 1); m.texreq[1].complete({});
  const failed = h.images.at(-1);
  h.complete(m, 0);
  failed.onerror();
  assert.equal(m.status[1], 1);
  assert.equal(h.context.pending, 0);
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
  h.request(m, 0); h.geometry(m, 0);
  assert.equal(h.context.pending, 0);
  assert.equal(h.context.cacheSize, 42);
  h.Nexus.flush(h.context, m);
  assert.equal(h.context.cacheSize, 0);
});
