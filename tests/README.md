# Nexus regression tests

These tests accompany the Nexus changes imported from cloud-test. The five
converter patches are applied directly to `src/nxsbuild`, rather than stored as
patches for a Docker build:

- Missing/invalid UVs and fully transparent textures use a padded fallback atlas
  region instead of sampling an unrelated texture.
- OBJ vertex RGB survives texture seams and simplification on fallback faces.
- `nxsbuild -L` / `--lossless-textures` writes PNG atlases, preserves full-detail
  source pixels, and enables regional texture caching. JPEG remains the default.
- Regional caching prepares only the texture tiles required by each geometry LOD.
- OBJ point-cloud loading rewinds after material-library scanning.

The browser changes are adapted to `html/js/nexus.js`: large-file offsets,
decoded GPU texture accounting, shared textures, request cancellation/retries,
and camera-dependent cache priorities. The cache retains at least one loaded
root per mesh, a helper required by the imported eviction logic.

The `nexus_three.js` render hook still calls `Nexus.updateCache`. Removing that
call in cloud-test depended on its CustomViewer calling `Nexus.endFrame` after
rendering all meshes. That application integration is not part of this import.
The separate `nexus3d` implementation is not covered by these browser tests.

## Browser tests

Run from the repository root with Node.js 18 or newer:

```sh
node --test tests/nexus-cache.cjs tests/nexus-large-files.cjs
```

These 21 cases exercise the actual browser library with DOM/WebGL stubs; they
do not perform a visual browser rendering test.

## Converter tests

Build Nexus with Qt 6, VCGLib, and the recorded Corto submodule. The original
patch series used VCGLib revision `5cae2abc2f9056785b0537dcbe156c40da2aea20`.
With dependencies available, for example:

```sh
git submodule update --init --recursive
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_NXS_EDIT=OFF -DBUILD_NXS_VIEW=OFF -DVCGDIR=/path/to/vcglib
cmake --build build --target nxsbuild --parallel 4
```

With Python 3 and Pillow installed, pass the newly built executable to both
scripts. Together they contain 55 cases checking output geometry, UVs, colors,
lossless pixels, disk-cache eviction, and large source images:

```sh
python3 tests/test_missing_textures.py /path/to/nxsbuild
python3 tests/test_texture_preservation.py /path/to/nxsbuild
```

The standalone C++ test compares regional and original pyramids in 16 cases,
each across nine levels. With Qt 6 exposed through pkg-config:

```sh
c++ -std=c++17 -O2 tests/test_texture_regions.cpp src/nxsbuild/texpyramid.cpp \
  -Isrc/nxsbuild -I/path/to/vcglib -I/path/to/vcglib/eigenlib \
  $(pkg-config --cflags --libs Qt6Gui Qt6Core) -o /tmp/test_texture_regions
/tmp/test_texture_regions
```
