require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CLIENTES ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── CONFIGURACIÓN DEL NEGOCIO ───────────────────────────────────────────────
const NEGOCIO = {
  nombre: process.env.NOMBRE_NEGOCIO || 'Mi Negocio',
  tipo: process.env.TIPO_NEGOCIO || 'tienda',
  whatsapp_bot: process.env.TWILIO_WHATSAPP_NUMBER,
  whatsapp_dueno: process.env.WHATSAPP_DUENO,
  whatsapp_delivery: process.env.WHATSAPP_DELIVERY,
};

// ─── BASE DE DATOS EN MEMORIA (luego se reemplaza por DB real) ───────────────
const conversaciones = new Map(); // número → estado de conversación
const pedidos = [];

// ─── CATÁLOGO (se carga desde catalogo.json) ────────────────────────────────
let catalogo = [];
try {
  catalogo = JSON.parse(fs.readFileSync('./catalogo.json', 'utf8'));
} catch {
  catalogo = [
    { id: 1, nombre: 'Producto Principal', precio: 25.00, descripcion: 'Producto estrella del negocio', emoji: '🌟' },
    { id: 2, nombre: 'Complemento 1', precio: 12.00, descripcion: 'Complemento especial', emoji: '🎁' },
  ];
}

// ─── MENSAJES CONFIGURABLES ──────────────────────────────────────────────────
const MENSAJES = {
  bienvenida: `¡Hola! 👋 Bienvenido/a a *${NEGOCIO.nombre}*. Soy tu asistente virtual y estoy aquí para ayudarte. ¿Qué estás buscando hoy? 😊`,
  despedida: `¡Gracias por tu compra! 🎉 Fue un placer atenderte. ¡Hasta pronto! 💫`,
  no_entendio: `Disculpa, no entendí bien 😅 ¿Puedes explicarme un poco más? Estoy aquí para ayudarte.`,
  pedir_boucher: `¡Perfecto! 🎉 Para confirmar tu pedido, por favor envíame el comprobante de pago (boucher) del Banco Pichincha.`,
  boucher_invalido: `😅 El comprobante que enviaste no es válido o está vencido. Por favor envía un boucher reciente del Banco Pichincha con el monto correcto.`,
  cotizando_delivery: `📍 Estoy coordinando el envío, en un momento te confirmo el costo de la carrera. ¡Gracias por tu paciencia! ⏳`,
};

// ─── UTILIDADES ─────────────────────────────────────────────────────────────
function formatCatalogo() {
  return catalogo.map(p => `- ${p.emoji || '•'} *${p.nombre}*: $${p.precio.toFixed(2)} — ${p.descripcion}`).join('\n');
}

function getOrCreateConversacion(numero) {
  if (!conversaciones.has(numero)) {
    conversaciones.set(numero, {
      numero,
      historial: [],       // mensajes para Claude
      etapa: 'inicio',     // inicio → consultando → cotizando → delivery → pago → confirmado
      pedido: {},          // lo que va pidiendo el cliente
      esperando: null,     // 'boucher' | 'ubicacion' | 'delivery_respuesta'
      intentos_boucher: 0,
    });
  }
  return conversaciones.get(numero);
}

async function enviarMensaje(numero, mensaje) {
  try {
    await twilioClient.messages.create({
      from: `whatsapp:${NEGOCIO.whatsapp_bot}`,
      to: `whatsapp:${numero}`,
      body: mensaje,
    });
    console.log(`📤 Enviado a ${numero}: ${mensaje.substring(0, 60)}...`);
  } catch (err) {
    console.error('❌ Error enviando mensaje:', err.message);
  }
}

