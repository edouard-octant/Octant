const YCHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YCHART2 = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const YSEARCH = 'https://query1.finance.yahoo.com/v1/finance/search?q=';
const YPROFIL = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary/';
const ENTETES = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const MARCHES_EURO = /\.(PA|AS|L|MI|DE|MC|BR|SW|NX)/;
const DELAI = 4000;  // délai max par requête : jamais d'attente infinie

// Mnémoniques Euronext ambigus ou obsolètes sur Yahoo : redirection vers le bon ticker.
// 'AL' = Air Liquide (AL.PA désigne un autre titre sur Yahoo : ~2768 € au lieu de ~173 €)
// 'FP' = TotalEnergies ; 'WLB' = Worldline (maintenant WLN) ; 'BI' = bioMérieux (maintenant BIM)
const EXCEPTIONS = { 'AL': 'AI.PA', 'FP': 'TTE.PA', 'WLB': 'WLN.PA', 'BI': 'BIM.PA' };

// Fiche société Yahoo (secteur + pays) -> étiquettes françaises de l'app.
const SEC_FR = { 'Technology': 'Technologie', 'Financial Services': 'Financier',
  'Healthcare': 'Santé', 'Consumer Cyclical': 'Consommation', 'Consumer Defensive': 'Consommation',
  'Industrials': 'Industrie', 'Basic Materials': 'Matériaux', 'Energy': 'Énergie',
  'Utilities': 'Services publics', 'Real Estate': 'Immobilier', 'Communication Services': 'Communication' };
const PAYS_ZONE = { 'United States': 'USA', 'United Kingdom': 'Royaume-Uni', 'Japan': 'Japon',
  'Germany': 'Allemagne', 'Netherlands': 'Pays-Bas', 'Switzerland': 'Suisse', 'Italy': 'Italie',
  'Spain': 'Espagne', 'Belgium': 'Belgique', 'France': 'France', 'Canada': 'Canada',
  'Australia': 'Asie-Pacifique', 'China': 'Asie-Pacifique', 'Hong Kong': 'Asie-Pacifique',
  'Taiwan': 'Asie-Pacifique', 'South Korea': 'Asie-Pacifique', 'Singapore': 'Asie-Pacifique',
  'India': 'Asie-Pacifique', 'Brazil': 'Amérique latine', 'Mexico': 'Amérique latine' };

