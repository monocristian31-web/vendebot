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
  dias: [1, 2, 3, 4, 5, 6],
  horaInicio: 8,
  horaFin: 18,
  zona: 'America/Guayaquil',
};

function estaEnHorario() {
  const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: HORARIO.zona }));
  return HORARIO.dias.includes(ahora.getDay()) && ahora.getHours() >= HORARIO.horaInicio && ahora.getHours() < HORARIO.horaFin;
}

function horaActual() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: HORARIO.zona }));
}

// ─── PERSISTENCIA ─────────────────────────────────────────────────────────────
function cargarJSON(archivo, defecto) {
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}
function guardarJSON(archivo, data) {
  try { fs.writeFileSync(archivo, JSON.stringify(data, null, 2)); } catch (e) { console.error('Error guardando', archivo, e.message); }
}

function cargarNegocios() { return cargarJSON('./negocios.json', []); }
function cargarClientes() { return cargarJSON('./clientes.json', {}); }
function cargarPromociones() { return cargarJSON('./promociones.json', []); }
function cargarRepartidores() { return cargarJSON('./repartidores.json', []); }
function cargarPedidosPendientes() { return cargarJSON('./pedidos_pendientes.json', []); }
function guardarPedidosPendientes(p) { guardarJSON('./pedidos_pendientes.json', p); }

function obtenerCliente(numero) {
  const clientes = cargarClientes();
  if (!clientes[numero]) {
    clientes[numero] = { numero, nombre: '', primera_visita: new Date().toISOString(), ultima_visita: new Date().toISOString(), total_pedidos: 0, total_gastado: 0, historial_pedidos: [], es_frecuente: false };
    guardarJSON('./clientes.json', clientes);
  }
  return clientes[numero];
}

function actualizarCliente(numero, datos) {
  const clientes = cargarClientes();
  clientes[numero] = { ...(clientes[numero] || {}), ...datos, ultima_visita: new Date().toISOString() };
  if (clientes[numero].total_pedidos >= 3) clientes[numero].es_frecuente = true;
  guardarJSON('./clientes.json', clientes);
}

function registrarPedido(numero, pedido, negocioNombre) {
  const clientes = cargarClientes();
  const c = clientes[numero] || obtenerCliente(numero);
  c.total_pedidos = (c.total_pedidos || 0) + 1;
  c.total_gastado = (c.total_gastado || 0) + (pedido.total || 0);
  c.ultima_visita = new Date().toISOString();
  if (!c.historial_pedidos) c.historial_pedidos = [];
  c.historial_pedidos.push({
    id: `PED-${Date.now()}`,
    fecha: new Date().toISOString(),
    negocio: negocioNombre,
    items: pedido.items,
    total: pedido.total,
    descripcion: pedido.items?.map(i => `${i.nombre} x${i.cantidad}`).join(', '),
    estado: 'confirmado',
    es_domicilio: pedido.es_domicilio,
    direccion: pedido.direccion,
    seguimiento_enviado: false,
  });
  if (c.historial_pedidos.length > 20) c.historial_pedidos = c.historial_pedidos.slice(-20);
  if (c.total_pedidos >= 3) c.es_frecuente = true;
  clientes[numero] = c;
  guardarJSON('./clientes.json', clientes);

  // Guardar en pedidos pendientes para seguimiento
  const pendientes = cargarPedidosPendientes();
  pendientes.push({ numero, negocio: negocioNombre, pedido, fecha: new Date().toISOString(), recordatorio_enviado: false, entrega_confirmada: false });
  guardarPedidosPendientes(pendientes);
}

// ─── CONVERSACIONES ───────────────────────────────────────────────────────────
const conversaciones = new Map();
const clienteNegocioMap = new Map();

try {
  const mapa = cargarJSON('./cliente_negocio_map.json', {});
  for (const [k, v] of Object.entries(mapa)) clienteNegocioMap.set(k, v);
} catch {}

function guardarMapaClientes() {
  guardarJSON('./cliente_negocio_map.json', Object.fromEntries(clienteNegocioMap));
}

