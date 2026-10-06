/** Feathered canvas renderer ported from VeriSky/src/components/map/modelMapHtml.ts.
 * Per-pixel interpolation stays consistent across tile boundaries and zoom levels. */
import { NX, NY, RES, modelInfo } from './map-data.js';
const CALLED_ALPHA = 178, TIE_ALPHA = 60, FEATHER_PX = 20;
export function createScoreGrid(map) {
  const L = window.L;
  let activeGrid = null;
      var GridCanvas = L.GridLayer.extend({
        createTile: function (coords) {
          var tile = document.createElement('canvas');
          var size = this.getTileSize();
          tile.width = size.x;
          tile.height = size.y;
          var grid = activeGrid;
          if (!grid) return tile;
          var plane = grid.plane;
          var tab = grid.colorTab;

          var cellsAcross = NX / Math.pow(2, coords.z);
          var sharp = Math.max(1, size.x / cellsAcross / FEATHER_PX);
          var nw = coords.scaleBy(size);

          // Mercator separates: latitude depends only on the pixel row and
          // longitude only on the column, so the projection and the
          // neighbour/weight lookup tables run once per row and column.
          var r0 = new Int32Array(size.y);
          var r1 = new Int32Array(size.y);
          var tr = new Float32Array(size.y);
          for (var y = 0; y < size.y; y++) {
            var lat = this._map.unproject(L.point(nw.x, nw.y + y + 0.5), coords.z).lat;
            var u = (lat + 90) / RES;
            var fu = Math.floor(u);
            r0[y] = Math.min(NY - 1, Math.max(0, fu));
            r1[y] = Math.min(NY - 1, Math.max(0, fu + 1));
            tr[y] = Math.min(1, Math.max(0, (u - fu - 0.5) * sharp + 0.5));
          }
          var c0 = new Int32Array(size.x);
          var c1 = new Int32Array(size.x);
          var tc = new Float32Array(size.x);
          for (var x = 0; x < size.x; x++) {
            var lon = this._map.unproject(L.point(nw.x + x + 0.5, nw.y), coords.z).lng;
            var w = (((lon + 180) / RES) % NX + NX) % NX;
            var fw = Math.floor(w);
            c0[x] = fw;
            c1[x] = (fw + 1) % NX;
            tc[x] = Math.min(1, Math.max(0, (w - fw - 0.5) * sharp + 0.5));
          }

          var ctx = tile.getContext('2d');
          var img = ctx.createImageData(size.x, size.y);
          var data = img.data;

          for (var py = 0; py < size.y; py++) {
            var rb0 = r0[py] * NX;
            var rb1 = r1[py] * NX;
            var ty = tr[py];
            var outBase = py * size.x * 4;
            for (var px = 0; px < size.x; px++) {
              var v00 = plane[rb0 + c0[px]];
              var v01 = plane[rb0 + c1[px]];
              var v10 = plane[rb1 + c0[px]];
              var v11 = plane[rb1 + c1[px]];
              var o = outBase + px * 4;
              if (v00 === v01 && v00 === v10 && v00 === v11) {
                // Cell interiors (the vast majority of pixels): plain copy.
                var i = v00 * 4;
                data[o] = tab[i]; data[o + 1] = tab[i + 1]; data[o + 2] = tab[i + 2];
                data[o + 3] = tab[i + 3];
                continue;
              }
              var tx = tc[px];
              var i00 = v00 * 4, i01 = v01 * 4, i10 = v10 * 4, i11 = v11 * 4;
              // Alpha-weighted blend so transparent no-data neighbours fade
              // the colour out instead of dragging it toward black.
              var a00 = tab[i00 + 3] * (1 - ty) * (1 - tx);
              var a01 = tab[i01 + 3] * (1 - ty) * tx;
              var a10 = tab[i10 + 3] * ty * (1 - tx);
              var a11 = tab[i11 + 3] * ty * tx;
              var a = a00 + a01 + a10 + a11;
              if (a < 1) continue;
              data[o] = (tab[i00] * a00 + tab[i01] * a01 + tab[i10] * a10 + tab[i11] * a11) / a;
              data[o + 1] = (tab[i00 + 1] * a00 + tab[i01 + 1] * a01 + tab[i10 + 1] * a10 + tab[i11 + 1] * a11) / a;
              data[o + 2] = (tab[i00 + 2] * a00 + tab[i01 + 2] * a01 + tab[i10 + 2] * a10 + tab[i11 + 2] * a11) / a;
              data[o + 3] = a;
            }
          }
          ctx.putImageData(img, 0, 0);
          return tile;
        },
      });
      // Tiles are a few ms each, so render during panning: on mobile Leaflet
      // defaults updateWhenIdle to true, which left stale lower-zoom tiles
      // (scaled, differently smooth) sitting next to fresh ones with a hard
      // seam between them for as long as the user kept the map moving.
      var gridLayer = new GridCanvas({ pane: 'modelGrid', updateWhenIdle: false, keepBuffer: 4 });
      gridLayer.addTo(map);


  return {
    clear() { activeGrid = null; gridLayer.redraw(); },
    set(grid) {
      if (!grid.colorTab) {
        const tab = new Uint8ClampedArray(256 * 4);
        grid.prelude.roster.forEach((id, i) => {
          const hex = Number.parseInt(modelInfo(id).color.slice(1), 16);
          if (id === 'accuweather' || id.startsWith('verisky_')) return;
          tab.set([(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, CALLED_ALPHA], i * 4);
        });
        tab.set([148, 163, 184, TIE_ALPHA], 254 * 4);
        grid.colorTab = tab;
      }
      activeGrid = grid;
      gridLayer.redraw();
    },
  };
}
