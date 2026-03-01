require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('.'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'vendebot2024';

// ─── HORARIO ──────────────────────────────────────────────────────────────────
const HORARIO = { dias: [0, 1, 2, 3, 4, 5, 6], horaInicio: 8, horaFin: 18, zona: 'America/Guayaquil' };

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
function cargarCupones() { return cargarJSON('./cupones.json', []); }
function cargarPuntos() { return cargarJSON('./puntos.json', {}); }
function guardarPuntos(p) { guardarJSON('./puntos.json', p); }

// ─── SISTEMA DE PUNTOS ────────────────────────────────────────────────────────
const PUNTOS_POR_DOLAR = 10; // 10 puntos por cada $1 gastado
const PUNTOS_PARA_REGALO = 500; // 500 puntos = producto gratis

function obtenerPuntos(numero) {
  const puntos = cargarPuntos();
  return puntos[numero] || { total: 0, canjeados: 0, historial: [] };
}

function agregarPuntos(numero, monto, descripcion) {
  const puntos = cargarPuntos();
  if (!puntos[numero]) puntos[numero] = { total: 0, canjeados: 0, historial: [] };
  const puntosGanados = Math.floor(monto * PUNTOS_POR_DOLAR);
  puntos[numero].total += puntosGanados;
  puntos[numero].historial.push({ fecha: new Date().toISOString(), puntos: puntosGanados, descripcion });
  if (puntos[numero].historial.length > 20) puntos[numero].historial = puntos[numero].historial.slice(-20);
  guardarPuntos(puntos);
  return puntosGanados;
}

function canjearPuntos(numero, puntosACanjear) {
  const puntos = cargarPuntos();
  if (!puntos[numero] || puntos[numero].total < puntosACanjear) return false;
  puntos[numero].total -= puntosACanjear;
  puntos[numero].canjeados += puntosACanjear;
  puntos[numero].historial.push({ fecha: new Date().toISOString(), puntos: -puntosACanjear, descripcion: 'Canje de puntos' });
  guardarPuntos(puntos);
  return true;
}

// ─── SISTEMA DE CUPONES ───────────────────────────────────────────────────────
function validarCupon(codigo, subtotal) {
  const cupones = cargarCupones();
  const cupon = cupones.find(c => c.codigo.toUpperCase() === codigo.toUpperCase() && c.activo);
  if (!cupon) return { valido: false, motivo: 'Cupon no encontrado o inactivo' };
  if (cupon.usos_maximos && cupon.usos_actuales >= cupon.usos_maximos) return { valido: false, motivo: 'Cupon agotado' };
  if (cupon.fecha_expiracion && new Date(cupon.fecha_expiracion) < new Date()) return { valido: false, motivo: 'Cupon expirado' };
  if (cupon.monto_minimo && subtotal < cupon.monto_minimo) return { valido: false, motivo: `Monto minimo requerido: $${cupon.monto_minimo}` };
  
  let descuento = 0;
  if (cupon.tipo === 'porcentaje') descuento = subtotal * (cupon.valor / 100);
  else if (cupon.tipo === 'fijo') descuento = cupon.valor;
  
  return { valido: true, descuento: Math.min(descuento, subtotal), cupon };
}

function usarCupon(codigo) {
  const cupones = cargarCupones();
  const idx = cupones.findIndex(c => c.codigo.toUpperCase() === codigo.toUpperCase());
  if (idx >= 0) {
    cupones[idx].usos_actuales = (cupones[idx].usos_actuales || 0) + 1;
    guardarJSON('./cupones.json', cupones);
  }
}

// ─── SISTEMA DE REFERIDOS ─────────────────────────────────────────────────────
function cargarReferidos() { return cargarJSON('./referidos.json', {}); }

function generarCodigoReferido(numero) {
  const referidos = cargarReferidos();
  if (!referidos[numero]) {
    const codigo = 'REF' + numero.slice(-4) + Math.random().toString(36).substring(2, 5).toUpperCase();
    referidos[numero] = { codigo, numero, referidos: [], descuento_ganado: 0 };
    guardarJSON('./referidos.json', referidos);
  }
  return referidos[numero].codigo;
}

function procesarReferido(codigoRef, numeroNuevo) {
  const referidos = cargarReferidos();
  const dueno = Object.values(referidos).find(r => r.codigo === codigoRef.toUpperCase());
  if (!dueno || dueno.numero === numeroNuevo) return false;
  if (!dueno.referidos.includes(numeroNuevo)) {
    dueno.referidos.push(numeroNuevo);
    dueno.descuento_ganado += 5; // $5 de descuento por referido
    referidos[dueno.numero] = dueno;
    guardarJSON('./referidos.json', referidos);
    // Crear cupon automatico para el que refirio
    const cupones = cargarCupones();
    cupones.push({
      codigo: 'REFER' + Date.now(),
      tipo: 'fijo', valor: 5,
      activo: true, usos_maximos: 1, usos_actuales: 0,
      descripcion: 'Descuento por referido',
      para_numero: dueno.numero,
    });
    guardarJSON('./cupones.json', cupones);
    return dueno.numero;
  }
  return false;
}

// ─── FECHAS ESPECIALES ────────────────────────────────────────────────────────
function obtenerFechaEspecial() {
  const ahora = horaActual();
  const mes = ahora.getMonth() + 1;
  const dia = ahora.getDate();
  
  if (mes === 2 && dia >= 12 && dia <= 14) return { nombre: 'San Valentin', emoji: 'cupid', descuento: 15 };
  if (mes === 5 && dia >= 8 && dia <= 12) return { nombre: 'Dia de la Madre', emoji: 'rose', descuento: 10 };
  if (mes === 6 && dia >= 14 && dia <= 17) return { nombre: 'Dia del Padre', emoji: 'necktie', descuento: 10 };
  if (mes === 12 && dia >= 20 && dia <= 25) return { nombre: 'Navidad', emoji: 'christmas_tree', descuento: 20 };
  if (mes === 12 && dia >= 28 && dia <= 31) return { nombre: 'Anio Nuevo', emoji: 'fireworks', descuento: 15 };
  return null;
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
function obtenerCliente(numero) {
  const clientes = cargarClientes();
  if (!clientes[numero]) {
    clientes[numero] = { numero, nombre: '', primera_visita: new Date().toISOString(), ultima_visita: new Date().toISOString(), total_pedidos: 0, total_gastado: 0, historial_pedidos: [], es_frecuente: false, codigo_referido_usado: '' };
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
    id: 'PED-' + Date.now(),
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
function guardarMapaClientes() { guardarJSON('./cliente_negocio_map.json', Object.fromEntries(clienteNegocioMap)); }

function getOrCreateConversacion(numero, negocio) {
  const key = `${numero}:${negocio.id}`;
  if (!conversaciones.has(key)) {
    conversaciones.set(key, {
      numero, negocio_id: negocio.id, historial: [], etapa: 'inicio',
      pedido: { items: [], subtotal: 0, total: 0, es_domicilio: false, direccion: '', nombre_cliente: '', notas: '', metodo_pago: 'transferencia', fecha_entrega: '', hora_entrega: '', repartidor: '', cupon: null, descuento: 0 },
      esperando: null, intentos_boucher: 0, ultimo_mensaje: Date.now(),
    });
  }
  const conv = conversaciones.get(key);
  conv.ultimo_mensaje = Date.now();
  return conv;
}

setInterval(() => {
  const ahora = Date.now();
  for (const [key, conv] of conversaciones) {
    if (ahora - conv.ultimo_mensaje > 2 * 60 * 60 * 1000) conversaciones.delete(key);
  }
}, 30 * 60 * 1000);

// ─── TAREAS AUTOMÁTICAS ───────────────────────────────────────────────────────
// Recordatorio pago (30 min)
setInterval(async () => {
  if (!estaEnHorario()) return;
  const ahora = Date.now();
  for (const [key, conv] of conversaciones) {
    if (conv.esperando === 'boucher' && !conv.recordatorio_pago_enviado && ahora - conv.ultimo_mensaje > 30 * 60 * 1000) {
      const negocio = cargarNegocios().find(n => n.id === conv.negocio_id);
      if (negocio) { await enviarMensaje(conv.numero, 'Hola! Te recuerdo que tu pedido esta pendiente de pago. Cuando puedas envíame el comprobante.'); conv.recordatorio_pago_enviado = true; }
    }
  }
}, 30 * 60 * 1000);

// Recordatorio dia entrega (cada hora)
setInterval(async () => {
  if (!estaEnHorario()) return;
  const pendientes = cargarPedidosPendientes();
  const hoy = horaActual().toLocaleDateString('es-EC');
  let cambios = false;
  for (const p of pendientes) {
    if (!p.recordatorio_enviado && !p.entrega_confirmada && p.pedido.fecha_entrega === hoy) {
      await enviarMensaje(p.numero, `Hola! Hoy es el dia de entrega de tu pedido en ${p.negocio}. Nos pondremos en contacto pronto!`);
      p.recordatorio_enviado = true; cambios = true;
    }
  }
  if (cambios) guardarPedidosPendientes(pendientes);
}, 60 * 60 * 1000);

// Resumen diario 6pm
setInterval(async () => {
  const ahora = horaActual();
  if (ahora.getHours() === 18 && ahora.getMinutes() < 5) {
    const negocios = cargarNegocios();
    const clientes = cargarClientes();
    const hoy = ahora.toLocaleDateString('es-EC');
    for (const negocio of negocios.filter(n => n.activo)) {
      const pedidosHoy = Object.values(clientes).reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length || 0), 0);
      const ventasHoy = Object.values(clientes).reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total || 0), 0) || 0), 0);
      if (pedidosHoy > 0) await enviarMensaje(negocio.whatsapp_dueno, `Resumen del dia ${hoy} - ${negocio.nombre}\n\nPedidos: ${pedidosHoy}\nVentas: $${ventasHoy.toFixed(2)}\n\nBuen trabajo!`);
    }
  }
}, 5 * 60 * 1000);

