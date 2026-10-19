const YCHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YCHART2 = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const YSEARCH = 'https://query1.finance.yahoo.com/v1/finance/search?q=';
const ENTETES = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
const MARCHES_EURO = /\.(PA|AS|L|MI|DE|MC|BR|SW|NX)/;
const DELAI = 4000;  // délai max par requête : jamais d'attente infinie

// Mnémoniques Euronext ambigus sur Yahoo : redirection vers le bon ticker.
// AL = Air Liquide (sur Yahoo, AL.PA désigne un autre titre : le cours était
// donc faux, ~2768 € au lieu de ~173 €). FP = TotalEnergies.
const EXCEPTIONS = { 'AL': 'AI.PA', 'FP': 'TTE.PA' };

async function allez(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), DELAI);
  try {
    const r = await fetch(url, { headers: ENTETES, signal: c.signal });
    return r.ok ? r : null;
  } catch (e) { return null; }
  finally { clearTimeout(t); }
}
async function lire(url) {
  const r = await allez(url);
  if (!r) return null;
  try { return await r.json(); } catch (e) { return null; }
}
async function yahoo(symbole) {
  for (const h of [YCHART, YCHART2]) {
    const j = await lire(h + encodeURIComponent(symbole) + '?interval=1d&range=1d');
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    const prix = res && res.meta && res.meta.regularMarketPrice;
    if (prix) return { prix: prix, devise: (res.meta.currency || '') };
  }
  return null;
}
async function chercher(q) {
  const j = await lire(YSEARCH + encodeURIComponent(q) + '&quotesCount=8&newsCount=0');
  const quotes = (j && j.quotes || []).filter(x => x.symbol);
  const euro = quotes.find(x => MARCHES_EURO.test(x.symbol));
  return (euro || quotes[0] || {}).symbol || null;
}
async function resoudre(code, nom) {
  const base = code.split('.')[0].toUpperCase();
  let q = await yahoo(EXCEPTIONS[base] || code);
  if (q) return q;
  const s1 = await chercher(base);
  if (s1) { q = await yahoo(s1); if (q) return q; }
  if (nom) {
    const s2 = await chercher(nom);
    if (s2) { q = await yahoo(s2); if (q) return q; }
  }
  return null;
}

exports.handler = async (event) => {
  try {
    const p = event.queryStringParameters || {};
    const codes = String(p.codes || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 40);
    const noms = String(p.noms || '').split('|');
    const resultat = {}, echecs = [], taux = {};
    for (let i = 0; i < codes.length; i++) {
      try {
        const q = await resoudre(codes[i].toUpperCase(), (noms[i] || '').trim());
        if (!q) { echecs.push(codes[i]); continue; }
        let prix = q.prix;
        if (q.devise && q.devise !== 'EUR') {
          if (!(q.devise in taux)) {
            const t = await yahoo('EUR' + q.devise + '=X');
            taux[q.devise] = t ? t.prix : 0;
          }
          if (taux[q.devise]) prix = prix / taux[q.devise];
        }
        resultat[codes[i].toUpperCase()] = prix;
      } catch (e) { echecs.push(codes[i]); }
    }
    const diag = Object.keys(resultat).length
      ? 'ok' : 'aucun cours obtenu (Yahoo peut bloquer les IP Netlify)';
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ resultat: resultat, echecs: echecs, diag: diag }) };
  } catch (err) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ erreur: String(err && err.message ? err.message : err) }) };
  }
};
