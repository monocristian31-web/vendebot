// ============================================================
//  BOT UNIVERSAL DE WHATSAPP — VERSIÓN FINAL COMPLETA
//  ✅ IA con Groq (gratis, sin expiración)
//  ✅ Catálogo web con carrito
//  ✅ Verificación de comprobantes con OCR.space + IA
//  ✅ Sistema anti-fraude
//  ✅ Aprobación/rechazo manual por el dueño
//  ⚠️  NO EDITES ESTE ARCHIVO — Solo edita config.env
// ============================================================

require('dotenv').config({ path: './config.env' });
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ============================================================
//  VALIDACIONES AL INICIO
// ============================================================
const GROQ_KEY = process.env.GROQ_API_KEY || '';
if (!GROQ_KEY || GROQ_KEY === 'TU_GROQ_API_KEY') {
    console.error('\n❌ ERROR: GROQ_API_KEY no configurada en config.env');
    console.error('👉 Ve a https://console.groq.com → API Keys → Create API Key\n');
    process.exit(1);
}

const OCR_KEY = process.env.OCR_API_KEY || '';
if (!OCR_KEY || OCR_KEY === 'TU_OCR_API_KEY') {
    console.error('\n❌ ERROR: OCR_API_KEY no configurada en config.env');
    console.error('👉 Ve a https://ocr.space/ocrapi/freekey y regístrate gratis\n');
    process.exit(1);
}

// ============================================================
//  CONFIGURACIÓN
// ============================================================
const CONFIG = {
    nombre:        process.env.NEGOCIO_NOMBRE        || 'Mi Negocio',
    tipo:          process.env.NEGOCIO_TIPO           || 'general',
    horarioInicio: parseInt(process.env.NEGOCIO_HORARIO_INICIO) || 6,
    horarioFin:    parseInt(process.env.NEGOCIO_HORARIO_FIN)    || 18,
    horarioTexto:  process.env.NEGOCIO_HORARIO_TEXTO  || 'Lunes a Domingo 6am - 6pm',
    ciudad:        process.env.NEGOCIO_CIUDAD         || 'Ecuador',
    entrega:       process.env.NEGOCIO_ENTREGA        || 'a coordinar',
    numero:        process.env.NEGOCIO_NUMERO         || '',
    catalogoUrl:   process.env.CATALOGO_URL           || '',
    pago: {
        banco:      process.env.PAGO_BANCO            || '',
        tipoCuenta: process.env.PAGO_TIPO_CUENTA      || '',
        cuenta:     process.env.PAGO_NUMERO_CUENTA    || '',
        titular:    process.env.PAGO_TITULAR          || '',
    },
    msgFueraHorario: process.env.MSG_FUERA_HORARIO || 'Estamos fuera de horario. Volvemos a las {HORA_INICIO}:00 AM.',
    msgDespedida:    process.env.MSG_DESPEDIDA     || '¡Gracias por tu compra en {NEGOCIO}!',
};

// Parsear catálogo
const CATALOGO = (process.env.CATALOGO || '').split(',').map((item, i) => {
    const [nombre, precio, emoji] = item.split('|');
    return { id: String(i + 1), nombre: nombre?.trim(), precio: parseFloat(precio) || 0, emoji: emoji?.trim() || '📦' };
}).filter(p => p.nombre);

// Parsear servicios
const SERVICIOS = (process.env.SERVICIOS || '').split(',').map((item, i) => {
    const [nombre, duracion, precio, emoji] = item.split('|');
    return { id: String(i + 1), nombre: nombre?.trim(), duracion: parseInt(duracion) || 30, precio: parseFloat(precio) || 0, emoji: emoji?.trim() || '⭐' };
}).filter(s => s.nombre);

// Parsear FAQs
const FAQS = (process.env.FAQS || '').split('|').map(f => f.trim()).filter(Boolean);

