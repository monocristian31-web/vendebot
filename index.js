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

// ─── HORARIO ──────────────────────────────────────────────────────────────────
const HORARIO = {
  dias: [1, 2, 3, 4, 5, 6], // 0=Dom, 1=Lun ... 6=Sab
  horaInicio: 8,
  horaFin: 18,
  zona: 'America/Guayaquil',
};

function estaEnHorario() {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: HORARIO.zona }));
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  return HORARIO.dias.includes(dia) && hora >= HORARIO.horaInicio && hora < HORARIO.horaFin;
}

function mensajeFueraHorario(negocio) {
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const diasAtencion = HORARIO.dias.map(d => dias[d]).join(', ');
  return `😴 Hola, en este momento *${negocio.nombre}* está fuera de horario.\n\n⏰ *Horario de atención:*\n📅 ${diasAtencion}\n🕐 ${HORARIO.horaInicio}:00 am - ${HORARIO.horaFin}:00 pm\n\nTu mensaje quedó guardado y te responderemos apenas abramos. ¡Gracias por escribirnos! 💙`;
}

// ─── PERSISTENCIA ─────────────────────────────────────────────────────────────
function cargarNegocios() {
  try { return JSON.parse(fs.readFileSync('./negocios.json', 'utf8')); } catch { return []; }
}

function cargarClientes() {
  try { return JSON.parse(fs.readFileSync('./clientes.json', 'utf8')); } catch { return {}; }
}

function guardarClientes(clientes) {
  try { fs.writeFileSync('./clientes.json', JSON.stringify(clientes, null, 2)); } catch {}
}

function cargarPromociones() {
  try { return JSON.parse(fs.readFileSync('./promociones.json', 'utf8')); } catch { return []; }
}

function obtenerCliente(numero) {
  const clientes = cargarClientes();
  if (!clientes[numero]) {
    clientes[numero] = {
      numero,
      nombre: '',
      primera_visita: new Date().toISOString(),
      ultima_visita: new Date().toISOString(),
      total_pedidos: 0,
      total_gastado: 0,
      historial_pedidos: [],
      es_frecuente: false,
      notas: '',
    };
    guardarClientes(clientes);
  }
  return clientes[numero];
}

function actualizarCliente(numero, datos) {
  const clientes = cargarClientes();
  clientes[numero] = { ...clientes[numero], ...datos, ultima_visita: new Date().toISOString() };
  if (clientes[numero].total_pedidos >= 3) clientes[numero].es_frecuente = true;
  guardarClientes(clientes);
}

function registrarPedidoCliente(numero, pedido, negocioNombre) {
  const clientes = cargarClientes();
  const cliente = clientes[numero] || obtenerCliente(numero);
  cliente.total_pedidos = (cliente.total_pedidos || 0) + 1;
  cliente.total_gastado = (cliente.total_gastado || 0) + (pedido.total || 0);
  cliente.ultima_visita = new Date().toISOString();
  if (!cliente.historial_pedidos) cliente.historial_pedidos = [];
  cliente.historial_pedidos.push({
    fecha: new Date().toISOString(),
    negocio: negocioNombre,
    items: pedido.items,
    total: pedido.total,
    descripcion: pedido.items?.map(i => `${i.nombre} x${i.cantidad}`).join(', '),
  });
  if (cliente.historial_pedidos.length > 20) cliente.historial_pedidos = cliente.historial_pedidos.slice(-20);
  if (cliente.total_pedidos >= 3) cliente.es_frecuente = true;
  clientes[numero] = cliente;
  guardarClientes(clientes);
}

// ─── CONVERSACIONES ───────────────────────────────────────────────────────────
const conversaciones = new Map();
const clienteNegocioMap = new Map();

try {
  const mapa = JSON.parse(fs.readFileSync('./cliente_negocio_map.json', 'utf8'));
  for (const [k, v] of Object.entries(mapa)) clienteNegocioMap.set(k, v);
} catch {}

