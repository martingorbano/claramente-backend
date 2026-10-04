// Verificación de firma y logging persistente de los webhooks de MercadoPago.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const crypto = require('crypto');
const { supabase } = require('./clients');

// Verificar firma del webhook de MP
function verificarFirmaMP(req) {
  try {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return true; // Si no hay secret configurado, dejar pasar
    const xSignature = req.headers['x-signature'];
    const xRequestId = req.headers['x-request-id'];
    if (!xSignature) return false;
    const parts = xSignature.split(',');
    let ts, hash;
    parts.forEach(part => {
      const [key, val] = part.trim().split('=');
      if (key === 'ts') ts = val;
      if (key === 'v1') hash = val;
    });
    const dataId = req.query?.['data.id'] || req.body?.data?.id || '';
    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expectedHash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    return hash === expectedHash;
  } catch(e) {
    return true; // En caso de error, dejar pasar
  }
}

// Guarda un registro persistente de cada evento de webhook de MP que llega,
// con el estado que devolvió la API de MP y el payload completo. Esto es
// para poder auditar después qué pasó exactamente en un caso puntual —
// los logs de Render no se pueden consultar más allá de cierta antigüedad,
// así que sin esto un evento viejo queda imposible de rastrear.
// No bloquea el webhook (no se espera con await) y nunca tira error hacia
// afuera: si falla el insert (por ejemplo, si la tabla todavía no existe),
// solo se loguea el error y el webhook sigue su curso normal.
function registrarWebhookLog(tipo, resourceId, externalRef, status, payload) {
  supabase.from('webhook_logs').insert({
    tipo,
    resource_id: String(resourceId),
    external_reference: externalRef || null,
    status: status || null,
    payload,
  }).then(({ error }) => {
    if (error) console.error('Error guardando webhook_log:', error.message);
  });
}

module.exports = { verificarFirmaMP, registrarWebhookLog };