function getOrCreateConversacion(numero, negocio) {
  const key = `${numero}:${negocio.id}`;
  if (!conversaciones.has(key)) {
    conversaciones.set(key, {
      numero, negocio_id: negocio.id, historial: [], etapa: 'inicio',
      pedido: { items: [], subtotal: 0, total: 0, es_domicilio: false, direccion: '', nombre_cliente: '', notas: '', metodo_pago: 'transferencia', fecha_entrega: '', hora_entrega: '', repartidor: '' },
      esperando: null, intentos_boucher: 0, ultimo_mensaje: Date.now(), cancelado: false,
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

// ─── TAREAS AUTOMÁTICAS ───────────────────────────────────────────────────────

// Recordatorio de pago pendiente (cada 30 min)
setInterval(async () => {
  if (!estaEnHorario()) return;
  const ahora = Date.now();
  for (const [key, conv] of conversaciones) {
    if (conv.esperando === 'boucher' && conv.etapa === 'pago') {
      const tiempoEspera = ahora - conv.ultimo_mensaje;
      if (tiempoEspera > 30 * 60 * 1000 && !conv.recordatorio_pago_enviado) {
        const negocios = cargarNegocios();
        const negocio = negocios.find(n => n.id === conv.negocio_id);
        if (negocio) {
          await enviarMensaje(conv.numero, 'Hola! Te recuerdo que tu pedido esta pendiente de pago. Cuando puedas enviame el comprobante para confirmar tu pedido.');
          conv.recordatorio_pago_enviado = true;
        }
      }
    }
  }
}, 30 * 60 * 1000);

// Recordatorio dia de entrega (cada hora)
setInterval(async () => {
  if (!estaEnHorario()) return;
  const pendientes = cargarPedidosPendientes();
  const hoy = horaActual().toLocaleDateString('es-EC');
  let cambios = false;
  for (const p of pendientes) {
    if (!p.recordatorio_enviado && !p.entrega_confirmada && p.pedido.fecha_entrega === hoy) {
      await enviarMensaje(p.numero, `Hola! Te recuerdo que hoy es el dia de entrega de tu pedido en ${p.negocio}. Estaremos en contacto para coordinar.`);
      p.recordatorio_enviado = true;
      cambios = true;
    }
  }
  if (cambios) guardarPedidosPendientes(pendientes);
}, 60 * 60 * 1000);

// Resumen diario al dueno (6pm)
setInterval(async () => {
  const ahora = horaActual();
  if (ahora.getHours() === 18 && ahora.getMinutes() < 5) {
    const negocios = cargarNegocios();
    const clientes = cargarClientes();
    const hoy = ahora.toLocaleDateString('es-EC');
    for (const negocio of negocios.filter(n => n.activo)) {
      const pedidosHoy = Object.values(clientes).reduce((acc, c) => {
        return acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length || 0);
      }, 0);
      const ventasHoy = Object.values(clientes).reduce((acc, c) => {
        return acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total || 0), 0) || 0);
      }, 0);
      if (pedidosHoy > 0) {
        await enviarMensaje(negocio.whatsapp_dueno, `Resumen del dia ${hoy} - ${negocio.nombre}\n\nPedidos: ${pedidosHoy}\nVentas totales: $${ventasHoy.toFixed(2)}\n\nBuen trabajo hoy!`);
      }
    }
  }
}, 5 * 60 * 1000);

// Seguimiento post-venta (24 horas)
setInterval(async () => {
  if (!estaEnHorario()) return;
  const clientes = cargarClientes();
  const ahora = Date.now();
  let cambios = false;
  for (const [numero, cliente] of Object.entries(clientes)) {
    if (!cliente.historial_pedidos?.length) continue;
    const ultimo = cliente.historial_pedidos[cliente.historial_pedidos.length - 1];
    if (!ultimo.seguimiento_enviado) {
      const diff = ahora - new Date(ultimo.fecha).getTime();
      if (diff > 23 * 60 * 60 * 1000 && diff < 25 * 60 * 60 * 1000) {
        await enviarMensaje(numero, `Hola ${cliente.nombre || ''}! Esperamos que hayas disfrutado tu pedido. Como fue tu experiencia? Tu opinion nos ayuda a mejorar!`);
        ultimo.seguimiento_enviado = true;
        cambios = true;
      }
    }
  }
  if (cambios) guardarJSON('./clientes.json', clientes);
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
    console.log(`Enviado [${numero}] ${mensaje.substring(0, 60)}`);
  } catch (err) {
    console.error(`Error enviando: ${err.response?.data?.error?.message || err.message}`);
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
    console.error(`Error imagen: ${err.response?.data?.error?.message || err.message}`);
  }
}

