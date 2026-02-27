require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const NEGOCIO = {
  nombre: process.env.NOMBRE_NEGOCIO || 'Mi Negocio',
  tipo: process.env.TIPO_NEGOCIO || 'tienda',
  whatsapp_bot: process.env.TWILIO_WHATSAPP_NUMBER,
  whatsapp_dueno: process.env.WHATSAPP_DUENO,
  whatsapp_delivery: process.env.WHATSAPP_DELIVERY,
};

const conversaciones = new Map();
const pedidos = [];

let catalogo = [];
try {
  catalogo = JSON.parse(fs.readFileSync('./catalogo.json', 'utf8'));
} catch {
  catalogo = [
    { id: 1, nombre: 'Producto Principal', precio: 25.00, descripcion: 'Producto estrella', emoji: '🌟' },
  ];
}

const MENSAJES = {
  bienvenida: `¡Hola! 👋 Bienvenido/a a *${NEGOCIO.nombre}*. Soy tu asistente virtual. ¿Qué estás buscando hoy? 😊`,
  no_entendio: `Disculpa, no entendí bien 😅 ¿Puedes explicarme un poco más?`,
  boucher_invalido: `😅 El comprobante no es válido o está vencido. Por favor envía un boucher reciente del Banco Pichincha con el monto correcto.`,
  cotizando_delivery: `📍 Estoy coordinando el envío, en un momento te confirmo el costo. ¡Gracias por tu paciencia! ⏳`,
};

function formatCatalogo() {
  return catalogo.map(p => `- ${p.emoji || '•'} *${p.nombre}*: $${p.precio.toFixed(2)} — ${p.descripcion}`).join('\n');
}

function getOrCreateConversacion(numero) {
  if (!conversaciones.has(numero)) {
    conversaciones.set(numero, {
      numero,
      historial: [],
      etapa: 'inicio',
      pedido: {},
      esperando: null,
      intentos_boucher: 0,
      imagenes_enviadas: [],
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

async function enviarImagen(numero, imagenUrl, caption) {
  try {
    await twilioClient.messages.create({
      from: `whatsapp:${NEGOCIO.whatsapp_bot}`,
      to: `whatsapp:${numero}`,
      body: caption || '',
      mediaUrl: [imagenUrl],
    });
    console.log(`🖼️ Imagen enviada a ${numero}`);
  } catch (err) {
    console.error('❌ Error enviando imagen:', err.message);
  }
}

async function enviarProductosConImagenes(numero, productos) {
  for (const producto of productos) {
    if (producto.imagen) {
      const caption = `${producto.emoji} *${producto.nombre}*\n💰 Precio: $${producto.precio.toFixed(2)}\n📝 ${producto.descripcion}`;
      await enviarImagen(numero, producto.imagen, caption);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function notificarDueno(conv) {
  const pedido = conv.pedido;
  const msg = `
🔔 *NUEVO PEDIDO CONFIRMADO — ${NEGOCIO.nombre}*

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
1. ¿Es un comprobante del Banco Pichincha?
2. ¿La fecha es de hoy o de las últimas 24 horas? (fecha actual: ${new Date().toLocaleDateString('es-EC')})
3. ¿El monto es de $${montoPedido}?
4. ¿Parece un comprobante real?

Responde SOLO con este JSON:
{"valido": true/false, "motivo": "razón si es inválido", "monto_detectado": número, "fecha_detectada": "fecha"}`,
          },
        ],
      }],
    });
    return JSON.parse(response.content[0].text.trim());
  } catch (err) {
    console.error('Error validando boucher:', err.message);
    return { valido: false, motivo: 'No se pudo leer el comprobante' };
  }
}