// Reactivacion clientes inactivos (cada dia a las 10am)
setInterval(async () => {
  const ahora = horaActual();
  if (ahora.getHours() === 10 && ahora.getMinutes() < 5) {
    const clientes = cargarClientes();
    const negocios = cargarNegocios();
    const ahora30dias = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const [numero, cliente] of Object.entries(clientes)) {
      if (cliente.total_pedidos > 0 && new Date(cliente.ultima_visita).getTime() < ahora30dias && !cliente.reactivacion_enviada) {
        const negocioId = clienteNegocioMap.get(numero);
        const negocio = negocios.find(n => n.id === negocioId);
        if (negocio) {
          await enviarMensaje(numero, `Hola ${cliente.nombre || ''}! Te extrañamos en ${negocio.nombre}. Ha pasado un tiempo y queremos ofrecerte un descuento especial del 10% en tu proximo pedido. Usa el codigo: VUELVE10`);
          cliente.reactivacion_enviada = true;
          clientes[numero] = cliente;
          // Crear cupon
          const cupones = cargarCupones();
          if (!cupones.find(c => c.codigo === 'VUELVE10' && c.para_numero === numero)) {
            cupones.push({ codigo: 'VUELVE10_' + numero.slice(-4), tipo: 'porcentaje', valor: 10, activo: true, usos_maximos: 1, usos_actuales: 0, para_numero: numero, descripcion: 'Descuento reactivacion' });
            guardarJSON('./cupones.json', cupones);
          }
        }
      }
    }
    guardarJSON('./clientes.json', clientes);
  }
}, 5 * 60 * 1000);