async function enviarProducto(numero, producto) {
  const caption = `${producto.emoji || ''} ${producto.nombre}\nPrecio: $${producto.precio.toFixed(2)}\n${producto.descripcion}${producto.stock !== undefined ? '\nStock disponible: ' + producto.stock : ''}`;
  if (producto.imagen) await enviarImagen(numero, producto.imagen, caption);
  else await enviarMensaje(numero, caption);
  await new Promise(r => setTimeout(r, 800));
}

async function enviarResumenPedido(numero, conv) {
  const p = conv.pedido;
  if (!p.items?.length) return;
  let resumen = 'Tu pedido:\n\n';
  for (const item of p.items) resumen += `${item.emoji || ''} ${item.nombre} x${item.cantidad} - $${(item.precio * item.cantidad).toFixed(2)}\n`;
  resumen += `\nSubtotal: $${p.subtotal.toFixed(2)}`;
  if (p.costo_delivery) resumen += `\nDelivery: $${p.costo_delivery.toFixed(2)}\nTotal: $${p.total.toFixed(2)}`;
  if (p.fecha_entrega) resumen += `\nFecha entrega: ${p.fecha_entrega} ${p.hora_entrega || ''}`;
  if (p.metodo_pago === 'efectivo') resumen += '\nMetodo de pago: Efectivo contra entrega';
  await enviarMensaje(numero, resumen);
}

function generarMensajePago(conv, negocio) {
  if (conv.pedido.metodo_pago === 'efectivo') {
    return `Perfecto! Pagaras en efectivo al momento de la entrega.\nTotal a pagar: $${conv.pedido.total?.toFixed(2) || conv.pedido.subtotal?.toFixed(2) || '0.00'}\n\nTu pedido ha sido confirmado! Te avisaremos cuando el repartidor este en camino.`;
  }
  return `Datos para el pago:\n\nBanco: ${negocio.banco}\nCuenta: ${negocio.numero_cuenta}\nTitular: ${negocio.titular_cuenta}\nMonto exacto: $${conv.pedido.total?.toFixed(2) || conv.pedido.subtotal?.toFixed(2) || '0.00'}\n\nEnviame el comprobante (foto) para confirmar tu pedido.`;
}

async function notificarDueno(conv, negocio) {
  const p = conv.pedido;
  const items = p.items?.map(i => `  - ${i.nombre} x${i.cantidad} = $${(i.precio * i.cantidad).toFixed(2)}`).join('\n') || '';
  const repartidor = p.repartidor ? `\nRepartidor asignado: ${p.repartidor}` : '';
  const msg = `NUEVO PEDIDO - ${negocio.nombre}\n\nCliente: ${p.nombre_cliente || conv.numero}\nWhatsApp: ${conv.numero}\n\nDetalle:\n${items}\n\nTotal: $${p.total?.toFixed(2) || '0.00'}\n${p.es_domicilio ? `Direccion: ${p.direccion}` : 'Retira en tienda'}${p.fecha_entrega ? `\nEntrega: ${p.fecha_entrega} ${p.hora_entrega || ''}` : ''}${repartidor}${p.notas ? `\nNotas: ${p.notas}` : ''}\n\nPago: ${p.metodo_pago === 'efectivo' ? 'Efectivo contra entrega' : 'Transferencia verificada'}`;
  await enviarMensaje(negocio.whatsapp_dueno, msg);
}

function asignarRepartidor(negocio) {
  const repartidores = cargarRepartidores().filter(r => r.negocio_id === negocio.id && r.activo && r.disponible);
  if (!repartidores.length) return null;
  return repartidores[Math.floor(Math.random() * repartidores.length)];
}

