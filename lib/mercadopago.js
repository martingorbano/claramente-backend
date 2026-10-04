// Helpers de generación de links de pago/suscripción de MercadoPago.
// Extraído de index.js al dividir en módulos — sin cambios de comportamiento.
const { mp, PreApproval } = require('./clients');
const { PREMIUM_MONTO } = require('./constants');

// Bug conocido de MercadoPago (activo desde 2026-09-02, ver issue #480 en
// mercadopago/sdk-nodejs): para suscripciones "sin plan asociado" (auto_recurring,
// como las que creamos acá), la API devuelve el init_point con &activation=true,
// y ESE parámetro puntual hace que la página tire "Esta página no existe" en
// mercadopago.com.ar. Sacándolo, el mismo link funciona bien. Lo limpiamos acá
// para no depender de que MP lo arregle de su lado.
function limpiarInitPoint(url) {
  if (!url) return url;
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.delete('activation');
    return urlObj.toString();
  } catch(e) {
    return url; // si algo falla al parsear, devolvemos el original sin tocar
  }
}

// Genera un link de pago de MP personalizado para un profesional EXISTENTE
// (a diferencia de /registro-pendiente, que es para altas nuevas).
// Usa el id del profesional como external_reference para que el webhook
// pueda identificarlo y actualizar su plan directamente.
//
// IMPORTANTE: se crea SIN preapproval_plan_id. Usar preapproval_plan_id acá
// requiere pasar un card_token_id ya tokenizado (o sea, vos mismo capturando
// la tarjeta en tu frontend con el SDK de MP) — si no lo tenés, la API tira
// "card_token_id is required". Mandando auto_recurring completo en cambio,
// MP crea una suscripción "sin plan asociado" con status pendiente y devuelve
// un init_point para que el usuario complete el pago en el checkout hosteado.
async function generarLinkUpgrade(profesional, mpEmail) {
  const backUrl = `${process.env.APP_URL || 'https://claramentepsi.com'}/panel.html?upgrade=ok`;
  const emailParaPago = mpEmail || profesional.email; // si no se especifica, caemos al de Claramente

  const preApproval = new PreApproval(mp);
  const subscription = await preApproval.create({
    body: {
      reason: 'Plan Premium - claramentepsi',
      payer_email: emailParaPago,
      external_reference: `prof_${profesional.id}`,
      back_url: backUrl,
      status: 'pending',
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: PREMIUM_MONTO,
        currency_id: 'ARS',
      },
    }
  });
  console.log(`Suscripción creada (upgrade existente) — email Claramente: ${profesional.email}, email MP usado: ${emailParaPago}, prof_id: ${profesional.id}, init_point: ${subscription.init_point}, mp_id: ${subscription.id}`);
  return limpiarInitPoint(subscription.init_point);
}

module.exports = { limpiarInitPoint, generarLinkUpgrade };