// Seguimiento post-venta
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
        ultimo.seguimiento_enviado = true; cambios = true;
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
  } catch (err) { console.error(`Error: ${err.response?.data?.error?.message || err.message}`); }
}

async function enviarImagen(numero, url, caption) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: numero, type: 'image', image: { link: url, caption: caption || '' } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) { console.error(`Error imagen: ${err.response?.data?.error?.message || err.message}`); }
}

async function enviarProducto(numero, producto) {
  const stockInfo = producto.stock !== undefined ? `\nStock: ${producto.stock}` : '';
  const caption = `${producto.emoji || ''} ${producto.nombre}\nPrecio: $${producto.precio.toFixed(2)}\n${producto.descripcion}${stockInfo}`;
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
  if (p.descuento > 0) resumen += `\nDescuento: -$${p.descuento.toFixed(2)}`;
  if (p.costo_delivery) resumen += `\nDelivery: $${p.costo_delivery.toFixed(2)}`;
  resumen += `\nTotal: $${p.total.toFixed(2)}`;
  if (p.fecha_entrega) resumen += `\nEntrega: ${p.fecha_entrega} ${p.hora_entrega || ''}`;
  if (p.metodo_pago === 'efectivo') resumen += '\nPago: Efectivo contra entrega';
  const puntos = obtenerPuntos(numero);
  resumen += `\n\nTus puntos actuales: ${puntos.total} pts`;
  await enviarMensaje(numero, resumen);
}

function generarMensajePago(conv, negocio) {
  if (conv.pedido.metodo_pago === 'efectivo') {
    return `Perfecto! Pagaras en efectivo al momento de la entrega.\nTotal: $${conv.pedido.total?.toFixed(2) || '0.00'}\n\nTu pedido esta confirmado! Te avisaremos cuando el repartidor este en camino.`;
  }
  return `Datos para el pago:\n\nBanco: ${negocio.banco}\nCuenta: ${negocio.numero_cuenta}\nTitular: ${negocio.titular_cuenta}\nMonto exacto: $${conv.pedido.total?.toFixed(2) || '0.00'}\n\nEnviame el comprobante (foto) para confirmar.`;
}

async function notificarDueno(conv, negocio) {
  const p = conv.pedido;
  const items = p.items?.map(i => `  - ${i.nombre} x${i.cantidad} = $${(i.precio * i.cantidad).toFixed(2)}`).join('\n') || '';
  const msg = `NUEVO PEDIDO - ${negocio.nombre}\n\nCliente: ${p.nombre_cliente || conv.numero}\nWhatsApp: ${conv.numero}\n\nDetalle:\n${items}\n${p.descuento > 0 ? `Descuento: -$${p.descuento.toFixed(2)}\n` : ''}Total: $${p.total?.toFixed(2) || '0.00'}\n${p.es_domicilio ? `Direccion: ${p.direccion}` : 'Retira en tienda'}${p.fecha_entrega ? `\nEntrega: ${p.fecha_entrega} ${p.hora_entrega || ''}` : ''}${p.notas ? `\nNotas: ${p.notas}` : ''}\nPago: ${p.metodo_pago === 'efectivo' ? 'Efectivo' : 'Transferencia verificada'}`;
  await enviarMensaje(negocio.whatsapp_dueno, msg);
}

