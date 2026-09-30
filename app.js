/* =====================================================================
   MA STATION MÉTÉO — application web
   ---------------------------------------------------------------------
   Lit Firebase en lecture seule (API REST, aucune bibliothèque Firebase) :
     /direct/int            intérieur en temps réel (écrit toutes les 15 s)
     /direct/ext            dernier paquet de la station extérieure
     /h5/<clé>/<case>       moyenne 5 min, anneau de 30 jours
     /resume/<clé>/<date>   min / max / moyenne de chaque jour (pour toujours)
   Pour tester avec une autre base : index.html?db=https://ma-base...
   ===================================================================== */
'use strict';

const PARAMS = new URLSearchParams(location.search);
const DB = (PARAMS.get('db') ||
  'https://station-meteo-1aac0-default-rtdb.europe-west1.firebasedatabase.app').replace(/\/+$/, '');

const PAS_H5 = 300;            // 5 min (doit correspondre à la station intérieure)
const NB_SLOTS_H5 = 8640;      // 30 jours
const PERIME_INT_S = 120;      // intérieur "hors ligne" après 2 min sans nouvelles
const RAFRAICH_SPARK_MS = 5 * 60 * 1000;

// Couleurs de l'écran de la station (lettres envoyées par la station extérieure)
const COUL = {
  v: '#22c55e', o: '#fb923c', r: '#ef4444', b: '#3b82f6', c: '#22d3ee',
  j: '#facc15', m: '#d946ef', g: '#9ca3af', w: '#f5f5f5'
};

// Mesures intérieures (clés historiques de la station)
const INT = [
  { cle: 'temp',  nom: 'Température', unite: '°C',    icone: 'thermo',     coul: COUL.b,    dec: 1,
    alerte: v => v < 15 || v > 25 },
  { cle: 'hum',   nom: 'Humidité',    unite: '%',     icone: 'goutte',     coul: COUL.c,    dec: 0,
    alerte: v => v < 25 || v > 60 },
  { cle: 'co2',   nom: 'CO₂',         unite: 'ppm',   icone: 'nuage',      coul: COUL.v,    dec: 0,
    alerte: v => v > 2000 },
  { cle: 'pm10',  nom: 'PM 1.0',      unite: 'µg/m³', icone: 'particules', coul: '#fdba74', dec: 0,
    alerte: v => v > 55 },
  { cle: 'pm25',  nom: 'PM 2.5',      unite: 'µg/m³', icone: 'particules', coul: COUL.o,    dec: 0,
    alerte: v => v > 55 },
  { cle: 'pm100', nom: 'PM 10',       unite: 'µg/m³', icone: 'particules', coul: '#ea580c', dec: 0,
    alerte: v => v > 55 },
];

const etat = {
  direct: null,        // contenu de /direct
  ancien: null,        // /meteo (ancienne version de la station), en secours
  spark: {},           // clé -> [{t, v}] sur 24 h
  ouvert: null,        // clé de la mesure affichée en détail
  plageH: 72,
  graphes: { detail: null },
  resume: null,        // /resume complet (résumés quotidiens)
  hVue: 'mois',        // historique du détail : mois / annee / tout
  hPeriode: null,
  recapOuvert: false,
  rLieu: 'ext', rVue: 'mois', rPeriode: null,
};

/* =====================================================================
   OUTILS
   ===================================================================== */
const $ = s => document.querySelector(s);
const maintenant = () => Date.now() / 1000;

function sansAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Nombres à la suisse : 1'019.3 (fait main : identique sur tous les appareils)
function fmt(v, dec) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '--';
  const [ent, frac] = Math.abs(Number(v)).toFixed(dec).split('.');
  const groupes = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2019');
  return (Number(v) < 0 && Number(Number(v).toFixed(dec)) !== 0 ? '-' : '') + groupes + (frac ? '.' + frac : '');
}

const p2 = n => String(n).padStart(2, '0');
const fmtHeure = d => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
// "Mer 30.9 14:05"
const fmtMoment = t => { const d = new Date(t * 1000); return `${JOURS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1} ${fmtHeure(d)}`; };