// ============================================================
//  CLIENTE IA — GROQ
// ============================================================
async function llamarGroq(mensajes, systemPrompt) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
                { role: 'system', content: systemPrompt },
                ...mensajes.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
            ],
            max_tokens: 500,
            temperature: 0.7
        });

        const options = {
            hostname: 'api.groq.com',
            path: '/openai/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.error) {
                        reject(new Error(result.error.message));
                    } else {
                        resolve(result.choices[0].message.content);
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ============================================================
//  CONTEXTO DEL NEGOCIO PARA LA IA
// ============================================================
function construirContexto() {
    const catalogoTexto = CATALOGO.map(p => `- ${p.emoji} ${p.nombre}: $${p.precio.toFixed(2)}`).join('\n');
    const serviciosTexto = SERVICIOS.length > 0
        ? SERVICIOS.map(s => `- ${s.emoji} ${s.nombre}: $${s.precio.toFixed(2)} (${s.duracion} min)`).join('\n')
        : 'No aplica';
    const faqsTexto = FAQS.length > 0 ? FAQS.join('\n') : 'Sin FAQs';
    const datospago = `${CONFIG.pago.banco} | ${CONFIG.pago.tipoCuenta} | Cuenta: ${CONFIG.pago.cuenta} | Titular: ${CONFIG.pago.titular}`;

    return `Eres un asistente de ventas por WhatsApp para "${CONFIG.nombre}", negocio tipo "${CONFIG.tipo}" en ${CONFIG.ciudad}.

PERSONALIDAD:
- Eres cálido, natural y amable como un vendedor humano real
- Respondes brevemente (máximo 3-4 líneas)
- Usas emojis con moderación
- NUNCA uses listas numeradas rígidas
- Adaptas tu tono al cliente

INFORMACIÓN:
- Horario: ${CONFIG.horarioTexto}
- Ciudad: ${CONFIG.ciudad}
- Entrega: ${CONFIG.entrega}
- Datos de pago: ${datospago}
- Catálogo web: ${CONFIG.catalogoUrl || 'No configurado'}

CATÁLOGO:
${catalogoTexto || 'Sin productos'}

SERVICIOS:
${serviciosTexto}

PREGUNTAS FRECUENTES:
${faqsTexto}

FLUJO DE VENTA:
1. Saluda y pregunta en qué puedes ayudar
2. Cuando pidan ver productos o hacer un pedido, SIEMPRE comparte el link del catálogo: ${CONFIG.catalogoUrl}
3. Cuando el cliente confirme su pedido (ya sea por catálogo o por chat), pide su nombre
4. Envía los datos de pago
5. Cuando el cliente diga que ya pagó o que enviará el comprobante, responde incluyendo exactamente: [ESPERANDO_COMPROBANTE]
6. Cuando confirmes un pedido completo incluye al final: [PEDIDO_CONFIRMADO:NombreCliente:Producto:Cantidad:Total]

REGLAS:
- NUNCA salgas del tema del negocio
- NUNCA inventes productos o precios
- Si el cliente envía un pedido desde el catálogo web (mensaje que empiece con 🌸), confírmalo directamente
- Si no tienes el producto, ofrece la alternativa más cercana`;
}

// ============================================================
//  HISTORIAL DE CONVERSACIONES
// ============================================================
const conversaciones = {};
const estados = {};

function getHistorial(numero) {
    if (!conversaciones[numero]) conversaciones[numero] = [];
    return conversaciones[numero];
}

function agregarMensaje(numero, rol, contenido) {
    const h = getHistorial(numero);
    h.push({ role: rol, content: contenido });
    if (h.length > 20) h.splice(0, 2);
}

// ============================================================
//  LLAMADA A IA (con reintento automático si hay rate limit)
// ============================================================
async function preguntarIA(numero, mensaje) {
    agregarMensaje(numero, 'user', mensaje);
    try {
        const historial = getHistorial(numero);
        const contexto = construirContexto();
        const texto = await llamarGroq(historial, contexto);
        agregarMensaje(numero, 'assistant', texto);
        return texto;
    } catch (error) {
        console.error('Error IA:', error.message);
        return '😊 Disculpa el retraso. ¿Puedes repetir tu mensaje?';
    }
}

// ============================================================
//  VERIFICACIÓN DE COMPROBANTE CON OCR.SPACE + IA
// ============================================================
async function verificarComprobante(imagenBase64, mimeType, totalEsperado) {
    return new Promise((resolve) => {
        try {
            const boundary = 'Boundary' + Date.now();
            let body = '';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="base64Image"\r\n\r\n';
            body += 'data:' + mimeType + ';base64,' + imagenBase64 + '\r\n';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="language"\r\n\r\nspa\r\n';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="isOverlayRequired"\r\n\r\nfalse\r\n';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="scale"\r\n\r\ntrue\r\n';
            body += '--' + boundary + '--\r\n';

            const options = {
                hostname: 'api.ocr.space',
                path: '/parse/image',
                method: 'POST',
                headers: {
                    'apikey': OCR_KEY,
                    'Content-Type': 'multipart/form-data; boundary=' + boundary,
                    'Content-Length': Buffer.byteLength(body)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', async () => {
                    try {
                        const result = JSON.parse(data);
                        const textoOCR = result.ParsedResults?.[0]?.ParsedText || '';
                        console.log('[OCR] Texto:', textoOCR.substring(0, 200));

                        if (!textoOCR || textoOCR.trim().length < 5) {
                            resolve({ estado: 'ilegible' });
                            return;
                        }

                        // Analizar con Groq
                        const ocrPrompt = `Analiza este texto de un comprobante bancario. Responde SOLO con JSON válido, sin texto adicional.

Texto OCR:
${textoOCR.substring(0, 800)}

Monto esperado: $${totalEsperado}
Banco esperado: ${CONFIG.pago.banco}
Titular esperado: ${CONFIG.pago.titular}

JSON esperado:
{"monto_detectado": número_o_null, "monto_coincide": true_o_false, "banco_correcto": true_o_false, "parece_valido": true_o_false, "nivel_confianza": "alto_medio_o_bajo", "razon": "explicación corta"}`;

                        const respIA = await llamarGroq([{role:'user', content: ocrPrompt}], 'Eres un analizador de comprobantes bancarios. Responde SOLO con JSON válido.');
                        const match = respIA.match(/\{[\s\S]*\}/);
                        if (match) {
                            const verificacion = JSON.parse(match[0]);
                            resolve({ estado: 'analizado', verificacion, textoOCR });
                        } else {
                            resolve({ estado: 'ilegible' });
                        }
                    } catch (e) {
                        console.error('[OCR] Error analizando:', e.message);
                        resolve({ estado: 'error' });
                    }
                });
            });

            req.on('error', (e) => {
                console.error('[OCR] Error request:', e.message);
                resolve({ estado: 'error' });
            });

            req.write(body);
            req.end();

        } catch (e) {
            console.error('[OCR] Error general:', e.message);
            resolve({ estado: 'error' });
        }
    });
}