function asignarRepartidor(negocio) {
  const reps = cargarRepartidores().filter(r => r.negocio_id === negocio.id && r.activo && r.disponible);
  return reps.length ? reps[Math.floor(Math.random() * reps.length)] : null;
}

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
  const fechaEspecial = obtenerFechaEspecial();
  const promo_texto = promociones.length > 0 ? '\nPROMOCIONES:\n' + promociones.map(p => `  ${p.nombre}: ${p.descripcion} - ${p.descuento}`).join('\n') : '';
  const fecha_especial_texto = fechaEspecial ? `\nFECHA ESPECIAL: ${fechaEspecial.nombre} - ${fechaEspecial.descuento}% de descuento!` : '';
  const pedidoActual = conv.pedido.items?.length > 0 ? conv.pedido.items.map(i => `${i.nombre} x${i.cantidad}`).join(', ') : 'vacio';
  const puntos = obtenerPuntos(conv.numero);
  const codigoReferido = generarCodigoReferido(conv.numero);

  const system = `Eres el asistente de ${negocio.nombre}, una ${negocio.tipo} en Ecuador. Atiende clientes por WhatsApp de forma calida y profesional.

CATALOGO:
${catalogoTexto}
${promo_texto}
${fecha_especial_texto}

CLIENTE:
- Nombre: ${cliente?.nombre || 'Desconocido'}
- Pedidos anteriores: ${cliente?.total_pedidos || 0}
- Cliente frecuente: ${cliente?.es_frecuente ? 'SI' : 'No'}
- Puntos acumulados: ${puntos.total} pts (necesita ${PUNTOS_PARA_REGALO} para producto gratis)
- Codigo de referido: ${codigoReferido}

ESTADO:
- Etapa: ${conv.etapa}
- Pedido: ${pedidoActual}
- Subtotal: $${conv.pedido.subtotal?.toFixed(2) || '0.00'}
- Descuento: $${conv.pedido.descuento?.toFixed(2) || '0.00'}
- Total: $${conv.pedido.total?.toFixed(2) || '0.00'}
- Metodo pago: ${conv.pedido.metodo_pago || 'transferencia'}

REGLAS:
1. Habla en espanol, tono amigable y calido.
2. Si el cliente menciona un producto especifico: ENVIAR_IMAGENES: [ese ID]
3. Si quiere ver TODO el catalogo: ENVIAR_IMAGENES: [todos los IDs]
4. Si hay fecha especial activa, mencionala con entusiasmo.
5. Si el cliente tiene muchos puntos, sugieres que puede canjearlos.
6. Cuando el cliente confirme pedido, pregunta: nombre, fecha/hora entrega, domicilio o retiro, metodo pago.
7. Si elige efectivo, solo para domicilio.
8. Si el cliente menciona un cupon, valida con APLICAR_CUPON: [codigo]
9. Si el cliente quiere su codigo de referido, dimelo.
10. Si el cliente quiere cancelar antes de confirmar, confirma la cancelacion.
11. Si producto con stock 0, sugiere alternativas.
12. Horario: Lunes a Sabado 8am-6pm. Domingos cerrado.
13. Cuando pedido listo para pagar: MOSTRAR_PAGO: true
14. Mencion puntos ganados despues de confirmar pedido.

Al FINAL escribe:
ETAPA: [inicio|consultando|cotizando|confirmando|delivery|pago|confirmado|cancelado]
PEDIDO_JSON: {"items":[{"id":1,"nombre":"","precio":0,"cantidad":1,"emoji":""}],"subtotal":0,"total":0,"es_domicilio":false,"nombre_cliente":"","direccion":"","fecha_entrega":"","hora_entrega":"","notas":"","metodo_pago":"transferencia","descuento":0}
ENVIAR_IMAGENES: []
MOSTRAR_PAGO: false
APLICAR_CUPON: 
NOMBRE_CLIENTE: `;

  conv.historial.push({ role: 'user', content: mensajeUsuario });
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages: conv.historial });
  const full = response.content[0].text;
  const lineas = full.split('\n');
  let msg = [], etapa = conv.etapa, pedidoJSON = null, imgs = [], mostrarPago = false, aplicarCupon = '', nombreCliente = '';

  for (const l of lineas) {
    if (l.startsWith('ETAPA:')) etapa = l.replace('ETAPA:', '').trim();
    else if (l.startsWith('PEDIDO_JSON:')) { try { pedidoJSON = JSON.parse(l.replace('PEDIDO_JSON:', '').trim()); } catch {} }
    else if (l.startsWith('ENVIAR_IMAGENES:')) { try { imgs = JSON.parse(l.replace('ENVIAR_IMAGENES:', '').trim()); } catch {} }
    else if (l.startsWith('MOSTRAR_PAGO:')) mostrarPago = l.includes('true');
    else if (l.startsWith('APLICAR_CUPON:')) aplicarCupon = l.replace('APLICAR_CUPON:', '').trim();
    else if (l.startsWith('NOMBRE_CLIENTE:')) nombreCliente = l.replace('NOMBRE_CLIENTE:', '').trim();
    else msg.push(l);
  }

  const mensajeFinal = msg.join('\n').trim();
  conv.etapa = etapa;

  if (pedidoJSON) {
    conv.pedido = { ...conv.pedido, ...pedidoJSON };
    if (pedidoJSON.items?.length > 0) {
      conv.pedido.subtotal = pedidoJSON.items.reduce((a, i) => a + (i.precio * i.cantidad), 0);
      conv.pedido.total = conv.pedido.subtotal - (conv.pedido.descuento || 0) + (conv.pedido.costo_delivery || 0);
    }
  }

  // Aplicar cupon si existe
  if (aplicarCupon && aplicarCupon.length > 2) {
    const resultCupon = validarCupon(aplicarCupon, conv.pedido.subtotal);
    if (resultCupon.valido) {
      conv.pedido.descuento = resultCupon.descuento;
      conv.pedido.total = conv.pedido.subtotal - conv.pedido.descuento + (conv.pedido.costo_delivery || 0);
      conv.pedido.cupon = aplicarCupon;
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

    if (negocio.modo_vacaciones) { await enviarMensaje(numero, negocio.mensaje_vacaciones || `Hola! ${negocio.nombre} esta de vacaciones. Volvemos pronto!`); return; }
    if (!estaEnHorario()) {
      const dias = ['Domingo', 'Lunes', 'Martes', 'Miercoles', 'Jueves', 'Viernes', 'Sabado'];
      await enviarMensaje(numero, `Hola! ${negocio.nombre} esta fuera de horario.\n\nAtencion: ${HORARIO.dias.map(d => dias[d]).join(', ')}\n8:00 am - 6:00 pm`);
      return;
    }

    const conv = getOrCreateConversacion(numero, negocio);
    const cliente = obtenerCliente(numero);

    // Detectar codigo de referido en primer mensaje
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      const textoRef = mensaje.text?.body?.trim() || '';
      if (textoRef.toUpperCase().startsWith('REF')) {
        const dueno = procesarReferido(textoRef, numero);
        if (dueno) {
          await enviarMensaje(dueno, `Alguien uso tu codigo de referido! Tienes un descuento de $5 para tu proximo pedido.`);
          actualizarCliente(numero, { codigo_referido_usado: textoRef });
        }
      }
    }

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
            if (conv.pedido.cupon) usarCupon(conv.pedido.cupon);
            const puntosGanados = agregarPuntos(numero, conv.pedido.total, `Pedido en ${negocio.nombre}`);
            const puntosActuales = obtenerPuntos(numero).total;
            const repartidor = conv.pedido.es_domicilio ? asignarRepartidor(negocio) : null;
            if (repartidor) {
              conv.pedido.repartidor = repartidor.nombre;
              await enviarMensaje(repartidor.whatsapp, `Nuevo pedido!\nCliente: ${conv.pedido.nombre_cliente || numero}\nDireccion: ${conv.pedido.direccion}\nTotal: $${conv.pedido.total?.toFixed(2)}`);
            }
            const msgConfirm = `Pago verificado! Tu pedido en ${negocio.nombre} esta confirmado!\n\n${repartidor ? `Repartidor: ${repartidor.nombre}\nTiempo estimado: ${negocio.tiempo_entrega || '30-45 min'}` : conv.pedido.es_domicilio ? `Tiempo estimado: ${negocio.tiempo_entrega || '30-45 min'}` : 'Puedes pasar a retirarlo cuando gustes.'}\n\nGanaste ${puntosGanados} puntos! Total: ${puntosActuales} pts${puntosActuales >= PUNTOS_PARA_REGALO ? '\n\nTienes puntos suficientes para un producto gratis! Escribe "canjear puntos" para reclamar.' : ''}\n\nGracias por tu compra!`;
            await enviarMensaje(numero, msgConfirm);
            registrarPedido(numero, conv.pedido, negocio.nombre);
            await notificarDueno(conv, negocio);
          } else {
            conv.intentos_boucher++;
            if (conv.intentos_boucher >= 3) {
              await enviarMensaje(numero, `No pudimos verificar tu pago. Contacta a ${negocio.nombre} directamente.`);
            } else {
              await enviarMensaje(numero, `No pude verificar el comprobante.\nMotivo: ${resultado.motivo}\n\nEnvia el comprobante del ${negocio.banco} por $${conv.pedido.total?.toFixed(2)} (intento ${conv.intentos_boucher}/3)`);
            }
          }
        } catch (e) { await enviarMensaje(numero, 'No pude procesar la imagen. Intenta de nuevo.'); }
      } else {
        await enviarMensaje(numero, 'Gracias por la imagen! En que puedo ayudarte?');
      }
      return;
    }

    if (tipo === 'audio') { await enviarMensaje(numero, 'Solo puedo atenderte por texto. Que necesitas?'); return; }
    if (tipo === 'document') {
      if (conv.esperando === 'boucher') await enviarMensaje(numero, 'Necesito el comprobante como imagen (foto o captura).');
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
    const textoLower = texto.toLowerCase();

    // Comandos
    if (['cancelar', 'cancel'].includes(textoLower)) {
      if (conv.etapa === 'confirmado') { await enviarMensaje(numero, 'Tu pedido ya fue confirmado. Contacta al negocio si necesitas ayuda.'); }
      else { conversaciones.delete(`${numero}:${negocio.id}`); await enviarMensaje(numero, 'Pedido cancelado. Escribe cuando necesites algo!'); }
      return;
    }
    if (textoLower === 'mi pedido' || textoLower === 'ver pedido') {
      if (conv.pedido.items?.length > 0) await enviarResumenPedido(numero, conv);
      else await enviarMensaje(numero, 'No tienes productos aun. Que te gustaria ordenar?');
      return;
    }
    if (textoLower === 'mis compras' || textoLower === 'historial') {
      const c = cargarClientes()[numero];
      if (c?.historial_pedidos?.length > 0) {
        let hist = 'Tu historial:\n\n';
        c.historial_pedidos.slice(-5).forEach((p, i) => { hist += `${i + 1}. ${new Date(p.fecha).toLocaleDateString('es-EC')} - ${p.descripcion} ($${p.total})\n`; });
        hist += `\nTotal gastado: $${c.total_gastado?.toFixed(2) || '0.00'}\nTotal pedidos: ${c.total_pedidos}`;
        await enviarMensaje(numero, hist);
      } else { await enviarMensaje(numero, 'Aun no tienes pedidos. Animete a hacer tu primer pedido!'); }
      return;
    }
    if (textoLower === 'mis puntos' || textoLower === 'puntos') {
      const p = obtenerPuntos(numero);
      await enviarMensaje(numero, `Tus puntos: ${p.total} pts\nTotal canjeados: ${p.canjeados} pts\n\nNecesitas ${PUNTOS_PARA_REGALO - p.total > 0 ? PUNTOS_PARA_REGALO - p.total : 0} puntos mas para un producto gratis!\n\nGanas ${PUNTOS_POR_DOLAR} puntos por cada $1 gastado.`);
      return;
    }
    if (textoLower === 'canjear puntos') {
      const p = obtenerPuntos(numero);
      if (p.total >= PUNTOS_PARA_REGALO) {
        if (canjearPuntos(numero, PUNTOS_PARA_REGALO)) {
          await enviarMensaje(numero, `Felicidades! Canjeaste ${PUNTOS_PARA_REGALO} puntos por un producto gratis!\n\nDinos que producto del catalogo quieres y lo agregaremos a tu proximo pedido sin costo.`);
          await enviarMensaje(negocio.whatsapp_dueno, `Cliente ${numero} canjeo ${PUNTOS_PARA_REGALO} puntos por producto gratis!`);
        }
      } else {
        await enviarMensaje(numero, `Aun no tienes suficientes puntos. Te faltan ${PUNTOS_PARA_REGALO - p.total} puntos.\n\nSigue comprando para acumular mas!`);
      }
      return;
    }
    if (textoLower === 'mi referido' || textoLower === 'codigo referido') {
      const codigo = generarCodigoReferido(numero);
      const refs = cargarReferidos()[numero];
      await enviarMensaje(numero, `Tu codigo de referido: ${codigo}\n\nComparte este codigo con tus amigos. Cuando hagan su primer pedido usando tu codigo, ganaras $5 de descuento!\n\nReferidos exitosos: ${refs?.referidos?.length || 0}\nDescuento ganado: $${refs?.descuento_ganado || 0}`);
      return;
    }
    if (textoLower === 'promociones' || textoLower === 'ofertas') {
      const promos = cargarPromociones().filter(p => p.activa);
      const fechaEsp = obtenerFechaEspecial();
      let msg = '';
      if (fechaEsp) msg += `FECHA ESPECIAL: ${fechaEsp.nombre}\n${fechaEsp.descuento}% de descuento en todos los productos!\n\n`;
      if (promos.length > 0) { msg += 'Promociones disponibles:\n\n'; promos.forEach(p => { msg += `${p.emoji || ''} ${p.nombre}\n${p.descripcion}\n${p.descuento}\n\n`; }); }
      if (!msg) msg = 'No hay promociones activas en este momento.';
      await enviarMensaje(numero, msg);
      return;
    }
    if (textoLower === 'horario') { await enviarMensaje(numero, `Horario de ${negocio.nombre}:\n\nLunes a Sabado: 8am - 6pm\nDomingos: Cerrado`); return; }
    if (textoLower === 'devoluciones' || textoLower === 'politica de devoluciones') {
      await enviarMensaje(numero, negocio.politica_devoluciones || `Politica de devoluciones:\n\n- 24 horas para reportar problemas.\n- Productos en estado original.\n- Contactanos por este WhatsApp.`);
      return;
    }

    // Bienvenida
    if (conv.etapa === 'inicio' && conv.historial.length === 0) {
      let bienvenida = '';
      const fechaEsp = obtenerFechaEspecial();
      if (cliente.es_frecuente) {
        bienvenida = `Hola de nuevo${cliente.nombre ? ', ' + cliente.nombre : ''}! Que gusto verte otra vez en ${negocio.nombre}!`;
      } else if (cliente.total_pedidos > 0) {
        bienvenida = `Hola${cliente.nombre ? ', ' + cliente.nombre : ''}! Bienvenido/a de vuelta a ${negocio.nombre}.`;
      } else {
        bienvenida = negocio.mensajes?.bienvenida || `Hola! Bienvenido/a a ${negocio.nombre}. En que puedo ayudarte?`;
      }
      if (fechaEsp) bienvenida += `\n\nEsta semana celebramos ${fechaEsp.nombre} con ${fechaEsp.descuento}% de descuento especial!`;
      await enviarMensaje(numero, bienvenida);
      conv.etapa = 'consultando';
      const saludos = ['hola', 'buenas', 'hi', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'ola'];
      if (!saludos.includes(textoLower) && texto.length > 6) {
        const { mensaje: r, imagenesIds } = await procesarConClaude(conv, negocio, texto, cliente);
        if (r) await enviarMensaje(numero, r);
        if (imagenesIds?.length > 0 && conv.etapa !== 'pago') for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);
      }
      return;
    }

    if (conv.esperando === 'boucher') { await enviarMensaje(numero, `Estoy esperando tu comprobante. Envia una foto del ${negocio.banco} por $${conv.pedido.total?.toFixed(2) || '0.00'}`); return; }

    const { mensaje: respuesta, imagenesIds, mostrarPago } = await procesarConClaude(conv, negocio, texto, cliente);
    if (respuesta) await enviarMensaje(numero, respuesta);
    if (imagenesIds?.length > 0 && conv.etapa !== 'pago' && conv.etapa !== 'confirmado') for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p);

    if ((conv.etapa === 'pago' || mostrarPago) && conv.esperando !== 'boucher') {
      await new Promise(r => setTimeout(r, 500));
      await enviarResumenPedido(numero, conv);
      await new Promise(r => setTimeout(r, 500));
      await enviarMensaje(numero, generarMensajePago(conv, negocio));
      if (conv.pedido.metodo_pago === 'efectivo') {
        conv.etapa = 'confirmado';
        const puntosGanados = agregarPuntos(numero, conv.pedido.total, `Pedido en ${negocio.nombre}`);
        registrarPedido(numero, conv.pedido, negocio.nombre);
        await notificarDueno(conv, negocio);
        await enviarMensaje(numero, `Ganaste ${puntosGanados} puntos! Total: ${obtenerPuntos(numero).total} pts`);
      } else { conv.esperando = 'boucher'; }
    }

    if (conv.etapa === 'cancelado') conversaciones.delete(`${numero}:${negocio.id}`);

  } catch (err) { console.error('Error en webhook:', err.message); }
});