function fmtDuree(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

const JOURS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function fmtDate(d) {
  return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`;
}
function dateCle(d) {   // "2026-09-30" (heure locale, comme la station)
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function lire(chemin, params) {
  const u = new URL(`${DB}${chemin}.json`);
  if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, JSON.stringify(v));
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) {
    const texte = await r.text().catch(() => '');
    const e = new Error(`${r.status} ${texte}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* =====================================================================
   SYMBOLES (les mêmes que sur l'écran de la station)
   ===================================================================== */
function iconePour(nom) {
  const a = sansAccents(nom);
  if (a.includes('temp')) return 'thermo';
  if (a.includes('hum')) return 'goutte';
  if (a.includes('pres')) return 'pression';
  if (a.includes('uv')) return 'uv';
  if (a.includes('lum') || a.includes('lux')) return 'lumiere';
  if (a.includes('bat')) return 'batterie';
  if (a.includes('tension')) return 'tension';
  if (a.includes('ciel') || a.includes('meteo')) return 'ciel';
  if (a.includes('co2')) return 'nuage';
  return 'autre';
}

function couleurIcone(type, secours) {
  return ({
    thermo: COUL.b, goutte: COUL.c, pression: COUL.v, uv: COUL.j, lumiere: COUL.j,
    ciel: COUL.g, nuage: COUL.v, particules: COUL.o, tension: COUL.v
  })[type] || secours || COUL.w;
}

function svgIcone(type, c, pct = 100) {
  const d = {
    thermo: `<circle cx="12" cy="17" r="5" fill="${c}"/><rect x="9.5" y="3" width="5" height="12" rx="2.5" fill="${c}"/>`,
    goutte: `<path d="M12 2.5 C12 2.5 5.5 10.5 5.5 15 A6.5 6.5 0 0 0 18.5 15 C18.5 10.5 12 2.5 12 2.5Z" fill="${c}"/>`,
    nuage:  `<circle cx="7" cy="15" r="4.5" fill="${c}"/><circle cx="12.5" cy="10.5" r="6" fill="${c}"/><circle cx="18" cy="14.5" r="4.5" fill="${c}"/><rect x="7" y="14" width="11" height="5" fill="${c}"/>`,
    ciel:   `<circle cx="7" cy="15" r="4.5" fill="${c}"/><circle cx="12.5" cy="10.5" r="6" fill="${c}"/><circle cx="18" cy="14.5" r="4.5" fill="${c}"/><rect x="7" y="14" width="11" height="5" fill="${c}"/>`,
    particules: `<circle cx="7" cy="14" r="2.3" fill="${c}"/><circle cx="16" cy="18" r="2.3" fill="${c}"/><circle cx="12" cy="6.5" r="2.3" fill="${c}"/><circle cx="18" cy="9" r="1.6" fill="${c}"/>`,
    pression: `<circle cx="12" cy="12" r="9" fill="none" stroke="${c}" stroke-width="2"/><line x1="12" y1="12" x2="17" y2="6.5" stroke="${c}" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="${c}"/>`,
    uv: `<circle cx="12" cy="12" r="4.5" fill="${c}"/>` + [0, 45, 90, 135, 180, 225, 270, 315].map(a =>
      `<line x1="12" y1="4" x2="12" y2="1.5" stroke="${c}" stroke-width="2" stroke-linecap="round" transform="rotate(${a} 12 12)"/>`).join(''),
    lumiere: `<circle cx="12" cy="9.5" r="6.5" fill="${c}"/><rect x="9" y="15" width="6" height="4" rx="1" fill="#9ca3af"/><line x1="10" y1="21" x2="14" y2="21" stroke="#9ca3af" stroke-width="1.6" stroke-linecap="round"/>`,
    batterie: `<rect x="2" y="7" width="18" height="10" rx="2" fill="none" stroke="#9ca3af" stroke-width="1.6"/><rect x="20.5" y="10" width="2" height="4" rx=".8" fill="#9ca3af"/><rect x="4" y="9" width="${Math.max(0, Math.min(100, pct)) * 0.14}" height="6" rx="1" fill="${c}"/>`,
    tension: `<path d="M13 2 L5 13.5 H11 L10 22 L19 9.5 H13 Z" fill="${c}"/>`,
    autre: `<circle cx="12" cy="12" r="4" fill="none" stroke="${c}" stroke-width="2"/>`,
  }[type] || '';
  return `<svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">${d}</svg>`;
}

/* =====================================================================
   LISTE DES MESURES (intérieur fixe + extérieur tel que l'envoie la station)
   ===================================================================== */
function mesuresExt() {
  const m = etat.direct?.ext?.m || {};
  return Object.entries(m)
    .map(([cle, x]) => {
      const icone = iconePour(x.n);
      const unite = x.u || '';
      const dec = unite === '°C' ? 1 : unite === 'hPa' ? 1 : unite === 'V' ? 2
                : icone === 'uv' ? 1 : 0;
      return {
        cle, nom: x.n || cle, unite, icone, dec,
        coul: couleurIcone(icone, COUL[x.c] || COUL.w),
        coulValeur: COUL[x.c] || couleurIcone(icone, COUL.w),
        affiche: x.a, v: x.v, ordre: x.o ?? 99, cache: !!x.cache, lieu: 'ext',
      };
    })
    .sort((a, b) => a.ordre - b.ordre);
}

function mesureParCle(cle) {
  const i = INT.find(x => x.cle === cle);
  if (i) return { ...i, lieu: 'int' };
  return mesuresExt().find(x => x.cle === cle) || { cle, nom: cle, unite: '', icone: 'autre', coul: COUL.w, dec: 1, lieu: 'ext' };
}

function valeurInt(cle) {
  const d = etat.direct?.int;
  if (d && d[cle] !== undefined && d[cle] !== null) return d[cle];
  if (etat.ancien && etat.ancien[cle] !== undefined) return etat.ancien[cle];
  return null;
}

function ageInt() {
  const t = etat.direct?.int?.t;
  return t ? maintenant() - t : null;
}
function ageExt() {
  const t = etat.direct?.ext?.t;
  return t ? maintenant() - t : null;
}
function extPerime() {
  const a = ageExt();
  const p = etat.direct?.ext?.p || 600;
  return a === null || a > p;
}
function intPerime() {
  const a = ageInt();
  return a !== null && a > PERIME_INT_S;
}

/* =====================================================================
   HISTORIQUE 5 MIN : lecture d'une plage dans l'anneau de 30 jours
   ===================================================================== */
async function lireH5(cle, heures) {
  const fin = maintenant();
  const debut = fin - heures * 3600;
  const trancheDebut = Math.floor(debut / PAS_H5);
  const trancheFin = Math.floor(fin / PAS_H5);
  const pad = n => String(n).padStart(4, '0');

  let plages;
  if (trancheFin - trancheDebut + 1 >= NB_SLOTS_H5) {
    plages = [null];                                   // tout l'anneau
  } else {
    const a = trancheDebut % NB_SLOTS_H5, b = trancheFin % NB_SLOTS_H5;
    plages = a <= b ? [[a, b]] : [[a, NB_SLOTS_H5 - 1], [0, b]];
  }

  const morceaux = await Promise.all(plages.map(p =>
    lire(`/h5/${cle}`, p ? { orderBy: '$key', startAt: pad(p[0]), endAt: pad(p[1]) } : null)));

  const points = [];
  for (const m of morceaux) {
    if (!m) continue;
    // Firebase peut renvoyer un tableau quand les clés sont des nombres
    const liste = Array.isArray(m) ? m : Object.values(m);
    for (const x of liste) {
      if (x && typeof x.t === 'number' && x.t >= debut - PAS_H5 && x.t <= fin && x.v !== null) {
        points.push({ t: x.t, v: x.v });
      }
    }
  }
  points.sort((p, q) => p.t - q.t);
  return points;
}

// Pour uPlot : colonnes [temps], [valeurs], avec une coupure s'il manque des données
function versColonnes(points, pasMax = 3 * PAS_H5) {
  const xs = [], ys = [];
  let prec = null;
  for (const p of points) {
    if (prec !== null && p.t - prec > pasMax) { xs.push(prec + PAS_H5); ys.push(null); }
    xs.push(p.t); ys.push(p.v);
    prec = p.t;
  }
  return [xs, ys];
}

/* =====================================================================
   TEMPS RÉEL : flux Firebase (EventSource), avec relevé régulier en secours
   ===================================================================== */
function ecrireChemin(racine, chemin, valeur, fusion) {
  const cles = chemin.split('/').filter(Boolean);
  if (!cles.length) {
    if (fusion && racine && typeof racine === 'object' && valeur && typeof valeur === 'object') {
      for (const [k, v] of Object.entries(valeur)) ecrireChemin(racine, k, v, false);
      return racine;
    }
    return valeur;
  }
  racine = (racine && typeof racine === 'object') ? racine : {};
  let o = racine;
  for (const k of cles.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  const der = cles[cles.length - 1];
  if (fusion && o[der] && typeof o[der] === 'object' && valeur && typeof valeur === 'object') {
    for (const [k, v] of Object.entries(valeur)) ecrireChemin(o[der], k, v, false);
  } else if (valeur === null) {
    delete o[der];
  } else {
    o[der] = valeur;
  }
  return racine;
}

let flux = null, releve = null;

function demarrerDirect() {
  arreterDirect();
  if ('EventSource' in window) {
    flux = new EventSource(`${DB}/direct.json`);
    const traiter = fusion => e => {
      try {
        const { path, data } = JSON.parse(e.data);
        etat.direct = ecrireChemin(etat.direct, path, data, fusion);
        cacherAlerte();
        rendreAccueil();
      } catch (err) { console.warn(err); }
    };
    flux.addEventListener('put', traiter(false));
    flux.addEventListener('patch', traiter(true));
    flux.addEventListener('cancel', () => { arreterFlux(); relever(); });
    flux.onerror = () => {
      // Le navigateur se reconnecte tout seul ; en attendant on relève à la main
      if (flux && flux.readyState === EventSource.CLOSED) { arreterFlux(); }
    };
  }
  relever();
  releve = setInterval(relever, 30000);   // secours (et utile si le flux est coupé)
}

function arreterFlux() { if (flux) { flux.close(); flux = null; } }
function arreterDirect() { arreterFlux(); if (releve) { clearInterval(releve); releve = null; } }

async function relever() {
  try {
    const d = await lire('/direct');
    if (d) etat.direct = d;
    if (!d || !d.int) {
      // Station intérieure encore sur l'ancienne version : on lit l'ancien emplacement
      etat.ancien = await lire('/meteo').catch(() => null);
    }
    cacherAlerte();
  } catch (e) {
    montrerErreur(e);
  }
  rendreAccueil();
}

function montrerErreur(e) {
  const a = $('#alerte');
  if (e && (e.status === 401 || e.status === 403)) {
    a.innerHTML = `<b>Accès refusé par Firebase.</b><br>Dans la console Firebase → Realtime Database → Règles,
      mets <code>".read": true</code> (et <code>".write": false</code>), puis Publier.`;
  } else {
    a.innerHTML = `<b>Impossible de joindre Firebase.</b><br>Vérifie ta connexion internet. Nouvel essai automatique…`;
  }
  a.hidden = false;
}
function cacherAlerte() { $('#alerte').hidden = true; }

/* =====================================================================
   ACCUEIL
   ===================================================================== */
function sparkSvg(points, couleur) {
  if (!points || points.length < 2) return '<svg class="spark" viewBox="0 0 100 30"></svg>';
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  let mn = Infinity, mx = -Infinity;
  for (const p of points) { if (p.v < mn) mn = p.v; if (p.v > mx) mx = p.v; }
  if (mx - mn < 1e-9) { mn -= 1; mx += 1; }
  const X = t => ((t - t0) / Math.max(1, t1 - t0)) * 100;
  const Y = v => 27 - ((v - mn) / (mx - mn)) * 24;
  let d = '', prec = null;
  for (const p of points) {
    const saut = prec === null || p.t - prec > 3 * PAS_H5;
    d += `${saut ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`;
    prec = p.t;
  }
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${couleur}" stroke-width="1.6" vector-effect="non-scaling-stroke"
      stroke-linejoin="round" stroke-linecap="round" opacity=".9"/></svg>`;
}

function mini24h(cle, dec) {
  const p = etat.spark[cle];
  if (!p || !p.length) return '';
  let mn = Infinity, mx = -Infinity;
  for (const x of p) { if (x.v < mn) mn = x.v; if (x.v > mx) mx = x.v; }
  return `24 h · min ${fmt(mn, dec)} · max ${fmt(mx, dec)}`;
}

function carteHtml(m, valeurTexte, couleurValeur, perime, pct) {
  const ic = svgIcone(m.icone, perime ? '#4a4a4a' : m.coul, pct);
  return `<button class="carte${m.cache ? ' petite' : ''}${perime ? ' perime' : ''}" data-cle="${m.cle}">
    <div class="carte-haut"><span class="ic">${ic}</span><span class="nom">${m.nom}</span></div>
    <div class="valeur" style="color:${perime ? '#8b8b8b' : couleurValeur}">${valeurTexte}<span class="unite">${m.unite}</span></div>
    ${m.cache ? '' : sparkSvg(etat.spark[m.cle], m.coul)}
    <div class="mini">${mini24h(m.cle, m.dec)}</div>
  </button>`;
}

function rendreAccueil() {
  // --- Extérieur ---
  const ext = mesuresExt();
  const pe = extPerime();
  $('#cartes-ext').innerHTML = ext.length
    ? ext.map(m => {
        const texte = (m.affiche !== undefined && m.affiche !== '') ? m.affiche : fmt(m.v, m.dec);
        const pct = m.icone === 'batterie' ? (String(m.affiche).toUpperCase() === 'USB' ? 100 : m.v ?? 0) : 100;
        return carteHtml(m, texte, m.coulValeur, pe, pct);
      }).join('')
    : `<p class="vide">En attente de la station extérieure…</p>`;

  // --- Intérieur ---
  const pi = intPerime();
  $('#cartes-int').innerHTML = INT.map(m => {
    const v = valeurInt(m.cle);
    const coul = v !== null && m.alerte(v) ? COUL.r : m.coul;
    return carteHtml({ ...m }, fmt(v, m.dec), coul, pi || v === null);
  }).join('');

  majEtats();
  if (etat.ouvert) majValeurDetail();

  // Nouvelles mesures extérieures (1er chargement, ou ajout dehors) : on charge leurs courbes
  const cles = ext.map(m => m.cle).join(',');
  if (cles !== clesConnues) { clesConnues = cles; chargerSparks(); }
}
let clesConnues = '';

function majEtats() {
  const ei = $('#etat-int'), ee = $('#etat-ext');
  const ai = ageInt(), ae = ageExt();

  ei.className = 'etat ' + (ai === null ? '' : intPerime() ? 'ko' : 'ok');
  ei.innerHTML = `<i></i>Intérieur${ai === null ? '' : intPerime() ? ` · hors ligne ${fmtDuree(ai)}` : ` · ${fmtDuree(ai)}`}`;

  ee.className = 'etat ' + (ae === null ? '' : extPerime() ? 'ko' : 'ok');
  ee.innerHTML = `<i></i>Extérieur${ae === null ? '' : extPerime() ? ` · hors ligne ${fmtDuree(ae)}` : ` · ${fmtDuree(ae)}`}`;
}

function majHeure() {
  const d = new Date();
  $('#heure').textContent = fmtHeure(d);
  $('#date').textContent = `${JOURS[d.getDay()]} ${d.getDate()} ${MOIS[d.getMonth()]}`;
  majEtats();
}

// Courbes 24 h de toutes les cartes
let sparkEnCours = false, sparkARefaire = false;
async function chargerSparks() {
  if (sparkEnCours) { sparkARefaire = true; return; }
  sparkEnCours = true;
  sparkARefaire = false;
  const cles = [...INT.map(m => m.cle), ...mesuresExt().filter(m => !m.cache).map(m => m.cle)];
  await Promise.all(cles.map(async cle => {
    try { etat.spark[cle] = await lireH5(cle, 24); } catch (e) { /* pas encore d'historique */ }
  }));
  sparkEnCours = false;
  rendreAccueil();
  if (sparkARefaire) chargerSparks();
}

/* =====================================================================
   DÉTAIL D'UNE MESURE
   ===================================================================== */
const FR_NOMS = {
  MMMM: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  MMM: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  WWWW: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  WWW: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
};
const fmtDateFr = tpl => uPlot.fmtDate(
  tpl.replace('{M}/{D}', '{D}.{M}').replace('{M}/{D}/{YY}', '{D}.{M}.{YY}').replace('{h}:{mm}{aa}', '{HH}:{mm}')
     .replace('{h}{aa}', '{HH}h').replace('{aa}', ''), FR_NOMS);

// Graduations de l'axe des temps en 24 h, format suisse
const AXE_TEMPS = [
  [3600 * 24 * 365, '{YYYY}', null, null, null, null, null, null, 1],
  [3600 * 24 * 28, '{MMM}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600 * 24, '{D}.{M}', '\n{YYYY}', null, null, null, null, null, 1],
  [3600, '{HH}:{mm}', '\n{D}.{M}', null, '\n{D}.{M}', null, null, null, 1],
  [60, '{HH}:{mm}', '\n{D}.{M}', null, '\n{D}.{M}', null, null, null, 1],
];

function axes(dec, unite) {
  const base = { stroke: '#8b8b8b', grid: { stroke: '#1c1c1c', width: 1 }, ticks: { stroke: '#2a2a2a', width: 1 },
                 font: '11px -apple-system, system-ui, sans-serif' };
  return [
    { ...base, values: AXE_TEMPS },
    { ...base, size: 52, values: (u, vals) => vals.map(v => fmt(v, dec)) },
  ];
}

function detruireGraphe(role) {
  if (etat.graphes[role]) { etat.graphes[role].destroy(); etat.graphes[role] = null; }
}
function detruireGraphes() { detruireGraphe('detail'); }

function largeurGraphe(el) { return Math.max(260, el.clientWidth); }
function hauteurGraphe() { return window.innerWidth >= 700 ? 320 : 260; }

function message(el, texte) { el.innerHTML = `<div class="message">${texte}</div>`; }

function ouvrirDetail(cle) {
  const m = mesureParCle(cle);
  etat.ouvert = cle;
  $('#d-nom').textContent = m.nom;
  $('#d-lieu').textContent = m.lieu === 'int' ? 'INTÉRIEUR' : 'EXTÉRIEUR';
  $('#d-lieu').style.color = m.lieu === 'int' ? '#f5f5f5' : COUL.o;
  $('#d-icone').innerHTML = svgIcone(m.icone, m.coul, m.icone === 'batterie' ? (m.v ?? 100) : 100);
  majValeurDetail();
  $('#detail').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#detail').scrollTop = 0;
  etat.hVue = 'mois';
  etat.hPeriode = aujourdHui();
  $('#h-info').textContent = 'Touchez une barre pour voir ses valeurs.';
  requestAnimationFrame(() => { chargerDetail(); chargerHistorique(); });
}

function fermerDetail() {
  etat.ouvert = null;
  $('#detail').hidden = true;
  document.body.style.overflow = '';
  detruireGraphes();
}

function majValeurDetail() {
  const m = mesureParCle(etat.ouvert);
  let texte, coul;
  if (m.lieu === 'int') {
    const v = valeurInt(m.cle);
    texte = fmt(v, m.dec);
    coul = v !== null && m.alerte(v) ? COUL.r : m.coul;
  } else {
    texte = (m.affiche !== undefined && m.affiche !== '') ? m.affiche : fmt(m.v, m.dec);
    coul = m.coulValeur || m.coul;
  }
  $('#d-valeur').innerHTML = `<span style="color:${coul}">${texte}</span><span class="unite">${m.unite}</span>`;
}

let jetonDetail = 0;
async function chargerDetail() {
  const cle = etat.ouvert;
  if (!cle) return;
  const m = mesureParCle(cle);
  const el = $('#g-detail');
  const jeton = ++jetonDetail;
  detruireGraphe('detail');
  message(el, 'Chargement…');
  $('#d-stats').innerHTML = '';

  let points;
  try { points = await lireH5(cle, etat.plageH); }
  catch (e) { if (jeton === jetonDetail) message(el, 'Impossible de charger les données.'); return; }
  if (jeton !== jetonDetail || etat.ouvert !== cle) return;

  if (points.length < 2) {
    message(el, 'Pas encore d’historique détaillé pour cette mesure.<br>Il se remplit tout seul, un point toutes les 5 minutes.');
    return;
  }

  // Statistiques de la période
  let mn = points[0], mx = points[0], somme = 0;
  for (const p of points) { if (p.v < mn.v) mn = p; if (p.v > mx.v) mx = p; somme += p.v; }
  const heure = fmtMoment;
  $('#d-stats').innerHTML = `
    <span class="max">max <b>${fmt(mx.v, m.dec)} ${m.unite}</b> · ${heure(mx.t)}</span>
    <span class="min">min <b>${fmt(mn.v, m.dec)} ${m.unite}</b> · ${heure(mn.t)}</span>
    <span>moyenne <b>${fmt(somme / points.length, m.dec)} ${m.unite}</b></span>`;

  el.innerHTML = '';
  detruireGraphe('detail');
  const donnees = versColonnes(points);
  const g = new uPlot({
    width: largeurGraphe(el), height: hauteurGraphe(),
    fmtDate: fmtDateFr,
    scales: { x: { time: true } },
    cursor: { drag: { x: true, y: false }, points: { size: 7 } },
    legend: { live: true },
    series: [
      { label: 'Moment', value: (u, t) => t == null ? '--' : fmtMoment(t) },
      { label: m.nom, stroke: m.coul, width: 2, fill: m.coul + '1f', points: { show: false },
        value: (u, v) => v == null ? '--' : `${fmt(v, m.dec)} ${m.unite}` },
    ],
    axes: axes(m.dec, m.unite),
  }, donnees, el);
  etat.graphes.detail = g;
}

/* =====================================================================
   HISTORIQUE : résumés quotidiens (min / max / moyenne de chaque jour)
   ===================================================================== */
const MOIS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août',
                   'septembre', 'octobre', 'novembre', 'décembre'];
const MOIS_INIT = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const JOURS_LONG = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const majuscule = s => s.charAt(0).toUpperCase() + s.slice(1);
const nbJoursMois = (an, mois) => new Date(an, mois, 0).getDate();      // mois : 1 à 12

// Tous les résumés en une fois (quelques centaines de Ko par an), gardés 5 min
let resumesCharges = 0, resumesPromesse = null;
function chargerResumes(forcer = false) {
  if (!forcer && etat.resume && Date.now() - resumesCharges < 5 * 60 * 1000) return Promise.resolve(etat.resume);
  if (resumesPromesse) return resumesPromesse;
  resumesPromesse = lire('/resume')
    .then(r => { etat.resume = r || {}; resumesCharges = Date.now(); return etat.resume; })
    .finally(() => { resumesPromesse = null; });
  return resumesPromesse;
}

function joursDe(cle) {
  const r = etat.resume?.[cle] || {};
  return Object.entries(r)
    .filter(([d, x]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && x && x.min != null && x.max != null)
    .map(([d, x]) => ({
      d, an: +d.slice(0, 4), mois: +d.slice(5, 7), jour: +d.slice(8, 10),
      min: x.min, max: x.max, moy: x.moy ?? (x.min + x.max) / 2, n: x.n || 1,
    }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
}

// Min, max (avec leur date), moyenne pondérée d'une liste de jours
function agreger(jours) {
  if (!jours.length) return null;
  let mn = jours[0], mx = jours[0], s = 0, n = 0;
  for (const j of jours) {
    if (j.min < mn.min) mn = j;
    if (j.max > mx.max) mx = j;
    s += j.moy * j.n; n += j.n;
  }
  return { min: mn.min, dMin: mn.d, max: mx.max, dMax: mx.d, moy: s / n, nb: jours.length };
}

function dateLongue(d) {        // "mardi 29 septembre 2026"
  const x = new Date(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
  return `${JOURS_LONG[x.getDay()]} ${x.getDate()} ${MOIS_LONG[x.getMonth()]} ${x.getFullYear()}`;
}
function dateCourte(d) {        // "29.9.2026"
  return `${+d.slice(8, 10)}.${+d.slice(5, 7)}.${d.slice(0, 4)}`;
}

// Affichage d'une valeur avec son unité (les lux en "k" au-delà de 10'000)
function fmtVal(v, m, avecUnite = true) {
  if (v == null || Number.isNaN(v)) return '–';
  if (m.unite === 'lux' && Math.abs(v) >= 10000) return `${fmt(v / 1000, 0)}k${avecUnite ? ' lux' : ''}`;
  return fmt(v, m.dec) + (avecUnite && m.unite ? ` ${m.unite}` : '');
}

/* ---------- Choix de la période (mois / année / tout) ---------- */
function aujourdHui() { const d = new Date(); return { an: d.getFullYear(), mois: d.getMonth() + 1 }; }

function titrePeriode(vue, p, premier) {
  if (vue === 'mois') return `${majuscule(MOIS_LONG[p.mois - 1])} ${p.an}`;
  if (vue === 'annee') return String(p.an);
  return premier ? `Depuis ${MOIS_LONG[premier.mois - 1]} ${premier.an}` : 'Tout l’historique';
}

function decaler(vue, p, sens) {
  if (vue === 'mois') {
    let m = p.mois + sens, a = p.an;
    if (m < 1) { m = 12; a--; } else if (m > 12) { m = 1; a++; }
    return { an: a, mois: m };
  }
  if (vue === 'annee') return { an: p.an + sens, mois: p.mois };
  return p;
}

// Bornes : du premier jour enregistré jusqu'à aujourd'hui
function bornesOk(vue, p, premier) {
  const auj = aujourdHui();
  if (vue === 'mois') {
    const k = p.an * 12 + p.mois;
    return k <= auj.an * 12 + auj.mois && (!premier || k >= premier.an * 12 + premier.mois);
  }
  if (vue === 'annee') return p.an <= auj.an && (!premier || p.an >= premier.an);
  return true;
}

/* ---------- Graphe en barres min → max (dessiné à la main, en SVG) ---------- */
function echelle(lo, hi, n) {
  const brut = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(brut)));
  const f = brut / p;
  const pas = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  const a = Math.floor(lo / pas) * pas, b = Math.ceil(hi / pas) * pas;
  const ticks = [];
  for (let t = a; t <= b + pas / 2; t += pas) ticks.push(+t.toFixed(10));
  return { ticks, a, b, pas };
}

function dessinerBarres(el, items, m, surChoix) {
  const pleins = items.filter(i => i.min != null);
  if (!pleins.length) { message(el, 'Pas de données pour cette période.'); return; }

  const W = Math.max(280, el.clientWidth), H = window.innerWidth >= 700 ? 300 : 240;
  const G = 46, D = 6, HAUT = 10, BAS = 24;
  let lo = Math.min(...pleins.map(i => i.min)), hi = Math.max(...pleins.map(i => i.max));
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const { ticks, a, b, pas: pasY } = echelle(lo, hi, 5);
  const y = v => HAUT + (b - v) / (b - a) * (H - HAUT - BAS);
  const n = items.length, pas = (W - G - D) / n;
  const larg = Math.max(2, Math.min(26, pas * 0.62));
  const mAxe = { ...m, dec: pasY < 1 ? 1 : 0 };

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
  for (const t of ticks) {
    svg += `<line x1="${G}" x2="${W - D}" y1="${y(t)}" y2="${y(t)}" stroke="#1f1f1f"/>` +
           `<text x="${G - 7}" y="${y(t) + 4}" text-anchor="end" class="axe">${fmtVal(t, mAxe, false)}</text>`;
  }
  items.forEach((it, i) => {
    const cx = G + pas * (i + 0.5);
    if (it.etiquette) svg += `<text x="${cx}" y="${H - 7}" text-anchor="middle" class="axe">${it.etiquette}</text>`;
    if (it.min == null) return;
    const y1 = y(it.max), y2 = y(it.min), h = Math.max(3, y2 - y1);
    const r = Math.min(larg / 2, 4);
    svg += `<g class="barre" data-i="${i}">` +
      `<rect x="${cx - pas / 2}" y="${HAUT}" width="${pas}" height="${H - HAUT - BAS}" fill="transparent"/>` +
      `<rect class="corps" x="${cx - larg / 2}" y="${y1}" width="${larg}" height="${h}" rx="${r}" fill="${m.coul}"/>`;
    if (larg >= 7) {
      svg += `<circle cx="${cx}" cy="${y1}" r="${Math.min(3.5, larg / 3)}" fill="#ef4444"/>` +
             `<circle cx="${cx}" cy="${y1 + h}" r="${Math.min(3.5, larg / 3)}" fill="#22d3ee"/>`;
    }
    if (it.moy != null) {
      svg += `<line x1="${cx - larg / 2}" x2="${cx + larg / 2}" y1="${y(it.moy)}" y2="${y(it.moy)}" stroke="#000" stroke-width="2" opacity=".55"/>`;
    }
    svg += `</g>`;
  });
  svg += '</svg>';
  el.innerHTML = svg;
  el.querySelectorAll('.barre').forEach(g => g.addEventListener('click', () => {
    el.querySelectorAll('.barre.choisie').forEach(x => x.classList.remove('choisie'));
    g.classList.add('choisie');
    surChoix(items[+g.dataset.i]);
  }));
}

// Barres pour une vue : 1 par jour (mois), 1 par mois (année), 1 par mois ou par an (tout)
function barresPourVue(jours, vue, p) {
  const items = [];
  if (vue === 'mois') {
    const nb = nbJoursMois(p.an, p.mois);
    for (let j = 1; j <= nb; j++) {
      const x = jours.find(k => k.an === p.an && k.mois === p.mois && k.jour === j);
      const montrer = j === 1 || j % 5 === 0;
      items.push({ etiquette: montrer ? String(j) : '', min: x?.min ?? null, max: x?.max ?? null, moy: x?.moy ?? null,
                   titre: x ? majuscule(dateLongue(x.d)) : null });
    }
  } else if (vue === 'annee') {
    for (let mo = 1; mo <= 12; mo++) {
      const g = agreger(jours.filter(k => k.an === p.an && k.mois === mo));
      items.push({ etiquette: MOIS_INIT[mo - 1], min: g?.min ?? null, max: g?.max ?? null, moy: g?.moy ?? null,
                   titre: `${majuscule(MOIS_LONG[mo - 1])} ${p.an}`, agg: g, lien: { an: p.an, mois: mo } });
    }
  } else if (jours.length) {
    const deb = jours[0], auj = aujourdHui();
    const nbMois = (auj.an * 12 + auj.mois) - (deb.an * 12 + deb.mois) + 1;
    if (nbMois <= 36) {
      for (let k = 0; k < nbMois; k++) {
        const an = deb.an + Math.floor((deb.mois - 1 + k) / 12), mo = (deb.mois - 1 + k) % 12 + 1;
        const g = agreger(jours.filter(x => x.an === an && x.mois === mo));
        items.push({ etiquette: (mo === 1 || k === 0) ? `${MOIS_INIT[mo - 1]}'${String(an).slice(2)}` : MOIS_INIT[mo - 1],
                     min: g?.min ?? null, max: g?.max ?? null, moy: g?.moy ?? null,
                     titre: `${majuscule(MOIS_LONG[mo - 1])} ${an}`, agg: g, lien: { an, mois: mo } });
      }
    } else {
      for (let an = deb.an; an <= auj.an; an++) {
        const g = agreger(jours.filter(x => x.an === an));
        items.push({ etiquette: String(an), min: g?.min ?? null, max: g?.max ?? null, moy: g?.moy ?? null,
                     titre: String(an), agg: g, lienAn: an });
      }
    }
  }
  return items;
}