function guardarMapaClientes() {
  try { fs.writeFileSync('./cliente_negocio_map.json', JSON.stringify(Object.fromEntries(clienteNegocioMap), null, 2)); } catch {}
}

function getOrCreateConversacion(numero, negocio) {
  const key = `${numero}:${negocio.id}`;
  if (!conversaciones.has(key)) {
    conversaciones.set(key, {
      numero, negocio_id: negocio.id,
      historial: [], etapa: 'inicio',
      pedido: { items: [], subtotal: 0, total: 0, es_domicilio: false, direccion: '', nombre_cliente: '', notas: '', fecha_entrega: '', hora_entrega: '' },
      esperando: null, intentos_boucher: 0, ultimo_mensaje: Date.now(),
    });
  }
  const conv = conversaciones.get(key);
  conv.ultimo_mensaje = Date.now();
  return conv;
}

// Limpiar conversaciones inactivas (2 horas)
setInterval(() => {
  const ahora = Date.now();
  for (const [key, conv] of conversaciones) {
    if (ahora - conv.ultimo_mensaje > 2 * 60 * 60 * 1000) conversaciones.delete(key);
  }
}, 30 * 60 * 1000);

// Seguimiento post-venta (24 horas después del pedido)
setInterval(async () => {
  const clientes = cargarClientes();
  const ahora = Date.now();
  for (const [numero, cliente] of Object.entries(clientes)) {
    if (!cliente.historial_pedidos?.length) continue;
    const ultimoPedido = cliente.historial_pedidos[cliente.historial_pedidos.length - 1];
    if (!ultimoPedido.seguimiento_enviado) {
      const fechaPedido = new Date(ultimoPedido.fecha).getTime();
      if (ahora - fechaPedido > 23 * 60 * 60 * 1000 && estaEnHorario()) {
        await enviarMensaje(numero, `¡Hola ${cliente.nombre || ''}! 😊 Esperamos que hayas disfrutado tu pedido de *${ultimoPedido.negocio}*.\n\n⭐ ¿Cómo fue tu experiencia? Tu opinión nos ayuda a mejorar.\n\n¡Gracias por confiar en nosotros! 💙`);
        ultimoPedido.seguimiento_enviado = true;
        clientes[numero] = cliente;
        guardarClientes(clientes);
      }
    }
  }
}, 60 * 60 * 1000);