// ─── VALIDAR BOUCHER ──────────────────────────────────────────────────────────
async function validarBoucher(b64, mediaType, monto) {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
        { type: 'text', text: `Es comprobante bancario real y reciente por $${monto}? Solo JSON: {"valido":true,"motivo":""}` }
      ]}]
    });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g, ''));
  } catch { return { valido: false, motivo: 'No se pudo analizar' }; }
}

// ─── CLAUDE ───────────────────────────────────────────────────────────────────
async function procesarConClaude(conv, negocio, mensajeUsuario, cliente) {
  const catalogoTexto = negocio.catalogo.map(p => {
    const stockInfo = p.stock !== undefined ? ` [Stock: ${p.stock}]` : '';
    return `  ID:${p.id} | ${p.emoji || ''} ${p.nombre} | $${p.precio.toFixed(2)}${stockInfo} | ${p.descripcion}`;
  }).join('\n');

  const promociones = cargarPromociones().filter(p => p.activa);
  const promocionesTexto = promociones.length > 0 ? '\nPROMOCIONES:\n' + promociones.map(p => `  ${p.nombre}: ${p.descripcion} - ${p.descuento}`).join('\n') : '';
  const pedidoActual = conv.pedido.items?.length > 0 ? conv.pedido.items.map(i => `${i.nombre} x${i.cantidad}`).join(', ') : 'vacio';
  const negocioEnModoVacaciones = negocio.modo_vacaciones;
  const metodoPagoActual = conv.pedido.metodo_pago || 'transferencia';

  const system = `Eres el asistente de ${negocio.nombre}, una ${negocio.tipo} en Ecuador. Atiende clientes por WhatsApp de forma calida y profesional.

CATALOGO:
${catalogoTexto}
${promocionesTexto}

METODOS DE PAGO DISPONIBLES:
- Transferencia bancaria (${negocio.banco})
- Efectivo contra entrega (solo domicilio)

CLIENTE:
- Nombre: ${cliente?.nombre || 'Desconocido'}
- Pedidos anteriores: ${cliente?.total_pedidos || 0}
- Cliente frecuente: ${cliente?.es_frecuente ? 'SI' : 'No'}

ESTADO:
- Etapa: ${conv.etapa}
- Pedido: ${pedidoActual}
- Subtotal: $${conv.pedido.subtotal?.toFixed(2) || '0.00'}
- Metodo pago: ${metodoPagoActual}
- Domicilio: ${conv.pedido.es_domicilio ? 'Si' : 'No definido'}

REGLAS:
1. Habla en espanol, tono amigable.
2. Si el cliente menciona un producto especifico responde ENVIAR_IMAGENES: [ese ID]
3. Si quiere ver TODO el catalogo responde ENVIAR_IMAGENES: [todos los IDs]
4. Cuando confirme pedido, pregunta: nombre, fecha/hora de entrega, domicilio o retiro, metodo de pago (transferencia o efectivo).
5. Si elige efectivo, solo disponible para domicilio.
6. Si quiere domicilio pide direccion.
7. Si el cliente quiere MODIFICAR su pedido, ayudale amablemente.
8. Si el cliente quiere CANCELAR antes de confirmar, confirma la cancelacion.
9. Si el producto tiene stock 0, dile que no hay disponible y sugiere alternativas.
10. Horario: Lunes a Sabado 8am-6pm.
11. Cuando el pedido este listo para pagar, escribe MOSTRAR_PAGO: true
12. NUNCA inventes precios o productos fuera del catalogo.

Al FINAL escribe:
ETAPA: [inicio|consultando|cotizando|confirmando|delivery|pago|confirmado|cancelado]
PEDIDO_JSON: {"items":[{"id":1,"nombre":"","precio":0,"cantidad":1,"emoji":""}],"subtotal":0,"total":0,"es_domicilio":false,"nombre_cliente":"","direccion":"","fecha_entrega":"","hora_entrega":"","notas":"","metodo_pago":"transferencia"}
ENVIAR_IMAGENES: []
MOSTRAR_PAGO: false
NOMBRE_CLIENTE: `;

  conv.historial.push({ role: 'user', content: mensajeUsuario });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1000,
    system, messages: conv.historial,
  });

  const full = response.content[0].text;
  const lineas = full.split('\n');
  let msg = [], etapa = conv.etapa, pedidoJSON = null, imgs = [], mostrarPago = false, nombreCliente = '';

  for (const l of lineas) {
    if (l.startsWith('ETAPA:')) etapa = l.replace('ETAPA:', '').trim();
    else if (l.startsWith('PEDIDO_JSON:')) { try { pedidoJSON = JSON.parse(l.replace('PEDIDO_JSON:', '').trim()); } catch {} }
    else if (l.startsWith('ENVIAR_IMAGENES:')) { try { imgs = JSON.parse(l.replace('ENVIAR_IMAGENES:', '').trim()); } catch {} }
    else if (l.startsWith('MOSTRAR_PAGO:')) mostrarPago = l.includes('true');
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

  if (nombreCliente && nombreCliente.length > 1) {
    conv.pedido.nombre_cliente = nombreCliente;
    actualizarCliente(conv.numero, { nombre: nombreCliente });
  }

  conv.historial.push({ role: 'assistant', content: mensajeFinal });
  if (conv.historial.length > 30) conv.historial = conv.historial.slice(-30);

  return { mensaje: mensajeFinal, imagenesIds: imgs, mostrarPago };
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('Webhook verificado');
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
    console.log(`Mensaje de ${numero} (${tipo})`);

    const negocios = cargarNegocios();
    let negocioId = clienteNegocioMap.get(numero);
    let negocio = negocios.find(n => n.id === negocioId && n.activo);
    if (!negocio) {
      negocio = negocios.find(n => n.activo);
      if (negocio) { clienteNegocioMap.set(numero, negocio.id); guardarMapaClientes(); }
    }
    if (!negocio) { await enviarMensaje(numero, 'Hola! No hay negocios disponibles ahora.'); return; }

    // Modo vacaciones
    if (negocio.modo_vacaciones) {
      await enviarMensaje(numero, negocio.mensaje_vacaciones || `Hola! ${negocio.nombre} esta de vacaciones. Volvemos pronto!`);
      return;
    }

    // Verificar horario
    if (!estaEnHorario()) {
      const dias = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
      const diasAtencion = HORARIO.dias.map(d => dias[d]).join(', ');
      await enviarMensaje(numero, `Hola! ${negocio.nombre} esta fuera de horario.\n\nHorario de atencion:\n${diasAtencion}\n8:00 am - 6:00 pm\n\nTe atenderemos en cuanto abramos!`);
      return;
    }

    const conv = getOrCreateConversacion(numero, negocio);
    const cliente = obtenerCliente(numero);

    // IMAGEN
    if (tipo === 'image') {
      if (conv.esperando === 'boucher') {
        await enviarMensaje(numero, 'Analizando tu comprobante...');
        try {
          const mediaRes = await axios.get(`https://graph.facebook.com/v18.0/${mensaje.image.id}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
          const imgRes = await axios.get(mediaRes.data.url, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
          const b64 = Buffer.from(imgRes.data).toString('base64');
          const resultado = await validarBoucher(b64, mensaje.image.mime_type || 'image/jpeg', conv.pedido.total || 0);
          if (resultado.valido) {
            conv.etapa = 'confirmado'; conv.esperando = null;
            // Asignar repartidor si es domicilio
            if (conv.pedido.es_domicilio) {
              const repartidor = asignarRepartidor(negocio);
              if (repartidor) {
                conv.pedido.repartidor = repartidor.nombre;
                await enviarMensaje(numero, `Pago verificado! Tu pedido en ${negocio.nombre} esta confirmado!\n\nTu repartidor es: ${repartidor.nombre}\nTiempo estimado de entrega: ${negocio.tiempo_entrega || '30-45 minutos'}\n\nGracias por tu compra!`);
                await enviarMensaje(repartidor.whatsapp, `Nuevo pedido asignado!\n\nCliente: ${conv.pedido.nombre_cliente || numero}\nDireccion: ${conv.pedido.direccion}\nTotal: $${conv.pedido.total?.toFixed(2)}\nPedido: ${conv.pedido.items?.map(i => i.nombre).join(', ')}`);
              } else {
                await enviarMensaje(numero, `Pago verificado! Tu pedido en ${negocio.nombre} esta confirmado!\n\nTiempo estimado: ${negocio.tiempo_entrega || '30-45 minutos'}\n\nGracias por tu compra!`);
              }
            } else {
              await enviarMensaje(numero, `Pago verificado! Tu pedido en ${negocio.nombre} esta confirmado!\n\nPuedes pasar a retirarlo cuando gustes.\n\nGracias por tu compra!`);
            }
            registrarPedido(numero, conv.pedido, negocio.nombre);
            await notificarDueno(conv, negocio);
          } else {
            conv.intentos_boucher++;
            if (conv.intentos_boucher >= 3) {
              await enviarMensaje(numero, `No pudimos verificar tu pago. Contacta directamente a ${negocio.nombre}.`);
            } else {
              await enviarMensaje(numero, `No pude verificar el comprobante.\nMotivo: ${resultado.motivo}\n\nEnvia el comprobante del ${negocio.banco} por $${conv.pedido.total?.toFixed(2)} (intento ${conv.intentos_boucher}/3)`);
            }
          }
        } catch (e) { await enviarMensaje(numero, 'No pude procesar la imagen. Intenta de nuevo.'); }
      } else if (conv.esperando === 'foto_entrega') {
        // Confirmar entrega con foto
        conv.esperando = null;
        await enviarMensaje(numero, 'Foto de entrega recibida! Gracias por confirmar.');
        const pendientes = cargarPedidosPendientes();
        const idx = pendientes.findIndex(p => p.numero === numero && !p.entrega_confirmada);
        if (idx >= 0) { pendientes[idx].entrega_confirmada = true; guardarPedidosPendientes(pendientes); }
        const negocios = cargarNegocios();
        const neg = negocios.find(n => n.id === conv.negocio_id);
        if (neg) await enviarMensaje(neg.whatsapp_dueno, `Entrega confirmada para cliente ${conv.pedido.nombre_cliente || numero}!`);
      } else {
        await enviarMensaje(numero, 'Gracias por la imagen! En que puedo ayudarte?');
      }
      return;
    }

    if (tipo === 'audio') { await enviarMensaje(numero, 'Solo puedo atenderte por texto. Que necesitas?'); return; }
    if (tipo === 'document') {
      if (conv.esperando === 'boucher') await enviarMensaje(numero, 'Necesito el comprobante como imagen (foto o captura de pantalla).');
      else await enviarMensaje(numero, 'Gracias! En que puedo ayudarte?');
      return;
    }
    if (tipo === 'location') {
      conv.pedido.direccion = `https://maps.google.com/?q=${mensaje.location.latitude},${mensaje.location.longitude}`;
      conv.pedido.es_domicilio = true; conv.esperando = null; conv.etapa = 'pago';
      await enviarMensaje(numero, `Ubicacion recibida!\n\n${generarMensajePago(conv, negocio)}`);
      if (conv.pedido.metodo_pago !== 'efectivo') conv.esperando = 'boucher';
      return;
    }

    if (tipo !== 'text') return;
    const texto = mensaje.text.body.trim();
    if (!texto) return;

    // Comandos especiales
    const textoLower = texto.toLowerCase();

    if (['cancelar', 'cancel'].includes(textoLower)) {
      if (conv.etapa === 'confirmado') {
        await enviarMensaje(numero, 'Tu pedido ya fue confirmado y no puede cancelarse. Contacta directamente al negocio si necesitas ayuda.');
      } else {
        conversaciones.delete(`${numero}:${negocio.id}`);
        await enviarMensaje(numero, `Pedido cancelado. Si necesitas algo mas, escribe cuando quieras!`);
      }
      return;
    }

    if (textoLower === 'mi pedido' || textoLower === 'ver pedido') {
      if (conv.pedido.items?.length > 0) await enviarResumenPedido(numero, conv);
      else await enviarMensaje(numero, 'No tienes productos en tu pedido aun. Que te gustaria ordenar?');
      return;
    }

    if (textoLower === 'mis compras' || textoLower === 'historial') {
      const c = cargarClientes()[numero];
      if (c?.historial_pedidos?.length > 0) {
        let hist = 'Tu historial de compras:\n\n';
        c.historial_pedidos.slice(-5).forEach((p, i) => { hist += `${i + 1}. ${new Date(p.fecha).toLocaleDateString('es-EC')} - ${p.descripcion} ($${p.total})\n`; });
        hist += `\nTotal gastado: $${c.total_gastado?.toFixed(2) || '0.00'}\nTotal pedidos: ${c.total_pedidos}`;
        await enviarMensaje(numero, hist);
      } else {
        await enviarMensaje(numero, 'Aun no tienes pedidos registrados. Animete a hacer tu primer pedido!');
      }
      return;
    }

    if (textoLower === 'promociones' || textoLower === 'ofertas') {
      const promos = cargarPromociones().filter(p => p.activa);
      if (promos.length > 0) {
        let msg = 'Promociones disponibles:\n\n';
        promos.forEach(p => { msg += `${p.emoji || ''} ${p.nombre}\n${p.descripcion}\n${p.descuento}\n\n`; });
        await enviarMensaje(numero, msg);
      } else {
        await enviarMensaje(numero, 'No hay promociones activas en este momento.');
      }
      return;
    }

    if (textoLower === 'horario') {
      await enviarMensaje(numero, `Horario de atencion de ${negocio.nombre}:\n\nLunes a Sabado\n8:00 am - 6:00 pm`);
      return;
    }

    if (textoLower === 'politica de devoluciones' || textoLower === 'devoluciones') {
      await enviarMensaje(numero, negocio.politica_devoluciones || `Politica de devoluciones de ${negocio.nombre}:\n\n- Tienes 24 horas para reportar cualquier problema con tu pedido.\n- Los productos deben estar en su estado original.\n- Contactanos por este mismo WhatsApp para iniciar el proceso.`);
      return;
    }

    if (textoLower === 'confirmar entrega' || textoLower === 'ya recibi') {
      conv.esperando = 'foto_entrega';
      await enviarMensaje(numero, 'Que bueno! Por favor envianos una foto del pedido recibido para confirmar la entrega.');
      return;
    }

    // Bienvenida
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      let bienvenida = '';
      if (cliente.es_frecuente) {
        bienvenida = `Hola de nuevo${cliente.nombre ? ', ' + cliente.nombre : ''}! Que gusto verte por aqui otra vez en ${negocio.nombre}! En que puedo ayudarte hoy?`;
      } else if (cliente.total_pedidos > 0) {
        bienvenida = `Hola${cliente.nombre ? ', ' + cliente.nombre : ''}! Bienvenido/a de vuelta a ${negocio.nombre}. En que puedo ayudarte?`;
      } else {
        bienvenida = negocio.mensajes?.bienvenida || `Hola! Bienvenido/a a ${negocio.nombre}. Soy tu asistente virtual. En que puedo ayudarte hoy?`;
      }
      await enviarMensaje(numero, bienvenida);
      conv.etapa = 'consultando';
      const saludos = ['hola', 'buenas', 'hi', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'ola'];
      if (!saludos.includes(textoLower) && texto.length > 6) {
        const { mensaje: r, imagenesIds, mostrarPago } = await procesarConClaude(conv, negocio, texto, cliente);
        if (r) await enviarMensaje(numero, r);
        if (imagenesIds?.length > 0 && conv.etapa !== 'pago') {
          for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);
        }
      }
      return;
    }

    if (conv.esperando === 'boucher') {
      await enviarMensaje(numero, `Estoy esperando tu comprobante de pago. Envia una foto del comprobante del ${negocio.banco} por $${conv.pedido.total?.toFixed(2) || '0.00'}`);
      return;
    }

    const { mensaje: respuesta, imagenesIds, mostrarPago } = await procesarConClaude(conv, negocio, texto, cliente);
    if (respuesta) await enviarMensaje(numero, respuesta);

    if (imagenesIds?.length > 0 && conv.etapa !== 'pago' && conv.etapa !== 'confirmado') {
      for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);
    }

    if ((conv.etapa === 'pago' || mostrarPago) && conv.esperando !== 'boucher') {
      await new Promise(r => setTimeout(r, 500));
      await enviarResumenPedido(numero, conv);
      await new Promise(r => setTimeout(r, 500));
      await enviarMensaje(numero, generarMensajePago(conv, negocio));
      if (conv.pedido.metodo_pago === 'efectivo') {
        // Efectivo: confirmar directo sin boucher
        conv.etapa = 'confirmado';
        registrarPedido(numero, conv.pedido, negocio.nombre);
        await notificarDueno(conv, negocio);
      } else {
        conv.esperando = 'boucher';
      }
    }

    if (conv.etapa === 'cancelado') {
      conversaciones.delete(`${numero}:${negocio.id}`);
    }

  } catch (err) { console.error('Error en webhook:', err.message); }
});