async function procesarConClaude(conv, mensajeUsuario) {
  const systemPrompt = `
Eres el asistente virtual de *${NEGOCIO.nombre}*, una ${NEGOCIO.tipo}.
Tu trabajo es atender clientes por WhatsApp de forma natural y amigable.

CATÁLOGO DISPONIBLE:
${formatCatalogo()}

REGLAS IMPORTANTES:
1. Habla siempre en español, de forma cálida. Usa emojis con moderación.
2. Cuando el cliente pregunte por productos o quiera ver opciones, responde normalmente Y escribe al final: ENVIAR_IMAGENES: [id1,id2,id3] con los IDs de los productos relevantes.
3. Ofrece siempre complementos de forma natural.
4. Cuando el cliente confirme su pedido, pregunta si desea domicilio o retiro en tienda.
5. Si quiere domicilio, pide su ubicación.
6. Cuando tengas el total listo, informa el precio EXACTO y los datos de pago:
   Banco Pichincha | Cuenta: ${process.env.NUMERO_CUENTA} | Titular: ${process.env.TITULAR_CUENTA}
7. Después del precio, pide el boucher de pago.
8. NUNCA inventes productos o precios que no estén en el catálogo.

ESTADO ACTUAL:
${JSON.stringify(conv.pedido, null, 2)}
ETAPA: ${conv.etapa}

Al final de tu respuesta escribe en líneas separadas:
ETAPA: [inicio|consultando|cotizando|delivery|pago|confirmado]
PEDIDO_JSON: [JSON con: descripcion, total, subtotal, es_domicilio, fecha_entrega, hora_entrega]
ENVIAR_IMAGENES: [array de IDs de productos a mostrar, ej: [1,2] o [] si ninguno]
`.trim();

  conv.historial.push({ role: 'user', content: mensajeUsuario });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: systemPrompt,
    messages: conv.historial,
  });

  const respuestaCompleta = response.content[0].text;
  const lineas = respuestaCompleta.split('\n');
  let mensajeCliente = [];
  let nuevaEtapa = conv.etapa;
  let nuevoPedidoJSON = null;
  let imagenesIds = [];

  for (const linea of lineas) {
    if (linea.startsWith('ETAPA:')) {
      nuevaEtapa = linea.replace('ETAPA:', '').trim();
    } else if (linea.startsWith('PEDIDO_JSON:')) {
      try { nuevoPedidoJSON = JSON.parse(linea.replace('PEDIDO_JSON:', '').trim()); } catch {}
    } else if (linea.startsWith('ENVIAR_IMAGENES:')) {
      try { imagenesIds = JSON.parse(linea.replace('ENVIAR_IMAGENES:', '').trim()); } catch {}
    } else {
      mensajeCliente.push(linea);
    }
  }

  const mensajeFinal = mensajeCliente.join('\n').trim();
  conv.etapa = nuevaEtapa;
  if (nuevoPedidoJSON) conv.pedido = { ...conv.pedido, ...nuevoPedidoJSON };
  conv.historial.push({ role: 'assistant', content: mensajeFinal });

  if (conv.historial.length > 20) conv.historial = conv.historial.slice(-20);

  return { mensaje: mensajeFinal, imagenesIds };
}