// ─── ENVÍO MENSAJES ───────────────────────────────────────────────────────────
async function enviarMensaje(numero, mensaje) {
  if (!mensaje?.trim()) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'text', text: { body: mensaje } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`📤 [${numero}] ${mensaje.substring(0, 60)}`);
  } catch (err) {
    console.error(`❌ Error: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function enviarImagen(numero, url, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'image', image: { link: url, caption: caption || '' } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error(`❌ Error imagen: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function enviarProducto(numero, producto) {
  const caption = `${producto.emoji || '•'} *${producto.nombre}*\n💰 $${producto.precio.toFixed(2)}\n📝 ${producto.descripcion}`;
  if (producto.imagen) await enviarImagen(numero, producto.imagen, caption);
  else await enviarMensaje(numero, caption);
  await new Promise(r => setTimeout(r, 800));
}

async function enviarResumenPedido(numero, conv) {
  const p = conv.pedido;
  if (!p.items?.length) return;
  let resumen = `🛒 *Tu pedido:*\n\n`;
  for (const item of p.items) resumen += `${item.emoji || '•'} ${item.nombre} x${item.cantidad} — $${(item.precio * item.cantidad).toFixed(2)}\n`;
  resumen += `\n💰 *Subtotal: $${p.subtotal.toFixed(2)}*`;
  if (p.costo_delivery) resumen += `\n🛵 Delivery: $${p.costo_delivery.toFixed(2)}\n💳 *Total: $${p.total.toFixed(2)}*`;
  if (p.fecha_entrega) resumen += `\n📅 Entrega: ${p.fecha_entrega} a las ${p.hora_entrega || 'Por coordinar'}`;
  await enviarMensaje(numero, resumen);
}

function mensajePago(conv, negocio) {
  return `💳 *Datos para el pago:*\n\n🏦 *${negocio.banco}*\n💳 Cuenta: ${negocio.numero_cuenta}\n👤 Titular: ${negocio.titular_cuenta}\n💰 Monto exacto: *$${conv.pedido.total?.toFixed(2) || conv.pedido.subtotal?.toFixed(2) || '0.00'}*\n\nEnvíame el *comprobante* (foto) para confirmar tu pedido. 🧾`;
}

async function notificarDueno(conv, negocio) {
  const p = conv.pedido;
  const items = p.items?.map(i => `  • ${i.nombre} x${i.cantidad} = $${(i.precio * i.cantidad).toFixed(2)}`).join('\n') || 'Ver chat';
  const msg = `🔔 *NUEVO PEDIDO — ${negocio.nombre}*\n\n👤 ${p.nombre_cliente || conv.numero}\n📱 ${conv.numero}\n\n📦 Detalle:\n${items}\n\n💳 *TOTAL: $${p.total?.toFixed(2) || '0.00'}*\n${p.es_domicilio ? `📍 ${p.direccion}` : '🏪 Retira en tienda'}${p.fecha_entrega ? `\n📅 Entrega: ${p.fecha_entrega} ${p.hora_entrega || ''}` : ''}${p.notas ? `\n📝 ${p.notas}` : ''}\n\n✅ Pago verificado`;
  await enviarMensaje(negocio.whatsapp_dueno, msg);
}

// ─── VALIDAR BOUCHER ──────────────────────────────────────────────────────────
async function validarBoucher(b64, mediaType, monto) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: `¿Es comprobante bancario real y reciente (${new Date().toLocaleDateString('es-EC')}) por $${monto}? Solo JSON: {"valido":true/false,"motivo":""}` }
      ]}]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g, ''));
  } catch { return { valido: false, motivo: 'No se pudo analizar' }; }
}