/* ---------- Bloc "Historique" de la page détail ---------- */
async function chargerHistorique() {
  const cle = etat.ouvert;
  if (!cle) return;
  const el = $('#g-histo');
  if (!etat.resume) message(el, 'Chargement…');
  try { await chargerResumes(); }
  catch (e) { if (etat.ouvert === cle) message(el, 'Impossible de charger l’historique.'); return; }
  if (etat.ouvert === cle) rendreHistorique();
}

function rendreHistorique() {
  const cle = etat.ouvert;
  if (!cle || !etat.resume) return;
  const m = mesureParCle(cle);
  const jours = joursDe(cle);
  const vue = etat.hVue, p = etat.hPeriode;
  const premier = jours[0];

  for (const b of document.querySelectorAll('#h-vues button')) b.classList.toggle('actif', b.dataset.v === vue);
  $('#h-titre').textContent = titrePeriode(vue, p, premier);
  $('#h-prec').style.visibility = vue !== 'tout' && bornesOk(vue, decaler(vue, p, -1), premier) ? 'visible' : 'hidden';
  $('#h-suiv').style.visibility = vue !== 'tout' && bornesOk(vue, decaler(vue, p, +1), premier) ? 'visible' : 'hidden';
  $('#h-info').textContent = vue === 'mois' ? 'Touchez une barre pour voir ses valeurs.'
                                            : 'Touchez une barre pour voir ses valeurs ; touchez-la encore pour l’ouvrir.';

  // Statistiques de la période affichée
  const dansPeriode = jours.filter(j => vue === 'tout' || (j.an === p.an && (vue === 'annee' || j.mois === p.mois)));
  const g = agreger(dansPeriode);
  $('#h-stats').innerHTML = g ? `
    <span class="max">max <b>${fmtVal(g.max, m)}</b> · ${dateCourte(g.dMax)}</span>
    <span class="min">min <b>${fmtVal(g.min, m)}</b> · ${dateCourte(g.dMin)}</span>
    <span>moyenne <b>${fmtVal(g.moy, m)}</b></span>
    <span><b>${g.nb}</b> jour${g.nb > 1 ? 's' : ''}</span>` : '';

  const items = barresPourVue(jours, vue, p);
  let dernierChoix = null;
  dessinerBarres($('#g-histo'), items, m, it => {
    if (dernierChoix === it && (it.lien || it.lienAn)) {           // 2e toucher : on descend d'un niveau
      if (it.lien) { etat.hVue = 'mois'; etat.hPeriode = it.lien; }
      else { etat.hVue = 'annee'; etat.hPeriode = { an: it.lienAn, mois: 1 }; }
      rendreHistorique();
      return;
    }
    dernierChoix = it;
    $('#h-info').innerHTML = `<b>${it.titre}</b> — <span class="c-max">max ${fmtVal(it.max, m)}</span> · ` +
      `<span class="c-min">min ${fmtVal(it.min, m)}</span> · moyenne ${fmtVal(it.moy, m)}`;
  });
}