async function notificarDueno(conv) {
  const pedido = conv.pedido;
  const msg = `
🔔 *NUEVO PEDIDO CONFIRMADO*

👤 Cliente: ${pedido.nombre_cliente || conv.numero}
📱 WhatsApp: ${conv.numero}
📦 Pedido: ${pedido.descripcion || 'Ver conversación'}
💰 Total: $${pedido.total || '0.00'}
📅 Entrega: ${pedido.fecha_entrega || 'A coordinar'}
🕐 Hora: ${pedido.hora_entrega || 'A coordinar'}
${pedido.es_domicilio ? `📍 Domicilio: Sí\n🛵 Carrera: $${pedido.costo_delivery || '?'}` : '🏪 Retira en tienda'}

✅ Boucher verificado
  `.trim();

  await enviarMensaje(NEGOCIO.whatsapp_dueno, msg);
}

// ─── CLAUDE — CEREBRO DEL BOT ────────────────────────────────────────────────
async function procesarConClaude(conv, mensajeUsuario) {
  const systemPrompt = `
Eres el asistente virtual de *${NEGOCIO.nombre}*, una ${NEGOCIO.tipo}.
Tu trabajo es atender clientes por WhatsApp de forma natural, amigable y fluida, como si fueras un humano.

CATÁLOGO DISPONIBLE:
${formatCatalogo()}

REGLAS IMPORTANTES:
1. Habla siempre en español, de forma cálida y cercana. Usa emojis con moderación.
2. Cuando el cliente describa lo que quiere, ayúdale a elegir del catálogo.
3. Ofrece siempre complementos (otros productos del catálogo) de forma natural.
4. Cuando el cliente confirme su pedido, pregunta si desea domicilio o retiro en tienda.
5. Si quiere domicilio, pide su ubicación (dile que la comparta desde WhatsApp).
6. Cuando tengas el total del pedido listo, informa el precio EXACTO y los datos de pago:
   Banco Pichincha | Cuenta: ${process.env.NUMERO_CUENTA} | Titular: ${process.env.TITULAR_CUENTA}
7. Después del precio, pide el boucher de pago.
8. Si el cliente pregunta algo fuera del tema, responde brevemente y retoma el pedido.
9. Sé proactivo: si el cliente no sabe qué quiere, sugiere opciones del catálogo.
10. NUNCA inventes productos o precios que no estén en el catálogo.

ESTADO ACTUAL DEL PEDIDO:
${JSON.stringify(conv.pedido, null, 2)}

ETAPA: ${conv.etapa}

Responde SOLO con el mensaje para el cliente. Sin explicaciones adicionales.
Al final de tu respuesta, en una línea separada escribe:
ETAPA: [inicio|consultando|cotizando|delivery|pago|confirmado]
PEDIDO_JSON: [el JSON actualizado del pedido con campos: descripcion, total, es_domicilio, fecha_entrega, hora_entrega]
`.trim();

  conv.historial.push({ role: 'user', content: mensajeUsuario });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: systemPrompt,
    messages: conv.historial,
  });

  const respuestaCompleta = response.content[0].text;

  // Extraer metadatos que Claude devuelve
  const lineas = respuestaCompleta.split('\n');
  let mensajeCliente = [];
  let nuevaEtapa = conv.etapa;
  let nuevoPedidoJSON = null;

  for (const linea of lineas) {
    if (linea.startsWith('ETAPA:')) {
      nuevaEtapa = linea.replace('ETAPA:', '').trim();
    } else if (linea.startsWith('PEDIDO_JSON:')) {
      try {
        nuevoPedidoJSON = JSON.parse(linea.replace('PEDIDO_JSON:', '').trim());
      } catch {}
    } else {
      mensajeCliente.push(linea);
    }
  }

  const mensajeFinal = mensajeCliente.join('\n').trim();

  // Actualizar estado
  conv.etapa = nuevaEtapa;
  if (nuevoPedidoJSON) conv.pedido = { ...conv.pedido, ...nuevoPedidoJSON };
  conv.historial.push({ role: 'assistant', content: mensajeFinal });

  // Limitar historial a últimos 20 mensajes
  if (conv.historial.length > 20) {
    conv.historial = conv.historial.slice(-20);
  }

  return mensajeFinal;
}