// ─── API ADMIN ────────────────────────────────────────────────────────────────
app.get('/admin/negocios', (req, res) => res.json(cargarNegocios()));
app.post('/admin/negocios', (req, res) => {
  const negocios = cargarNegocios();
  const nuevo = { id: 'negocio_' + Date.now(), activo: true, catalogo: [], modo_vacaciones: false, tiempo_entrega: '30-45 minutos', politica_devoluciones: '', mensajes: { bienvenida: 'Hola! Bienvenido/a. En que puedo ayudarte?', tono: 'amigable' }, ...req.body };
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
app.delete('/admin/negocios/:id', (req, res) => { guardarJSON('./negocios.json', cargarNegocios().filter(n => n.id !== req.params.id)); res.json({ ok: true }); });
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
app.get('/admin/puntos', (req, res) => res.json(cargarPuntos()));
app.get('/admin/cupones', (req, res) => res.json(cargarCupones()));
app.post('/admin/cupones', (req, res) => {
  const cupones = cargarCupones();
  const nuevo = { id: 'cupon_' + Date.now(), activo: true, usos_actuales: 0, ...req.body };
  cupones.push(nuevo);
  guardarJSON('./cupones.json', cupones);
  res.json({ ok: true, cupon: nuevo });
});
app.delete('/admin/cupones/:id', (req, res) => { guardarJSON('./cupones.json', cargarCupones().filter(c => c.id !== req.params.id)); res.json({ ok: true }); });
app.get('/admin/referidos', (req, res) => res.json(cargarReferidos()));
app.get('/admin/repartidores', (req, res) => res.json(cargarRepartidores()));
app.post('/admin/repartidores', (req, res) => {
  const reps = cargarRepartidores();
  const nuevo = { id: 'rep_' + Date.now(), activo: true, disponible: true, ...req.body };
  reps.push(nuevo);
  guardarJSON('./repartidores.json', reps);
  res.json({ ok: true });
});
app.get('/admin/promociones', (req, res) => res.json(cargarPromociones()));
app.post('/admin/promociones', (req, res) => {
  const promos = cargarPromociones();
  promos.push({ id: 'promo_' + Date.now(), activa: true, ...req.body });
  guardarJSON('./promociones.json', promos);
  res.json({ ok: true });
});
app.delete('/admin/promociones/:id', (req, res) => { guardarJSON('./promociones.json', cargarPromociones().filter(p => p.id !== req.params.id)); res.json({ ok: true }); });

// Envío masivo
app.post('/admin/masivo', async (req, res) => {
  const { mensaje, solo_frecuentes } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
  const clientes = cargarClientes();
  let enviados = 0;
  const lista = Object.values(clientes).filter(c => c.total_pedidos > 0 && (!solo_frecuentes || c.es_frecuente));
  res.json({ ok: true, total: lista.length, mensaje: 'Enviando en segundo plano...' });
  for (const cliente of lista) {
    await enviarMensaje(cliente.numero, mensaje);
    enviados++;
    await new Promise(r => setTimeout(r, 1500)); // Evitar spam
    if (enviados % 10 === 0) console.log(`Masivo: ${enviados}/${lista.length} enviados`);
  }
  console.log(`Envio masivo completado: ${enviados} mensajes`);
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
    total_puntos_activos: Object.values(cargarPuntos()).reduce((a, p) => a + p.total, 0),
    cupones_activos: cargarCupones().filter(c => c.activo).length,
  });
});
app.get('/', (req, res) => res.json({ status: 'VendeBot v6.0 activo', conversaciones: conversaciones.size, en_horario: estaEnHorario() }));