/* =====================================================================
   TABLEAU RÉCAPITULATIF (extérieur ou intérieur, par jour / mois / année)
   ===================================================================== */
const COLONNES = {
  ext: [
    { cle: 'ext_temperature', nom: 'Température', unite: '°C',  dec: 1, stats: ['min', 'max'], icone: 'thermo',   coul: COUL.b },
    { cle: 'ext_humidite',    nom: 'Humidité',    unite: '%',   dec: 0, stats: ['min', 'max'], icone: 'goutte',   coul: COUL.c },
    { cle: 'ext_pression',    nom: 'Pression',    unite: 'hPa', dec: 1, stats: ['min', 'max'], icone: 'pression', coul: COUL.v },
    { cle: 'ext_indiceuv',    nom: 'UV',          unite: '',    dec: 1, stats: ['max'],        icone: 'uv',       coul: COUL.j },
    { cle: 'ext_lumiere',     nom: 'Lumière',     unite: 'lux', dec: 0, stats: ['max'],        icone: 'lumiere',  coul: COUL.j },
  ],
  int: [
    { cle: 'temp',  nom: 'Température', unite: '°C',    dec: 1, stats: ['min', 'max'], icone: 'thermo',     coul: COUL.b },
    { cle: 'hum',   nom: 'Humidité',    unite: '%',     dec: 0, stats: ['min', 'max'], icone: 'goutte',     coul: COUL.c },
    { cle: 'co2',   nom: 'CO₂',         unite: 'ppm',   dec: 0, stats: ['moy', 'max'], icone: 'nuage',      coul: COUL.v },
    { cle: 'pm25',  nom: 'PM 2.5',      unite: 'µg/m³', dec: 0, stats: ['max'],        icone: 'particules', coul: COUL.o },
    { cle: 'pm100', nom: 'PM 10',       unite: 'µg/m³', dec: 0, stats: ['max'],        icone: 'particules', coul: '#ea580c' },
  ],
};
const EXCLUES = /batterie|tension|etat|uvbrut|ciel/;