// ─── CLAUDE IA ────────────────────────────────────────────────────────────────
async function procesarConClaude(conv, negocio, mensajeUsuario, cliente) {
  const catalogoTexto = negocio.catalogo.map(p =>
    `  ID:${p.id} | ${p.emoji || '•'} ${p.nombre} | $${p.precio.toFixed(2)} | ${p.descripcion}`
  ).join('\n');

  const promociones = cargarPromociones().filter(p => p.activa);
  const promocionesTexto = promociones.length > 0
    ? '\nPROMOCIONES ACTIVAS:\n' + promociones.map(p => `  🏷️ ${p.nombre}: ${p.descripcion} — ${p.descuento}`).join('\n')
    : '';

  const historialCliente = cliente?.historial_pedidos?.slice(-3).map(p =>
    `  • ${new Date(p.fecha).toLocaleDateString('es-EC')}: ${p.descripcion} ($${p.total})`
  ).join('\n') || 'Sin pedidos previos';

  const pedidoActual = conv.pedido.items?.length > 0
    ? conv.pedido.items.map(i => `${i.nombre} x${i.cantidad}`).join(', ')
    : 'vacío';

  const esClienteFrecuente = cliente?.es_frecuente || cliente?.total_pedidos >= 3;

  const system = `Eres el asistente virtual de *${negocio.nombre}*, una ${negocio.tipo} en Ecuador. Atiende clientes de forma cálida, natural y profesional.

CATÁLOGO:
${catalogoTexto}
${promocionesTexto}

CLIENTE:
- Nombre: ${cliente?.nombre || 'Desconocido'}
- Pedidos anteriores: ${cliente?.total_pedidos || 0}
- Cliente frecuente: ${esClienteFrecuente ? 'SÍ ⭐' : 'No'}
- Últimos pedidos:\n${historialCliente}

ESTADO ACTUAL:
- Etapa: ${conv.etapa}
- Pedido: ${pedidoActual}
- Subtotal: $${conv.pedido.subtotal?.toFixed(2) || '0.00'}
- Domicilio: ${conv.pedido.es_domicilio ? 'Sí' : 'No definido'}
- Fecha entrega: ${conv.pedido.fecha_entrega || 'No definida'}

REGLAS:
1. Habla SIEMPRE en español ecuatoriano, tono ${negocio.mensajes?.tono || 'amigable'} y cálido.
2. Si el cliente es frecuente, salúdalo de forma especial y menciona que lo recuerdas.
3. Si el cliente menciona un producto específico → ENVIAR_IMAGENES: [ese ID]
4. Si quiere ver TODO → ENVIAR_IMAGENES: [todos los IDs]
5. Cuando confirme pedido, pregunta nombre, fecha y hora de entrega, y si quiere domicilio o retiro.
6. Si quiere domicilio, pide dirección completa.
7. Si hay promociones activas, mencionarlas cuando sea relevante.
8. Cuando tengas total, da datos de pago: ${negocio.banco} | ${negocio.numero_cuenta} | ${negocio.titular_cuenta}
9. Pide comprobante después de dar datos de pago.
10. Si el cliente quiere cambiar pedido, ayúdale amablemente.
11. Si pide algo fuera del catálogo, dilo amablemente y sugiere alternativas.
12. Si pide descuento, menciona las promociones activas pero los precios base son fijos.
13. Horario: Lunes a Sábado 8am-6pm. Si pregunta por horario, infórmale.
14. Mantén el hilo de la conversación siempre.
15. Si el cliente menciona una mala experiencia anterior, discúlpate y ofrece ayuda.

Al FINAL escribe en líneas separadas:
ETAPA: [inicio|consultando|cotizando|confirmando|delivery|pago|confirmado]
PEDIDO_JSON: {"items":[{"id":1,"nombre":"","precio":0,"cantidad":1,"emoji":""}],"subtotal":0,"total":0,"es_domicilio":false,"nombre_cliente":"","direccion":"","fecha_entrega":"","hora_entrega":"","notas":""}
ENVIAR_IMAGENES: []
NOMBRE_CLIENTE: [nombre si lo mencionó, si no vacío]`;

  conv.historial.push({ role: 'user', content: mensajeUsuario });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1000,
    system, messages: conv.historial,
  });

  const full = response.content[0].text;
  const lineas = full.split('\n');
  let msg = [], etapa = conv.etapa, pedidoJSON = null, imgs = [], nombreCliente = '';

  for (const l of lineas) {
    if (l.startsWith('ETAPA:')) etapa = l.replace('ETAPA:', '').trim();
    else if (l.startsWith('PEDIDO_JSON:')) { try { pedidoJSON = JSON.parse(l.replace('PEDIDO_JSON:', '').trim()); } catch {} }
    else if (l.startsWith('ENVIAR_IMAGENES:')) { try { imgs = JSON.parse(l.replace('ENVIAR_IMAGENES:', '').trim()); } catch {} }
    else if (l.startsWith('NOMBRE_CLIENTE:')) nombreCliente = l.replace('NOMBRE_CLIENTE:', '').trim();
    else msg.push(l);
  }

  const mensajeFinal = msg.join('\n').trim();
  conv.etapa = etapa;

  if (pedidoJSON) {
    conv.pedido = { ...conv.pedido, ...pedidoJSON };
    if (pedidoJSON.items?.length > 0) {
      conv.pedido.subtotal = pedidoJSON.items.reduce((a, i) => a + (i.precio * i.cantidad), 0);
      conv.pedido.total = conv.pedido.subtotal + (conv.pedido.costo_delivery || 0);
    }
  }

  if (nombreCliente && nombreCliente !== 'vacío') {
    conv.pedido.nombre_cliente = nombreCliente;
    actualizarCliente(conv.numero, { nombre: nombreCliente });
  }

  conv.historial.push({ role: 'assistant', content: mensajeFinal });
  if (conv.historial.length > 30) conv.historial = conv.historial.slice(-30);

  return { mensaje: mensajeFinal, imagenesIds: imgs };
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado');
    res.status(200).send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.[0]) return;

    const mensaje = value.messages[0];
    const numero = mensaje.from;
    const tipo = mensaje.type;
    console.log(`📨 [${numero}] ${tipo}`);

    const negocios = cargarNegocios();
    let negocioId = clienteNegocioMap.get(numero);
    let negocio = negocios.find(n => n.id === negocioId && n.activo);
    if (!negocio) {
      negocio = negocios.find(n => n.activo);
      if (negocio) { clienteNegocioMap.set(numero, negocio.id); guardarMapaClientes(); }
    }
    if (!negocio) { await enviarMensaje(numero, '¡Hola! 👋 No hay negocios disponibles ahora.'); return; }

    // Verificar horario
    if (!estaEnHorario()) {
      await enviarMensaje(numero, mensajeFueraHorario(negocio));
      return;
    }

    const conv = getOrCreateConversacion(numero, negocio);
    const cliente = obtenerCliente(numero);

    // IMAGEN
    if (tipo === 'image') {
      if (conv.esperando === 'boucher') {
        await enviarMensaje(numero, '🔍 Analizando tu comprobante...');
        try {
          const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mensaje.image.id}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
          const imgRes = await axios.get(mediaRes.data.url, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
          const b64 = Buffer.from(imgRes.data).toString('base64');
          const resultado = await validarBoucher(b64, mensaje.image.mime_type || 'image/jpeg', conv.pedido.total || 0);
          if (resultado.valido) {
            conv.etapa = 'confirmado'; conv.esperando = null;
            registrarPedidoCliente(numero, conv.pedido, negocio.nombre);
            const esFrec = cliente.total_pedidos >= 2;
            await enviarMensaje(numero, `✅ *¡Pago verificado!*\n\nTu pedido en *${negocio.nombre}* está *confirmado* 🎉${esFrec ? '\n\n⭐ ¡Gracias por tu preferencia, cliente especial!' : ''}\n\n¡Gracias por tu compra! 💙`);
            await notificarDueno(conv, negocio);
          } else {
            conv.intentos_boucher++;
            if (conv.intentos_boucher >= 3) {
              await enviarMensaje(numero, `😔 No pudimos verificar tu pago tras varios intentos. Contacta a *${negocio.nombre}* directamente.`);
            } else {
              await enviarMensaje(numero, `😅 No pude verificar el comprobante.\n*Motivo:* ${resultado.motivo}\n\nEnvía el comprobante del *${negocio.banco}* por *$${conv.pedido.total?.toFixed(2)}* (intento ${conv.intentos_boucher}/3)`);
            }
          }
        } catch (e) { await enviarMensaje(numero, '😅 No pude procesar la imagen. Intenta de nuevo.'); }
      } else {
        await enviarMensaje(numero, '¡Gracias por la imagen! 😊 ¿En qué puedo ayudarte?');
      }
      return;
    }

    if (tipo === 'audio') { await enviarMensaje(numero, '😊 Solo puedo atenderte por texto. ¿Qué necesitas?'); return; }
    if (tipo === 'document') {
      if (conv.esperando === 'boucher') await enviarMensaje(numero, '📄 Necesito el comprobante como *imagen* (foto o captura de pantalla).');
      else await enviarMensaje(numero, '¡Gracias! 😊 ¿En qué puedo ayudarte?');
      return;
    }
    if (tipo === 'location') {
      conv.pedido.direccion = `https://maps.google.com/?q=${mensaje.location.latitude},${mensaje.location.longitude}`;
      conv.pedido.es_domicilio = true; conv.esperando = null; conv.etapa = 'pago';
      await enviarMensaje(numero, `📍 ¡Ubicación recibida!\n\n${mensajePago(conv, negocio)}`);
      conv.esperando = 'boucher'; return;
    }

    if (tipo !== 'text') return;
    const texto = mensaje.text.body.trim();
    if (!texto) return;

    // Comandos especiales
    if (['cancelar', 'cancel', 'reiniciar'].includes(texto.toLowerCase())) {
      conversaciones.delete(`${numero}:${negocio.id}`);
      await enviarMensaje(numero, `🔄 ¡Listo! Empecemos de nuevo. 👋 Bienvenido/a a *${negocio.nombre}*. ¿En qué puedo ayudarte?`);
      return;
    }
    if (['mi pedido', 'ver pedido', 'mi orden'].includes(texto.toLowerCase())) {
      if (conv.pedido.items?.length > 0) await enviarResumenPedido(numero, conv);
      else await enviarMensaje(numero, '📭 Aún no tienes productos en tu pedido. ¿Qué te gustaría ordenar?');
      return;
    }
    if (['mis compras', 'historial', 'mis pedidos'].includes(texto.toLowerCase())) {
      const c = cargarClientes()[numero];
      if (c?.historial_pedidos?.length > 0) {
        let hist = `📋 *Tu historial de compras:*\n\n`;
        c.historial_pedidos.slice(-5).forEach((p, i) => {
          hist += `${i + 1}. ${new Date(p.fecha).toLocaleDateString('es-EC')} — ${p.descripcion} — $${p.total}\n`;
        });
        hist += `\n💰 Total gastado: $${c.total_gastado?.toFixed(2) || '0.00'}\n🛍️ Total pedidos: ${c.total_pedidos}`;
        await enviarMensaje(numero, hist);
      } else {
        await enviarMensaje(numero, '📭 Aún no tienes pedidos registrados. ¡Anímate a hacer tu primer pedido! 😊');
      }
      return;
    }
    if (['promociones', 'descuentos', 'ofertas'].includes(texto.toLowerCase())) {
      const promos = cargarPromociones().filter(p => p.activa);
      if (promos.length > 0) {
        let msg = `🏷️ *Promociones disponibles:*\n\n`;
        promos.forEach(p => { msg += `${p.emoji || '🎁'} *${p.nombre}*\n${p.descripcion}\n💰 ${p.descuento}\n\n`; });
        await enviarMensaje(numero, msg);
      } else {
        await enviarMensaje(numero, '😊 En este momento no tenemos promociones activas, pero nuestros precios siempre son los mejores. ¿Te puedo ayudar con algo?');
      }
      return;
    }
    if (texto.toLowerCase() === 'horario') {
      await enviarMensaje(numero, `⏰ *Horario de atención de ${negocio.nombre}:*\n\n📅 Lunes a Sábado\n🕐 8:00 am - 6:00 pm\n\n¡Estamos aquí para ayudarte! 😊`);
      return;
    }

    // Bienvenida
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      let bienvenida = '';
      if (cliente.es_frecuente || cliente.total_pedidos >= 3) {
        bienvenida = `¡Hola de nuevo${cliente.nombre ? ', *' + cliente.nombre + '*' : ''}! 👋⭐ ¡Qué gusto verte por aquí otra vez en *${negocio.nombre}*! ¿Qué te gustaría hoy?`;
      } else if (cliente.total_pedidos > 0) {
        bienvenida = `¡Hola${cliente.nombre ? ', *' + cliente.nombre + '*' : ''}! 👋 Bienvenido/a de vuelta a *${negocio.nombre}*. ¿En qué puedo ayudarte hoy? 😊`;
      } else {
        bienvenida = negocio.mensajes?.bienvenida || `¡Hola! 👋 Bienvenido/a a *${negocio.nombre}*. Soy tu asistente virtual. ¿En qué puedo ayudarte hoy? 😊`;
      }
      await enviarMensaje(numero, bienvenida);
      conv.etapa = 'consultando';
      if (texto.toLowerCase() !== 'hola' && texto.toLowerCase() !== 'buenas' && texto.length > 4) {
        const { mensaje: r, imagenesIds } = await procesarConClaude(conv, negocio, texto, cliente);
        if (r) await enviarMensaje(numero, r);
        if (imagenesIds?.length > 0) for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);
      }
      return;
    }

    if (conv.esperando === 'boucher') {
      await enviarMensaje(numero, `💳 Estoy esperando tu *comprobante de pago*.\n\nEnvía una foto del comprobante del *${negocio.banco}* por *$${conv.pedido.total?.toFixed(2) || '0.00'}*`);
      return;
    }

    const { mensaje: respuesta, imagenesIds } = await procesarConClaude(conv, negocio, texto, cliente);
    if (respuesta) await enviarMensaje(numero, respuesta);
    if (imagenesIds?.length > 0) for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);

    if (conv.etapa === 'pago' && conv.esperando !== 'boucher') {
      await new Promise(r => setTimeout(r, 500));
      await enviarResumenPedido(numero, conv);
      await new Promise(r => setTimeout(r, 500));
      await enviarMensaje(numero, mensajePago(conv, negocio));
      conv.esperando = 'boucher';
    }

  } catch (err) { console.error('❌ Error:', err.message); }
});

