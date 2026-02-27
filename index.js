require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vendebot2024';

function cargarNegocios() {
  try { return JSON.parse(fs.readFileSync('./negocios.json', 'utf8')); } catch { return []; }
}

const conversaciones = new Map();

function getOrCreateConversacion(numero, negocio) {
  const key = `${numero}:${negocio.id}`;
  if (!conversaciones.has(key)) {
    conversaciones.set(key, {
      numero, negocio_id: negocio.id,
      historial: [], etapa: 'inicio', pedido: {},
      esperando: null, intentos_boucher: 0,
    });
  }
  return conversaciones.get(key);
}

const clienteNegocioMap = new Map();
try {
  const mapa = JSON.parse(fs.readFileSync('./cliente_negocio_map.json', 'utf8'));
  for (const [k, v] of Object.entries(mapa)) clienteNegocioMap.set(k, v);
} catch {}

function guardarMapaClientes() {
  try { fs.writeFileSync('./cliente_negocio_map.json', JSON.stringify(Object.fromEntries(clienteNegocioMap), null, 2)); } catch {}
}

async function enviarMensaje(numero, mensaje) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: mensaje } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📤 Enviado a ${numero}: ${mensaje.substring(0, 50)}...`);
  } catch (err) {
    console.error(`❌ Error enviando mensaje: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function enviarImagen(numero, imagenUrl, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'image', image: { link: imagenUrl, caption } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`🖼️ Imagen enviada a ${numero}`);
  } catch (err) {
    console.error(`❌ Error enviando imagen: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function enviarProductosConImagenes(numero, productos) {
  for (const producto of productos) {
    if (producto.imagen) {
      const caption = `${producto.emoji || '•'} *${producto.nombre}*\n💰 $${producto.precio.toFixed(2)}\n📝 ${producto.descripcion}`;
      await enviarImagen(numero, producto.imagen, caption);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function notificarDueno(conv, negocio) {
  const pedido = conv.pedido;
  const msg = `🔔 *NUEVO PEDIDO — ${negocio.nombre}*\n\n👤 Cliente: ${conv.numero}\n📦 ${pedido.descripcion || 'Ver conversación'}\n💰 Total: $${pedido.total || '0.00'}\n${pedido.es_domicilio ? `📍 Domicilio: ${pedido.direccion}\n🛵 Carrera: $${pedido.costo_delivery || '?'}` : '🏪 Retira en tienda'}\n✅ Boucher verificado`;
  await enviarMensaje(negocio.whatsapp_dueno, msg);
}

async function procesarConClaude(conv, negocio, mensajeUsuario) {
  const catalogoTexto = negocio.catalogo.map(p => `- ${p.emoji || '•'} *${p.nombre}*: $${p.precio.toFixed(2)} — ${p.descripcion}`).join('\n');

  const systemPrompt = `Eres el asistente virtual de *${negocio.nombre}*, una ${negocio.tipo}. Atiende clientes por WhatsApp de forma natural y amigable.

CATÁLOGO:
${catalogoTexto}

REGLAS:
1. Habla siempre en español. Usa emojis moderadamente.
2. Cuando el cliente quiera ver productos escribe al final: ENVIAR_IMAGENES: [id1,id2]
3. Cuando confirme el pedido, pregunta si quiere domicilio o retiro en tienda.
4. Cuando tengas el total, informa precio y datos de pago:
   ${negocio.banco} | Cuenta: ${negocio.numero_cuenta} | Titular: ${negocio.titular_cuenta}
5. Después del precio, pide el comprobante de pago.
6. NUNCA inventes productos o precios fuera del catálogo.

ESTADO: ${JSON.stringify(conv.pedido)} | ETAPA: ${conv.etapa}

Al final escribe:
ETAPA: [inicio|consultando|cotizando|delivery|pago|confirmado]
PEDIDO_JSON: {"descripcion":"","total":0,"subtotal":0,"es_domicilio":false}
ENVIAR_IMAGENES: []`;

  conv.historial.push({ role: 'user', content: mensajeUsuario });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: systemPrompt,
    messages: conv.historial,
  });

  const respuestaCompleta = response.content[0].text;
  const lineas = respuestaCompleta.split('\n');
  let mensajeCliente = [], nuevaEtapa = conv.etapa, nuevoPedidoJSON = null, imagenesIds = [];

  for (const linea of lineas) {
    if (linea.startsWith('ETAPA:')) nuevaEtapa = linea.replace('ETAPA:', '').trim();
    else if (linea.startsWith('PEDIDO_JSON:')) { try { nuevoPedidoJSON = JSON.parse(linea.replace('PEDIDO_JSON:', '').trim()); } catch {} }
    else if (linea.startsWith('ENVIAR_IMAGENES:')) { try { imagenesIds = JSON.parse(linea.replace('ENVIAR_IMAGENES:', '').trim()); } catch {} }
    else mensajeCliente.push(linea);
  }

  const mensajeFinal = mensajeCliente.join('\n').trim();
  conv.etapa = nuevaEtapa;
  if (nuevoPedidoJSON) conv.pedido = { ...conv.pedido, ...nuevoPedidoJSON };
  conv.historial.push({ role: 'assistant', content: mensajeFinal });
  if (conv.historial.length > 20) conv.historial = conv.historial.slice(-20);

  return { mensaje: mensajeFinal, imagenesIds };
}

// ─── VERIFICACIÓN WEBHOOK META ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── WEBHOOK MENSAJES META ────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    if (!value?.messages?.[0]) return;

    const mensaje = value.messages[0];
    const numero = mensaje.from;
    const tipo = mensaje.type;

    console.log(`📨 Mensaje de ${numero} (${tipo})`);

    const negocios = cargarNegocios();
    let negocioId = clienteNegocioMap.get(numero);
    let negocio = negocios.find(n => n.id === negocioId && n.activo);

    if (!negocio) {
      negocio = negocios[0];
      clienteNegocioMap.set(numero, negocio.id);
      guardarMapaClientes();
    }

    if (!negocio) {
      await enviarMensaje(numero, `¡Hola! 👋 No encontré tu negocio asignado. Contacta al administrador.`);
      return;
    }

    const conv = getOrCreateConversacion(numero, negocio);

    // Boucher (imagen)
    if (tipo === 'image' && conv.esperando === 'boucher') {
      await enviarMensaje(numero, '🔍 Revisando tu comprobante...');
      try {
        const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mensaje.image.id}`, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        const imageRes = await axios.get(mediaRes.data.url, {
          responseType: 'arraybuffer',
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        const imagenBase64 = Buffer.from(imageRes.data).toString('base64');
        const mediaType = mensaje.image.mime_type || 'image/jpeg';

        const resultado = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: imagenBase64 } },
              { type: 'text', text: `¿Es un comprobante bancario real y reciente (hoy ${new Date().toLocaleDateString('es-EC')}) por $${conv.pedido.total || 0}? Responde solo JSON: {"valido":true/false,"motivo":""}` }
            ]
          }]
        });

        let validacion = { valido: false, motivo: 'No se pudo leer' };
        try { validacion = JSON.parse(resultado.content[0].text.trim()); } catch {}

        if (validacion.valido) {
          conv.etapa = 'confirmado';
          conv.esperando = null;
          await enviarMensaje(numero, `✅ ¡Comprobante verificado! Tu pedido en *${negocio.nombre}* está confirmado. 🎉\n\n¡Gracias por tu compra! 💫`);
          await notificarDueno(conv, negocio);
        } else {
          conv.intentos_boucher++;
          if (conv.intentos_boucher >= 3) {
            await enviarMensaje(numero, `😔 No pudimos verificar tu pago. Contacta directamente a ${negocio.nombre}.`);
          } else {
            await enviarMensaje(numero, `😅 Comprobante inválido: ${validacion.motivo}\n\nPor favor envía un boucher reciente con el monto correcto.`);
          }
        }
      } catch (e) {
        await enviarMensaje(numero, '😅 No pude leer el comprobante. Intenta enviarlo de nuevo.');
      }
      return;
    }

    if (tipo !== 'text') return;
    const texto = mensaje.text.body;

    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      await enviarMensaje(numero, negocio.mensajes?.bienvenida || `¡Hola! 👋 Bienvenido/a a *${negocio.nombre}*. ¿En qué puedo ayudarte?`);
      conv.etapa = 'consultando';
      return;
    }

    const textoLower = texto.toLowerCase();
    if (conv.etapa === 'cotizando' && (textoLower.includes('domicilio') || textoLower.includes('delivery') || textoLower.includes('envío'))) {
      conv.pedido.es_domicilio = true;
      conv.esperando = 'ubicacion';
      await enviarMensaje(numero, `🏠 ¡Con gusto! Por favor envíame tu *dirección completa* para coordinar el envío.`);
      return;
    }

    if (conv.esperando === 'ubicacion') {
      conv.pedido.direccion = texto;
      conv.esperando = null;
      conv.etapa = 'pago';
      await enviarMensaje(numero, `✅ Dirección: ${texto}\n\n💰 *Total: $${conv.pedido.total || '0.00'}*\n\nRealiza el pago a:\n🏦 *${negocio.banco}*\n💳 Cuenta: ${negocio.numero_cuenta}\n👤 Titular: ${negocio.titular_cuenta}\n\nLuego envíame el comprobante 🧾`);
      conv.esperando = 'boucher';
      return;
    }

    if (conv.etapa === 'pago') conv.esperando = 'boucher';

    const { mensaje: respuesta, imagenesIds } = await procesarConClaude(conv, negocio, texto);
    await enviarMensaje(numero, respuesta);

    if (imagenesIds?.length > 0) {
      const productosAMostrar = negocio.catalogo.filter(p => imagenesIds.includes(p.id));
      if (productosAMostrar.length > 0) await enviarProductosConImagenes(numero, productosAMostrar);
    }

    if (conv.etapa === 'pago') conv.esperando = 'boucher';

  } catch (err) {
    console.error('❌ Error en webhook:', err.message);
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'VendeBot Meta activo ✅', conversaciones: conversaciones.size });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 VendeBot Meta iniciado en puerto ${PORT}`);
  console.log(`🌐 Webhook: http://localhost:${PORT}/webhook\n`);
});