// Colonnes du tableau : les connues + toute nouvelle mesure extérieure enregistrée
function colonnes(lieu) {
  const liste = [...COLONNES[lieu]];
  if (lieu === 'ext' && etat.resume) {
    const connues = new Set(liste.map(c => c.cle));
    const direct = etat.direct?.ext?.m || {};
    for (const cle of Object.keys(etat.resume)) {
      if (!cle.startsWith('ext_') || connues.has(cle) || EXCLUES.test(cle)) continue;
      const x = direct[cle];
      const icone = iconePour(x?.n || cle);
      liste.push({ cle, nom: x?.n || cle.slice(4), unite: x?.u || '', dec: 1, stats: ['min', 'max'],
                   icone, coul: couleurIcone(icone, COUL.w) });
    }
  }
  return liste.filter(c => etat.resume?.[c.cle] || COLONNES[lieu].includes(c));
}

async function ouvrirRecap() {
  etat.recapOuvert = true;
  $('#recap').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#recap').scrollTop = 0;
  if (!etat.resume) $('#r-tableau').innerHTML = '<div class="message">Chargement…</div>';
  try { await chargerResumes(); }
  catch (e) { $('#r-tableau').innerHTML = '<div class="message">Impossible de charger l’historique.</div>'; return; }
  rendreRecap();
}