// ─── VALIDAR BOUCHER ─────────────────────────────────────────────────────────
async function validarBoucher(imagenBase64, mediaType, montoPedido) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: imagenBase64 },
          },
          {
            type: 'text',
            text: `Analiza este comprobante de pago del Banco Pichincha.
Verifica:
1. ¿Es un comprobante del Banco Pichincha? (busca logo, nombre del banco)
2. ¿La fecha es de hoy o de las últimas 24 horas? (fecha actual: ${new Date().toLocaleDateString('es-EC')})
3. ¿El monto es de $${montoPedido}? (puede tener pequeñas diferencias de centavos)
4. ¿Parece un comprobante real (no editado, no screenshot de otro boucher)?

Responde SOLO con este JSON:
{"valido": true/false, "motivo": "razón si es inválido", "monto_detectado": número, "fecha_detectada": "fecha"}`,
          },
        ],
      }],
    });

    const resultado = JSON.parse(response.content[0].text.trim());
    return resultado;
  } catch (err) {
    console.error('Error validando boucher:', err.message);
    return { valido: false, motivo: 'No se pudo leer el comprobante' };
  }
}

// ─── WEBHOOK PRINCIPAL DE WHATSAPP ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Twilio

  const { From, Body, MediaUrl0, MediaContentType0, NumMedia } = req.body;
  const numero = From.replace('whatsapp:', '');
  const conv = getOrCreateConversacion(numero);

  console.log(`📨 Mensaje de ${numero}: ${Body || '[multimedia]'}`);

  try {
    // ── CASO: cliente envía imagen (posible boucher) ──
    if (NumMedia > 0 && MediaUrl0) {
      if (conv.esperando === 'boucher') {
        await enviarMensaje(numero, '🔍 Revisando tu comprobante...');

        // Descargar imagen de Twilio
        const axios = require('axios');
        const imgResponse = await axios.get(MediaUrl0, {
          responseType: 'arraybuffer',
          auth: {
            username: process.env.TWILIO_ACCOUNT_SID,
            password: process.env.TWILIO_AUTH_TOKEN,
          },
        });

        const imagenBase64 = Buffer.from(imgResponse.data).toString('base64');
        const mediaType = MediaContentType0 || 'image/jpeg';
        const montoPedido = conv.pedido.total || 0;

        const resultado = await validarBoucher(imagenBase64, mediaType, montoPedido);

        if (resultado.valido) {
          conv.etapa = 'confirmado';
          conv.esperando = null;
          conv.pedido.boucher_validado = true;

          await enviarMensaje(numero, `✅ ¡Comprobante verificado! Tu pedido está *confirmado*. 🎉\n\nEn breve recibirás tu pedido. ¡Gracias por tu compra! 💫`);
          await notificarDueno(conv);
        } else {
          conv.intentos_boucher++;
          if (conv.intentos_boucher >= 3) {
            await enviarMensaje(numero, `😔 No hemos podido verificar tu pago después de varios intentos. Por favor contacta directamente al negocio.`);
            await enviarMensaje(NEGOCIO.whatsapp_dueno, `⚠️ Cliente ${numero} tiene problemas con el boucher. Requiere atención manual.`);
          } else {
            await enviarMensaje(numero, `${MENSAJES.boucher_invalido}\n\n_Motivo: ${resultado.motivo}_`);
          }
        }
        return;
      }

      // Si manda imagen pero no era boucher
      await enviarMensaje(numero, '📷 Recibí tu imagen! Si es un comprobante de pago, recuerda que debo solicitártelo en el momento correcto 😊');
      return;
    }

    // ── CASO: cliente envía ubicación ──
    const { Latitude, Longitude } = req.body;
    if (Latitude && Longitude && conv.esperando === 'ubicacion') {
      conv.pedido.ubicacion = { lat: Latitude, lng: Longitude };
      conv.esperando = 'delivery_respuesta';

      // Enviar ubicación al repartidor
      await twilioClient.messages.create({
        from: `whatsapp:${NEGOCIO.whatsapp_bot}`,
        to: `whatsapp:${NEGOCIO.whatsapp_delivery}`,
        body: `🛵 *Nueva solicitud de delivery*\nCliente: ${numero}\nUbicación: https://maps.google.com/?q=${Latitude},${Longitude}\n\n¿Cuánto cuesta la carrera? Responde solo con el monto (ej: 3.50)`,
      });

      await enviarMensaje(numero, MENSAJES.cotizando_delivery);
      return;
    }

    // ── CASO: mensaje de texto normal ──
    if (!Body || Body.trim() === '') return;

    // Si no hay conversación activa, empezar con bienvenida
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      await enviarMensaje(numero, MENSAJES.bienvenida);
      conv.etapa = 'consultando';
      // Esperar respuesta del cliente antes de procesar
      return;
    }

    // Detectar si el bot debe pedir ubicación
    const mensajeLower = Body.toLowerCase();
    if (conv.etapa === 'cotizando' && (mensajeLower.includes('domicilio') || mensajeLower.includes('delivery') || mensajeLower.includes('envío') || mensajeLower.includes('llevar'))) {
      conv.pedido.es_domicilio = true;
      conv.esperando = 'ubicacion';
      await enviarMensaje(numero, `🏠 ¡Con gusto! Para cotizar el envío, por favor *comparte tu ubicación* desde WhatsApp.\n\n_(Toca el clip 📎 → Ubicación → Tu ubicación actual)_`);
      return;
    }

    // Detectar si debe pedir boucher
    if (conv.etapa === 'pago' && conv.esperando !== 'boucher') {
      conv.esperando = 'boucher';
    }

    // Procesar con Claude
    const respuesta = await procesarConClaude(conv, Body);
    await enviarMensaje(numero, respuesta);

    // Si Claude dice que es hora del pago, activar espera de boucher
    if (conv.etapa === 'pago') {
      conv.esperando = 'boucher';
    }

  } catch (err) {
    console.error('❌ Error en webhook:', err);
    await enviarMensaje(numero, MENSAJES.no_entendio);
  }
});