// ─── WEBHOOK PRINCIPAL ───────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  const { From, Body, MediaUrl0, MediaContentType0, NumMedia, Latitude, Longitude } = req.body;
  const numero = From.replace('whatsapp:', '');
  const conv = getOrCreateConversacion(numero);

  console.log(`📨 Mensaje de ${numero}: ${Body || '[multimedia]'}`);

  try {
    // ── BOUCHER (imagen) ──
    if (NumMedia > 0 && MediaUrl0 && conv.esperando === 'boucher') {
      await enviarMensaje(numero, '🔍 Revisando tu comprobante...');
      const axios = require('axios');
      const imgResponse = await axios.get(MediaUrl0, {
        responseType: 'arraybuffer',
        auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN },
      });
      const imagenBase64 = Buffer.from(imgResponse.data).toString('base64');
      const resultado = await validarBoucher(imagenBase64, MediaContentType0 || 'image/jpeg', conv.pedido.total || 0);

      if (resultado.valido) {
        conv.etapa = 'confirmado';
        conv.esperando = null;
        await enviarMensaje(numero, `✅ ¡Comprobante verificado! Tu pedido está *confirmado*. 🎉\n\n¡Gracias por tu compra en ${NEGOCIO.nombre}! 💫`);
        await notificarDueno(conv);
      } else {
        conv.intentos_boucher++;
        if (conv.intentos_boucher >= 3) {
          await enviarMensaje(numero, `😔 No pudimos verificar tu pago. Por favor contacta directamente al negocio.`);
        } else {
          await enviarMensaje(numero, `${MENSAJES.boucher_invalido}\n\n_Motivo: ${resultado.motivo}_`);
        }
      }
      return;
    }

    // ── UBICACIÓN ──
    if (Latitude && Longitude && conv.esperando === 'ubicacion') {
      conv.pedido.ubicacion = { lat: Latitude, lng: Longitude };
      conv.esperando = 'delivery_respuesta';
      await twilioClient.messages.create({
        from: `whatsapp:${NEGOCIO.whatsapp_bot}`,
        to: `whatsapp:${NEGOCIO.whatsapp_delivery}`,
        body: `🛵 *Nueva solicitud de delivery*\nCliente: ${numero}\nUbicación: https://maps.google.com/?q=${Latitude},${Longitude}\n\n¿Cuánto cuesta la carrera? Responde solo con el monto (ej: 3.50)`,
      });
      await enviarMensaje(numero, MENSAJES.cotizando_delivery);
      return;
    }

    if (!Body || Body.trim() === '') return;

    // ── BIENVENIDA ──
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      await enviarMensaje(numero, MENSAJES.bienvenida);
      conv.etapa = 'consultando';
      return;
    }

    // ── DETECTAR DOMICILIO ──
    const mensajeLower = Body.toLowerCase();
    if (conv.etapa === 'cotizando' && (mensajeLower.includes('domicilio') || mensajeLower.includes('delivery') || mensajeLower.includes('envío') || mensajeLower.includes('llevar'))) {
      conv.pedido.es_domicilio = true;
      conv.esperando = 'ubicacion';
      await enviarMensaje(numero, `🏠 ¡Con gusto! Por favor *comparte tu ubicación* desde WhatsApp.\n\n_(Toca el clip 📎 → Ubicación → Tu ubicación actual)_`);
      return;
    }

    if (conv.etapa === 'pago' && conv.esperando !== 'boucher') conv.esperando = 'boucher';

    // ── PROCESAR CON CLAUDE ──
    const { mensaje, imagenesIds } = await procesarConClaude(conv, Body);
    await enviarMensaje(numero, mensaje);

    // ── ENVIAR IMÁGENES SI CLAUDE LO INDICA ──
    if (imagenesIds && imagenesIds.length > 0) {
      const productosAMostrar = catalogo.filter(p => imagenesIds.includes(p.id));
      if (productosAMostrar.length > 0) {
        await enviarProductosConImagenes(numero, productosAMostrar);
      }
    }

    if (conv.etapa === 'pago') conv.esperando = 'boucher';

  } catch (err) {
    console.error('❌ Error en webhook:', err);
    await enviarMensaje(numero, MENSAJES.no_entendio);
  }
});

// ─── WEBHOOK DELIVERY ────────────────────────────────────────────────────────
app.post('/webhook-delivery', async (req, res) => {
  res.sendStatus(200);
  const { Body } = req.body;
  const costo = parseFloat(Body?.match(/[\d.]+/)?.[0]);
  if (!costo) return;

  for (const [numero, conv] of conversaciones) {
    if (conv.esperando === 'delivery_respuesta') {
      conv.pedido.costo_delivery = costo;
      conv.pedido.total = (conv.pedido.subtotal || 0) + costo;
      conv.esperando = null;
      conv.etapa = 'pago';

      const msg = `✅ ¡Listo! Te confirmo los costos:\n\n📦 Pedido: $${(conv.pedido.subtotal || 0).toFixed(2)}\n🛵 Carrera: $${costo.toFixed(2)}\n💰 *Total: $${conv.pedido.total.toFixed(2)}*\n\nPara confirmar realiza el pago a:\n🏦 *Banco Pichincha*\n💳 Cuenta: ${process.env.NUMERO_CUENTA}\n👤 Titular: ${process.env.TITULAR_CUENTA}\n\nLuego envíame el comprobante 🧾`;

      await enviarMensaje(numero, msg);
      conv.esperando = 'boucher';
      break;
    }
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'VendeBot activo ✅',
    negocio: NEGOCIO.nombre,
    conversaciones_activas: conversaciones.size,
    pedidos_hoy: pedidos.length,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 VendeBot iniciado en puerto ${PORT}`);
  console.log(`📱 Negocio: ${NEGOCIO.nombre}`);
  console.log(`🌐 Webhook: http://localhost:${PORT}/webhook\n`);
});