function fermerRecap() {
  etat.recapOuvert = false;
  $('#recap').hidden = true;
  if (!etat.ouvert) document.body.style.overflow = '';
}

function rendreRecap() {
  if (!etat.recapOuvert || !etat.resume) return;
  const lieu = etat.rLieu, vue = etat.rVue, p = etat.rPeriode;
  const cols = colonnes(lieu);
  const joursParCle = Object.fromEntries(cols.map(c => [c.cle, joursDe(c.cle)]));

  // Premier jour enregistré, toutes colonnes confondues
  let premier = null;
  for (const js of Object.values(joursParCle)) if (js[0] && (!premier || js[0].d < premier.d)) premier = js[0];

  for (const b of document.querySelectorAll('#r-lieux button')) b.classList.toggle('actif', b.dataset.l === lieu);
  for (const b of document.querySelectorAll('#r-vues button')) b.classList.toggle('actif', b.dataset.v === vue);
  $('#r-titre').textContent = titrePeriode(vue, p, premier);
  $('#r-prec').style.visibility = vue !== 'tout' && bornesOk(vue, decaler(vue, p, -1), premier) ? 'visible' : 'hidden';
  $('#r-suiv').style.visibility = vue !== 'tout' && bornesOk(vue, decaler(vue, p, +1), premier) ? 'visible' : 'hidden';

  if (!premier) {
    $('#r-tableau').innerHTML = '<div class="message">Pas encore de résumé quotidien enregistré.</div>';
    return;
  }

  // Lignes de la période
  const auj = new Date(), cleAuj = dateCle(auj);
  const lignes = [];
  if (vue === 'mois') {
    for (let j = 1; j <= nbJoursMois(p.an, p.mois); j++) {
      const d = `${p.an}-${String(p.mois).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
      if (d > cleAuj) break;
      const x = new Date(p.an, p.mois - 1, j);
      lignes.push({ titre: `${JOURS[x.getDay()]} ${j}`, weekend: x.getDay() === 0 || x.getDay() === 6,
                    filtre: k => k.d === d, aujourdhui: d === cleAuj });
    }
  } else if (vue === 'annee') {
    for (let mo = 1; mo <= 12; mo++) {
      if (p.an * 12 + mo > auj.getFullYear() * 12 + auj.getMonth() + 1) break;
      lignes.push({ titre: majuscule(MOIS_LONG[mo - 1]), filtre: k => k.an === p.an && k.mois === mo,
                    lien: { vue: 'mois', periode: { an: p.an, mois: mo } } });
    }
  } else {
    for (let an = premier.an; an <= auj.getFullYear(); an++) {
      lignes.push({ titre: String(an), filtre: k => k.an === an, lien: { vue: 'annee', periode: { an, mois: 1 } } });
    }
  }
  const filtrePeriode = vue === 'tout' ? () => true
    : vue === 'annee' ? k => k.an === p.an : k => k.an === p.an && k.mois === p.mois;

  // Calcul des cellules
  const valeur = (agg, s) => agg ? (s === 'min' ? agg.min : s === 'max' ? agg.max : agg.moy) : null;
  const totaux = cols.map(c => agreger(joursParCle[c.cle].filter(filtrePeriode)));
  const cellule = (c, s, v, record) => {
    const cls = [s === 'min' ? 'c-min' : s === 'max' ? 'c-max' : '', record ? 'record' : ''].join(' ');
    return `<td class="${cls}">${fmtVal(v, c, false)}</td>`;
  };

  // En-têtes
  let h = '<table><thead><tr><th class="fixe" rowspan="2">' +
          (vue === 'mois' ? 'Jour' : vue === 'annee' ? 'Mois' : 'Année') + '</th>';
  for (const c of cols) {
    h += `<th colspan="${c.stats.length}" class="groupe" style="--c:${c.coul}">` +
         `<span class="th-ic">${svgIcone(c.icone, c.coul)}</span>${c.nom}` +
         (c.unite ? `<small> ${c.unite}</small>` : '') + '</th>';
  }
  h += '</tr><tr>';
  for (const c of cols) for (const s of c.stats) h += `<th class="sous">${s === 'moy' ? 'moy.' : s}</th>`;
  h += '</tr></thead><tbody>';

  // Ligne de synthèse de la période
  h += `<tr class="total"><th class="fixe">${vue === 'mois' ? 'Mois' : vue === 'annee' ? 'Année' : 'Total'}</th>`;
  cols.forEach((c, i) => { for (const s of c.stats) h += cellule(c, s, valeur(totaux[i], s), false); });
  h += '</tr>';

  // Une ligne par jour / mois / année
  for (const l of lignes) {
    const cls = [l.weekend ? 'weekend' : '', l.aujourdhui ? 'aujourdhui' : '', l.lien ? 'cliquable' : ''].join(' ');
    h += `<tr class="${cls}"${l.lien ? ` data-lien='${JSON.stringify(l.lien)}'` : ''}><th class="fixe">${l.titre}</th>`;
    cols.forEach((c, i) => {
      const agg = agreger(joursParCle[c.cle].filter(l.filtre));
      for (const s of c.stats) {
        const v = valeur(agg, s), t = valeur(totaux[i], s);
        const record = v != null && t != null && s !== 'moy' && Math.abs(v - t) < 1e-9 && lignes.length > 1;
        h += cellule(c, s, v, record);
      }
    });
    h += '</tr>';
  }
  h += '</tbody></table>';
  if (vue !== 'mois') h += '<p class="aide">Touchez une ligne pour voir son détail.</p>';
  $('#r-tableau').innerHTML = h;
}

/* =====================================================================
   NAVIGATION (le bouton retour du téléphone / du navigateur ferme les pages)
   ===================================================================== */
function suivreAdresse() {
  const cle = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (cle === 'recap') {
    if (etat.ouvert) fermerDetail();
    if (!etat.recapOuvert) ouvrirRecap();
    return;
  }
  if (etat.recapOuvert) fermerRecap();
  if (cle && cle !== etat.ouvert) ouvrirDetail(cle);
  else if (!cle && etat.ouvert) fermerDetail();
}

document.addEventListener('click', e => {
  const carte = e.target.closest('.carte');
  if (carte) { location.hash = encodeURIComponent(carte.dataset.cle); return; }

  const plage = e.target.closest('#plages button');
  if (plage) {
    for (const b of document.querySelectorAll('#plages button')) b.classList.toggle('actif', b === plage);
    etat.plageH = Number(plage.dataset.h);
    chargerDetail();
    return;
  }

  // Historique du détail : vue et période
  const hv = e.target.closest('#h-vues button');
  if (hv) { etat.hVue = hv.dataset.v; rendreHistorique(); return; }
  if (e.target.closest('#h-prec')) { etat.hPeriode = decaler(etat.hVue, etat.hPeriode, -1); rendreHistorique(); return; }
  if (e.target.closest('#h-suiv')) { etat.hPeriode = decaler(etat.hVue, etat.hPeriode, +1); rendreHistorique(); return; }

  // Tableau récapitulatif
  const rl = e.target.closest('#r-lieux button');
  if (rl) { etat.rLieu = rl.dataset.l; rendreRecap(); return; }
  const rv = e.target.closest('#r-vues button');
  if (rv) { etat.rVue = rv.dataset.v; rendreRecap(); return; }
  if (e.target.closest('#r-prec')) { etat.rPeriode = decaler(etat.rVue, etat.rPeriode, -1); rendreRecap(); return; }
  if (e.target.closest('#r-suiv')) { etat.rPeriode = decaler(etat.rVue, etat.rPeriode, +1); rendreRecap(); return; }
  const ligne = e.target.closest('#r-tableau tr[data-lien]');
  if (ligne) {
    const l = JSON.parse(ligne.dataset.lien);
    etat.rVue = l.vue; etat.rPeriode = l.periode;
    rendreRecap();
    $('#recap').scrollTop = 0;
    return;
  }

  if (e.target.closest('[data-retour]')) {
    if (history.length > 1 && location.hash) history.back();
    else { location.hash = ''; fermerDetail(); fermerRecap(); }
  }
});
window.addEventListener('hashchange', suivreAdresse);

// Redimensionnement des graphes
let minuterieTaille = null;
window.addEventListener('resize', () => {
  clearTimeout(minuterieTaille);
  minuterieTaille = setTimeout(() => {
    const g = etat.graphes.detail;
    const el = g && g.root.parentElement;
    if (el) g.setSize({ width: largeurGraphe(el), height: hauteurGraphe() });
    if (etat.ouvert) rendreHistorique();
  }, 150);
});

// Quand l'appli revient au premier plan (iPhone), on se reconnecte
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    demarrerDirect();
    chargerSparks();
    if (etat.ouvert) { chargerDetail(); chargerResumes(true).then(rendreHistorique).catch(() => {}); }
    if (etat.recapOuvert) chargerResumes(true).then(rendreRecap).catch(() => {});
  } else {
    arreterDirect();
  }
});

/* =====================================================================
   DÉMARRAGE
   ===================================================================== */
etat.rPeriode = aujourdHui();
majHeure();
setInterval(majHeure, 10000);
rendreAccueil();
demarrerDirect();
chargerSparks();
setInterval(chargerSparks, RAFRAICH_SPARK_MS);
suivreAdresse();


if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