// ─── API ADMIN ────────────────────────────────────────────────────────────────
app.get('/admin/negocios', (req, res) => res.json(cargarNegocios()));
app.post('/admin/negocios', (req, res) => {
  const negocios = cargarNegocios();
  const nuevo = { id: `negocio_${Date.now()}`, activo: true, catalogo: [], mensajes: { bienvenida: `¡Hola! 👋 Bienvenido/a a *${req.body.nombre}*. ¿En qué puedo ayudarte?`, tono: 'amigable' }, ...req.body };
  negocios.push(nuevo);
  fs.writeFileSync('./negocios.json', JSON.stringify(negocios, null, 2));
  res.json({ ok: true, negocio: nuevo });
});
app.put('/admin/negocios/:id', (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx] = { ...negocios[idx], ...req.body };
  fs.writeFileSync('./negocios.json', JSON.stringify(negocios, null, 2));
  res.json({ ok: true });
});
app.delete('/admin/negocios/:id', (req, res) => {
  fs.writeFileSync('./negocios.json', JSON.stringify(cargarNegocios().filter(n => n.id !== req.params.id), null, 2));
  res.json({ ok: true });
});
app.get('/admin/clientes', (req, res) => res.json(cargarClientes()));
app.get('/admin/promociones', (req, res) => res.json(cargarPromociones()));
app.post('/admin/promociones', (req, res) => {
  const promos = cargarPromociones();
  const nueva = { id: `promo_${Date.now()}`, activa: true, ...req.body };
  promos.push(nueva);
  fs.writeFileSync('./promociones.json', JSON.stringify(promos, null, 2));
  res.json({ ok: true, promocion: nueva });
});
app.delete('/admin/promociones/:id', (req, res) => {
  fs.writeFileSync('./promociones.json', JSON.stringify(cargarPromociones().filter(p => p.id !== req.params.id), null, 2));
  res.json({ ok: true });
});
app.get('/admin/stats', (req, res) => {
  const n = cargarNegocios();
  const c = cargarClientes();
  const clientes = Object.values(c);
  res.json({
    negocios_activos: n.filter(x => x.activo).length,
    conversaciones_activas: conversaciones.size,
    total_clientes: clientes.length,
    clientes_frecuentes: clientes.filter(c => c.es_frecuente).length,
    pedidos_hoy: clientes.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => new Date(p.fecha).toDateString() === new Date().toDateString()).length || 0), 0),
  });
});
app.get('/', (req, res) => res.json({ status: 'VendeBot v4.0 ✅', conversaciones: conversaciones.size, en_horario: estaEnHorario() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🤖 VendeBot v4.0 iniciado en puerto ${PORT}\n`));