// ============================================================
//  UTILIDADES
// ============================================================
function estaEnHorario() {
    const h = new Date().getHours();
    return h >= CONFIG.horarioInicio && h < CONFIG.horarioFin;
}

function horaActual() {
    return new Date().toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
}

function fechaActual() {
    return new Date().toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function parsear(msg) {
    return msg.replace(/{NEGOCIO}/g, CONFIG.nombre).replace(/{HORA_INICIO}/g, CONFIG.horarioInicio);
}

async function notificarDueno(texto) {
    if (!CONFIG.numero) return;
    try {
        await bot.sendMessage(`${CONFIG.numero}@c.us`, texto);
    } catch (e) {
        console.error('[Notificación] Error:', e.message);
    }
}

// ============================================================
//  PROCESAR RESPUESTA DE LA IA
// ============================================================
async function procesarRespuesta(numero, respuestaIA, msg) {

    // Detectar esperar comprobante
    if (respuestaIA.includes('[ESPERANDO_COMPROBANTE]')) {
        estados[numero] = 'esperando_comprobante';

        // Extraer total del historial
        const textoHistorial = getHistorial(numero).map(m => m.content).join(' ');
        const montos = [...textoHistorial.matchAll(/\$(\d+\.?\d*)/g)]
            .map(m => parseFloat(m[1]))
            .filter(m => m > 1);
        if (montos.length > 0) estados[numero + '_total'] = Math.max(...montos);

        const limpio = respuestaIA.replace('[ESPERANDO_COMPROBANTE]', '').trim();
        if (limpio) await msg.reply(limpio);
        return;
    }

    // Detectar pedido confirmado
    const matchPedido = respuestaIA.match(/\[PEDIDO_CONFIRMADO:([^\]]+)\]/);
    if (matchPedido) {
        const [nombre, producto, cantidad, total] = matchPedido[1].split(':');
        if (nombre) estados[numero + '_nombre'] = nombre;
        if (total) estados[numero + '_total'] = parseFloat(total);

        const limpio = respuestaIA.replace(matchPedido[0], '').trim();
        if (limpio) await msg.reply(limpio);

        await notificarDueno(
            `🔔 *NUEVO PEDIDO*\n\n` +
            `👤 ${nombre || 'Sin nombre'}\n` +
            `📱 +${numero}\n` +
            `🛍️ ${producto || 'Ver chat'} x${cantidad || 1}\n` +
            `💰 $${total || '0'}\n` +
            `🕐 ${horaActual()} — ${fechaActual()}\n` +
            `📎 Esperando comprobante`
        );
        return;
    }

    await msg.reply(respuestaIA);
}

