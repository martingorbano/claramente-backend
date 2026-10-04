// Clientes de servicios externos, instanciados una sola vez y compartidos
// por toda la app. Extraído de index.js al dividir en módulos — sin cambios
// de comportamiento, mismas variables de entorno, mismo orden de creación.
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { MercadoPagoConfig, PreApprovalPlan, PreApproval } = require('mercadopago');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

module.exports = { anthropic, supabase, resend, mp, PreApprovalPlan, PreApproval };
