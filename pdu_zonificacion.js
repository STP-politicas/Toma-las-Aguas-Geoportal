/* =====================================================================
   CHAC MOOL · MÓDULO PDU – ZONIFICACIÓN SECUNDARIA
   ---------------------------------------------------------------------
   - Carga la nueva capa del PDU desde Supabase (con paginación: >1000 filas)
   - Muestra la clasificación del municipio (tipo, clave, CVE, COS, CUS,
     niveles, restricciones, densidades) en el popup de cada polígono
   - Botón "Calcular": cruza el polígono con todas las capas del geoportal
     (humedales, IAHCSA, karst, colapso, fallas, POEL, pozos, ejidos,
     fraccionamientos, proyectos, descargas/extracciones)
   Requiere que el geoportal ya haya definido: map, layerGroups,
   allLayersData, SUPABASE_URL, SUPABASE_KEY, isUTM, convertUTMtoLatLon, COLORS
   ===================================================================== */
(function () {
    'use strict';

    // ---------------- CONFIGURACIÓN ----------------
    const PDU_CONFIG = {
        tabla: 'porcentaje de viviendas en humedales pdu2026 copy',   // nombre exacto de la tabla en Supabase
        tamPagina: 1000,                // Supabase entrega máximo 1000 filas por petición
        turfURL: 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js',
        areaMinima: 1                   // m² — ignora traslapes menores (ruido numérico)
    };

    // Colores por Clave de uso de suelo
    const PDU_COLORES = {
        'ANP': '#14532d', 'CON': '#15803d', 'ZDVC': '#4d7c0f', 'AVTP': '#65a30d',
        'EP': '#84cc16', 'H': '#facc15', 'HM': '#fb923c', 'CM': '#ef4444',
        'C': '#be123c', 'TC': '#c026d3', 'TH': '#9333ea', 'TE': '#a855f7',
        'I': '#78716c', 'INF': '#6b7280', 'EU': '#2563eb', 'RT': '#d6b98c',
        'RTE': '#b45309', 'PODECIB': '#0d9488'
    };
    // Claves que, por su naturaleza, habilitan urbanización
    const CLAVES_URBANIZABLES = ['H', 'HM', 'CM', 'C', 'TC', 'TH', 'TE', 'I', 'EU', 'AVTP'];

    const NOMBRES_HUMEDAL = {
        'manglar': 'Manglar', 'manglar 2': 'Manglar 2', 'tular': 'Tular',
        'planicie carstica sujeta a inu': 'Planicie cárstica sujeta a inundación',
        'suelo con poca vegetacion prop': 'Suelo con poca vegetación propensa a inundación',
        'zona de manglar inundada (est': 'Manglar inundado',
        'selva mediana perennifolia': 'Manglar con selva mediana perennifolia',
        'nubes': 'Planicies kársticas sujetas a inundación',
        'zona de cambio de uso de suelo': 'Zona inundada impactada por cambio de uso de suelo'
    };

    const CUERPOS_IAHCSA = [
        ['piscinas', 'Piscinas'], ['cenotesSup', 'Cenotes modificados'],
        ['cenotesSub', 'Cenotes artificiales'], ['aguadasArt', 'Aguadas antropizadas'],
        ['aguadasNat', 'Aguadas naturales'], ['sascab', 'Sascaberas'],
        ['rios', 'Ríos artificiales']
    ];

    // ---------------- ESTADO ----------------
    const estado = {
        features: [],            // features GeoJSON (lng/lat) indexados por _k
        capaPorKey: {},          // _k -> capa Leaflet
        gruposTipo: {},          // tipo -> L.geoJSON
        grupoPadre: null,
        opacidad: 0.45,
        seleccion: null,
        ultimoResumen: ''
    };

    // ---------------- UTILIDADES ----------------
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const vacio = v => v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '--' || String(v).toLowerCase() === 'nan';

    function colorDe(p) {
        const clave = (p.Clave || '').toString().trim().toUpperCase();
        if (PDU_COLORES[clave]) return PDU_COLORES[clave];
        const s = clave || p.tipo || 'x';
        let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
        return `hsl(${h},65%,50%)`;
    }

    function parseNum(v) {
        if (vacio(v)) return null;
        const n = parseFloat(String(v).replace(/,/g, '').replace(/[^\d.\-]/g, ''));
        return isNaN(n) ? null : n;
    }

    function parsePct(v) {
        if (vacio(v)) return null;
        const s = String(v);
        const n = parseNum(s);
        if (n === null) return null;
        if (s.includes('%')) return n / 100;
        return n <= 1 ? n : n / 100;
    }

    // "60 viviendas/hectárea", "1 vivienda por cada 167 m2 de terreno", "1 vivienda por lote"
    function parseDensidad(v, areaM2) {
        if (vacio(v) || String(v).trim() === '0') return null;
        const s = String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let m = s.match(/([\d.,]+)\s*(viviendas?|cuartos?)\s*\/\s*hect/);
        if (m) return { valor: parseNum(m[1]) * areaM2 / 10000, texto: v };
        m = s.match(/([\d.,]+)\s*(viviendas?|cuartos?)\s*por\s*cada\s*([\d.,]+)\s*m/);
        if (m) return { valor: parseNum(m[1]) * areaM2 / parseNum(m[3]), texto: v };
        if (s.includes('por lote')) return { valor: null, texto: v };
        return { valor: null, texto: v };
    }

    function fmtM2(a) {
        if (a === null || a === undefined || isNaN(a)) return '—';
        if (a >= 10000) return `${Math.round(a).toLocaleString('es-MX')} m² (${(a / 10000).toLocaleString('es-MX', { maximumFractionDigits: 2 })} ha)`;
        return `${a.toLocaleString('es-MX', { maximumFractionDigits: 0 })} m²`;
    }
    const fmtN = (n, d = 0) => (n === null || n === undefined || isNaN(n)) ? '—' : n.toLocaleString('es-MX', { maximumFractionDigits: d });
    const pct = (a, total) => total > 0 ? ` · ${(100 * a / total).toLocaleString('es-MX', { maximumFractionDigits: 1 })}%` : '';

    function formatVol(v) {
        if (typeof formatVolume === 'function') return formatVolume(v);
        return `${fmtN(v, 3)} hm³/año`;
    }

    function cargarTurf() {
        if (typeof turf !== 'undefined') return Promise.resolve();
        if (cargarTurf._p) return cargarTurf._p;
        cargarTurf._p = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = PDU_CONFIG.turfURL;
            s.onload = () => res();
            s.onerror = () => rej(new Error('No se pudo cargar Turf.js'));
            document.head.appendChild(s);
        });
        return cargarTurf._p;
    }

    // ---------------- GEOMETRÍA ----------------
    function convPunto(c) {
        const x = c[0], y = c[1];
        if (typeof isUTM === 'function' && isUTM(x, y)) {
            const r = convertUTMtoLatLon(x, y);
            return r ? [r.lon, r.lat] : null;
        }
        return [x, y];
    }

    function convAnillo(r) {
        const c = r.map(convPunto).filter(Boolean);
        if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push(c[0]);
        return c.length >= 4 ? c : null;
    }

    function convPoligono(p) {
        const rings = p.map(convAnillo).filter(Boolean);
        return rings.length ? rings : null;
    }

    function obtenerGeometria(item) {
        let g = item.geojson || item.geom || item.geometry || item.the_geom || item.wkb_geometry;
        if (!g) return null;
        if (typeof g === 'string') {
            try { g = JSON.parse(g); }
            catch (e) {
                if (!obtenerGeometria._avisado) {
                    console.warn('[PDU] La geometría llega como texto no-JSON (probablemente WKB). Expón la columna como GeoJSON (ST_AsGeoJSON) o impórtala igual que las demás capas.');
                    obtenerGeometria._avisado = true;
                }
                return null;
            }
        }
        const polys = [];
        const agregar = geo => {
            if (!geo) return;
            if (geo.type === 'Polygon') { const p = convPoligono(geo.coordinates); if (p) polys.push(p); }
            else if (geo.type === 'MultiPolygon') geo.coordinates.forEach(pc => { const p = convPoligono(pc); if (p) polys.push(p); });
            else if (geo.type === 'GeometryCollection') geo.geometries.forEach(agregar);
        };
        agregar(g);
        if (!polys.length) return null;
        return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
    }

    const bboxTraslapa = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

    // Convierte un L.Polygon del geoportal en partes turf. El geoportal aplana
    // multipolígonos en anillos; aquí cada anillo es una parte y si el anillo
    // cae dentro del primero se trata como hueco (se resta).
    function partesDe(layer) {
        if (layer._pduPartes) return layer._pduPartes;
        const anillos = [];
        (function walk(a) {
            if (!Array.isArray(a) || !a.length) return;
            if (a[0] && typeof a[0].lat === 'number') anillos.push(a);
            else a.forEach(walk);
        })(layer.getLatLngs());
        const partes = anillos.map(r => {
            const c = r.map(p => [p.lng, p.lat]);
            if (c.length && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1])) c.push(c[0]);
            if (c.length < 4) return null;
            try { const poly = turf.polygon([c]); return { poly, bbox: turf.bbox(poly), signo: 1 }; }
            catch (e) { return null; }
        }).filter(Boolean);
        if (partes.length > 1) {
            for (let i = 1; i < partes.length; i++) {
                const v = partes[i].poly.geometry.coordinates[0][0];
                try { if (turf.booleanPointInPolygon(v, partes[0].poly)) partes[i].signo = -1; } catch (e) { }
            }
        }
        layer._pduPartes = partes;
        return partes;
    }

    function areaTraslape(obj, layer, ctx) {
        let area = 0;
        for (const parte of partesDe(layer)) {
            if (!bboxTraslapa(parte.bbox, obj.bbox)) continue;
            try {
                const i = turf.intersect(obj.feature, parte.poly);
                if (i) area += parte.signo * turf.area(i);
            } catch (e) { ctx.errores++; }
        }
        return Math.max(0, area);
    }

    function poligonosDe(nombreGrupo) {
        const out = [];
        const g = layerGroups && layerGroups[nombreGrupo];
        if (!g) return out;
        g.eachLayer(l => { if (l instanceof L.Polygon) out.push(l); });
        return out;
    }

    function textoPopup(layer) {
        const p = layer.getPopup && layer.getPopup();
        if (!p) return '';
        const c = p.getContent();
        return typeof c === 'string' ? c : '';
    }

    function colorInverso(mapa) {
        const inv = {};
        Object.entries(mapa || {}).forEach(([k, v]) => { if (k !== 'default') inv[String(v).toLowerCase()] = k; });
        return inv;
    }

    // ---------------- CARGA DE DATOS ----------------
    async function traerTodo() {
        const filas = [];
        let offset = 0;
        while (true) {
            const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(PDU_CONFIG.tabla)}?select=*&limit=${PDU_CONFIG.tamPagina}&offset=${offset}`;
            const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
            if (!r.ok) throw new Error(`HTTP ${r.status} – ${await r.text()}`);
            const d = await r.json();
            filas.push(...d);
            if (d.length < PDU_CONFIG.tamPagina) break;
            offset += PDU_CONFIG.tamPagina;
            if (typeof updateLoading === 'function') updateLoading(`Cargando PDU… ${filas.length} polígonos`);
        }
        return filas;
    }

    function estilo(feature) {
        const c = colorDe(feature.properties);
        return { color: c, weight: 1, opacity: 0.9, fillColor: c, fillOpacity: estado.opacidad };
    }

    async function cargarPDU() {
        const cont = document.getElementById('count-pdu');
        try {
            const filas = await traerTodo();
            let sinGeom = 0;
            const porTipo = {};
            filas.forEach(item => {
                const geom = obtenerGeometria(item);
                if (!geom) { sinGeom++; return; }
                const props = {};
                Object.keys(item).forEach(k => {
                    if (!['geom', 'geojson', 'geometry', 'the_geom', 'wkb_geometry'].includes(k)) props[k] = item[k];
                });
                props._k = estado.features.length;
                const f = { type: 'Feature', properties: props, geometry: geom };
                estado.features.push(f);
                const tipo = (props.tipo || props.Name || 'Sin tipo').toString().trim();
                (porTipo[tipo] = porTipo[tipo] || []).push(f);
            });

            const renderer = L.canvas({ pane: 'pduPane', padding: 0.3 });
            estado.grupoPadre = L.layerGroup();
            Object.entries(porTipo).forEach(([tipo, feats]) => {
                const g = L.geoJSON(feats, {
                    pane: 'pduPane',
                    renderer,
                    style: estilo,
                    onEachFeature: (f, layer) => {
                        estado.capaPorKey[f.properties._k] = layer;
                        layer.bindPopup(() => popupPDU(f), { maxWidth: 380, minWidth: 280 });
                        layer.on('mouseover', () => { if (estado.seleccion !== layer) layer.setStyle({ weight: 2.5, fillOpacity: Math.min(estado.opacidad + 0.2, 0.9) }); });
                        layer.on('mouseout', () => { if (estado.seleccion !== layer) layer.setStyle(estilo(f)); });
                    }
                });
                estado.gruposTipo[tipo] = g;
                g.addTo(estado.grupoPadre);
            });
            layerGroups.pdu = estado.grupoPadre;
            if (document.getElementById('layer-pdu').checked) estado.grupoPadre.addTo(map);

            if (cont) { cont.textContent = estado.features.length; cont.classList.add('loaded'); }
            construirFiltros(porTipo);
            construirLeyenda(porTipo);
            console.log(`✓ PDU: ${estado.features.length} polígonos cargados (${sinGeom} sin geometría)`);
            if (sinGeom && !estado.features.length) {
                avisoPanel('La tabla del PDU cargó, pero ninguna fila trae geometría legible. Revisa el nombre de la columna de geometría.');
            }
        } catch (e) {
            console.error('[PDU] Error cargando zonificación:', e);
            if (cont) cont.textContent = '!';
            avisoPanel(`No se pudo leer la tabla «${esc(PDU_CONFIG.tabla)}». Verifica el nombre en PDU_CONFIG.tabla y que la política RLS permita lectura pública.`);
        }
    }

    // ---------------- POPUP DEL POLÍGONO ----------------
    function decodificarCVE(cve) {
        const partes = String(cve || '').split('/');
        if (partes.length !== 4) return '';
        const [uso, niv, cos, den] = partes;
        if (niv === '0' && cos === '0') return `Uso ${esc(uso)}, sin aprovechamiento urbano`;
        return `Uso ${esc(uso)}, ${esc(niv)} niveles, COS ${esc(cos)}%, rango de densidad ${esc(den)}`;
    }

    function popupPDU(f) {
        const p = f.properties;
        const c = colorDe(p);
        const fila = (etq, v) => `<tr><td style="color:#6b7280;padding:3px 8px 3px 0;vertical-align:top;white-space:nowrap;">${etq}</td><td style="padding:3px 0;"><strong>${vacio(v) ? '—' : esc(v)}</strong></td></tr>`;
        const sup = !vacio(p.HAS) ? `${esc(p.HAS)} ha` : '';
        const m2 = !vacio(p.area_m2) ? `${esc(p.area_m2)} m²` : '';
        const excluir = ['_k', 'timstmp', 'begin', 'end', 'alttdMd', 'tessllt', 'extrude', 'visblty', 'drwOrdr', 'icon', 'snippet'];
        const todos = Object.entries(p).filter(([k, v]) => !excluir.includes(k) && !vacio(v))
            .map(([k, v]) => `<div><span style="color:#6b7280;">${esc(k)}:</span> ${esc(v)}</div>`).join('');

        return `
        <div class="custom-popup">
            <h3 style="color:${c};">🏙️ PDU: ${esc(p.tipo || p.Name || 'Sin tipo')}</h3>
            <div class="custom-popup-divider" style="border-color:${c};">
                <div style="background:#f8fafc;border-left:4px solid ${c};padding:8px 10px;border-radius:4px;margin-bottom:8px;">
                    <div style="font-size:15px;font-weight:700;color:#1f2937;">${esc(p.CVE || p.Clave || '')}</div>
                    <div style="font-size:11px;color:#4b5563;">${decodificarCVE(p.CVE)}</div>
                </div>
                <table style="font-size:12px;border-collapse:collapse;width:100%;">
                    ${fila('Identificador', p.id)}
                    ${fila('Clave', p.Clave)}
                    ${fila('Superficie', [sup, m2].filter(Boolean).join(' / '))}
                    ${fila('COS', p.COS)}
                    ${fila('CUS', p.CUS)}
                    ${fila('Niveles', p.Niveles)}
                    ${fila('Altura máx.', p.Altura)}
                    ${fila('Restr. frontal', p.Rst_frn)}
                    ${fila('Restr. fondo', p.Rst_fnd)}
                    ${fila('Restr. lateral', p.Rest_lt)}
                    ${fila('Dens. vivienda', p.Den_viv)}
                    ${fila('Dens. cuartos', p.Den_Cts)}
                </table>
                <details style="margin-top:8px;font-size:11px;">
                    <summary style="cursor:pointer;color:#2563eb;">Ver todos los campos del municipio</summary>
                    <div style="margin-top:6px;line-height:1.5;">${todos}</div>
                </details>
                <button type="button" onclick="event.stopPropagation(); PDU.calcular(${p._k});"
                    style="margin-top:12px;width:100%;padding:10px;background:#0f766e;color:white;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:13px;">
                    🧮 Calcular qué hay en este polígono
                </button>
            </div>
        </div>`;
    }

    // ---------------- ANÁLISIS ESPACIAL ----------------
    function analizar(f) {
        const p = f.properties;
        const feature = turf.feature(f.geometry);
        const obj = { feature, bbox: turf.bbox(feature) };
        const ctx = { errores: 0 };
        const areaGeom = turf.area(feature);
        const areaAttr = parseNum(p.area_m2);
        const area = areaAttr && areaAttr > 0 ? areaAttr : areaGeom;
        const R = { area, areaGeom };

        const dentro = (lng, lat) =>
            lng >= obj.bbox[0] && lng <= obj.bbox[2] && lat >= obj.bbox[1] && lat <= obj.bbox[3] &&
            turf.booleanPointInPolygon([lng, lat], feature);

        // Humedales / zonas inundables
        const invSocio = colorInverso(COLORS.socioeco);
        R.humedales = {}; R.humedalTotal = 0;
        poligonosDe('socioeco').forEach(l => {
            const a = areaTraslape(obj, l, ctx);
            if (a < PDU_CONFIG.areaMinima) return;
            const tipo = invSocio[String(l.options.fillColor).toLowerCase()] || 'otro';
            const nombre = NOMBRES_HUMEDAL[tipo] || tipo;
            R.humedales[nombre] = (R.humedales[nombre] || 0) + a;
            R.humedalTotal += a;
        });

        // Cuerpos de agua IAHCSA
        R.cuerpos = [];
        CUERPOS_IAHCSA.forEach(([grupo, nombre]) => {
            let n = 0, a = 0;
            poligonosDe(grupo).forEach(l => {
                const x = areaTraslape(obj, l, ctx);
                if (x >= PDU_CONFIG.areaMinima) { n++; a += x; }
            });
            if (n) R.cuerpos.push({ nombre, n, a });
        });

        // Zonas de protección de pozos
        R.pozosSin = poligonosDe('pozosSinProteccion').reduce((s, l) => s + areaTraslape(obj, l, ctx), 0);
        R.pozosCon = poligonosDe('pozosConProteccion').reduce((s, l) => s + areaTraslape(obj, l, ctx), 0);

        // Descargas y extracciones (puntos)
        const sumaPuntos = arr => {
            let n = 0, v = 0;
            (arr || []).forEach(x => { if (dentro(x.lng, x.lat)) { n++; v += x.vol || 0; } });
            return { n, v };
        };
        R.descargas = sumaPuntos(allLayersData.descargas);
        R.extracciones = sumaPuntos(allLayersData.extracciones);

        // Karstificación
        R.karst = { a: 0, max: null, cats: {} };
        poligonosDe('karstificacion').forEach(l => {
            const a = areaTraslape(obj, l, ctx);
            if (a < PDU_CONFIG.areaMinima) return;
            R.karst.a += a;
            const html = textoPopup(l);
            const mi = html.match(/Intensidad:<\/strong>\s*([\d.]+)/);
            const mc = html.match(/Categoría:<\/strong>\s*([^<]+)/);
            if (mi) { const v = parseFloat(mi[1]); if (R.karst.max === null || v > R.karst.max) R.karst.max = v; }
            if (mc) { const k = mc[1].trim(); R.karst.cats[k] = (R.karst.cats[k] || 0) + a; }
        });

        // Riesgo de colapso
        const invColapso = colorInverso(COLORS.colapsoKarst);
        R.colapso = {};
        poligonosDe('colapsoKarst').forEach(l => {
            const a = areaTraslape(obj, l, ctx);
            if (a < PDU_CONFIG.areaMinima) return;
            const m = textoPopup(l).match(/Nivel de Riesgo:<\/strong>\s*([^<]+)/);
            const nivel = m ? m[1].trim() : (invColapso[String(l.options.fillColor).toLowerCase()] || 'Sin dato');
            R.colapso[nivel] = (R.colapso[nivel] || 0) + a;
        });

        // Fallas y fracturas
        const fallas = grupo => {
            let n = 0, km = 0;
            const g = layerGroups[grupo];
            if (!g) return { n, km };
            g.eachLayer(l => {
                if (!(l instanceof L.Polyline) || l instanceof L.Polygon) return;
                const linea = l.toGeoJSON();
                try {
                    if (!bboxTraslapa(turf.bbox(linea), obj.bbox)) return;
                    if (!turf.booleanIntersects(linea, feature)) return;
                    n++;
                    const trozos = turf.lineSplit(linea, feature).features;
                    (trozos.length ? trozos : [linea]).forEach(t => {
                        const len = turf.length(t);
                        const mid = turf.along(t, len / 2).geometry.coordinates;
                        if (turf.booleanPointInPolygon(mid, feature)) km += len;
                    });
                } catch (e) { ctx.errores++; }
            });
            return { n, km };
        };
        R.fallasINEGI = fallas('fallasINEGI');
        R.fallasCENAPRED = fallas('fallasCENAPRED');

        // POEL 2013
        const invPoel = colorInverso(COLORS.poel);
        R.poel = {};
        poligonosDe('poel').forEach(l => {
            const a = areaTraslape(obj, l, ctx);
            if (a < PDU_CONFIG.areaMinima) return;
            const m = textoPopup(l).match(/UGA\s+([^<]+)<\/h3>/);
            const mp = textoPopup(l).match(/Política:<\/strong>\s*([^<]+)/);
            const uga = m ? m[1].trim() : '¿?';
            const pol = mp ? mp[1].trim() : (invPoel[String(l.options.fillColor).toLowerCase()] || 'Sin dato');
            const k = `${uga}|${pol}`;
            R.poel[k] = (R.poel[k] || 0) + a;
        });

        // Fraccionamientos que el municipio busca legalizar
        R.fracc = [];
        poligonosDe('fraccionamientosPOEL').forEach(l => {
            const a = areaTraslape(obj, l, ctx);
            if (a < PDU_CONFIG.areaMinima) return;
            const m = textoPopup(l).match(/Nombre:<\/strong>\s*([^<]+)/);
            R.fracc.push({ nombre: m ? m[1].trim() : 'Sin nombre', a });
        });

        // Tenencia de la tierra
        const tenencia = grupo => {
            let a = 0; const nombres = new Set();
            poligonosDe(grupo).forEach(l => {
                const x = areaTraslape(obj, l, ctx);
                if (x < PDU_CONFIG.areaMinima) return;
                a += x;
                const m = textoPopup(l).match(/(?:Nombre|Ejido|Localidad):<\/strong>\s*([^<]+)/);
                if (m && m[1].trim() !== 'N/A') nombres.add(m[1].trim());
            });
            return { a, nombres: [...nombres] };
        };
        R.comunales = tenencia('tierrasComunales');
        R.parceladas = tenencia('tierrasParceladas');
        R.nucleos = tenencia('nucleosAgrarios');
        R.asentamientos = tenencia('asentamientosHumanos');

        // Proyectos
        R.proyectos = (allLayersData.proyectos || []).filter(x => dentro(x.lng, x.lat)).map(x => x.nombre);
        const puntosGrupo = (grupo, campo) => {
            const out = [];
            const g = layerGroups[grupo];
            if (g) g.eachLayer(l => {
                if (!l.getLatLng) return;
                const ll = l.getLatLng();
                if (dentro(ll.lng, ll.lat)) out.push((l.projectData && l.projectData[campo]) || 'Sin nombre');
            });
            return out;
        };
        R.colab = puntosGrupo('proyectosColab', 'nombre_proyecto');
        R.hidrosociales = puntosGrupo('proyectosHidrosociales', 'nombre_proyecto');

        // Potencial urbano según el propio PDU
        const cos = parsePct(p.COS);
        const cus = parseNum(p.CUS);
        const niveles = parseNum(p.Niveles);
        R.cos = cos; R.cus = cus; R.niveles = niveles;
        R.desplante = cos ? area * cos : null;
        R.construible = cus ? area * cus : (cos && niveles ? area * cos * niveles : null);
        R.viviendas = parseDensidad(p.Den_viv, area);
        R.cuartos = parseDensidad(p.Den_Cts, area);
        const clave = String(p.Clave || '').toUpperCase().trim();
        R.permite = (cos && cos > 0) || (R.viviendas && R.viviendas.valor > 0) || (R.cuartos && R.cuartos.valor > 0) || CLAVES_URBANIZABLES.includes(clave);

        // Alertas
        R.alertas = [];
        if (R.permite) {
            if (R.humedalTotal > 0) R.alertas.push(`El PDU permite aprovechamiento urbano sobre ${fmtM2(R.humedalTotal)} de humedales o zonas inundables${pct(R.humedalTotal, area)} del polígono.`);
            const cenotes = R.cuerpos.filter(c => /Cenote|naturales/.test(c.nombre));
            if (cenotes.length) R.alertas.push(`Hay ${cenotes.map(c => `${c.n} ${c.nombre.toLowerCase()}`).join(', ')} dentro de un polígono con uso urbanizable.`);
            const poelProt = Object.entries(R.poel).filter(([k]) => /Protecci|Conservaci|Preservaci/.test(k.split('|')[1]));
            poelProt.forEach(([k, a]) => {
                const [uga, pol] = k.split('|');
                R.alertas.push(`Se traslapa ${fmtM2(a)} con la UGA ${uga} del POEL 2013, cuya política es de ${pol}.`);
            });
            const colAlto = Object.entries(R.colapso).filter(([n]) => /alto/i.test(n));
            if (colAlto.length) R.alertas.push(`Incluye zonas con riesgo de colapso ${colAlto.map(([n, a]) => `${n.toLowerCase()} (${fmtM2(a)})`).join(', ')}.`);
            if (R.karst.a > 0 && R.desplante) R.alertas.push(`El COS permitiría impermeabilizar hasta ${fmtM2(R.desplante)} en un terreno con ${fmtM2(R.karst.a)} de karstificación media a muy alta.`);
            if (R.fallasINEGI.n + R.fallasCENAPRED.n > 0) R.alertas.push(`Lo cruzan ${R.fallasINEGI.n + R.fallasCENAPRED.n} fallas o fracturas kársticas.`);
        }
        if (R.pozosSin + R.pozosCon > PDU_CONFIG.areaMinima) R.alertas.push(`Se traslapa ${fmtM2(R.pozosSin + R.pozosCon)} con zonas de protección de pozos de abastecimiento.`);
        if (R.fracc.length) R.alertas.push(`Coincide con ${R.fracc.length} fraccionamiento(s) que el municipio busca regularizar: ${R.fracc.map(x => x.nombre).join(', ')}.`);
        if (R.comunales.a > 0 && R.permite) R.alertas.push(`Incluye ${fmtM2(R.comunales.a)} de tierras de uso común ejidal; conviene revisar su régimen agrario.`);

        R.errores = ctx.errores;
        return R;
    }

    // ---------------- PANEL DE RESULTADOS ----------------
    function seccion(titulo, filas) {
        const contenido = filas.filter(Boolean).join('');
        if (!contenido) return '';
        return `<section class="pdu-sec"><h4>${titulo}</h4>${contenido}</section>`;
    }
    const linea = (etq, val, extra = '') => `<div class="pdu-row"><span>${etq}</span><strong>${val}</strong>${extra ? `<em>${extra}</em>` : ''}</div>`;
    const nada = t => `<div class="pdu-nada">${t}</div>`;

    function renderResultado(f, R) {
        const p = f.properties;
        const c = colorDe(p);
        const A = R.area;
        const txt = [];
        txt.push(`ANÁLISIS DEL POLÍGONO PDU ${p.id || ''} (${p.tipo || ''}, ${p.CVE || p.Clave || ''})`);
        txt.push(`Superficie: ${fmtM2(A)}`);

        const humedal = Object.entries(R.humedales).map(([n, a]) => linea(n, fmtM2(a), pct(a, A).replace(' · ', '')));
        const cuerpos = R.cuerpos.map(x => linea(x.nombre, `${x.n}`, fmtM2(x.a)));
        const colapso = Object.entries(R.colapso).map(([n, a]) => linea(`Riesgo ${n}`, fmtM2(a), pct(a, A).replace(' · ', '')));
        const poel = Object.entries(R.poel).sort((a, b) => b[1] - a[1]).map(([k, a]) => { const [uga, pol] = k.split('|'); return linea(`UGA ${esc(uga)} (${esc(pol)})`, fmtM2(a), pct(a, A).replace(' · ', '')); });
        const listaNombres = (arr, max = 6) => arr.length ? `<div class="pdu-lista">${arr.slice(0, max).map(esc).join('<br>')}${arr.length > max ? `<br>…y ${arr.length - max} más` : ''}</div>` : '';

        const alertas = R.alertas.length
            ? `<section class="pdu-alertas"><h4>⚠️ Puntos a revisar</h4><ul>${R.alertas.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
               <p>Cruce automático de capas; sirve para orientar la revisión, no sustituye un dictamen técnico ni jurídico.</p></section>`
            : `<section class="pdu-ok">No se detectaron traslapes críticos con las capas cargadas.</section>`;

        const html = `
            <div class="pdu-cab" style="border-color:${c};">
                <div class="pdu-cab-tipo" style="color:${c};">${esc(p.tipo || 'Sin tipo')}</div>
                <div class="pdu-cab-cve">${esc(p.CVE || p.Clave || '')} <span>${esc(p.id || '')}</span></div>
                <div class="pdu-cab-area">${fmtM2(A)}</div>
            </div>
            ${alertas}
            ${seccion('🏗️ Lo que permite el PDU aquí', [
                linea('Superficie de desplante (COS)', R.desplante ? fmtM2(R.desplante) : '—', R.cos ? `COS ${fmtN(R.cos * 100)}%` : ''),
                linea('Superficie construible', R.construible ? fmtM2(R.construible) : '—', R.cus ? `CUS ${fmtN(R.cus, 2)}` : ''),
                linea('Niveles', R.niveles !== null ? fmtN(R.niveles) : esc(p.Niveles || '—')),
                R.viviendas ? linea('Viviendas máximas estimadas', R.viviendas.valor !== null ? fmtN(Math.floor(R.viviendas.valor)) : '—', esc(R.viviendas.texto)) : '',
                R.cuartos ? linea('Cuartos máximos estimados', R.cuartos.valor !== null ? fmtN(Math.floor(R.cuartos.valor)) : '—', esc(R.cuartos.texto)) : ''
            ])}
            ${seccion('💧 Agua y humedales', [
                humedal.length ? humedal.join('') : nada('Sin humedales ni zonas inundables mapeadas'),
                R.descargas.n ? linea('Descargas de aguas residuales', R.descargas.n, formatVol(R.descargas.v)) : '',
                R.extracciones.n ? linea('Extracciones de agua dulce', R.extracciones.n, formatVol(R.extracciones.v)) : '',
                R.pozosSin > PDU_CONFIG.areaMinima ? linea('Zona de pozo sin protección', fmtM2(R.pozosSin)) : '',
                R.pozosCon > PDU_CONFIG.areaMinima ? linea('Zona de pozo con protección', fmtM2(R.pozosCon)) : ''
            ])}
            ${seccion('🌊 Cuerpos de agua antropizados (IAHCSA)', [cuerpos.length ? cuerpos.join('') : nada('Ninguno mapeado dentro del polígono')])}
            ${seccion('🪨 Geología', [
                R.karst.a ? linea('Karstificación media a muy alta', fmtM2(R.karst.a), R.karst.max !== null ? `intensidad máx. ${R.karst.max}` : '') : '',
                colapso.join(''),
                (R.fallasINEGI.n + R.fallasCENAPRED.n) ? linea('Fallas y fracturas', R.fallasINEGI.n + R.fallasCENAPRED.n, `${fmtN(R.fallasINEGI.km + R.fallasCENAPRED.km, 2)} km dentro`) : '',
                (!R.karst.a && !colapso.length && !(R.fallasINEGI.n + R.fallasCENAPRED.n)) ? nada('Sin karst, colapso ni fallas mapeadas') : ''
            ])}
            ${seccion('🏞️ POEL 2013 y regularizaciones', [
                poel.length ? poel.join('') : nada('Fuera de las UGAs cargadas'),
                R.fracc.length ? linea('Fraccionamientos a regularizar', R.fracc.length, fmtM2(R.fracc.reduce((s, x) => s + x.a, 0))) + listaNombres(R.fracc.map(x => x.nombre)) : ''
            ])}
            ${seccion('🏘️ Tenencia de la tierra (RAN)', [
                R.nucleos.a ? linea('Núcleo agrario', fmtM2(R.nucleos.a)) + listaNombres(R.nucleos.nombres) : '',
                R.comunales.a ? linea('Tierras de uso común', fmtM2(R.comunales.a)) : '',
                R.parceladas.a ? linea('Tierras parceladas', fmtM2(R.parceladas.a)) : '',
                R.asentamientos.a ? linea('Asentamiento humano ejidal', fmtM2(R.asentamientos.a)) : '',
                (!R.nucleos.a && !R.comunales.a && !R.parceladas.a && !R.asentamientos.a) ? nada('Sin tierras ejidales mapeadas') : ''
            ])}
            ${seccion('📍 Proyectos registrados', [
                R.proyectos.length ? linea('Inmobiliario-turísticos', R.proyectos.length) + listaNombres(R.proyectos) : '',
                R.colab.length ? linea('Colaborativos', R.colab.length) + listaNombres(R.colab) : '',
                R.hidrosociales.length ? linea('Hidrosociales comunitarios', R.hidrosociales.length) + listaNombres(R.hidrosociales) : '',
                (!R.proyectos.length && !R.colab.length && !R.hidrosociales.length) ? nada('Ninguno registrado') : ''
            ])}
            ${R.errores ? `<p class="pdu-nota">${R.errores} geometrías no se pudieron cruzar (topología inválida) y quedaron fuera del conteo.</p>` : ''}
            <div class="pdu-acciones">
                <button type="button" onclick="PDU.copiar()">📋 Copiar resumen</button>
                <button type="button" onclick="PDU.zoom(${p._k})">🔍 Acercar</button>
            </div>`;

        // Resumen en texto plano para informes
        if (R.alertas.length) { txt.push('', 'PUNTOS A REVISAR:'); R.alertas.forEach(a => txt.push(`- ${a}`)); }
        txt.push('', `Desplante permitido (COS): ${R.desplante ? fmtM2(R.desplante) : '—'}`);
        if (R.viviendas && R.viviendas.valor) txt.push(`Viviendas máximas estimadas: ${fmtN(Math.floor(R.viviendas.valor))} (${R.viviendas.texto})`);
        if (R.cuartos && R.cuartos.valor) txt.push(`Cuartos máximos estimados: ${fmtN(Math.floor(R.cuartos.valor))} (${R.cuartos.texto})`);
        Object.entries(R.humedales).forEach(([n, a]) => txt.push(`Humedal – ${n}: ${fmtM2(a)}`));
        R.cuerpos.forEach(x => txt.push(`IAHCSA – ${x.nombre}: ${x.n} (${fmtM2(x.a)})`));
        if (R.descargas.n) txt.push(`Descargas: ${R.descargas.n} (${formatVol(R.descargas.v)})`);
        if (R.extracciones.n) txt.push(`Extracciones: ${R.extracciones.n} (${formatVol(R.extracciones.v)})`);
        if (R.karst.a) txt.push(`Karstificación media-muy alta: ${fmtM2(R.karst.a)}`);
        Object.entries(R.colapso).forEach(([n, a]) => txt.push(`Riesgo de colapso ${n}: ${fmtM2(a)}`));
        Object.entries(R.poel).forEach(([k, a]) => { const [u, pol] = k.split('|'); txt.push(`POEL 2013 UGA ${u} (${pol}): ${fmtM2(a)}`); });
        R.fracc.forEach(x => txt.push(`Fraccionamiento a regularizar: ${x.nombre} (${fmtM2(x.a)})`));
        if (R.proyectos.length) txt.push(`Proyectos inmobiliario-turísticos: ${R.proyectos.join(', ')}`);
        txt.push('', 'Fuente: Chac Mool de Toma las Aguas – cruce automático de capas.');
        estado.ultimoResumen = txt.join('\n');

        document.getElementById('pdu-res-cuerpo').innerHTML = html;
    }

    function abrirPanel(html) {
        const panel = document.getElementById('pdu-resultados');
        document.getElementById('pdu-res-cuerpo').innerHTML = html;
        panel.classList.add('abierto');
    }

    function seleccionar(k) {
        if (estado.seleccion) {
            const prev = estado.seleccion;
            prev.setStyle(estilo(prev.feature));
        }
        const capa = estado.capaPorKey[k];
        if (capa) {
            capa.setStyle({ color: '#0f172a', weight: 4, dashArray: '6 4', fillOpacity: Math.min(estado.opacidad + 0.15, 0.9) });
            capa.bringToFront && capa.bringToFront();
            estado.seleccion = capa;
        }
    }

    async function calcular(k) {
        const f = estado.features[k];
        if (!f) return;
        map.closePopup();
        seleccionar(k);
        abrirPanel('<div class="pdu-cargando"><div class="spinner"></div>Cruzando el polígono con las capas del geoportal…</div>');
        try {
            await cargarTurf();
            await sleep(40); // deja pintar el mensaje
            const R = analizar(f);
            renderResultado(f, R);
        } catch (e) {
            console.error('[PDU] Error en el análisis:', e);
            document.getElementById('pdu-res-cuerpo').innerHTML = `<p class="pdu-nota">No se pudo completar el análisis: ${esc(e.message)}</p>`;
        }
    }

    function cerrar() {
        document.getElementById('pdu-resultados').classList.remove('abierto');
        if (estado.seleccion) { estado.seleccion.setStyle(estilo(estado.seleccion.feature)); estado.seleccion = null; }
    }

    async function copiar() {
        try {
            await navigator.clipboard.writeText(estado.ultimoResumen);
            alert('✅ Resumen copiado al portapapeles');
        } catch (e) {
            prompt('Copia el resumen:', estado.ultimoResumen);
        }
    }

    function zoom(k) {
        const capa = estado.capaPorKey[k];
        if (capa && capa.getBounds) map.fitBounds(capa.getBounds(), { padding: [40, 40], maxZoom: 18 });
    }

    // ---------------- INTERFAZ ----------------
    function inyectarCSS() {
        const css = `
        .pdu-tipos{padding:4px 0 6px 28px;max-height:220px;overflow-y:auto;}
        .pdu-tipo{display:flex;align-items:center;gap:6px;font-size:11px;padding:3px 0;cursor:pointer;}
        .pdu-tipo input{width:14px;height:14px;cursor:pointer;}
        .pdu-tipo .sw{width:12px;height:12px;border-radius:2px;flex:none;border:1px solid rgba(0,0,0,.15);}
        .pdu-tipo .n{margin-left:auto;color:#9ca3af;font-size:10px;}
        .pdu-ctrl{padding:4px 8px 4px 28px;font-size:11px;color:#4a5568;}
        .pdu-ctrl input[type=range]{width:100%;}
        .pdu-ctrl button{margin-top:4px;width:100%;padding:5px;font-size:11px;background:#e2e8f0;border:none;border-radius:4px;cursor:pointer;color:#1f2937;}
        .pdu-hint{font-size:10px;color:#6b7280;padding:0 8px 8px 28px;margin:0;line-height:1.4;}
        .pdu-aviso{font-size:11px;color:#991b1b;background:#fee2e2;border-left:3px solid #ef4444;padding:6px 8px;margin:4px 0 8px 20px;border-radius:4px;}
        #pdu-resultados{position:fixed;top:90px;right:20px;width:380px;max-height:calc(100vh - 110px);background:#fff;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.25);z-index:1500;display:none;flex-direction:column;font-family:'Segoe UI',sans-serif;}
        #pdu-resultados.abierto{display:flex;}
        #pdu-resultados .pdu-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#0f766e;color:#fff;border-radius:10px 10px 0 0;}
        #pdu-resultados .pdu-top h3{margin:0;font-size:14px;}
        #pdu-resultados .pdu-top button{background:rgba(255,255,255,.2);color:#fff;border:none;width:30px;height:30px;border-radius:6px;cursor:pointer;font-size:16px;}
        #pdu-res-cuerpo{overflow-y:auto;padding:12px 14px 16px;font-size:12px;color:#1f2937;}
        .pdu-cab{border-left:5px solid;padding:4px 0 4px 10px;margin-bottom:12px;}
        .pdu-cab-tipo{font-size:17px;font-weight:700;}
        .pdu-cab-cve{font-size:13px;font-weight:600;}
        .pdu-cab-cve span{color:#9ca3af;font-weight:400;font-size:11px;margin-left:6px;}
        .pdu-cab-area{font-size:12px;color:#4b5563;margin-top:2px;}
        .pdu-sec{border-top:1px solid #e5e7eb;padding:8px 0;}
        .pdu-sec h4{margin:0 0 6px;font-size:12px;color:#0f766e;}
        .pdu-row{display:grid;grid-template-columns:1fr auto;gap:0 8px;padding:3px 0;}
        .pdu-row span{color:#374151;}
        .pdu-row strong{text-align:right;}
        .pdu-row em{grid-column:1/-1;font-style:normal;color:#6b7280;font-size:11px;}
        .pdu-lista{font-size:11px;color:#4b5563;padding:2px 0 4px 10px;border-left:2px solid #e5e7eb;margin:2px 0 4px;}
        .pdu-nada{color:#9ca3af;font-style:italic;}
        .pdu-alertas{background:#fef2f2;border-left:4px solid #dc2626;padding:8px 10px;border-radius:6px;margin-bottom:8px;}
        .pdu-alertas h4{margin:0 0 4px;color:#991b1b;font-size:13px;}
        .pdu-alertas ul{margin:0;padding-left:18px;}
        .pdu-alertas li{margin:4px 0;line-height:1.4;}
        .pdu-alertas p{margin:6px 0 0;font-size:10px;color:#7f1d1d;}
        .pdu-ok{background:#ecfdf5;border-left:4px solid #10b981;padding:8px 10px;border-radius:6px;margin-bottom:8px;color:#065f46;}
        .pdu-nota{font-size:11px;color:#92400e;background:#fef3c7;padding:6px 8px;border-radius:4px;}
        .pdu-acciones{display:flex;gap:8px;margin-top:10px;}
        .pdu-acciones button{flex:1;padding:9px;border:none;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;background:#0f766e;color:#fff;}
        .pdu-acciones button+button{background:#e2e8f0;color:#1f2937;}
        .pdu-cargando{text-align:center;padding:30px 10px;color:#4b5563;}
        @media (max-width:768px){
            #pdu-resultados{top:auto;bottom:0;right:0;left:0;width:auto;max-height:65vh;border-radius:14px 14px 0 0;}
            #pdu-resultados .pdu-top{border-radius:14px 14px 0 0;}
        }`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }

    function construirUI() {
        inyectarCSS();

        // Pane propio: por defecto encima de las demás capas para poder tocar los polígonos
        const pane = map.createPane('pduPane');
        pane.style.zIndex = 450;

        const panel = document.getElementById('control-panel');
        const bloque = document.createElement('div');
        bloque.innerHTML = `
            <h3>🏙️ PDU – Zonificación secundaria (nuevo)</h3>
            <div class="layer-control">
                <input type="checkbox" id="layer-pdu" checked>
                <label for="layer-pdu">
                    <span class="color-indicator" style="background: linear-gradient(135deg,#facc15,#fb923c,#c026d3,#15803d);"></span>
                    Usos de suelo del PDU
                </label>
                <span class="layer-count" id="count-pdu">…</span>
            </div>
            <div id="pdu-aviso"></div>
            <div class="pdu-tipos" id="pdu-tipos"></div>
            <div class="pdu-ctrl">
                Transparencia del relleno
                <input type="range" id="pdu-opacidad" min="0" max="90" value="${Math.round(estado.opacidad * 100)}">
                <button type="button" id="pdu-orden">⬇️ Enviar PDU debajo de las otras capas</button>
            </div>
            <p class="pdu-hint">Toca un polígono para ver la clasificación del municipio y usa «Calcular» para saber qué hay dentro.</p>`;
        panel.appendChild(bloque);

        document.getElementById('layer-pdu').addEventListener('change', e => {
            if (!estado.grupoPadre) return;
            if (e.target.checked) map.addLayer(estado.grupoPadre); else map.removeLayer(estado.grupoPadre);
        });

        document.getElementById('pdu-opacidad').addEventListener('input', e => {
            estado.opacidad = e.target.value / 100;
            Object.values(estado.gruposTipo).forEach(g => g.setStyle(estilo));
            if (estado.seleccion) seleccionar(estado.seleccion.feature.properties._k);
        });

        document.getElementById('pdu-orden').addEventListener('click', e => {
            const arriba = pane.style.zIndex === '450';
            pane.style.zIndex = arriba ? 350 : 450;
            e.target.textContent = arriba ? '⬆️ Traer PDU encima de las otras capas' : '⬇️ Enviar PDU debajo de las otras capas';
        });

        // Panel de resultados
        const res = document.createElement('div');
        res.id = 'pdu-resultados';
        res.innerHTML = `
            <div class="pdu-top">
                <h3>🧮 ¿Qué hay en este polígono?</h3>
                <button type="button" onclick="PDU.cerrar()" title="Cerrar">✕</button>
            </div>
            <div id="pdu-res-cuerpo"></div>`;
        document.body.appendChild(res);
        L.DomEvent.disableClickPropagation(res);
        L.DomEvent.disableScrollPropagation(res);
    }

    function avisoPanel(msg) {
        const el = document.getElementById('pdu-aviso');
        if (el) el.innerHTML = `<div class="pdu-aviso">${msg}</div>`;
    }

    function construirFiltros(porTipo) {
        const cont = document.getElementById('pdu-tipos');
        if (!cont) return;
        const orden = Object.entries(porTipo).sort((a, b) => b[1].length - a[1].length);
        cont.innerHTML = orden.map(([tipo, feats], i) => `
            <label class="pdu-tipo">
                <input type="checkbox" data-tipo="${esc(tipo)}" checked>
                <span class="sw" style="background:${colorDe(feats[0].properties)};"></span>
                ${esc(tipo)} <span class="n">${feats.length}</span>
            </label>`).join('');
        cont.querySelectorAll('input[data-tipo]').forEach(cb => {
            cb.addEventListener('change', e => {
                const g = estado.gruposTipo[e.target.dataset.tipo];
                if (!g) return;
                if (e.target.checked) estado.grupoPadre.addLayer(g); else estado.grupoPadre.removeLayer(g);
            });
        });
    }

    function construirLeyenda(porTipo) {
        const legend = document.getElementById('legends-panel');
        if (!legend) return;
        const div = document.createElement('div');
        div.style.marginTop = '12px';
        div.innerHTML = `
            <strong style="font-size:11px;color:#4a5568;">PDU – Usos de suelo</strong>
            <div style="margin-top:5px;font-size:10px;">
                ${Object.entries(porTipo).sort((a, b) => a[0].localeCompare(b[0])).map(([tipo, feats]) => `
                    <div style="display:flex;align-items:center;margin:3px 0;">
                        <div style="width:12px;height:12px;background:${colorDe(feats[0].properties)};border-radius:2px;margin-right:6px;"></div>
                        <span>${esc(tipo)} (${esc(feats[0].properties.Clave || '')})</span>
                    </div>`).join('')}
            </div>`;
        legend.appendChild(div);
    }

    // ---------------- ARRANQUE ----------------
    async function iniciar() {
        const t0 = Date.now();
        // Espera a que el geoportal termine de crear el mapa y cargar sus capas
        while (true) {
            const mapaListo = typeof map !== 'undefined' && map && typeof layerGroups !== 'undefined' && layerGroups;
            const cargaTerminada = document.getElementById('loading')?.classList.contains('hidden');
            if (mapaListo && (cargaTerminada || Date.now() - t0 > 60000)) break;
            await sleep(300);
        }
        construirUI();
        cargarTurf().catch(e => console.warn('[PDU]', e.message));
        await cargarPDU();
    }

    window.PDU = { calcular, cerrar, copiar, zoom, config: PDU_CONFIG };

    if (document.readyState === 'complete') iniciar();
    else window.addEventListener('load', iniciar);
})();