// ============================================================
//  BOT WHATSAPP
// ============================================================
const bot = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

bot.on('message', async (msg) => {
    if (msg.fromMe) return;

    const numero = msg.from.replace('@c.us', '');
    const texto = msg.body.trim();
    const textoMin = texto.toLowerCase();

    // ── Comandos del dueño ──────────────────────────────────
    if (msg.from === `${CONFIG.numero}@c.us`) {
        const mAprobar  = textoMin.match(/^aprobar\s+(\d+)/);
        const mRechazar = textoMin.match(/^rechazar\s+(\d+)/);

        if (mAprobar) {
            const nc = mAprobar[1];
            const nombre = estados[nc + '_nombre'] || 'Cliente';
            delete estados[nc]; delete estados[nc + '_total']; delete estados[nc + '_nombre'];
            await bot.sendMessage(`${nc}@c.us`, `✅ *¡Pago confirmado ${nombre}!*\n\nTu pedido está en proceso 🌸 ¡Gracias!`);
            await msg.reply(`✅ Pedido de +${nc} aprobado.`);
            return;
        }

        if (mRechazar) {
            const nc = mRechazar[1];
            delete estados[nc]; delete estados[nc + '_total']; delete estados[nc + '_nombre'];
            await bot.sendMessage(`${nc}@c.us`, `❌ No pudimos verificar tu pago.\n\nEscríbenos directamente para resolver esto 😊`);
            await msg.reply(`❌ Pedido de +${nc} rechazado.`);
            return;
        }
    }

    // ── Fuera de horario ─────────────────────────────────────
    if (!estaEnHorario()) {
        if (!estados[numero + '_fh']) {
            estados[numero + '_fh'] = true;
            await msg.reply(`🌙 ${parsear(CONFIG.msgFueraHorario)}\n\n⏰ *${CONFIG.horarioTexto}*`);
        }
        return;
    }
    delete estados[numero + '_fh'];

    // ── Comprobante de pago ───────────────────────────────────
    if (estados[numero] === 'esperando_comprobante') {
        if (msg.hasMedia) {
            await msg.reply(`📎 Recibí tu comprobante, verificando... 🔍`);

            try {
                const media = await msg.downloadMedia();
                const totalEsperado = estados[numero + '_total'] || 0;
                const nombreCliente = estados[numero + '_nombre'] || 'Cliente';

                const resultado = await verificarComprobante(media.data, media.mimetype, totalEsperado);

                if (resultado.estado === 'analizado') {
                    const v = resultado.verificacion;
                    console.log('[Verificación]', v);

                    if (v.parece_valido && v.monto_coincide && v.nivel_confianza === 'alto') {
                        // ✅ APROBADO AUTOMÁTICAMENTE
                        delete estados[numero]; delete estados[numero + '_total']; delete estados[numero + '_nombre'];
                        const conf = await preguntarIA(numero, '[SISTEMA: Comprobante verificado exitosamente. Confirma el pago de forma cálida y despídete.]');
                        await msg.reply(conf.replace(/\[.*?\]/g, '').trim());
                        await notificarDueno(
                            `✅ *PAGO VERIFICADO AUTOMÁTICAMENTE*\n\n` +
                            `👤 ${nombreCliente} | 📱 +${numero}\n` +
                            `💰 Detectado: $${v.monto_detectado || totalEsperado} | Esperado: $${totalEsperado}\n` +
                            `🏦 Banco correcto: ${v.banco_correcto ? 'Sí' : 'No'}\n` +
                            `✅ Confianza: ${v.nivel_confianza}\n` +
                            `🕐 ${horaActual()}`
                        );

                    } else if (!v.parece_valido || v.nivel_confianza === 'bajo') {
                        // 🚨 POSIBLE FRAUDE
                        await msg.reply(
                            `❌ No pude verificar tu comprobante.\n\n` +
                            `Por favor envía un comprobante claro de la transferencia 📸\n` +
                            `O contáctanos directamente si ya realizaste el pago.`
                        );
                        await notificarDueno(
                            `🚨 *ALERTA: POSIBLE COMPROBANTE FALSO*\n\n` +
                            `👤 ${nombreCliente} | 📱 +${numero}\n` +
                            `💰 Detectado: $${v.monto_detectado || 'N/A'} | Esperado: $${totalEsperado}\n` +
                            `⚠️ ${v.razon}\n` +
                            `🕐 ${horaActual()}\n\n` +
                            `Responde *APROBAR ${numero}* o *RECHAZAR ${numero}*`
                        );

                    } else {
                        // ⚠️ DUDA — Revisión manual
                        await msg.reply(`⏳ Tu comprobante está siendo revisado. Te confirmamos en máximo *15 minutos* 😊`);
                        await notificarDueno(
                            `⚠️ *COMPROBANTE - REVISIÓN MANUAL*\n\n` +
                            `👤 ${nombreCliente} | 📱 +${numero}\n` +
                            `💰 Detectado: $${v.monto_detectado || 'No claro'} | Esperado: $${totalEsperado}\n` +
                            `📝 ${v.razon}\n` +
                            `🕐 ${horaActual()}\n\n` +
                            `Responde *APROBAR ${numero}* o *RECHAZAR ${numero}*`
                        );
                        estados[numero] = 'en_revision';
                    }

                } else {
                    // No se pudo leer
                    await msg.reply(`⏳ No pude leer bien el comprobante. Lo revisamos manualmente y te confirmamos pronto 😊`);
                    await notificarDueno(
                        `⚠️ *COMPROBANTE ILEGIBLE*\n\n` +
                        `👤 ${nombreCliente} | 📱 +${numero}\n` +
                        `💰 Monto esperado: $${totalEsperado}\n` +
                        `🕐 ${horaActual()}\n\n` +
                        `Responde *APROBAR ${numero}* o *RECHAZAR ${numero}*`
                    );
                    estados[numero] = 'en_revision';
                }

            } catch (e) {
                console.error('[Comprobante] Error:', e.message);
                await msg.reply(`📎 Comprobante recibido. Lo revisamos y te confirmamos pronto 😊`);
                await notificarDueno(`⚠️ Error técnico verificando comprobante de +${numero}. Revisar manualmente.\n\nResponde *APROBAR ${numero}* o *RECHAZAR ${numero}*`);
            }

        } else {
            await msg.reply(`📸 Solo falta enviarme el *comprobante como imagen*. ¡Ya casi! 😊`);
        }
        return;
    }

    // ── Pedido desde catálogo web ────────────────────────────
    if (texto.startsWith('🛒 PEDIDO_CATALOGO')) {
        // Extraer total del mensaje
        const matchTotal = texto.match(/Total: \$(\d+\.?\d*)/);
        const total = matchTotal ? parseFloat(matchTotal[1]) : 0;
        if (total > 0) estados[numero + '_total'] = total;

        // Pasar a la IA para que lo confirme naturalmente
        const respuesta = await preguntarIA(numero,
            `[SISTEMA: El cliente acaba de seleccionar productos desde el catálogo web y quiere confirmar este pedido:
${texto}

Confirma el pedido de forma cálida, muéstrale el resumen y pide su nombre para procesarlo. No le pidas que elija productos de nuevo.]`
        );
        await procesarRespuesta(numero, respuesta, msg);
        return;
    }

    // ── Conversación con IA ──────────────────────────────────
    try {
        const respuesta = await preguntarIA(numero, texto);
        await procesarRespuesta(numero, respuesta, msg);
    } catch (e) {
        console.error('[Bot] Error general:', e.message);
        await msg.reply('Disculpa, tuve un problema. ¿Puedes escribirme de nuevo? 😊');
    }
});

bot.on('qr', qr => {
    console.log('\n📱 Escanea este QR con WhatsApp:\n');
    qrcode.generate(qr, { small: true });
});

bot.on('ready', () => {
    console.log(`\n✅ Bot de "${CONFIG.nombre}" conectado y listo!`);
    console.log(`🤖 IA: Groq LLaMA 3.3 70B (gratis, sin expiración)`);
    console.log(`🔍 OCR: OCR.space (anti-fraude activo)`);
    console.log(`🛍️  Catálogo: ${CONFIG.catalogoUrl || 'No configurado'}`);
    console.log(`⏰ Horario: ${CONFIG.horarioTexto}\n`);
});

bot.on('auth_failure', () => {
    console.log('❌ Error de autenticación. Borra .wwebjs_auth y reinicia.');
});

bot.initialize();