// ─── WEBHOOK PARA RESPUESTA DEL REPARTIDOR ──────────────────────────────────
app.post('/webhook-delivery', async (req, res) => {
  res.sendStatus(200);
  const { From, Body } = req.body;

  // Buscar qué cliente está esperando delivery
  const costo = parseFloat(Body?.match(/[\d.]+/)?.[0]);
  if (!costo) return;

  // Encontrar la conversación que espera respuesta de delivery
  for (const [numero, conv] of conversaciones) {
    if (conv.esperando === 'delivery_respuesta') {
      conv.pedido.costo_delivery = costo;
      conv.pedido.total = (conv.pedido.subtotal || 0) + costo;
      conv.esperando = null;
      conv.etapa = 'pago';

      const msg = `
✅ ¡Listo! Te confirmo los costos:

📦 Pedido: $${(conv.pedido.subtotal || 0).toFixed(2)}
🛵 Carrera: $${costo.toFixed(2)}
💰 *Total a pagar: $${conv.pedido.total.toFixed(2)}*

Para confirmar tu pedido, realiza el pago a:
🏦 *Banco Pichincha*
💳 Cuenta: ${process.env.NUMERO_CUENTA}
👤 Titular: ${process.env.TITULAR_CUENTA}

Luego envíame el comprobante de pago 🧾
      `.trim();

      await enviarMensaje(numero, msg);
      conv.esperando = 'boucher';
      break;
    }
  }
});

// ─── ENDPOINT DE SALUD ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'VendeBot activo ✅',
    negocio: NEGOCIO.nombre,
    conversaciones_activas: conversaciones.size,
    pedidos_hoy: pedidos.length,
  });
});

// ─── INICIAR SERVIDOR ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 VendeBot iniciado en puerto ${PORT}`);
  console.log(`📱 Negocio: ${NEGOCIO.nombre}`);
  console.log(`🌐 Webhook: http://localhost:${PORT}/webhook\n`);
});