async function allez(url, entetesSup) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), DELAI);
  try {
    const r = await fetch(url, { headers: Object.assign({}, ENTETES, entetesSup || {}), signal: c.signal });
    return r.ok ? r : null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
async function lire(url, entetesSup) {
  const r = await allez(url, entetesSup);
  if (!r) return null;
  try { return await r.json(); } catch (e) { return null; }
}

// Cours Yahoo : essaie les deux hôtes. Retourne { prix, devise, nom, place } —
// le NOM du titre trouvé sert à vérifier qu'on a le bon actif (anti-erreur).
async function yahoo(symbole) {
  for (const h of [YCHART, YCHART2]) {
    const j = await lire(h + encodeURIComponent(symbole) + '?interval=1d&range=1d');
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const meta = res && res.meta;
    const prix = meta && meta.regularMarketPrice;
    if (prix) return { prix: prix, devise: (meta.currency || ''),
                       nom: (meta.shortName || meta.longName || ''),
                       place: (meta.fullExchangeName || meta.exchangeName || '') };
  }
  return null;
}
// Recherche Yahoo : liste de candidats avec leurs noms (oracle d'identité).
async function chercherDetail(q) {
  const j = await lire(YSEARCH + encodeURIComponent(q) + '&quotesCount=8&newsCount=0');
  return (j && j.quotes || []).filter(x => x.symbol);
}

// ---- Vérification d'identité : le nom de l'actif saisi par l'utilisateur
// doit se retrouver dans le nom du titre que Yahoo renvoie -----------------
// Ex : « BNP Euro Stoxx 600 » vs « BNP Paribas Easy Stoxx Europe 600 » -> 3 mots communs.
// Ex : « Air Liquide » vs « C3.ai » -> 0 : ce n'est pas le bon titre !
function normaliser(t) {
  return String(t || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function scoreNom(nomActif, nomTitre) {
  const a = normaliser(nomActif).split(' ').filter(x => x.length >= 3);
  const b = normaliser(nomTitre).split(' ').filter(x => x.length >= 3);
  let n = 0;
  for (const t of a) if (b.indexOf(t) !== -1) n++;
  return n;
}
// Identité d'un ticker via la recherche (quand la réponse chart n'a pas le nom).
async function nomViaRecherche(t) {
  const qs = await chercherDetail(t);
  const m = qs.filter(x => x.symbol === t)[0];
  return (m && (m.shortname || m.longname)) || '';
}

// ---- Résolution d'un code : au plus 5 tentatives, dans cet ordre ----------
// 1. exception connue (AL, FP, WLB, BI...) ;
// 2. ISIN (FR0000121014...) : recherche directe, non ambiguë ;
// 3. code nu (ex « AI ») : essai avec le suffixe Paris « AI.PA » d'abord ;
// 4. code tel quel ;
// 5. candidats de la recherche Yahoo, triés : marché européen + nom proche.
// À chaque prix trouvé, l'identité est vérifiée avec le nom de l'actif :
//   'verifie' = le nom correspond ; 'pa' = titre européen, identité
//   indéterminable ; 'douteux' = le nom ne correspond pas (l'app alerte).
async function resoudre(code, nom) {
  const base = code.split('.')[0].toUpperCase();
  const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(code);
  const essais = [];
  if (EXCEPTIONS[base]) essais.push(EXCEPTIONS[base]);
  if (isin) {
    for (const q of await chercherDetail(code)) essais.push(q.symbol);
  } else {
    if (code.indexOf('.') === -1) essais.push(code + '.PA');
    essais.push(code);
    const tries = (await chercherDetail(base)).slice().sort((x, y) => {
      const sy = (MARCHES_EURO.test(y.symbol) ? 2 : 0) + scoreNom(nom, y.shortname || y.longname || '');
      const sx = (MARCHES_EURO.test(x.symbol) ? 2 : 0) + scoreNom(nom, x.shortname || x.longname || '');
      return sy - sx;
    });
    for (const t of tries) essais.push(t.symbol);
  }
  const vus = [];
  let secours = null;
  for (const t of essais) {
    if (!t || vus.indexOf(t) !== -1) continue;
    vus.push(t);
    if (vus.length > 5) break;                      // jamais plus de 5 tentatives par actif
    const q = await yahoo(t);
    if (!q) continue;
    const nomTitre = q.nom || await nomViaRecherche(t) || '';
    const eur = MARCHES_EURO.test(t);
    if (!nom || !nomTitre) return { prix: q.prix, devise: q.devise, ticker: t,
                                    nom: nomTitre, confiance: eur ? 'pa' : 'douteux' };
    if (scoreNom(nom, nomTitre) >= 1) return { prix: q.prix, devise: q.devise, ticker: t,
                                              nom: nomTitre, confiance: 'verifie' };
    if (!secours && eur) secours = { prix: q.prix, devise: q.devise, ticker: t,
                                     nom: nomTitre, confiance: 'douteux' };
  }
  return secours;
}

// ---- Fiche société (secteur + pays) : Yahoo exige un « crumb » obtenu
// avec un cookie. Mis en cache dans l'instance de la fonction. -------------
let crumbEnMemoire = null;
async function obtenirCrumb() {
  if (crumbEnMemoire) return crumbEnMemoire;
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: ENTETES });  // 404 attendu : seul le cookie compte
    const brut = (typeof r.headers.getSetCookie === 'function')
      ? r.headers.getSetCookie().join(' ; ')
      : (r.headers.get('set-cookie') || '');
    const m = brut.match(/A3=[^;]+/);
    if (!m) return null;
    const r2 = await allez('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: m[0] });
    if (!r2) return null;
    const c = (await r2.text()).trim();
    if (c && c.length < 40 && c.indexOf('<') === -1) { crumbEnMemoire = c; return c; }
    return null;
  } catch (e) { return null; }
}
async function profil(symbole) {
  const c = await obtenirCrumb();
  if (!c) return null;
  const j = await lire(YPROFIL + encodeURIComponent(symbole) + '?modules=assetProfile&crumb=' + encodeURIComponent(c));
  const res = j && j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0];
  const ap = res && res.assetProfile;
  if (!ap) return null;
  return { secteur: SEC_FR[ap.sector] || ap.sector || '',
           zone: PAYS_ZONE[ap.country] || (ap.country ? 'Monde' : '') };
}

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    const codes = String(p.codes || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    const noms = String(p.noms || '').split('|');
    const manque = String(p.manque || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);
    const resultat = {}, detail = {}, echecs = [], taux = {}, etiquettes = {}, tickers = {};
    for (let i = 0; i < codes.length; i++) {
      try {
        const q = await resoudre(codes[i].toUpperCase(), (noms[i] || '').trim());
        if (!q) { echecs.push(codes[i]); continue; }
        tickers[codes[i].toUpperCase()] = q.ticker || '';
        let prix = q.prix;
        if (q.devise && q.devise !== 'EUR') {
          if (!(q.devise in taux)) {
            const t = await yahoo('EUR' + q.devise + '=X');
            taux[q.devise] = t ? t.prix : 0;
          }
          if (taux[q.devise]) prix = prix / taux[q.devise];
        }
        resultat[codes[i].toUpperCase()] = prix;
        detail[codes[i].toUpperCase()] = { ticker: q.ticker || '', nom: q.nom || '',
                                           confiance: q.confiance || 'pa' };
      } catch (e) { echecs.push(codes[i]); }
    }
    // Fiches société pour les codes dont l'app réclame le secteur ou la zone.
    for (const m of manque) {
      try {
        let t = tickers[m];
        if (!t) {
          const q = await resoudre(m, (noms[codes.map(c => c.toUpperCase()).indexOf(m)] || '').trim());
          t = q ? (q.ticker || '') : '';
        }
        if (!t) continue;
        const pr = await profil(t);
        if (pr && (pr.secteur || pr.zone)) etiquettes[m] = pr;
      } catch (e) { /* l'étiquette est facultative : on continue */ }
    }
    const diag = Object.keys(resultat).length
      ? 'ok' : 'aucun cours obtenu (Yahoo peut bloquer les IP Netlify)';
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ resultat: resultat, detail: detail, echecs: echecs,
                                   etiquettes: etiquettes, diag: diag }) };
  } catch (err) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ erreur: String(err && err.message ? err.message : err) }) };
  }
};