// ─── API ADMIN ────────────────────────────────────────────────────────────────
app.get('/admin/negocios', (req, res) => res.json(cargarNegocios()));
app.post('/admin/negocios', (req, res) => {
  const negocios = cargarNegocios();
  const id = 'negocio_' + Date.now();
  const nuevo = { id, activo: true, catalogo: [], modo_vacaciones: false, tiempo_entrega: '30-45 minutos', politica_devoluciones: '', mensajes: { bienvenida: 'Hola! Bienvenido/a. En que puedo ayudarte?', tono: 'amigable' }, ...req.body };
  negocios.push(nuevo);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, negocio: nuevo });
});
app.put('/admin/negocios/:id', (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx] = { ...negocios[idx], ...req.body };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.delete('/admin/negocios/:id', (req, res) => {
  guardarJSON('./negocios.json', cargarNegocios().filter(n => n.id !== req.params.id));
  res.json({ ok: true });
});
app.put('/admin/negocios/:id/vacaciones', (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].modo_vacaciones = req.body.activo;
  negocios[idx].mensaje_vacaciones = req.body.mensaje || '';
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.get('/admin/clientes', (req, res) => res.json(cargarClientes()));
app.get('/admin/repartidores', (req, res) => res.json(cargarRepartidores()));
app.post('/admin/repartidores', (req, res) => {
  const repartidores = cargarRepartidores();
  const nuevo = { id: 'rep_' + Date.now(), activo: true, disponible: true, ...req.body };
  repartidores.push(nuevo);
  guardarJSON('./repartidores.json', repartidores);
  res.json({ ok: true, repartidor: nuevo });
});
app.put('/admin/repartidores/:id/disponible', (req, res) => {
  const repartidores = cargarRepartidores();
  const idx = repartidores.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  repartidores[idx].disponible = req.body.disponible;
  guardarJSON('./repartidores.json', repartidores);
  res.json({ ok: true });
});
app.get('/admin/promociones', (req, res) => res.json(cargarPromociones()));
app.post('/admin/promociones', (req, res) => {
  const promos = cargarPromociones();
  const nueva = { id: 'promo_' + Date.now(), activa: true, ...req.body };
  promos.push(nueva);
  guardarJSON('./promociones.json', promos);
  res.json({ ok: true });
});
app.delete('/admin/promociones/:id', (req, res) => {
  guardarJSON('./promociones.json', cargarPromociones().filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});
app.get('/admin/pedidos', (req, res) => res.json(cargarPedidosPendientes()));
app.get('/admin/stats', (req, res) => {
  const n = cargarNegocios();
  const c = cargarClientes();
  const clientes = Object.values(c);
  const hoy = horaActual().toLocaleDateString('es-EC');
  res.json({
    negocios_activos: n.filter(x => x.activo).length,
    conversaciones_activas: conversaciones.size,
    total_clientes: clientes.length,
    clientes_frecuentes: clientes.filter(c => c.es_frecuente).length,
    pedidos_hoy: clientes.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length || 0), 0),
    ventas_hoy: clientes.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total || 0), 0) || 0), 0),
  });
});
app.get('/', (req, res) => res.json({ status: 'VendeBot v5.0 activo', conversaciones: conversaciones.size, en_horario: estaEnHorario() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VendeBot v5.0 iniciado en puerto ${PORT}`));
