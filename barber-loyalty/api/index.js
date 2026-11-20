/* CarteBarber — entry serverless Vercel (Postgres requis : POSTGRES_URL).
   Les assets statiques (css/js/img/landing) sont servis SANS base de données ;
   seuls /s/* (salons), /super* (vendeur) et /api/* rechargent la plateforme
   depuis Postgres à chaque requête — cohérent même avec plusieurs lambdas. */
const { server, loadPlatform, ensureVapid } = require('../server.js');

const listener = server.listeners('request')[0];

module.exports = async (req, res) => {
  const url = req.url || '';
  const dynamic = url.startsWith('/s/') || url.startsWith('/super') || url.startsWith('/api');
  if (dynamic) {
    if (!process.env.POSTGRES_URL) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'POSTGRES_URL manquant — ajoutez une base Postgres (Vercel → Storage) et redéployez.' }));
    }
    try {
      await loadPlatform();
      ensureVapid();
    } catch (err) {
      console.error('[vercel boot]', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ error: 'Base de données indisponible. Vérifiez POSTGRES_URL.' }));
    }
  }
  return listener(req, res);
};
