// Adapted from VeriSky basemapLayer.ts and modelMapHtml.ts (OpenFreeMap).
export function installScoreBasemap(map) {
      function refLineWidth(width, extra) {
        if (typeof width === 'number') return width + extra;
        if (Array.isArray(width) && ['step', 'interpolate'].includes(width[0])) {
          // Zoom must stay at the top level; increase each output stop.
          var copy = JSON.parse(JSON.stringify(width));
          for (var i = width[0] === 'step' ? 2 : 4; i < copy.length; i += 2) {
            copy[i] = typeof copy[i] === 'number' ? copy[i] + extra : ['+', copy[i], extra];
          }
          return copy;
        }
        return 1 + extra;
      }

      function cloneRefLayer(layer, role, paintOverride) {
        var copy = JSON.parse(JSON.stringify(layer));
        copy.id = 'mm-ref-' + role + '-' + layer.id;
        copy.paint = Object.assign({}, copy.paint || {}, paintOverride);
        return copy;
      }

      function addReferenceGeo(glMap) {
        var upstream = typeof basemapStyleJson === 'object' ? basemapStyleJson : null;
        if (!upstream || !upstream.layers) return;
        var styleNow = glMap.getStyle();
        var beforeId = styleNow && styleNow.layers && styleNow.layers.length
          ? styleNow.layers[0].id
          : undefined;
        var under = [];
        var over = [];
        upstream.layers.forEach(function (layer) {
          if (layer.type === 'fill' && layer['source-layer'] === 'water') {
            under.push(cloneRefLayer(layer, 'shade', {
              'fill-color': VERISKY_MAP_INK.waterShade,
              'fill-opacity': VERISKY_MAP_INK.waterShadeOpacity,
              'fill-antialias': true,
            }));
            return;
          }
          if (layer.type !== 'line' || layer['source-layer'] !== 'boundary') return;
          // Upstream filters (maritime borders off, disputed dashes) and the
          // z0-4/z5- zoom splits survive the clone; only the paint changes.
          var minor = String(layer.id).indexOf('state') >= 0;
          var width = (layer.paint || {})['line-width'];
          under.push(cloneRefLayer(layer, 'halo', {
            'line-color': VERISKY_MAP_INK.lineHalo,
            'line-opacity': minor ? 0.5 : 0.7,
            'line-width': refLineWidth(width, 2),
          }));
          over.push(cloneRefLayer(layer, 'core', {
            'line-color': VERISKY_MAP_INK.lineCore,
            'line-opacity': minor ? 0.4 : 0.6,
          }));
        });
        under.concat(over).forEach(function (layer) {
          if (glMap.getLayer(layer.id)) return;
          try { glMap.addLayer(layer, beforeId); } catch (e) { /* best effort */ }
        });
      }

      window.onVeriskyBasemapLayerReady = function (glMap, role) {
        if (role !== 'labels') return;
        glMap.on('style.load', function () { addReferenceGeo(glMap); });
        if (glMap.isStyleLoaded && glMap.isStyleLoaded()) addReferenceGeo(glMap);
      };


      var basemapInstallStarted = false;
      // Fetched style JSON, kept so a WebGL retry does not refetch it.
      var basemapStyleJson = null;
      // Roles already live on the map, so a retry rebuilds only what is missing.
      var basemapInstalledRoles = {};

      // Delays before each install retry. A basemap failure is almost always
      // transient: a request dropped on a mobile network, or a WebGL context
      // the system refused because another map WebView had not finished
      // releasing its own (each map document holds two or three). A one-shot
      // install turned either into a black map for the whole life of the
      // WebView — closing and reopening the sheet was the only way out.
      var BASEMAP_RETRY_MS = [400, 1200, 3500];
      var BASEMAP_STYLE_TIMEOUT_MS = 12000;
      // How long a GL layer may exist without painting a single tile.
      var BASEMAP_BLANK_MS = 9000;
      var BASEMAP_BLANK_RELOADS = 2;

      function basemapReport(stage, detail) {
        console.warn('Basemap: ' + stage, detail);
        if (typeof window.onVeriskyBasemapStatus === 'function') {
          var message = detail && detail.message ? detail.message : detail;
          window.onVeriskyBasemapStatus({
            stage: stage,
            detail: message == null ? '' : String(message),
          });
        }
      }

      // One style slice per stacking position: symbol layers (labels) or
      // everything else. Sources, glyphs and sprite are carried into both —
      // symbol layers need glyphs/sprite, and slicing must not drop the
      // style's raster shading source.
      function basemapStyleSlice(upstream, wantSymbols, weatherReferences) {
        var slice = {
          version: 8,
          sources: upstream.sources || {},
          layers: (upstream.layers || []).filter(function (layer) {
            return (layer.type === 'symbol') === wantSymbols;
          }),
        };
        if (wantSymbols && weatherReferences) {
          var shores = (upstream.layers || []).filter(function (layer) {
            return layer.type === 'fill' && layer['source-layer'] === 'water';
          }).map(function (layer) {
            // Fill outlines respect polygon tile clipping, unlike stroking
            // water polygons as lines, which can expose tile-edge seams.
            // Keep the interior transparent so wind colours remain intact.
            return Object.assign({}, layer, {
              id: 'weather-shore-' + layer.id,
              paint: {
                'fill-color': 'rgba(0,0,0,0)',
                'fill-outline-color': VERISKY_MAP_INK.shoreOutline,
                'fill-antialias': true,
              },
            });
          });
          slice.layers = shores.concat(slice.layers.map(function (layer) {
            var layout = Object.assign({}, layer.layout || {});
            if (layer['source-layer'] === 'place') {
              layout['text-transform'] = 'none';
              if (typeof layout['text-size'] === 'number') {
                layout['text-size'] = Math.max(12, layout['text-size']);
              }
            }
            return Object.assign({}, layer, {
              layout: layout,
              paint: Object.assign({}, layer.paint || {}, {
                'text-color': VERISKY_MAP_INK.labelText,
                'text-halo-color': VERISKY_MAP_INK.labelHalo,
                'text-halo-width': 1.6,
                'text-halo-blur': 0.25,
              }),
            });
          }));
        }
        if (upstream.glyphs) slice.glyphs = upstream.glyphs;
        if (upstream.sprite) slice.sprite = upstream.sprite;
        return slice;
      }



      var VERISKY_MAP_INK = { waterShade: '#060c19', waterShadeOpacity: 0.5, lineHalo: '#05080f', lineCore: '#f8fafc', shoreOutline: '#cbd5e1', labelText: '#f8fafc', labelHalo: '#080e1e' };

      // Leaflet binds a layer's map event handlers *before* it calls onAdd, so a
      // GL layer whose WebGL context fails to build stays registered with live
      // handlers around a null map: the next pan throws inside its handler and
      // aborts the whole event dispatch, taking the wind/rain layers' own
      // handlers down with it. Adding through here leaves a failed layer
      // completely detached instead, so only the basemap is missing.
      function veriskyAddGlLayer(map, layer) {
        try {
          layer.addTo(map);
        } catch (error) {
          // The bridge's own onRemove dereferences the GL map that never got
          // built; swap in one that only undoes what did happen. removeLayer
          // then unbinds the handlers and drops the layer from the map.
          layer.onRemove = function () {
            if (this._container && this._container.parentNode) {
              this._container.parentNode.removeChild(this._container);
            }
            if (this._glMap) {
              try { this._glMap.remove(); } catch (removeError) { /* already dead */ }
              this._glMap = null;
            }
          };
          try { map.removeLayer(layer); } catch (cleanupError) { /* best effort */ }
          throw error;
        }
        return layer;
      }


      // The quieter half of a black map: the context builds and the style
      // loads, but no vector tile ever arrives. MapLibre re-requests a failed
      // tile only when the viewport changes, so a map the user is not touching
      // stays empty for good. While the layer has never painted a single tile,
      // reload the style — the same recovery MapLibre runs after a lost
      // context. One tile is enough to disarm this for good, so an ordinary
      // slow pan can never trigger a reload.
      function watchBlankBasemapLayer(glMap, style, role) {
        var sawTile = false;
        var alive = true;
        var reloads = 0;
        glMap.on('data', function (event) {
          if (event && event.dataType === 'source' && event.tile) sawTile = true;
        });
        glMap.on('remove', function () { alive = false; });
        function check() {
          if (sawTile || !alive) return;
          if (reloads >= BASEMAP_BLANK_RELOADS) {
            basemapReport('layer still blank, giving up (' + role + ')', role);
            return;
          }
          reloads += 1;
          basemapReport('layer blank, reloading style (' + role + ')', role);
          try {
            glMap.setStyle(style, { diff: false });
          } catch (error) {
            basemapReport('style reload failed (' + role + ')', error);
            return;
          }
          setTimeout(check, BASEMAP_BLANK_MS);
        }
        setTimeout(check, BASEMAP_BLANK_MS);
      }

      function addBasemapLayer(map, style, pane, role) {
        var layer = L.maplibreGL({
          style: style,
          pane: pane,
          interactive: false,
          // Surfaces through Leaflet's attribution control (the bridge's
          // getAttribution) as plain text: the style's own source attributions
          // carry <a> links, and a tap on one would navigate the WebView away
          // from the map document. Both layers pass the identical text, which
          // Leaflet's control dedupes to a single credit.
          attributionControl: { customAttribution: 'OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap' },
        });
        veriskyAddGlLayer(map, layer);
        basemapInstalledRoles[role] = true;
        var glMap = layer.getMaplibreMap();
        if (glMap) {
          glMap.on('error', function (event) {
            basemapReport('layer error (' + role + ')', event && event.error ? event.error : event);
          });
          // MapLibre rebuilds itself from webglcontextrestored, so these are
          // reported rather than handled — a device that keeps losing contexts
          // is worth seeing in the map's own diagnostics.
          glMap.on('webglcontextlost', function () { basemapReport('context lost (' + role + ')', role); });
          glMap.on('webglcontextrestored', function () { basemapReport('context restored (' + role + ')', role); });
          watchBlankBasemapLayer(glMap, style, role);
          // Data maps may need the exact vector geometry used by the basemap.
          // The current map uses this hook to query OpenMapTiles' water
          // polygons before drawing an arrow. Other maps leave it undefined.
          if (typeof window.onVeriskyBasemapLayerReady === 'function') {
            window.onVeriskyBasemapLayerReady(glMap, role);
          }
        }
      }

      function fetchBasemapStyle(url) {
        if (basemapStyleJson) return Promise.resolve(basemapStyleJson);
        // A request that never settles would stall the install for as long as
        // the WebView lives, so the retry schedule owns the deadline.
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timer = setTimeout(function () {
          if (controller) controller.abort();
        }, BASEMAP_STYLE_TIMEOUT_MS);
        return fetch(url, controller ? { signal: controller.signal } : undefined)
          .then(function (res) {
            if (!res.ok) throw new Error('Basemap style request failed: ' + res.status);
            return res.json();
          })
          .then(function (style) {
            clearTimeout(timer);
            basemapStyleJson = style;
            return style;
          }, function (error) {
            clearTimeout(timer);
            throw error;
          });
      }

      // Only the roles that are still missing, so a retry after a half-built
      // install (base up, labels refused a context) does not duplicate a layer.
      function addMissingBasemapLayers(map, options) {
        if (typeof L.maplibreGL !== 'function') throw new Error('MapLibre bridge unavailable');
        if (!options.labelPane) {
          if (!basemapInstalledRoles.all) addBasemapLayer(map, basemapStyleJson, 'tilePane', 'all');
          return;
        }
        if (!basemapInstalledRoles.base) {
          addBasemapLayer(map, basemapStyleSlice(basemapStyleJson, false), 'tilePane', 'base');
        }
        if (!basemapInstalledRoles.labels) {
          addBasemapLayer(map, basemapStyleSlice(basemapStyleJson, true, options.weatherReferences), options.labelPane, 'labels');
        }
      }

      function attemptBasemapInstall(map, options, attempt) {
        fetchBasemapStyle(options.styleUrl)
          .then(function () {
            addMissingBasemapLayers(map, options);
            if (attempt > 0) basemapReport('installed after retry ' + attempt, '');
          })
          .catch(function (error) {
            if (attempt < BASEMAP_RETRY_MS.length) {
              basemapReport('install failed, retrying', error);
              setTimeout(function () {
                attemptBasemapInstall(map, options, attempt + 1);
              }, BASEMAP_RETRY_MS[attempt]);
              return;
            }
            // Best-effort: a missing basemap must never break the working map.
            basemapReport('unavailable, keeping plain canvas', error);
            if (options.fallbackAttribution) map.attributionControl.addAttribution(options.fallbackAttribution);
            if (typeof window.onVeriskyBasemapError === 'function') {
              window.onVeriskyBasemapError(error);
            }
          });
      }

      function installBasemap(map, options) {
        if (basemapInstallStarted) return;
        basemapInstallStarted = true;
        attemptBasemapInstall(map, options, 0);
      }

      installBasemap(map, {
        styleUrl: 'https://tiles.openfreemap.org/styles/dark',
        labelPane: 'mapReference',
        weatherReferences: true,
      });


}