// ─── AUTENTICACIÓN ────────────────────────────────────────────────────────────
const crypto = require('crypto');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vendebot2024admin';
const tokens = new Map();

function generarToken() { return crypto.randomBytes(32).toString('hex'); }
function verificarToken(token) { return tokens.has(token) && Date.now() - tokens.get(token).tiempo < 24 * 60 * 60 * 1000; }
function verificarTokenPanel(token, slug) { const t = tokens.get(token); return t && t.slug === slug && Date.now() - t.tiempo < 24 * 60 * 60 * 1000; }

app.post('/auth/admin', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    const token = generarToken();
    tokens.set(token, { tipo: 'admin', tiempo: Date.now() });
    res.json({ ok: true, token });
  } else res.json({ ok: false });
});

app.post('/auth/panel/:slug', (req, res) => {
  const negocios = cargarNegocios();
  const negocio = negocios.find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (negocio && req.body.password === negocio.password) {
    const token = generarToken();
    tokens.set(token, { tipo: 'panel', slug: req.params.slug, tiempo: Date.now() });
    res.json({ ok: true, token });
  } else res.json({ ok: false });
});

app.get('/auth/verify', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const t = tokens.get(token);
  res.json({ ok: t?.tipo === 'admin' && verificarToken(token) });
});

app.get('/auth/verify-panel/:slug', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  res.json({ ok: verificarTokenPanel(token, req.params.slug) });
});

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const t = tokens.get(token);
  if (t?.tipo === 'admin' && verificarToken(token)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

function authPanel(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (verificarTokenPanel(token, req.params.slug)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// ─── RUTAS DE PANELES ─────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile('admin.html', { root: '.' }));
app.get('/panel/:slug', (req, res) => res.sendFile('panel.html', { root: '.' }));

// Panel routes
app.get('/panel/:slug/negocio', authPanel, (req, res) => {
  const n = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  res.json(n || {});
});
app.put('/panel/:slug/negocio', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx] = { ...negocios[idx], ...req.body };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.get('/panel/:slug/stats', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json({});
  const clientes = cargarClientes();
  const todos = Object.values(clientes).filter(c => c.historial_pedidos?.some(p => p.negocio === negocio.nombre));
  const hoy = horaActual().toLocaleDateString('es-EC');
  res.json({
    ventas_hoy: todos.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total||0), 0)||0), 0),
    pedidos_hoy: todos.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length||0), 0),
    total_clientes: todos.length,
    clientes_frecuentes: todos.filter(c => c.es_frecuente).length,
  });
});
app.get('/panel/:slug/clientes', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json({});
  const clientes = cargarClientes();
  const filtrado = {};
  for (const [num, c] of Object.entries(clientes)) {
    if (c.historial_pedidos?.some(p => p.negocio === negocio.nombre)) filtrado[num] = c;
  }
  res.json(filtrado);
});
app.get('/panel/:slug/promociones', authPanel, (req, res) => res.json(cargarPromociones()));
app.post('/panel/:slug/promociones', authPanel, (req, res) => {
  const promos = cargarPromociones();
  promos.push({ id: 'promo_' + Date.now(), activa: true, ...req.body });
  guardarJSON('./promociones.json', promos);
  res.json({ ok: true });
});
app.delete('/panel/:slug/promociones/:id', authPanel, (req, res) => {
  guardarJSON('./promociones.json', cargarPromociones().filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});
app.get('/panel/:slug/cupones', authPanel, (req, res) => res.json(cargarCupones()));
app.post('/panel/:slug/cupones', authPanel, (req, res) => {
  const cupones = cargarCupones();
  cupones.push({ id: 'cupon_' + Date.now(), activo: true, usos_actuales: 0, ...req.body });
  guardarJSON('./cupones.json', cupones);
  res.json({ ok: true });
});
app.delete('/panel/:slug/cupones/:id', authPanel, (req, res) => {
  guardarJSON('./cupones.json', cargarCupones().filter(c => c.id !== req.params.id));
  res.json({ ok: true });
});
app.get('/panel/:slug/repartidores', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  res.json(cargarRepartidores().filter(r => r.negocio_id === negocio?.id));
});
app.post('/panel/:slug/repartidores', authPanel, (req, res) => {
  const reps = cargarRepartidores();
  reps.push({ id: 'rep_' + Date.now(), activo: true, disponible: true, ...req.body });
  guardarJSON('./repartidores.json', reps);
  res.json({ ok: true });
});
app.delete('/panel/:slug/repartidores/:id', authPanel, (req, res) => {
  guardarJSON('./repartidores.json', cargarRepartidores().filter(r => r.id !== req.params.id));
  res.json({ ok: true });
});
app.post('/panel/:slug/masivo', authPanel, async (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const { mensaje, solo_frecuentes } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
  const clientes = cargarClientes();
  const lista = Object.values(clientes).filter(c => c.total_pedidos > 0 && c.historial_pedidos?.some(p => p.negocio === negocio.nombre) && (!solo_frecuentes || c.es_frecuente));
  res.json({ ok: true, total: lista.length });
  for (const c of lista) { await enviarMensaje(c.numero, mensaje); await new Promise(r => setTimeout(r, 1500)); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`VendeBot v6.0 iniciado en puerto ${PORT}`));
