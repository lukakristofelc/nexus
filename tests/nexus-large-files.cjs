const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the actual browser parser with just its DOM and WebGL dependencies stubbed.
function loadNexus() {
	const requests = [];
	const sandbox = {
		console,
		document: { getElementsByTagName: () => [] },
		WebGLRenderingContext: function () {},
		XMLHttpRequest: class {
			constructor() { this.headers = {}; requests.push(this); }
			open() {}
			setRequestHeader(key, value) { this.headers[key] = value; }
			send() {}
		},
	};
	sandbox.window = sandbox;
	vm.createContext(sandbox);
	const source = fs.readFileSync(path.join(__dirname, '../html/js/nexus.js'), 'utf8');
	vm.runInContext(source, sandbox);
	return { Nexus: sandbox.Nexus, requests };
}

function indexFixture(geometryStart, textureStart) {
	// One renderable node, one sink, one patch, one texture, and its end sentinel.
	const buffer = new ArrayBuffer(2 * 44 + 12 + 2 * 68);
	const view = new DataView(buffer);
	view.setUint32(0, geometryStart / 256, true);
	view.setUint16(4, 3, true);
	view.setUint16(6, 1, true);
	view.setUint32(44, (geometryStart + 512) / 256, true);
	view.setUint32(44 + 40, 1, true);
	view.setUint32(88, 1, true); // child is the sink
	view.setUint32(92, 1, true); // last triangle
	view.setUint32(100, textureStart / 256, true);
	view.setUint32(168, (textureStart + 512) / 256, true);
	return buffer;
}

for (const [name, geometry, texture] of [
	['small files', 1024, 2048],
	['crossing 4 GiB', 2 ** 32 - 256, 2 ** 32 - 256],
	['past 8 GiB', 2 ** 33 + 256, 10113214208],
	['maximum NXS block address', 0xffffffff * 256 - 512, 0xffffffff * 256 - 512],
]) {
	test(`preserves byte ranges for ${name}`, () => {
		const { Nexus, requests } = loadNexus();
		const mesh = new Nexus.Mesh();
		Object.assign(mesh, {
			nodesCount: 2, patchesCount: 1, texturesCount: 2,
			vertex: { texCoord: true },
		});
		mesh.handleIndex(indexFixture(geometry, texture));
		assert.equal(mesh.noffsets[0], geometry);
		assert.equal(mesh.noffsets[1], geometry + 512);
		assert.equal(mesh.textures[0], texture);
		assert.equal(mesh.textures[1], texture + 512);
		assert.equal(mesh.nsize[0], 3 * 20 + 6);
		assert.equal(mesh.texsize[0], 512); // provisional reservation, not a 10x GPU estimate
		for (const offsets of [mesh.noffsets, mesh.textures]) {
			mesh.httpRequest({ url: 'fixture.nxs', start: offsets[0], end: offsets[1] });
		}
		assert.equal(requests[0].headers.Range, `bytes=${geometry}-${geometry + 511}`);
		assert.equal(requests[1].headers.Range, `bytes=${texture}-${texture + 511}`);
	});
}

test('reads 64-bit header counts without JavaScript bit-shift truncation', () => {
	const { Nexus } = loadNexus();
	const buffer = new ArrayBuffer(88);
	const view = new DataView(buffer);
	view.setUint32(0, 0x4e787320, true);
	view.setBigUint64(8, 0x200000003n, true);
	view.setBigUint64(16, 0x400000005n, true);
	view.offset = 0;
	const header = new Nexus.Mesh().importHeader(view);
	assert.equal(header.verticesCount, 8589934595);
	assert.equal(header.facesCount, 17179869189);
});
