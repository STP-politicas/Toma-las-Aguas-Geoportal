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
    const PDU_VERSION = '9 · popup compacto';
    console.log('[PDU] Módulo cargado, versión ' + PDU_VERSION);

    // ---------------- CONFIGURACIÓN ----------------
    const PDU_CONFIG = {
        tabla: 'porcentaje de viviendas en humedales pdu2026 copy',   // nombre exacto de la tabla en Supabase
        tamPagina: 1000,                // Supabase entrega máximo 1000 filas por petición
        turfURL: 'https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js',
        areaMinima: 1,                  // m² — ignora traslapes menores (ruido numérico)
        // Opcional: ocupantes promedio por vivienda (ej. la cifra oficial del INEGI para el municipio).
        // Si lo dejas en null no se estima población.
        ocupantesPorVivienda: null,
        // Opcional: huéspedes promedio por cuarto turístico. También se puede capturar en el panel.
        huespedesPorCuarto: null,
        // Nombres EXACTOS de campos del geoproceso en QGIS. Mientras estén en null, el módulo
        // calcula todo con densidad × superficie del fragmento y detecta humedal por cruce espacial.
        campos: {
            viviendas: null,   // viviendas estimadas en cada fragmento
            cuartos: null,     // cuartos estimados en cada fragmento
            poblacion: null,   // personas estimadas en cada fragmento
            humedal: null,     // % o 0/1 o texto que indica si el fragmento es humedal
            bloque: null       // id del polígono regular original (si existe en la tabla)
        },
        // En celulares el PDU no se descarga al abrir la página, sólo cuando se activa la capa
        cargaDiferidaEnMovil: true,
        // Simplificación de geometría en celulares (grados; 0.00001 ≈ 1 m). 0 = desactivada
        simplificarEnMovil: 0.00001
    };

    const ES_MOVIL = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    // Diagnóstico: abrir la página con ?sinpdu desactiva por completo este módulo
    const SIN_PDU = /[?&]sinpdu\b/.test(location.search);

    // Campos esperados del PDU (se buscan sin importar mayúsculas/minúsculas)
    const CAMPOS_PDU = ['id', 'Name', 'tipo', 'Clave', 'CVE', 'HAS', 'area_m2', 'COS', 'CUS', 'Niveles',
        'Altura', 'Rst_frn', 'Rst_fnd', 'Rest_lt', 'Den_viv', 'Den_Cts'];

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
        ultimoResumen: '',
        modoPDU: false,          // false: el clic va a las demás capas; true: el clic consulta el PDU
        gps: { watch: null, marker: null, circulo: null, primera: true, ultimo: null },
        ocup: { viv: null, cua: null },   // ocupantes por vivienda / huéspedes por cuarto
        camposDetectados: {},
        ultimo: null,                     // { f, R } del último análisis
        capaBloque: null
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

    // Interpreta la densidad que asigna el PDU y calcula el máximo de unidades.
    // Admite: "60 viviendas/hectárea", "60 viv/ha", "1 vivienda por cada 167 m2 de terreno",
    // "1 vivienda por lote", "80 cuartos/hectárea", o un número solo (se interpreta por hectárea).
    function parseDensidad(v, areaM2) {
        if (vacio(v) || String(v).trim() === '0') return null;
        const s = String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const ha = areaM2 / 10000;
        const transf = /tra[ns]{1,3}f/.test(s);   // transferir, trasferir, trasnferir…
        const r = parseDensidadBase(s, v, areaM2, ha);
        if (r) r.transferible = transf;
        return r;
    }

    function parseDensidadBase(s, v, areaM2, ha) {
        let m = s.match(/([\d.,]+)\s*[a-z]*\s*(?:\/|por|x)\s*(?:ha\b|has\b|hect)/);
        if (m) {
            const n = parseNum(m[1]);
            return { valor: n * ha, texto: v, regla: `${fmtN(n, 2)} por hectárea`,
                formula: `${fmtN(n, 2)} × ${fmtN(ha, 2)} ha` };
        }
        m = s.match(/([\d.,]+)\s*[a-z]*\s*por\s*cada\s*([\d.,]+)\s*m/);
        if (m) {
            const n = parseNum(m[1]), lote = parseNum(m[2]);
            return { valor: n * areaM2 / lote, texto: v, regla: `${fmtN(n)} por cada ${fmtN(lote)} m²`,
                formula: `${fmtN(areaM2)} m² ÷ ${fmtN(lote)} m²${n !== 1 ? ` × ${fmtN(n)}` : ''}` };
        }
        if (/por\s*lote/.test(s)) return { valor: null, texto: v, porLote: true };
        if (/^[\d.,]+$/.test(s.trim())) {
            const n = parseNum(s);
            return { valor: n * ha, texto: v, regla: `${fmtN(n, 2)} por hectárea`, supuesto: true,
                formula: `${fmtN(n, 2)} × ${fmtN(ha, 2)} ha` };
        }
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

    // Detecta (una vez) los campos que agregó el geoproceso de QGIS
    function detectarCampos(props) {
        const claves = Object.keys(props);
        // Sólo se usan campos declarados explícitamente en PDU_CONFIG.campos
        const buscar = conf => {
            if (!conf) return null;
            return claves.find(x => x.toLowerCase() === String(conf).toLowerCase()) || null;
        };
        const c = PDU_CONFIG.campos;
        estado.camposDetectados = {
            viviendas: buscar(c.viviendas, /viv/i, /^den|dens/i),
            cuartos: buscar(c.cuartos, /cuart/i, /^den|dens/i),
            poblacion: buscar(c.poblacion, /pob|habit|persona|ocupant/i),
            humedal: buscar(c.humedal, /humed|wetland|inund/i),
            bloque: buscar(c.bloque, /padre|parent|orig|bloque|manzana/i)
        };
        const municipales = ['id', 'name', 'timstmp', 'begin', 'end', 'alttdmd', 'tessllt', 'extrude', 'visblty', 'drwordr',
            'icon', 'snippet', 'tipo', 'clave', 'cve', 'has', 'fid', 'area_m2', 'cos', 'cus', 'niveles', 'altura',
            'rst_frn', 'rst_fnd', 'den_viv', 'den_cts', 'rest_lt', '_k', 'geom', 'geojson', 'geometry'];
        estado.camposExtra = claves.filter(k => !municipales.includes(k.toLowerCase()));
        console.log('[PDU] Campos en uso del geoproceso:', estado.camposDetectados);
        console.log('[PDU] Campos adicionales en la tabla (no municipales):', estado.camposExtra.join(', ') || 'ninguno');
    }

    // Lee el valor numérico de un campo del geoproceso (null si no existe o no es número)
    function valorCampo(f, tipo) {
        const k = estado.camposDetectados[tipo];
        if (!k) return null;
        return parseNum(f.properties[k]);
    }

    // Fracción (0–1) del fragmento que es humedal según el campo del geoproceso
    function humedalDeCampo(f) {
        const k = estado.camposDetectados.humedal;
        if (!k) return null;
        const v = f.properties[k];
        if (vacio(v)) return 0;
        const n = parseNum(v);
        if (n !== null && /^[\s\d.,%-]+$/.test(String(v))) return n > 1 ? Math.min(1, n / 100) : n;
        return /^(no|0|false|f)$/i.test(String(v).trim()) ? 0 : 1;   // texto: nombre del humedal
    }

    // Superficie REAL del fragmento, medida sobre su geometría.
    // Los campos area_m2 y HAS conservan la superficie del polígono regular original
    // (el geoproceso los copió a cada fragmento), así que NO sirven para el fragmento.
    function areaDe(f) {
        try { if (typeof turf !== 'undefined') { const a = turf.area(f); if (a > 0) return a; } } catch (e) { }
        return areaOriginal(f) || 0;
    }

    // Superficie del polígono regular original, tal como la registró el municipio
    function areaOriginal(f) {
        const a = parseNum(f.properties.area_m2);
        if (a && a > 0) return a;
        const h = parseNum(f.properties.HAS);
        return h && h > 0 ? h * 10000 : null;
    }

    // Identificador del fragmento (la tabla puede nombrarlo id, fid, gid…)
    function idDe(p) {
        for (const k of ['id', 'ID', 'Id', 'fid', 'FID', 'gid', 'objectid', 'OBJECTID', 'id_1', 'ID_1']) {
            if (!vacio(p[k])) return String(p[k]);
        }
        return `#${p._k}`;
    }

    // Viviendas y cuartos que asigna el PDU a cada polígono (para el resumen municipal)
    function precalcular(f) {
        const area = areaDe(f);
        const v = parseDensidad(f.properties.Den_viv, area);
        const c = parseDensidad(f.properties.Den_Cts, area);
        f._area = area;
        f._areaOrig = areaOriginal(f);
        // Valores SIN redondear: al sumar muchos fragmentos pequeños el redondeo acumula error
        const vivDens = v && v.valor ? v.valor : 0;
        const cuaDens = c && c.valor ? c.valor : 0;
        const vivCampo = valorCampo(f, 'viviendas');
        const cuaCampo = valorCampo(f, 'cuartos');
        const vivTotal = vivCampo !== null ? vivCampo : vivDens;
        const cuaTotal = cuaCampo !== null ? cuaCampo : cuaDens;
        f._vivTransf = v && v.transferible;
        f._cuaTransf = c && c.transferible;
        // Las densidades "para transferir" no se edifican en sitio: se contabilizan aparte
        f._viv = f._vivTransf ? 0 : vivTotal;
        f._cua = f._cuaTransf ? 0 : cuaTotal;
        f._vivT = f._vivTransf ? vivTotal : 0;
        f._cuaT = f._cuaTransf ? cuaTotal : 0;
        f._pobCampo = valorCampo(f, 'poblacion');
        f._fuenteViv = vivCampo !== null ? 'campo' : 'densidad';
        f._porLote = !!(v && v.porLote);
        const h = humedalDeCampo(f);
        if (h !== null) { f._hum = h; f._humCampo = true; }
    }

    // Personas estimadas en un fragmento: primero el dato del geoproceso; si no, ocupación × unidades
    function personas(f) {
        if (f._pobCampo !== null && f._pobCampo !== undefined) return { hab: f._pobCampo, fuente: 'campo' };
        const hab = estado.ocup.viv ? f._viv * estado.ocup.viv : null;
        return { hab, fuente: hab !== null ? 'ocupacion' : null };
    }
    const huespedes = f => estado.ocup.cua ? f._cua * estado.ocup.cua : null;

    // ---------- FRAGMENTOS Y POLÍGONO REGULAR ----------
    // El geoproceso dividió cada polígono regular del PDU en fragmentos que siguen los
    // humedales. Aquí se reconstruye el polígono completo juntando los fragmentos contiguos
    // que comparten la misma clave (o el mismo id de bloque, si la tabla lo trae).
    const claveBloque = f => {
        const kb = estado.camposDetectados.bloque;
        if (kb && !vacio(f.properties[kb])) return 'B:' + f.properties[kb];
        const clave = f.properties.CVE || f.properties.Clave || f.properties.tipo || '';
        const orig = !vacio(f.properties.area_m2) ? f.properties.area_m2 : (!vacio(f.properties.HAS) ? f.properties.HAS : '');
        return 'C:' + clave + '|' + orig;
    };

    function vertices(f, max = 400) {
        const out = [];
        turf.coordEach(f, c => { out.push(c); });
        if (out.length <= max) return out;
        const paso = Math.ceil(out.length / max);
        return out.filter((_, i) => i % paso === 0);
    }

    function seTocan(a, b) {
        try { if (turf.booleanIntersects(a, b)) return true; } catch (e) { }
        // Tolerancia ≈ 2 m para geometrías simplificadas (celular) o con microhuecos
        const tol = 0.00002, t2 = tol * tol;
        const va = vertices(a), vb = vertices(b);
        for (const p of va) for (const q of vb) {
            const dx = p[0] - q[0], dy = p[1] - q[1];
            if (dx * dx + dy * dy < t2) return true;
        }
        return false;
    }

    function bloqueDe(f) {
        if (f._bloque) return f._bloque;
        const key = claveBloque(f);
        const cand = estado.features.filter(g => claveBloque(g) === key);
        cand.forEach(g => { if (!g._bbox) g._bbox = turf.bbox(g); });
        let miembros;
        if (key.startsWith('B:')) {
            miembros = cand;                               // id de bloque explícito
        } else {
            const tol = 0.00003;
            const cerca = (a, b) => !(a[2] + tol < b[0] || a[0] - tol > b[2] || a[3] + tol < b[1] || a[1] - tol > b[3]);
            const visto = new Set([f]); const cola = [f];
            while (cola.length && visto.size < 1500) {
                const a = cola.pop();
                for (const g of cand) {
                    if (visto.has(g) || !cerca(a._bbox, g._bbox)) continue;
                    if (seTocan(a, g)) { visto.add(g); cola.push(g); }
                }
            }
            miembros = [...visto];
        }
        miembros.forEach(g => { g._bloque = miembros; });
        return miembros;
    }

    function fraccionHumedal(f, ctx, humedales) {
        if (f._hum !== undefined) return f._hum;
        const feature = turf.feature(f.geometry);
        const obj = { feature, bbox: turf.bbox(feature) };
        let a = 0;
        humedales.forEach(l => { a += areaTraslape(obj, l, ctx); });
        const ag = turf.area(feature);
        f._humA = a;
        f._hum = ag > 0 ? Math.min(1, a / ag) : 0;
        return f._hum;
    }

    function resumenBloque(f, ctx) {
        const miembros = bloqueDe(f);
        const humedales = poligonosDe('socioeco');
        const dv = parseDensidad(f.properties.Den_viv, f._areaOrig || 0);
        const dc = parseDensidad(f.properties.Den_Cts, f._areaOrig || 0);
        const B = { n: miembros.length, area: 0, viv: 0, cua: 0, vivT: 0, cuaT: 0, hab: 0, habOK: true,
            areaOrig: f._areaOrig,
            vivOrig: dv && dv.valor && !dv.transferible ? dv.valor : null,
            cuaOrig: dc && dc.valor && !dc.transferible ? dc.valor : null,
            vivH: 0, cuaH: 0, habH: 0, areaH: 0, fragsHum: 0, frags: [] };
        miembros.forEach(g => {
            fraccionHumedal(g, ctx, humedales);
            const pers = personas(g);
            B.area += g._area; B.viv += g._viv; B.cua += g._cua; B.vivT += g._vivT; B.cuaT += g._cuaT;
            if (pers.hab === null) B.habOK = false; else { B.hab += pers.hab; B.habH += pers.hab * g._hum; }
            B.vivH += g._viv * g._hum; B.cuaH += g._cua * g._hum; B.areaH += g._area * g._hum;
            if (g._hum >= 0.5) B.fragsHum++;
            B.frags.push(g);
        });
        B.frags.sort((a, b) => (b._viv + b._cua) - (a._viv + a._cua) || b._area - a._area);
        return B;
    }

    // Habitantes del polígono: se recalcula al cambiar los ocupantes por vivienda
    function recalcHab(B) {
        B.hab = 0; B.habH = 0; B.habOK = true;
        B.frags.forEach(g => {
            const pers = personas(g);
            if (pers.hab === null) { if (g._viv) B.habOK = false; }
            else { B.hab += pers.hab; B.habH += pers.hab * g._hum; }
        });
    }

    function dibujarBloque(miembros) {
        if (estado.capaBloque) { map.removeLayer(estado.capaBloque); estado.capaBloque = null; }
        if (!miembros || miembros.length < 2) return;
        if (!map.getPane('pduBloquePane')) {
            const pn = map.createPane('pduBloquePane');
            pn.style.zIndex = 455; pn.style.pointerEvents = 'none';
        }
        estado.capaBloque = L.geoJSON(miembros, {
            pane: 'pduBloquePane', interactive: false,
            style: { color: '#f8fafc', weight: 2, dashArray: '2 4', fill: false, opacity: 0.95 }
        }).addTo(map);
    }

    function asegurarPDU() {
        if (!estado.cargaPromesa) estado.cargaPromesa = cargarPDU();
        return estado.cargaPromesa;
    }

    async function cargarPDU() {
        const cont = document.getElementById('count-pdu');
        if (cont) cont.textContent = 'Cargando…';
        try { await cargarTurf(); } catch (e) { console.warn('[PDU] Turf no disponible todavía'); }
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
                // Si Supabase guardó los nombres en minúsculas (den_viv, cos…), los homologamos
                CAMPOS_PDU.forEach(c => {
                    if (props[c] === undefined) {
                        const k = Object.keys(props).find(x => x.toLowerCase() === c.toLowerCase());
                        if (k) props[c] = props[k];
                    }
                });
                props._k = estado.features.length;
                if (!estado.features.length) detectarCampos(props);
                const f = { type: 'Feature', properties: props, geometry: geom };
                precalcular(f);
                // En celulares se aligera la geometría para ahorrar memoria (≈1 m de tolerancia)
                if (ES_MOVIL && PDU_CONFIG.simplificarEnMovil && typeof turf !== 'undefined') {
                    try { turf.simplify(f, { tolerance: PDU_CONFIG.simplificarEnMovil, mutate: true }); } catch (e) { }
                }
                estado.features.push(f);
                const tipo = (props.tipo || props.Name || 'Sin tipo').toString().trim();
                (porTipo[tipo] = porTipo[tipo] || []).push(f);
            });

            const renderer = L.canvas({ pane: 'pduPane', padding: ES_MOVIL ? 0.1 : 0.3 });
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
            setModo(estado.modoPDU);
            const tv = estado.features.reduce((s, f) => s + f._viv, 0);
            const el = document.getElementById('pdu-total-viv');
            if (el) el.textContent = fmtN(tv);
            console.log(`✓ PDU: ${estado.features.length} polígonos cargados (${sinGeom} sin geometría)`);
            if (sinGeom && !estado.features.length) {
                avisoPanel('La tabla del PDU cargó, pero ninguna fila trae geometría legible. Revisa el nombre de la columna de geometría.');
            }
        } catch (e) {
            console.error('[PDU] Error cargando zonificación:', e);
            if (cont) cont.textContent = '!';
            avisoPanel(`No se pudo leer la tabla «${esc(PDU_CONFIG.tabla)}». Verifica el nombre en PDU_CONFIG.tabla y que la política RLS permita lectura pública.`);
            estado.cargaPromesa = null;   // permite reintentar
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
        const supOrig = f._areaOrig ? fmtM2(f._areaOrig) : '—';
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
                ${(f._viv || f._cua) ? `<div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:12px;">
                    🏘️ En este fragmento: <strong>${fmtN(f._viv)}</strong> viviendas${f._cua ? ` · <strong>${fmtN(f._cua)}</strong> cuartos` : ''}${personas(f).hab !== null ? ` · <strong>${fmtN(personas(f).hab)}</strong> hab.` : ''}
                </div>` : ''}
                <table style="font-size:12px;border-collapse:collapse;width:100%;">
                    ${fila('Identificador', idDe(p))}
                    ${fila('Clave', p.Clave)}
                    <tr><td style="color:#6b7280;padding:3px 8px 3px 0;vertical-align:top;white-space:nowrap;">Este fragmento</td><td style="padding:3px 0;"><strong>${fmtM2(f._area)}</strong></td></tr>
                    <tr><td style="color:#6b7280;padding:3px 8px 3px 0;vertical-align:top;white-space:nowrap;">Polígono PDU original</td><td style="padding:3px 0;"><strong>${supOrig}</strong></td></tr>
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
                    <summary style="cursor:pointer;color:#2563eb;">Ver todos los campos (municipio y QGIS)</summary>
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
        const area = areaGeom;   // superficie real del fragmento (no la del polígono original)
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
        // Proporción del polígono ocupada por humedales (sobre la geometría real)
        R.fraccHumedal = areaGeom > 0 ? Math.min(1, R.humedalTotal / areaGeom) : 0;
        R.fraccKarst = areaGeom > 0 ? Math.min(1, R.karst.a / areaGeom) : 0;
        if (!f._humCampo) { f._hum = R.fraccHumedal; f._humA = R.humedalTotal; }
        R.vivHumedal = f._viv ? f._viv * f._hum : null;
        R.cuaHumedal = f._cua ? f._cua * f._hum : null;
        R.bloque = resumenBloque(f, ctx);
        const clave = String(p.Clave || '').toUpperCase().trim();
        R.permite = (cos && cos > 0) || (R.viviendas && R.viviendas.valor > 0) || (R.cuartos && R.cuartos.valor > 0) || CLAVES_URBANIZABLES.includes(clave);

        // Alertas
        R.alertas = [];
        if (R.permite) {
            if (R.humedalTotal > 0) R.alertas.push(`El PDU permite aprovechamiento urbano sobre ${fmtM2(R.humedalTotal)} de humedales o zonas inundables${pct(R.humedalTotal, area)} del polígono.`);
            if (R.bloque.vivH >= 1) R.alertas.push(`De las ${fmtN(R.bloque.viv)} viviendas que el PDU prospecta en este polígono, alrededor de ${fmtN(R.bloque.vivH)} quedarían asentadas sobre humedal.`);
            if (R.bloque.cuaH >= 1) R.alertas.push(`De los ${fmtN(R.bloque.cua)} cuartos turísticos prospectados en el polígono, alrededor de ${fmtN(R.bloque.cuaH)} quedarían sobre humedal.`);
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

    // Sección central: este fragmento frente al polígono regular completo
    function bloqueProspeccion(f, R) {
        const p = f.properties, B = R.bloque;
        const v = R.viviendas, c = R.cuartos;
        const sinDens = !v && !c && !f._viv && !f._cua && !f._vivT && !f._cuaT;
        const porc = (x, t) => t > 0 ? `${fmtN(100 * x / t, 1)}%` : '—';
        const persF = personas(f);
        const huesF = huespedes(f);
        const partes = [];

        if (sinDens) {
            partes.push(`<p class="pdu-explica">Este fragmento no tiene densidad habitacional ni hotelera asignada; el PDU no prospecta viviendas ni cuartos aquí.</p>`);
        }

        // Cifras del fragmento
        const fuenteViv = f._fuenteViv === 'campo'
            ? `dato del geoproceso (campo «${esc(estado.camposDetectados.viviendas)}»)`
            : (v && v.formula ? `${esc(v.formula)} = ${fmtN(v.valor, 1)}` : '');
        const soloTransf = !f._viv && f._vivT;
        const numCab = f._viv || f._vivT || (!f._viv && f._cua ? f._cua : 0);
        const etqCab = soloTransf ? 'viviendas transferibles (no se edifican aquí)'
            : (!f._viv && f._cua ? 'cuartos turísticos en este fragmento' : 'viviendas en este fragmento');
        if (!sinDens) {
            partes.push(`
            <div class="pdu-frag-cab">
                <div><span class="pdu-chip ${f._hum >= 0.5 ? 'hum' : ''}">${f._hum >= 0.5 ? '🌊 Fragmento en humedal' : (f._hum > 0.01 ? `🌊 ${fmtN(f._hum * 100, 0)}% humedal` : 'Fragmento fuera de humedal')}</span></div>
                <div class="pdu-prosp-n">${fmtN(numCab)} <small>${etqCab}</small></div>
                ${fuenteViv ? `<div class="pdu-formula">${fuenteViv}</div>` : ''}
            </div>`);
        }

        // Tabla comparativa fragmento / polígono completo
        const fila = (etq, frag, tot, extra = '') => `<tr><td>${etq}</td><td>${frag}</td><td>${tot}</td><td class="pc">${extra}</td></tr>`;
        const habTot = B.habOK ? B.hab : null;
        const hueTot = estado.ocup.cua ? B.cua * estado.ocup.cua : null;
        const filas = [
            fila('Superficie', fmtM2(f._area), fmtM2(B.area), porc(f._area, B.area)),
            (B.viv || f._viv) ? fila('Viviendas', fmtN(f._viv), fmtN(B.viv), porc(f._viv, B.viv)) : '',
            (B.hab || persF.hab) ? fila('Habitantes', persF.hab !== null ? fmtN(persF.hab) : '—', habTot !== null ? fmtN(habTot) : '—', habTot ? porc(persF.hab || 0, habTot) : '') : '',
            (B.cua || f._cua) ? fila('Cuartos turísticos', fmtN(f._cua), fmtN(B.cua), porc(f._cua, B.cua)) : '',
            (B.cua && estado.ocup.cua) ? fila('Huéspedes', fmtN(huesF), fmtN(hueTot), porc(huesF || 0, hueTot)) : '',
            B.vivT ? fila('Viviendas transferibles', fmtN(f._vivT), fmtN(B.vivT), '') : '',
            B.cuaT ? fila('Cuartos transferibles', fmtN(f._cuaT), fmtN(B.cuaT), '') : ''
        ].join('');
        // Verificación: suma de fragmentos contra la superficie registrada del polígono original
        let verif = '';
        if (B.areaOrig) {
            const cob = B.area / B.areaOrig;
            verif = `<div class="pdu-verif">
                <div><span>Polígono original (dato municipal)</span><strong>${fmtM2(B.areaOrig)}</strong></div>
                ${B.vivOrig !== null ? `<div><span>Viviendas asignadas al polígono original</span><strong>${fmtN(B.vivOrig)}</strong></div>` : ''}
                ${B.cuaOrig !== null ? `<div><span>Cuartos asignados al polígono original</span><strong>${fmtN(B.cuaOrig)}</strong></div>` : ''}
                <div><span>Superficie cubierta por los ${B.n} fragmentos</span><strong>${fmtN(cob * 100, 1)}%</strong></div>
                ${Math.abs(1 - cob) > 0.05 ? `<p class="pdu-explica">La suma de fragmentos no coincide con la superficie original (${fmtM2(B.area)} frente a ${fmtM2(B.areaOrig)}). Puede faltar algún fragmento, haber recortes por el límite municipal o traslapes en el geoproceso.</p>` : ''}
            </div>`;
        }
        partes.push(`
            <table class="pdu-tabla">
                <thead><tr><th></th><th>Este fragmento</th><th>Suma de fragmentos</th><th class="pc">% del polígono</th></tr></thead>
                <tbody>${filas}</tbody>
            </table>
            <div class="pdu-barra" title="Participación del fragmento en el polígono">
                <div style="width:${B.viv ? Math.max(1, 100 * f._viv / B.viv) : (B.area ? Math.max(1, 100 * f._area / B.area) : 0)}%"></div>
            </div>
            <p class="pdu-explica">Polígono regular del PDU con la clave <strong>${esc(p.CVE || p.Clave || '')}</strong>, dividido en <strong>${B.n}</strong> fragmento${B.n === 1 ? '' : 's'} (${B.fragsHum} en humedal). Su contorno aparece punteado en el mapa.</p>
            ${verif}`);

        // Reparto dentro y fuera de humedal
        if (B.viv || B.cua) {
            const fuera = B.viv - B.vivH;
            partes.push(`
            <div class="pdu-reparto">
                <div class="pdu-reparto-t">¿Dónde caen las unidades del polígono completo?</div>
                <div class="pdu-reparto-barra">
                    <div class="h" style="width:${B.viv ? 100 * B.vivH / B.viv : 100 * B.cuaH / (B.cua || 1)}%"></div>
                </div>
                ${B.viv ? `<div class="pdu-row"><span>🌊 Viviendas sobre humedal</span><strong>${fmtN(B.vivH)}</strong><em>${porc(B.vivH, B.viv)} del polígono · ${fmtM2(B.areaH)} de humedal</em></div>
                <div class="pdu-row"><span>🏠 Viviendas fuera de humedal</span><strong>${fmtN(fuera)}</strong><em>${porc(fuera, B.viv)}</em></div>` : ''}
                ${B.habOK && B.hab ? `<div class="pdu-row"><span>👥 Habitantes sobre humedal</span><strong>${fmtN(B.habH)}</strong><em>de ${fmtN(B.hab)} en el polígono</em></div>` : ''}
                ${B.cua ? `<div class="pdu-row"><span>🏨 Cuartos sobre humedal</span><strong>${fmtN(B.cuaH)}</strong><em>de ${fmtN(B.cua)} en el polígono</em></div>` : ''}
            </div>`);
        }

        // Lista de fragmentos
        if (B.n > 1) {
            const lista = B.frags.slice(0, 12).map(g => {
                const pg = personas(g);
                return `<div class="pdu-row pdu-click ${g === f ? 'actual' : ''}" onclick="PDU.calcular(${g.properties._k})">
                    <span>${g._hum >= 0.5 ? '🌊' : '▫️'} ${esc(idDe(g.properties))}</span><strong>${fmtN(g._viv || g._cua)}</strong>
                    <em>${fmtM2(g._area)} · ${fmtN(g._hum * 100, 0)}% humedal${g._cua && g._viv ? ` · ${fmtN(g._cua)} cuartos` : ''}${pg.hab ? ` · ${fmtN(pg.hab)} hab.` : ''}${g === f ? ' · analizado' : ''}</em></div>`;
            }).join('');
            partes.push(`<details class="pdu-frags" ${B.n <= 12 ? 'open' : ''}>
                <summary>Fragmentos del polígono (${B.n})</summary>
                <div class="pdu-frags-enc"><span>Fragmento</span><span>${B.viv ? 'Viviendas' : 'Cuartos'}</span></div>
                ${lista}${B.n > 12 ? `<div class="pdu-nada">…y ${B.n - 12} fragmentos más, de menor carga</div>` : ''}
            </details>`);
        }

        // Aviso de ocupación y notas de método
        if (!estado.camposDetectados.poblacion && !estado.ocup.viv && (B.viv || f._viv)) {
            partes.push(`<p class="pdu-nota">Para estimar habitantes, escribe los <strong>ocupantes por vivienda</strong> en el panel de capas (sección PDU). Te sugiero usar la cifra del Censo del INEGI para Puerto Morelos.</p>`);
        }
        if (B.vivT || B.cuaT) {
            partes.push(`<p class="pdu-explica">Las densidades marcadas «para transferir» no se edifican en este sitio: son potencial de desarrollo que el PDU permite trasladar a otras zonas. Por eso se cuentan aparte y no suman a la carga local.</p>`);
        }
        partes.push(`<p class="pdu-explica"><strong>Cómo se lee:</strong> el PDU asigna una sola densidad a todo el polígono regular. El geoproceso lo subdividió según los humedales identificados; cada fragmento conserva esa densidad, así que sus unidades se calculan con la <strong>superficie medida de su propia geometría</strong> (densidad × superficie del fragmento), no con la superficie del polígono original que viene en la tabla. Las cifras son la <strong>prospección normativa</strong>: el máximo que el instrumento autoriza, no lo construido hoy.</p>`);

        return seccion('🧩 Prospección del PDU: fragmento y polígono completo', partes);
    }

    function renderResultado(f, R) {
        const p = f.properties;
        if (R.bloque) recalcHab(R.bloque);
        const c = colorDe(p);
        const A = R.area;
        const txt = [];
        txt.push(`ANÁLISIS DEL FRAGMENTO PDU ${idDe(p)} (${p.tipo || ''}, ${p.CVE || p.Clave || ''})`);
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
                <div class="pdu-cab-cve">${esc(p.CVE || p.Clave || '')} <span>${esc(idDe(p))}</span></div>
                <div class="pdu-cab-area">${fmtM2(A)}</div>
            </div>
            ${alertas}
            ${bloqueProspeccion(f, R)}
            ${seccion('🏗️ Ocupación del suelo que autoriza el PDU', [
                linea('Superficie de desplante (COS)', R.desplante ? fmtM2(R.desplante) : '—', R.cos ? `COS ${fmtN(R.cos * 100)}%: porción del terreno que puede cubrirse con construcción, es decir, sellarse y dejar de infiltrar lluvia` : ''),
                linea('Superficie total construible', R.construible ? fmtM2(R.construible) : '—', R.cus ? `CUS ${fmtN(R.cus, 2)}: metros construidos permitidos por cada metro de terreno, sumando todos los niveles` : (R.construible ? 'Estimada como desplante × niveles' : '')),
                linea('Niveles permitidos', R.niveles !== null ? fmtN(R.niveles) : esc(p.Niveles || '—'))
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
        {
            const B = R.bloque, pf = personas(f);
            txt.push(`PROSPECCIÓN DEL PDU`);
            txt.push(`Este fragmento: ${fmtM2(f._area)} · ${fmtN(f._viv)} viviendas${pf.hab !== null ? ` · ${fmtN(pf.hab)} habitantes` : ''}${f._cua ? ` · ${fmtN(f._cua)} cuartos` : ''} · ${fmtN(f._hum * 100, 0)}% humedal`);
            txt.push(`Polígono completo (${B.n} fragmentos): ${fmtM2(B.area)} · ${fmtN(B.viv)} viviendas${B.habOK && B.hab ? ` · ${fmtN(B.hab)} habitantes` : ''}${B.cua ? ` · ${fmtN(B.cua)} cuartos` : ''}`);
            if (B.viv) txt.push(`Viviendas del polígono sobre humedal: ${fmtN(B.vivH)} (${fmtN(100 * B.vivH / B.viv, 1)}%); fuera de humedal: ${fmtN(B.viv - B.vivH)}`);
            if (B.habOK && B.hab) txt.push(`Habitantes del polígono sobre humedal: ${fmtN(B.habH)}`);
            if (B.cua) txt.push(`Cuartos del polígono sobre humedal: ${fmtN(B.cuaH)} de ${fmtN(B.cua)}`);
            if (B.vivT || B.cuaT) txt.push(`Potencial transferible (no se edifica en sitio): ${fmtN(B.vivT)} viviendas, ${fmtN(B.cuaT)} cuartos`);
        }
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
        document.getElementById('pdu-res-cuerpo').scrollTop = 0;
        panel.classList.add('abierto');
        minimizar(false);
        recogerLeyenda();
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
        const t = document.getElementById('pdu-top-titulo');
        if (t) t.textContent = `🧮 ${f.properties.tipo || 'Polígono'} ${f.properties.CVE ? '(' + f.properties.CVE + ')' : ''}`;
        seleccionar(k);
        abrirPanel('<div class="pdu-cargando"><div class="spinner"></div>Cruzando el polígono con las capas del geoportal…</div>');
        try {
            await cargarTurf();
            await sleep(40); // deja pintar el mensaje
            const R = analizar(f);
            estado.ultimo = { f, R };
            dibujarBloque(R.bloque && bloqueDe(f));
            renderResultado(f, R);
        } catch (e) {
            console.error('[PDU] Error en el análisis:', e);
            document.getElementById('pdu-res-cuerpo').innerHTML = `<p class="pdu-nota">No se pudo completar el análisis: ${esc(e.message)}</p>`;
        }
    }

    function cerrar() {
        document.getElementById('pdu-resultados').classList.remove('abierto');
        dibujarBloque(null);
        estado.ultimo = null;
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
        #pdu-resultados .pdu-top{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0f766e;color:#fff;border-radius:10px 10px 0 0;cursor:pointer;flex:none;user-select:none;}
        #pdu-resultados .pdu-top h3{margin:0;font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        #pdu-resultados .pdu-top button{background:rgba(255,255,255,.2);color:#fff;border:none;width:32px;height:32px;min-height:32px !important;padding:0 !important;border-radius:6px;cursor:pointer;font-size:16px !important;flex:none;}
        #pdu-resultados .pdu-top button:hover{background:rgba(255,255,255,.35);}
        #pdu-res-cuerpo{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:12px 14px 16px;font-size:12px;color:#1f2937;}
        #pdu-res-cuerpo::-webkit-scrollbar{width:8px;}
        #pdu-res-cuerpo::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px;}
        #pdu-resultados.minimizado{max-height:none;}
        #pdu-resultados.minimizado #pdu-res-cuerpo{display:none;}
        #pdu-resultados.minimizado .pdu-top{border-radius:10px;}
        .legends-panel:not(.panel-minimized){max-height:calc(100vh - 40px);overflow-y:auto;overscroll-behavior:contain;}
        .pdu-leyenda summary{cursor:pointer;font-size:11px;font-weight:700;color:#4a5568;padding:2px 0;}
        .pdu-leyenda[open] summary{margin-bottom:4px;}
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
        .pdu-ocup{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:4px 8px 4px 28px;font-size:10px;color:#4a5568;}
        .pdu-ocup label{display:flex;flex-direction:column;gap:2px;}
        .pdu-ocup input{width:100%;padding:5px 6px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;box-sizing:border-box;}
        .pdu-frag-cab{margin-bottom:8px;}
        .pdu-chip{display:inline-block;padding:2px 8px;border-radius:10px;background:#f1f5f9;color:#334155;font-size:11px;font-weight:600;margin-bottom:4px;}
        .pdu-chip.hum{background:#e0f2fe;color:#075985;}
        .pdu-tabla{width:100%;border-collapse:collapse;font-size:11.5px;margin:6px 0;}
        .pdu-tabla th{font-size:10px;color:#64748b;font-weight:600;text-align:right;padding:3px 4px;border-bottom:1px solid #e2e8f0;}
        .pdu-tabla td{padding:4px;text-align:right;border-bottom:1px solid #f1f5f9;font-variant-numeric:tabular-nums;}
        .pdu-tabla td:first-child{text-align:left;color:#374151;}
        .pdu-tabla td:nth-child(2){font-weight:700;color:#0f172a;}
        .pdu-tabla .pc{color:#64748b;}
        .pdu-barra,.pdu-reparto-barra{height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;margin:4px 0 6px;}
        .pdu-barra div{height:100%;background:#0f766e;}
        .pdu-reparto{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;margin:8px 0;}
        .pdu-reparto-t{font-size:11px;font-weight:700;color:#334155;}
        .pdu-reparto-barra{background:#fde68a;}
        .pdu-reparto-barra .h{height:100%;background:#0284c7;}
        .pdu-frags{margin-top:8px;}
        .pdu-frags summary{cursor:pointer;font-weight:700;font-size:11px;color:#0f766e;}
        .pdu-frags-enc{display:flex;justify-content:space-between;font-size:10px;color:#64748b;padding:4px 0 2px;border-bottom:1px solid #e2e8f0;}
        .pdu-row.actual{background:#ecfeff;}
        .pdu-verif{background:#f8fafc;border:1px dashed #cbd5e1;border-radius:8px;padding:8px 10px;margin:6px 0;font-size:11px;}
        .pdu-verif>div{display:flex;justify-content:space-between;gap:8px;padding:2px 0;}
        .pdu-verif span{color:#475569;}
        .pdu-modo{margin-top:8px;}
        .pdu-modo>span{display:block;margin-bottom:4px;}
        .pdu-modo>div{display:flex;gap:4px;}
        .pdu-modo button{flex:1;margin:0 !important;background:#e2e8f0 !important;color:#1f2937 !important;font-weight:600;}
        .pdu-modo button.activo{background:#0f766e !important;color:#fff !important;}
        .pdu-total{margin:4px 8px 8px 28px;padding:8px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:6px;font-size:11px;color:#134e4a;}
        .pdu-total button{margin-top:6px;width:100%;padding:6px;border:none;border-radius:4px;background:#0f766e;color:#fff;font-weight:600;cursor:pointer;font-size:11px;}
        .pdu-prosp{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin:6px 0;}
        .pdu-prosp-alerta{background:#fef2f2;border-color:#fecaca;}
        .pdu-prosp-t{font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:.4px;}
        .pdu-prosp-n{font-size:24px;font-weight:800;color:#0f172a;line-height:1.2;}
        .pdu-prosp-n small{font-size:12px;font-weight:600;color:#475569;}
        .pdu-formula{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#334155;margin-top:2px;}
        .pdu-prosp-hum{margin-top:6px;padding:6px 8px;background:#e0f2fe;border-radius:6px;color:#075985;font-weight:600;}
        .pdu-prosp-hum span{font-weight:400;}
        .pdu-explica{font-size:11px;color:#4b5563;line-height:1.5;margin:6px 0 0;}
        .pdu-row .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:middle;}
        .pdu-click{cursor:pointer;border-radius:4px;}
        .pdu-click:hover{background:#f1f5f9;}
        .pdu-progreso{height:8px;background:#e2e8f0;border-radius:4px;overflow:hidden;margin:6px 0;}
        .pdu-progreso div{height:100%;background:#0f766e;transition:width .2s;}
        .pdu-map-ctl{display:flex;flex-direction:column;gap:6px;}
        .pdu-map-ctl button{padding:8px 12px;border:none;border-radius:8px;background:#fff;color:#1f2937;font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);text-align:left;white-space:nowrap;}
        .pdu-map-ctl button:hover{background:#f1f5f9;}
        .pdu-map-ctl button.activo{background:#0f766e;color:#fff;}
        #pdu-map-gps.activo{background:#2563eb;}
        .pdu-gps-icono span{display:block;width:22px;height:22px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 0 rgba(37,99,235,.6);animation:pduPulso 2s infinite;box-sizing:border-box;}
        @keyframes pduPulso{0%{box-shadow:0 0 0 0 rgba(37,99,235,.6);}70%{box-shadow:0 0 0 16px rgba(37,99,235,0);}100%{box-shadow:0 0 0 0 rgba(37,99,235,0);}}
        #pdu-gps-info{position:fixed;left:20px;bottom:120px;width:260px;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.25);padding:10px 12px;z-index:1400;font-family:'Segoe UI',sans-serif;font-size:12px;display:none;}
        #pdu-gps-info.visible{display:block;}
        #pdu-gps-info .t{font-weight:700;color:#1d4ed8;display:flex;justify-content:space-between;}
        #pdu-gps-info .t span{font-weight:400;color:#6b7280;}
        #pdu-gps-info .z{margin:6px 0;padding-left:8px;border-left:4px solid #cbd5e1;}
        #pdu-gps-info button{width:100%;margin-top:6px;padding:7px;border:none;border-radius:6px;background:#0f766e;color:#fff;font-weight:600;cursor:pointer;font-size:12px;}
        #pdu-gps-info button.sec{background:#e2e8f0;color:#1f2937;}
        @media (max-width:768px){
            #pdu-resultados{top:auto;bottom:0;right:0;left:0;width:auto;max-height:65vh;border-radius:14px 14px 0 0;}
            #pdu-resultados .pdu-top{border-radius:14px 14px 0 0;padding:12px 14px;}
            #pdu-resultados.minimizado .pdu-top{border-radius:14px 14px 0 0;}
            #pdu-resultados .pdu-top::before{content:'';position:absolute;top:5px;left:50%;transform:translateX(-50%);width:36px;height:4px;border-radius:2px;background:rgba(255,255,255,.5);}
            #pdu-resultados .pdu-top{position:relative;}
            #pdu-gps-info{left:10px;right:10px;width:auto;bottom:130px;}
        }`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }

    function construirUI() {
        inyectarCSS();

        // Pane propio: por defecto encima de las demás capas para poder tocar los polígonos
        const pane = map.createPane('pduPane');
        pane.style.zIndex = 350;
        pane.style.pointerEvents = 'none';

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
                <div class="pdu-modo" role="group" aria-label="Qué responde al clic">
                    <span>Al tocar el mapa consultar:</span>
                    <div>
                        <button type="button" data-modo="capas" class="activo">🗺️ Otras capas</button>
                        <button type="button" data-modo="pdu">🏙️ PDU</button>
                    </div>
                </div>
            </div>
            <div class="pdu-ocup">
                <label>Ocupantes por vivienda<input type="number" id="pdu-ocup-viv" min="0" step="0.1" inputmode="decimal" placeholder="Dato INEGI"></label>
                <label>Huéspedes por cuarto<input type="number" id="pdu-ocup-cua" min="0" step="0.1" inputmode="decimal" placeholder="Opcional"></label>
            </div>
            <div class="pdu-total">
                <div>Viviendas prospectadas en todo el PDU: <strong id="pdu-total-viv">…</strong></div>
                <button type="button" id="pdu-btn-resumen">📊 Ver resumen municipal</button>
            </div>
            <p class="pdu-hint">Activa «🏙️ PDU» y toca un polígono para ver la clasificación del municipio; con «Calcular» sabrás qué hay dentro. Regresa a «Otras capas» para consultar cenotes, pozos, proyectos y demás.</p>
            <p class="pdu-hint" style="color:#94a3b8;">Módulo PDU, versión ${PDU_VERSION}</p>`;
        panel.appendChild(bloque);

        const cbPDU = document.getElementById('layer-pdu');
        if (ES_MOVIL && PDU_CONFIG.cargaDiferidaEnMovil) {
            cbPDU.checked = false;
            document.getElementById('count-pdu').textContent = 'Activar';
        }
        cbPDU.addEventListener('change', e => {
            if (e.target.checked && !estado.grupoPadre) { asegurarPDU(); return; }
            if (!estado.grupoPadre) return;
            if (e.target.checked) map.addLayer(estado.grupoPadre); else map.removeLayer(estado.grupoPadre);
        });

        document.getElementById('pdu-opacidad').addEventListener('input', e => {
            estado.opacidad = e.target.value / 100;
            Object.values(estado.gruposTipo).forEach(g => g.setStyle(estilo));
            if (estado.seleccion) seleccionar(estado.seleccion.feature.properties._k);
        });

        bloque.querySelectorAll('.pdu-modo button').forEach(b =>
            b.addEventListener('click', () => setModo(b.dataset.modo === 'pdu')));
        document.getElementById('pdu-btn-resumen').addEventListener('click', resumenMunicipal);

        // Ocupación: se recuerda en este navegador
        const leer = (k, def) => { try { const v = parseFloat(localStorage.getItem(k)); return isNaN(v) ? def : v; } catch (e) { return def; } };
        estado.ocup.viv = leer('pdu_ocup_viv', PDU_CONFIG.ocupantesPorVivienda);
        estado.ocup.cua = leer('pdu_ocup_cua', PDU_CONFIG.huespedesPorCuarto);
        [['pdu-ocup-viv', 'viv', 'pdu_ocup_viv'], ['pdu-ocup-cua', 'cua', 'pdu_ocup_cua']].forEach(([id, k, ls]) => {
            const inp = document.getElementById(id);
            if (estado.ocup[k]) inp.value = estado.ocup[k];
            inp.addEventListener('change', () => {
                const n = parseFloat(inp.value);
                estado.ocup[k] = isNaN(n) || n <= 0 ? null : n;
                try { estado.ocup[k] ? localStorage.setItem(ls, estado.ocup[k]) : localStorage.removeItem(ls); } catch (e) { }
                if (estado.ultimo) renderResultado(estado.ultimo.f, estado.ultimo.R);
            });
        });
        document.getElementById('layer-pdu').addEventListener('change', e => { if (!e.target.checked) setModo(false); });

        construirControlesMapa();

        // Panel de resultados
        const res = document.createElement('div');
        res.id = 'pdu-resultados';
        res.innerHTML = `
            <div class="pdu-top" id="pdu-top" title="Toca para minimizar o expandir">
                <h3 id="pdu-top-titulo">🧮 ¿Qué hay en este polígono?</h3>
                <button type="button" id="pdu-btn-min" title="Minimizar">▾</button>
                <button type="button" id="pdu-btn-cerrar" title="Cerrar">✕</button>
            </div>
            <div id="pdu-res-cuerpo"></div>`;
        document.body.appendChild(res);
        L.DomEvent.disableClickPropagation(res);
        L.DomEvent.disableScrollPropagation(res);

        document.getElementById('pdu-top').addEventListener('click', e => {
            if (e.target.id === 'pdu-btn-cerrar') return;
            minimizar();
        });
        document.getElementById('pdu-btn-cerrar').addEventListener('click', e => { e.stopPropagation(); cerrar(); });

        // Que la rueda del mouse haga scroll en los paneles y no mueva el zoom del mapa
        ['control-panel', 'legends-panel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) L.DomEvent.disableScrollPropagation(el);
        });
    }

    // ---------- MODO DE CLIC ----------
    // El PDU se dibuja en un lienzo que cubre todo el mapa; si recibiera clics
    // taparía las demás capas. Por eso sólo responde cuando el modo PDU está activo.
    function setModo(pdu) {
        if (pdu && !estado.grupoPadre) {
            const cb = document.getElementById('layer-pdu');
            if (cb) cb.checked = true;
            estado.modoPDU = true;
            asegurarPDU();            // al terminar de cargar, cargarPDU vuelve a aplicar el modo
        }
        estado.modoPDU = !!pdu;
        const pane = map.getPane('pduPane');
        if (pane) {
            pane.style.zIndex = pdu ? 450 : 350;
            pane.style.pointerEvents = pdu ? 'auto' : 'none';
        }
        if (pdu) {
            const cb = document.getElementById('layer-pdu');
            if (cb && !cb.checked) { cb.checked = true; if (estado.grupoPadre) map.addLayer(estado.grupoPadre); }
        }
        document.querySelectorAll('.pdu-modo button').forEach(b =>
            b.classList.toggle('activo', (b.dataset.modo === 'pdu') === estado.modoPDU));
        const bm = document.getElementById('pdu-map-modo');
        if (bm) {
            bm.classList.toggle('activo', estado.modoPDU);
            bm.innerHTML = estado.modoPDU ? '🏙️ Consultando PDU' : '🏙️ Consultar PDU';
            bm.title = estado.modoPDU ? 'Toca para volver a consultar las demás capas' : 'Toca para que el clic muestre la zonificación del PDU';
        }
        map.closePopup();
    }

    function construirControlesMapa() {
        const Ctl = L.Control.extend({
            options: { position: 'bottomleft' },
            onAdd() {
                const d = L.DomUtil.create('div', 'pdu-map-ctl');
                d.innerHTML = `
                    <button type="button" id="pdu-map-gps" title="Mostrar mi ubicación">📍 Mi ubicación</button>
                    <button type="button" id="pdu-map-modo" title="Toca para que el clic muestre la zonificación del PDU">🏙️ Consultar PDU</button>`;
                L.DomEvent.disableClickPropagation(d);
                L.DomEvent.disableScrollPropagation(d);
                return d;
            }
        });
        map.addControl(new Ctl());
        document.getElementById('pdu-map-modo').addEventListener('click', () => setModo(!estado.modoPDU));
        document.getElementById('pdu-map-gps').addEventListener('click', activarGPS);

        const toast = document.createElement('div');
        toast.id = 'pdu-gps-info';
        document.body.appendChild(toast);
        L.DomEvent.disableClickPropagation(toast);
    }

    // ---------- GEOLOCALIZACIÓN ----------
    function activarGPS() {
        const g = estado.gps;
        if (!navigator.geolocation) { alert('Tu navegador no permite geolocalización.'); return; }
        if (g.watch !== null) {           // ya está siguiendo: sólo recentra
            if (g.ultimo) map.setView(g.ultimo, Math.max(map.getZoom(), 16));
            return;
        }
        const btn = document.getElementById('pdu-map-gps');
        btn.textContent = '📡 Buscando…';
        g.primera = true;
        g.watch = navigator.geolocation.watchPosition(pos => {
            const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
            const acc = pos.coords.accuracy;
            g.ultimo = ll;
            if (!g.marker) {
                g.marker = L.marker(ll, {
                    icon: L.divIcon({ className: 'pdu-gps-icono', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
                    interactive: false, keyboard: false, zIndexOffset: 1000
                }).addTo(map);
                g.circulo = L.circle(ll, { radius: acc, color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false }).addTo(map);
            } else {
                g.marker.setLatLng(ll);
                g.circulo.setLatLng(ll).setRadius(acc);
            }
            btn.textContent = '📍 Centrar';
            btn.classList.add('activo');
            if (g.primera) { map.setView(ll, 17); g.primera = false; }
            infoUbicacion(ll, acc);
        }, err => {
            const msg = {
                1: 'Diste o tienes bloqueado el permiso de ubicación. Actívalo en la configuración del navegador para este sitio.',
                2: 'No se pudo determinar tu ubicación. Revisa que el GPS o la ubicación del equipo estén activos.',
                3: 'La ubicación tardó demasiado. Intenta de nuevo, de preferencia al aire libre.'
            }[err.code] || err.message;
            alert('📍 ' + msg);
            detenerGPS();
        }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }

    function detenerGPS() {
        const g = estado.gps;
        if (g.watch !== null) navigator.geolocation.clearWatch(g.watch);
        if (g.marker) map.removeLayer(g.marker);
        if (g.circulo) map.removeLayer(g.circulo);
        Object.assign(g, { watch: null, marker: null, circulo: null, ultimo: null, primera: true });
        const btn = document.getElementById('pdu-map-gps');
        if (btn) { btn.textContent = '📍 Mi ubicación'; btn.classList.remove('activo'); }
        document.getElementById('pdu-gps-info').classList.remove('visible');
    }

    function pduEnPunto(ll) {
        if (typeof turf === 'undefined') return null;
        const pt = [ll.lng, ll.lat];
        for (const f of estado.features) {
            if (!f._bbox) f._bbox = turf.bbox(f);
            const b = f._bbox;
            if (pt[0] < b[0] || pt[0] > b[2] || pt[1] < b[1] || pt[1] > b[3]) continue;
            try { if (turf.booleanPointInPolygon(pt, f)) return f; } catch (e) { }
        }
        return null;
    }

    function infoUbicacion(ll, acc) {
        const f = pduEnPunto(ll);
        const el = document.getElementById('pdu-gps-info');
        const zona = f
            ? `<div class="z" style="border-color:${colorDe(f.properties)}">Zona PDU: <strong>${esc(f.properties.tipo || 'Sin tipo')}</strong> ${esc(f.properties.CVE || '')}</div>
               <button type="button" onclick="PDU.calcular(${f.properties._k})">🧮 ¿Qué hay en este polígono?</button>`
            : (estado.grupoPadre
                ? `<div class="z">Fuera de los polígonos del PDU</div>`
                : `<div class="z">Activa la capa del PDU para saber en qué zona estás.</div>
                   <button type="button" onclick="PDU.cargarYUbicar()">🏙️ Cargar PDU</button>`);
        el.innerHTML = `
            <div class="t">📍 Estás aquí <span>±${fmtN(acc)} m</span></div>
            ${zona}
            <button type="button" class="sec" onclick="PDU.detenerGPS()">Dejar de seguir mi ubicación</button>`;
        el.classList.add('visible');
    }

    async function cargarYUbicar() {
        const cb = document.getElementById('layer-pdu');
        if (cb) cb.checked = true;
        await asegurarPDU();
        const g = estado.gps;
        if (g.ultimo) infoUbicacion(g.ultimo, g.circulo ? g.circulo.getRadius() : 0);
    }

    // ---------- RESUMEN MUNICIPAL ----------
    async function resumenMunicipal() {
        if (!estado.grupoPadre) {
            const cb = document.getElementById('layer-pdu');
            if (cb) cb.checked = true;
            await asegurarPDU();
        }
        const porTipo = {};
        let tv = 0, tc = 0, lotes = 0, tvT = 0, tcT = 0, th = 0, thOK = true;
        estado.features.forEach(f => {
            tvT += f._vivT; tcT += f._cuaT;
            const ph = personas(f);
            if (ph.hab === null) { if (f._viv) thOK = false; } else th += ph.hab;
            const t = f.properties.tipo || 'Sin tipo';
            const r = porTipo[t] = porTipo[t] || { viv: 0, cua: 0, area: 0, n: 0, clave: f.properties.Clave, color: colorDe(f.properties) };
            r.viv += f._viv; r.cua += f._cua; r.area += f._area; r.n++;
            tv += f._viv; tc += f._cua; if (f._porLote) lotes++;
        });
        const filas = Object.entries(porTipo).filter(([, r]) => r.viv || r.cua).sort((a, b) => b[1].viv - a[1].viv)
            .map(([t, r]) => `<div class="pdu-row"><span><i class="sw" style="background:${r.color}"></i>${esc(t)}</span><strong>${fmtN(r.viv)}</strong>
                <em>${r.n} polígonos · ${fmtM2(r.area)}${r.cua ? ` · ${fmtN(r.cua)} cuartos` : ''}</em></div>`).join('');

        const t = document.getElementById('pdu-top-titulo');
        if (t) t.textContent = '📊 Resumen municipal del PDU';
        abrirPanel(`
            <div class="pdu-cab" style="border-color:#0f766e;">
                <div class="pdu-cab-tipo" style="color:#0f766e;">Carga habitacional del PDU</div>
                <div class="pdu-cab-area">${estado.features.length} polígonos analizados</div>
            </div>
            <div class="pdu-prosp">
                <div class="pdu-prosp-t">Viviendas prospectadas en el municipio</div>
                <div class="pdu-prosp-n">${fmtN(tv)} <small>viviendas</small></div>
                ${tc ? `<div class="pdu-formula">${fmtN(tc)} cuartos turísticos adicionales</div>` : ''}
                ${thOK && th ? `<div class="pdu-formula">≈ ${fmtN(th)} habitantes potenciales</div>` : ''}
                ${estado.ocup.cua && tc ? `<div class="pdu-formula">≈ ${fmtN(tc * estado.ocup.cua)} huéspedes</div>` : ''}
                ${tvT || tcT ? `<div class="pdu-formula">Además, potencial transferible: ${fmtN(tvT)} viviendas y ${fmtN(tcT)} cuartos</div>` : ''}
            </div>
            ${!thOK ? '<p class="pdu-nota">Escribe los ocupantes por vivienda en el panel de capas para estimar habitantes.</p>' : ''}
            <p class="pdu-explica">Suma, polígono por polígono, de la densidad asignada multiplicada por la superficie. Es la capacidad máxima que el instrumento habilita, no la población actual.${lotes ? ` No incluye ${lotes} polígonos con densidad «por lote», que no se pueden totalizar sin el número de lotes.` : ''}</p>
            <section class="pdu-sec"><h4>Por uso de suelo</h4>${filas || '<div class="pdu-nada">Ningún polígono tiene densidad asignada</div>'}</section>
            <section class="pdu-sec" id="pdu-hum-mun">
                <h4>🌊 ¿Cuántas caen sobre humedales?</h4>
                <p class="pdu-explica">Cruza cada polígono con densidad asignada contra la capa de humedales y zonas inundables. Puede tardar un par de minutos.</p>
                <div class="pdu-acciones"><button type="button" onclick="PDU.humedalesMunicipal()">Calcular viviendas sobre humedales</button></div>
            </section>`);
    }

    async function humedalesMunicipal() {
        await cargarTurf();
        const cont = document.getElementById('pdu-hum-mun');
        const objetivo = estado.features.filter(f => f._viv > 0 || f._cua > 0);
        const humedales = poligonosDe('socioeco');
        if (!humedales.length) { cont.innerHTML += '<p class="pdu-nota">La capa de humedales no está cargada.</p>'; return; }
        const ctx = { errores: 0 };
        let vivHum = 0, cuaHum = 0, areaHum = 0;
        const top = [];
        const porTipo = {};
        for (let i = 0; i < objetivo.length; i++) {
            const f = objetivo[i];
            if (f._hum !== undefined && f._humA === undefined) f._humA = f._hum * f._area;
            if (f._hum === undefined) {
                const feature = turf.feature(f.geometry);
                const obj = { feature, bbox: turf.bbox(feature) };
                const ag = turf.area(feature);
                let a = 0;
                humedales.forEach(l => { a += areaTraslape(obj, l, ctx); });
                f._hum = ag > 0 ? Math.min(1, a / ag) : 0;
                f._humA = a;
            }
            const vh = f._viv * f._hum, ch = f._cua * f._hum;
            vivHum += vh; cuaHum += ch; areaHum += f._humA;
            if (vh >= 1 || ch >= 1) {
                top.push({ f, vh, ch });
                const t = f.properties.tipo || 'Sin tipo';
                porTipo[t] = (porTipo[t] || 0) + vh;
            }
            if (i % 25 === 0) {
                cont.innerHTML = `<h4>🌊 ¿Cuántas caen sobre humedales?</h4>
                    <div class="pdu-progreso"><div style="width:${(100 * i / objetivo.length).toFixed(1)}%"></div></div>
                    <p class="pdu-explica">Analizando ${i} de ${objetivo.length} polígonos…</p>`;
                await sleep(0);
            }
        }
        top.sort((a, b) => b.vh - a.vh);
        const tv = estado.features.reduce((s, f) => s + f._viv, 0);
        cont.innerHTML = `
            <h4>🌊 Viviendas prospectadas sobre humedales</h4>
            <div class="pdu-prosp pdu-prosp-alerta">
                <div class="pdu-prosp-n">${fmtN(Math.round(vivHum))} <small>viviendas</small></div>
                <div class="pdu-formula">${fmtN(100 * vivHum / (tv || 1), 1)}% de todas las viviendas que prospecta el PDU${cuaHum >= 1 ? ` · ${fmtN(Math.round(cuaHum))} cuartos turísticos` : ''}</div>
                <div class="pdu-formula">${fmtM2(areaHum)} de humedal dentro de polígonos con densidad asignada</div>
            </div>
            <p class="pdu-explica">Estimación proporcional: en cada polígono, las viviendas prospectadas se multiplican por la fracción de su superficie que es humedal o zona inundable.</p>
            ${Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, v]) => linea(esc(t), fmtN(Math.round(v)))).join('')}
            <h4 style="margin-top:10px;">Polígonos con más viviendas sobre humedal</h4>
            ${top.slice(0, 10).map(x => `<div class="pdu-row pdu-click" onclick="PDU.zoom(${x.f.properties._k}); PDU.calcular(${x.f.properties._k});">
                <span>${esc(idDe(x.f.properties))} · ${esc(x.f.properties.tipo || '')}</span><strong>${fmtN(Math.round(x.vh))}</strong>
                <em>${esc(x.f.properties.CVE || '')} · ${fmtN(x.f._hum * 100, 1)}% humedal · toca para analizar</em></div>`).join('') || '<div class="pdu-nada">Ninguno</div>'}
            ${ctx.errores ? `<p class="pdu-nota">${ctx.errores} geometrías con topología inválida quedaron fuera del conteo.</p>` : ''}`;
        estado.ultimoResumen = `VIVIENDAS PROSPECTADAS POR EL PDU SOBRE HUMEDALES\nTotal prospectado en el municipio: ${fmtN(tv)} viviendas\nSobre humedales o zonas inundables (estimación proporcional): ${fmtN(Math.round(vivHum))} viviendas (${fmtN(100 * vivHum / (tv || 1), 1)}%)\n` +
            Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([t, v]) => `- ${t}: ${fmtN(Math.round(v))}`).join('\n') +
            '\n\nFuente: Chac Mool de Toma las Aguas – cruce automático de capas.';
        cont.innerHTML += `<div class="pdu-acciones"><button type="button" onclick="PDU.copiar()">📋 Copiar resumen</button></div>`;
    }

    function minimizar(forzar) {
        const panel = document.getElementById('pdu-resultados');
        const min = typeof forzar === 'boolean' ? forzar : !panel.classList.contains('minimizado');
        panel.classList.toggle('minimizado', min);
        const btn = document.getElementById('pdu-btn-min');
        btn.textContent = min ? '▴' : '▾';
        btn.title = min ? 'Expandir' : 'Minimizar';
    }

    // Minimiza la leyenda de la derecha para que no quede tapada por los resultados
    function recogerLeyenda() {
        const leg = document.getElementById('legends-panel');
        if (leg && !leg.classList.contains('panel-minimized')) {
            leg.classList.add('panel-minimized');
            const icon = document.getElementById('legends-toggle-icon');
            if (icon) icon.textContent = '+';
        }
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
        const div = document.createElement('details');
        div.className = 'pdu-leyenda';
        div.style.marginTop = '12px';
        div.innerHTML = `
            <summary>PDU – Usos de suelo (${Object.keys(porTipo).length})</summary>
            <div style="font-size:10px;">
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
        // Clic en mapa para proyectos hidrosociales (definido en index.html como window.clickHidrosocial)
        if (typeof window.clickHidrosocial === 'function') map.on('click', window.clickHidrosocial);
        cargarTurf().catch(e => console.warn('[PDU]', e.message));
        if (!(ES_MOVIL && PDU_CONFIG.cargaDiferidaEnMovil)) await asegurarPDU();
    }

    window.PDU = { calcular, cerrar, copiar, zoom, detenerGPS, humedalesMunicipal, resumenMunicipal, cargarYUbicar, config: PDU_CONFIG };

    if (SIN_PDU) { console.log('[PDU] Módulo desactivado por ?sinpdu'); return; }
    if (document.readyState === 'complete') iniciar();
    else window.addEventListener('load', iniciar);
})();
