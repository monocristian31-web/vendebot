require('dotenv').config();
const { Pool } = require('pg');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});


// ─── POSTGRESQL ───────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// Crear tablas si no existen
async function inicializarDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS datos (
      clave TEXT PRIMARY KEY,
      valor JSONB NOT NULL
    )
  `);
  console.log('✓ PostgreSQL conectado');
}

// Guardar tokens en DB cada 2 minutos para sobrevivir reinicios
setInterval(async () => {
  try {
    const tokensObj = {};
    for (const [k, v] of tokens.entries()) tokensObj[k] = v;
    await guardarDB('_tokens', tokensObj);
  } catch {}
}, 2 * 60 * 1000);

// Restaurar tokens desde DB
async function restaurarTokens() {
  try {
    const r = await db.query("SELECT valor FROM datos WHERE clave = '_tokens'");
    if (r.rows.length > 0) {
      const tokensObj = r.rows[0].valor;
      for (const [k, v] of Object.entries(tokensObj)) {
        // Solo restaurar si no expiraron (7 días)
        if (Date.now() - v.tiempo < 7 * 24 * 60 * 60 * 1000) {
          tokens.set(k, v);
        }
      }
      console.log('✓ Tokens restaurados:', tokens.size);
    }
  } catch {}
}

// Reemplaza cargarJSON — lee de Postgres, cae a archivo si falla
async function cargarDB(clave, defecto) {
  try {
    const r = await db.query('SELECT valor FROM datos WHERE clave = ', [clave]);
    if (r.rows.length > 0) return r.rows[0].valor;
  } catch {}
  // Fallback a archivo local
  try { return JSON.parse(fs.readFileSync('./' + clave + '.json', 'utf8')); } catch {}
  return defecto;
}

// Reemplaza guardarJSON — escribe en Postgres Y en archivo local (doble seguridad)
async function guardarDB(clave, data) {
  try {
    await db.query(
      'INSERT INTO datos (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = $2',
      [clave, JSON.stringify(data)]
    );
  } catch (e) { console.error('Error guardando en DB:', e.message); }
  // También guardar en archivo como backup
  try { fs.writeFileSync('./' + clave + '.json', JSON.stringify(data, null, 2)); } catch {}
}

const app = express();
app.use(express.json());
app.use(express.static('.', { extensions: [], index: false }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── SESIONES BAILEYS (una por negocio) ───────────────────────────────────────
const sesiones = new Map();
const mensajesProcesados = new Set(); // anti-duplicado // negocioId → { sock, qr, estado }

// ─── SESIONES PERSISTENTES EN POSTGRESQL ─────────────────────────────────────
async function initSessionTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS wa_sessions (
        negocio_id TEXT NOT NULL,
        file_key   TEXT NOT NULL,
        data       TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (negocio_id, file_key)
      )
    `);
    console.log('[Sessions] Tabla wa_sessions lista');
  } catch(e) { console.error('[Sessions] Error creando tabla:', e.message); }
}
initSessionTable();

async function usePostgresAuthState(negocioId) {
  const readData = async (key) => {
    try {
      const r = await db.query('SELECT data FROM wa_sessions WHERE negocio_id=$1 AND file_key=$2', [negocioId, key]);
      if (r.rows.length) return JSON.parse(r.rows[0].data, BufferJSON.reviver);
    } catch(e) {}
    return null;
  };

  const writeData = async (key, data) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await db.query(`
        INSERT INTO wa_sessions (negocio_id, file_key, data, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (negocio_id, file_key) DO UPDATE SET data=$3, updated_at=NOW()
      `, [negocioId, key, serialized]);
    } catch(e) { console.error('[Sessions] Error guardando:', key, e.message); }
  };

  const removeData = async (key) => {
    try { await db.query('DELETE FROM wa_sessions WHERE negocio_id=$1 AND file_key=$2', [negocioId, key]); } catch(e) {}
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async id => {
            const val = await readData(type + '--' + id);
            data[id] = val;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              tasks.push(val ? writeData(category + '--' + id, val) : removeData(category + '--' + id));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => { await writeData('creds', creds); }
  };
}

function dirSesion(negocioId) {
  const d = path.join('./sessions', negocioId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

async function iniciarSesion(negocio) {
  const id = negocio.id;
  if (sesiones.has(id) && sesiones.get(id).estado === 'conectado') return;

  const { state, saveCreds } = await usePostgresAuthState(id);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['VendeBot', 'Chrome', '1.0'],
  });

  sesiones.set(id, { sock, qr: null, estado: 'conectando' });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Convertir QR a imagen base64 para mostrar en el panel
      const QRCode = require('qrcode');
      const qrBase64 = await QRCode.toDataURL(qr);
      sesiones.get(id).qr = qrBase64;
      sesiones.get(id).estado = 'qr';
      console.log(`QR generado para negocio: ${negocio.nombre}`);
      notificarPanel(negocio.slug || id, { tipo: 'qr_actualizado', qr: qrBase64 });
    }

    if (connection === 'open') {
      sesiones.get(id).estado = 'conectado';
      sesiones.get(id).qr = null;
      console.log(`✅ WhatsApp conectado: ${negocio.nombre}`);
      notificarPanel(negocio.slug || id, { tipo: 'whatsapp_conectado' });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : null;
      const QR_TIMEOUT = 408;
      const debeReconectar = statusCode !== DisconnectReason.loggedOut && statusCode !== QR_TIMEOUT;
      console.log(`WhatsApp desconectado (${negocio.nombre}): código ${statusCode}`);
      sesiones.get(id).estado = 'desconectado';
      notificarPanel(negocio.slug || id, { tipo: 'whatsapp_desconectado' });

      if (debeReconectar) {
        console.log(`Reconectando ${negocio.nombre} en 10s...`);
        // Notificar al dueño que el bot se desconectó (solo si no fue logout voluntario)
        try {
          if (negocio.whatsapp_dueno) {
            // Usamos otra sesión activa para notificar, o lo logueamos si no hay ninguna
            const otraSesion = [...sesiones.values()].find(s => s.estado === 'conectado' && s !== sesiones.get(id));
            if (otraSesion) {
              const jid = `${negocio.whatsapp_dueno.replace(/\D/g, '')}@s.whatsapp.net`;
              await otraSesion.sock.sendMessage(jid, { text: `⚠️ El bot de *${negocio.nombre}* se desconectó. Reconectando automáticamente...\n\nSi no vuelve en 2 minutos, ve al panel y haz clic en "Reconectar WhatsApp".` });
            }
          }
        } catch {}
        setTimeout(() => iniciarSesion(negocio), 10000);
      } else {
        // Sesión cerrada (logout/401) — borrar credenciales de archivos Y PostgreSQL
        sesiones.delete(id);
        try { fs.rmSync(dirSesion(id), { recursive: true }); } catch {}
        try { await db.query('DELETE FROM wa_sessions WHERE negocio_id=$1', [id]); } catch {}
        console.log('[Sessions] Credenciales borradas para:', id);
        // Notificar al dueño que debe volver a escanear el QR
        try {
          const otraSesion = [...sesiones.values()].find(s => s.estado === 'conectado');
          if (otraSesion && negocio.whatsapp_dueno) {
            const jid = `${negocio.whatsapp_dueno.replace(/\D/g, '')}@s.whatsapp.net`;
            await otraSesion.sock.sendMessage(jid, { text: `⚠️ El bot de *${negocio.nombre}* fue desconectado manualmente.\n\nPara reactivarlo ve al panel y escanea el QR nuevamente.` });
          }
        } catch {}
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      // Anti-duplicado: ignorar si ya procesamos este mensaje
      const msgId = msg.key.id;
      if (mensajesProcesados.has(msgId)) continue;
      mensajesProcesados.add(msgId);
      setTimeout(() => mensajesProcesados.delete(msgId), 60000); // limpiar en 1 min
      await procesarMensajeBaileys(msg, negocio, sock);
    }
  });
}

// Iniciar sesiones de todos los negocios activos al arrancar
async function iniciarTodasLasSesiones() {
  const negocios = cargarNegocios().filter(n => n.activo);
  for (const negocio of negocios) {
    await iniciarSesion(negocio);
    await new Promise(r => setTimeout(r, 2000)); // pequeña pausa entre sesiones
  }
}

// ─── ENVÍO MENSAJES (Baileys) ─────────────────────────────────────────────────
async function enviarMensaje(numero, mensaje, negocioId) {
  if (!mensaje?.trim()) return;
  const sesion = negocioId ? sesiones.get(negocioId) : [...sesiones.values()][0];
  if (!sesion?.sock || sesion.estado !== 'conectado') {
    console.error(`Sin sesión activa para enviar a ${numero}`);
    return;
  }
  try {
    const jid = numero.includes('@') ? numero : `${numero.replace(/\D/g, '')}@s.whatsapp.net`;
    await sesion.sock.sendMessage(jid, { text: mensaje });
  } catch (err) { console.error(`Error enviando: ${err.message}`); }
}

async function enviarImagen(numero, url, caption, negocioId) {
  const sesion = negocioId ? sesiones.get(negocioId) : [...sesiones.values()][0];
  if (!sesion?.sock || sesion.estado !== 'conectado') return;
  try {
    const jid = numero.includes('@') ? numero : `${numero.replace(/\D/g, '')}@s.whatsapp.net`;
    await sesion.sock.sendMessage(jid, { image: { url }, caption: caption || '' });
  } catch (err) { console.error(`Error enviando imagen: ${err.message}`); }
}

// ─── LISTA BLANCA — ignorar números personales ────────────────────────────────
function estaEnListaBlanca(numero, negocio) {
  const lista = negocio.lista_blanca || [];
  const limpio = numero.replace(/\D/g, '');
  return lista.some(n => n.replace(/\D/g, '') === limpio);
}

// ─── LÓGICA DE NEGOCIO ───────────────────────────────────────────────────────
async function enviarProducto(numero, producto, negocio) {
  const stockInfo = producto.stock === 0 ? '\n⚠️ Últimas unidades' : '';
  const precio = '$' + producto.precio.toFixed(2);
  // Caption estilo vendedor humano, no lista de datos
  const caption = (producto.emoji ? producto.emoji + ' ' : '') + '*' + producto.nombre + '* — ' + precio +
    (producto.descripcion ? '\n' + producto.descripcion : '') + stockInfo;
  if (producto.imagen) await enviarImagen(numero, producto.imagen, caption);
  else await enviarMensaje(numero, caption);
  if (producto.modificadores?.length > 0 && negocio) {
    const slug = negocio.slug || negocio.id;
    const numeroLimpio = numero.replace(/\D/g, '');
    const link = `${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://vendebot-production.up.railway.app'}/personalizar/${slug}/${producto.id}?n=${numeroLimpio}`;
    await enviarMensaje(numero, `Personaliza este producto aqui:\n${link}`);
  }
  await new Promise(r => setTimeout(r, 800));
}

async function enviarResumenPedido(numero, conv) {
  const p = conv.pedido;
  if (!p.items?.length) return;
  let resumen = 'Tu pedido:\n\n';
  for (const item of p.items) {
    const precioConExtras = ((item.precio || 0) + (item.extras_precio || 0)) * item.cantidad;
    resumen += `${item.emoji || ''} ${item.nombre} x${item.cantidad} - $${precioConExtras.toFixed(2)}\n`;
    if (item.modificadores_txt) resumen += `   📝 ${item.modificadores_txt}\n`;
    if (item.mitad1) resumen += `   🍕 Mitad 1: ${item.mitad1}\n`;
    if (item.mitad2) resumen += `   🍕 Mitad 2: ${item.mitad2}\n`;
  }
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
    const total = conv.pedido.total?.toFixed(2) || '0.00';
    const billete = conv.pedido.cambio_solicitado || 0;
    const cambio = billete > 0 ? (billete - parseFloat(total)).toFixed(2) : null;
    let msg = `Perfecto! Pagarás en efectivo al momento de la entrega.\nTotal a pagar: $${total}`;
    if (cambio !== null && parseFloat(cambio) >= 0) msg += `\nBillete: $${billete.toFixed(2)}\nCambio que recibirás: $${cambio}`;
    else if (billete > 0) msg += `\nNota: El billete de $${billete.toFixed(2)} no cubre el total. Por favor prepara el monto exacto o un billete mayor.`;
    msg += `\n\n¡Tu pedido está confirmado! Te avisaremos cuando el repartidor esté en camino. 🛵`;
    return msg;
  }
  const banco = negocio.banco || 'Consultar con el negocio';
  const cuenta = negocio.numero_cuenta || 'Consultar con el negocio';
  const titular = negocio.titular_cuenta || negocio.nombre;
  const tipoCuenta = negocio.tipo_cuenta ? ('\nTipo: ' + negocio.tipo_cuenta) : '';
  return 'Datos para el pago:\n\nBanco: ' + banco + '\nCuenta: ' + cuenta + '\nTitular: ' + titular + tipoCuenta + '\nMonto exacto: $' + (conv.pedido.total ? conv.pedido.total.toFixed(2) : '0.00') + '\n\nEnviame el comprobante (foto) para confirmar.';
}

async function notificarDueno(conv, negocio) {
  const p = conv.pedido;
  const items = p.items?.map(i => {
    let linea = `  - ${i.nombre} x${i.cantidad} = $${(i.precio * i.cantidad).toFixed(2)}`;
    if (i.mitad1) linea += `\n     Mitad 1: ${i.mitad1}`;
    if (i.mitad2) linea += `\n     Mitad 2: ${i.mitad2}`;
    return linea;
  }).join('\n') || '';
  let infoPago = p.metodo_pago === 'efectivo' ? 'Efectivo' : 'Transferencia verificada';
  if (p.metodo_pago === 'efectivo' && p.cambio_solicitado > 0) {
    const cambio = (p.cambio_solicitado - (p.total || 0)).toFixed(2);
    infoPago += `\n💵 El cliente paga con $${p.cambio_solicitado.toFixed(2)} — llevar cambio de $${cambio}`;
  }
  const msg = `NUEVO PEDIDO - ${negocio.nombre}\n\nCliente: ${p.nombre_cliente || conv.numero}\nWhatsApp: ${conv.numero}\n\nDetalle:\n${items}\n${p.descuento > 0 ? `Descuento: -$${p.descuento.toFixed(2)}\n` : ''}Total: $${p.total?.toFixed(2) || '0.00'}\n${p.es_domicilio ? `Direccion: ${p.direccion}` : 'Retira en tienda'}${p.fecha_entrega ? `\nEntrega: ${p.fecha_entrega} ${p.hora_entrega || ''}` : ''}${p.notas ? `\nNotas: ${p.notas}` : ''}\nPago: ${infoPago}`;
  await enviarMensaje(negocio.whatsapp_dueno, msg);
}

function asignarRepartidor(negocio) {
  // Obtener repartidores del negocio (guardados dentro del negocio)
  const reps = (negocio.repartidores || []).filter(r => r.activo !== false);
  return reps.length ? reps[Math.floor(Math.random() * reps.length)] : null;
}

function obtenerRepartidoreActivos(negocio) {
  return (negocio.repartidores || []).filter(r => r.activo !== false);
}

async function validarBoucher(b64, mediaType, monto) {
  try {
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } }, { type: 'text', text: `Es comprobante bancario real y reciente por $${monto}? Solo JSON: {"valido":true,"motivo":""}` }] }] });
    return JSON.parse(r.content[0].text.trim().replace(/```json|```/g, ''));
  } catch { return { valido: false, motivo: 'No se pudo analizar' }; }
}

// ─── SUGERENCIAS PERSONALIZADAS ───────────────────────────────
function generarSugerencias(numero, catalogo) {
  const cliente = cargarClientes()[numero];
  if (!cliente?.historial_pedidos?.length) return [];
  const comprados = new Set();
  cliente.historial_pedidos.forEach(p => p.items?.forEach(i => comprados.add(i.nombre)));
  return (catalogo || []).filter(p => !comprados.has(p.nombre) && p.activo !== false).slice(0, 3);
}

async function procesarConClaude(conv, negocio, mensajeUsuario, cliente) {
  const catalogoTexto = (negocio.catalogo || []).map(p => {
    const stockInfo = p.stock !== undefined ? ` [Stock: ${p.stock}]` : '';
    const tieneImagen = p.imagen ? ' [📷 tiene foto]' : '';
    let txt = `  ID:${p.id} | ${p.emoji || ''} ${p.nombre} | $${p.precio.toFixed(2)}${stockInfo}${tieneImagen} | ${p.descripcion || ''}`;
    if (p.modificadores?.length > 0) {
      txt += '\n    EXTRAS/MODIFICADORES:';
      p.modificadores.forEach(g => {
        const ops = g.opciones.map(op => `"${op.nombre}"(+$${(op.precio||0).toFixed(2)})`).join(', ');
        txt += `\n      - ${g.nombre}${g.obligatorio ? ' (obligatorio)' : ''}: ${ops}`;
      });
    }
    return txt;
  }).join('\n');
  const promociones = cargarPromociones().filter(p => p.activa);
  const fechaEspecial = obtenerFechaEspecial();
  const promo_texto = promociones.length > 0 ? '\nPROMOCIONES:\n' + promociones.map(p => `  ${p.nombre}: ${p.descripcion} - ${p.descuento}`).join('\n') : '';
  const fecha_especial_texto = fechaEspecial ? `\nFECHA ESPECIAL: ${fechaEspecial.nombre} - ${fechaEspecial.descuento}% de descuento!` : '';
  const pedidoActual = conv.pedido.items?.length > 0 ? conv.pedido.items.map(i => `${i.nombre} x${i.cantidad}`).join(', ') : 'vacio';
  const puntos = obtenerPuntos(conv.numero);
  const sugerencias = generarSugerencias(conv.numero, negocio.catalogo);
  const sugerenciasTexto = sugerencias.length > 0 ? '\nPRODUCTOS SUGERIDOS PARA ESTE CLIENTE (no los ha comprado antes):\n' + sugerencias.map(p => `  - ${p.emoji || ''} ${p.nombre} $${p.precio.toFixed(2)}`).join('\n') : '';

  const system = `Eres el asistente virtual de ${negocio.nombre}, una ${negocio.tipo}. Atiendes por WhatsApp con tono cálido, profesional y paciente. Detecta el idioma del cliente (español o inglés) y responde SIEMPRE en ese idioma.
${sugerenciasTexto}

CATÁLOGO DISPONIBLE:
${catalogoTexto}
${promo_texto}
${fecha_especial_texto}

DATOS DEL CLIENTE:
- Nombre: ${cliente?.nombre || 'Desconocido'}
- Pedidos anteriores: ${cliente?.total_pedidos || 0}
- Cliente frecuente: ${cliente?.es_frecuente ? 'SÍ' : 'No'}
- Puntos: ${puntos.total} pts (necesita ${PUNTOS_PARA_REGALO} para producto gratis)

ESTADO ACTUAL DE LA CONVERSACIÓN:
- Etapa: ${conv.etapa}
- Pedido en curso: ${pedidoActual}
- Subtotal: $${conv.pedido.subtotal?.toFixed(2) || '0.00'}
- Descuento: $${conv.pedido.descuento?.toFixed(2) || '0.00'}
- Total: $${conv.pedido.total?.toFixed(2) || '0.00'}
- Método de pago: ${conv.pedido.metodo_pago || 'transferencia'}

═══════════════════════════════════════
REGLAS PRINCIPALES
═══════════════════════════════════════

1. CATÁLOGO Y PEDIDOS — FLUJO INTELIGENTE

   PASO 1 — PRIMERA INTERACCIÓN (etapa: inicio):
   Si el cliente saluda, pregunta qué tienen, dice que quiere pedir, o su intención es general:
   → Saluda calurosamente + manda el catálogo (ENVIAR_CATALOGO: true) + di algo como "Aquí puedes ver todo lo que tenemos, y si prefieres te asesoro yo directamente 😊"

   PASO 2 — EL CLIENTE IGNORÓ EL CATÁLOGO y escribe lo que quiere:
   Si ya mandaste el catálogo pero el cliente escribe una petición específica o pide ayuda personalizada:
   → Cambia a modo vendedor humano, olvídate del link, asesóralo directamente

   PASO 3 — ATENCIÓN DIRECTA sin catálogo cuando:
   - El cliente ya viene con pedido del catálogo web (mensaje empieza con "Hola! Quiero hacer un pedido 🛒") → PEDIDO_DESDE_CATALOGO: true
   - El cliente manda una foto de referencia desde el inicio → analiza y asesora directo
   - El cliente pregunta algo muy específico ("¿tienes rosas rojas?", "cuánto cuesta X") → responde directo
   - El cliente dice explícitamente "prefiero que me ayudes tú" o "no quiero el catálogo" → asesora directo

   REGLA CLAVE: ENVIAR_CATALOGO: true solo en el primer contacto general O si el cliente lo pide explícitamente. Una vez que el cliente muestra que prefiere atención directa, NUNCA vuelvas a mandar el link.
   Si producto sin stock, ofrece alternativas similares.

2. CONFIRMACIÓN DEL PEDIDO
   Al confirmar, pregunta en este orden (de a uno, no todo junto):
   a) Nombre del cliente
   b) ¿Domicilio o retira en tienda?
   c) Si es domicilio: dirección completa
   d) Fecha y hora de entrega: ${negocio.requiere_hora_entrega ? 'OBLIGATORIA — no avances sin hora exacta. Si dice "lo antes posible" responde: "¿A qué hora exacta necesitas que llegue?"' : 'OPCIONAL — si dice "lo antes posible", "ahora" o "hoy", acepta y usa tiempo estimado: ' + (negocio.tiempo_entrega || '30-45 min')}
   e) Método de pago (solo mostrar los activos): ${(negocio.metodos_pago || ['transferencia']).join(', ')}

3. PAGO
   - Transferencia: pon MOSTRAR_PAGO: true directo
   - Efectivo: pregunta "¿Con qué billete vas a pagar?" antes de MOSTRAR_PAGO: true. Guarda en cambio_solicitado.
   - Cupón mencionado: APLICAR_CUPON: [codigo]

4. PUNTOS Y PROMOCIONES
   - Si hay fecha especial activa, mencionala con entusiasmo
   - Si el cliente tiene puntos suficientes (${puntos.total} pts), sugiérele que puede canjear
   - Después de confirmar pedido, menciona los puntos que ganó

5. OTROS
   - Horario: ${negocio.horarios ? Object.entries(negocio.horarios).filter(([,h])=>h.abierto).map(([d,h])=>`${d}: ${h.desde}-${h.hasta}`).join(', ') || 'No configurado' : 'Lunes a Sábado 8am-6pm'}
   - Citas: si el cliente quiere agendar, dile que escriba "cita"${negocio.citas_config?.activo ? '. Servicios: ' + negocio.citas_config.servicios?.join(', ') : ''}
   - Cancelar: si el cliente quiere cancelar antes de confirmar, confírmalo amablemente

6. PEDIDO_JSON — CRÍTICO:
   - precio = precio base del producto SIN extras
   - extras_precio = suma de modificadores seleccionados
   - modificadores_txt = descripción textual (ej: "Con papas, Sin cebolla")
   - El subtotal DEBE incluir extras
   - Pizza mitad/mitad: mostrar "Mitad 1: X" y "Mitad 2: Y" para que el cliente confirme

═══════════════════════════════════════
MANEJO DE SITUACIONES REALES (MUY IMPORTANTE)
═══════════════════════════════════════

MENSAJES CONFUSOS O INCOMPLETOS:
- Escribe mal ("qiero 2 hambur con qeso", "rmo d rozas", "qnt csta"): interpreta con sentido común, NUNCA pidas que repita
- Solo emojis (🌹❤️): interpreta por contexto — en una floristería probablemente quiere rosas rojas
- Mensaje vacío o solo puntos: pregunta suavemente qué necesita, no hagas drama
- Mezcla idiomas ("I want un ramo please"): responde en el idioma principal del cliente
- Voz a texto con errores ("quisiera un ramo dé rosas rohas para mi nobia"): entiende la intención, no el error

RESPUESTAS VAGAS O AMBIGUAS:
- "sí", "dale", "ya", "ok", "bueno": asume que acepta lo último que propusiste y avanza
- "no sé", "sorpréndeme", "lo que recomiendas": toma el control, propón algo concreto basado en lo que sabes del cliente o en los más vendidos
- "el primero", "ese", "el de arriba": identifica a cuál se refiere por el contexto de la conversación
- "algo bonito", "algo rico", "lo normal": pregunta UNA cosa concreta para afinar ("¿para qué ocasión?" o "¿para cuántas personas?")
- "cuánto sale todo": suma el pedido actual y responde con el total desglosado
- Cliente que no responde una pregunta y cambia de tema: responde lo nuevo Y retoma la pregunta pendiente suavemente

CAMBIOS DE OPINIÓN Y PEDIDOS CAÓTICOS:
- Cambia de opinión ("mejor no, cámbialo por X"): actualiza sin drama, confirma el cambio
- Agrega cosas en cualquier momento ("ah y también quiero X"): agrégalo al pedido naturalmente
- Quiere quitar algo ("quita las cebollas"): actualiza y confirma
- Pide algo que ya tiene en el pedido ("quiero una hamburguesa" cuando ya tiene una): pregunta si quiere otra o se refiere a la misma
- Hace el pedido todo revuelto en un solo mensaje ("quiero 2 hamburguesas con queso y una sin queso y una cola y papas"): desglosa todo, confirma el resumen

CLIENTES DIFÍCILES:
- Grosero o frustrado ("esto es una mierda", "qué lento"): mantén calma total, sé empático, nunca te defiendas ni respondas con frialdad
- Impaciente ("ya pues", "cuánto demoras"): da información concreta del tiempo de entrega, no prometas lo que no puedes
- Desconfiado ("seguro me van a cobrar mal"): sé transparente, muestra el desglose del precio
- Exigente que quiere todo perfecto: muéstrate comprometido, anota las especificaciones con detalle
- Que dice que le cobraron mal antes: escucha, no discutas, ofrece hablar con el negocio si hay un problema real
- Que escribe TODO EN MAYÚSCULAS: no lo interpretes como agresión, responde normal
- Que te manda mensajes a las 3am: si el negocio está cerrado, avísale el horario amablemente

SITUACIONES ESPECIALES:
- "quiero lo mismo de siempre": si tiene historial, menciónalo. Si no, pide que especifique con humor ("¡Aún no nos conocemos tanto! ¿Qué sería lo de siempre? 😄")
- Cliente que pregunta algo que no sabes (horario exacto, ingredientes específicos): sé honesto — "eso mejor confirmarlo directamente con el negocio"
- Quiere negociar precio: los precios son fijos, pero menciona promociones o cupones si hay, sin ser rígido
- Pide algo que no está en catálogo: no digas simplemente "no tenemos" — busca lo más similar y ofrécelo
- Manda comprobante antes de tiempo: guárdalo en contexto, cuando llegue el momento úsalo
- Manda audio: "Solo puedo atenderte por texto o imagen, ¿me escribes lo que necesitas? 😊"
- Manda documento o archivo raro: ignora el archivo, responde naturalmente preguntando qué necesita
- Pregunta por redes sociales, dirección física, teléfono: comparte lo que está configurado en el negocio
- Se despide sin pedir nada ("gracias, bye"): despídete amablemente y deja la puerta abierta
- Manda "test", "hola", "prueba": responde normal como si fuera un cliente real

REGLAS DE ORO:
- NUNCA te quedes sin responder — siempre hay algo útil que decir
- NUNCA repitas exactamente el mismo mensaje dos veces
- NUNCA digas "no puedo ayudarte" sin ofrecer una alternativa
- NUNCA hagas más de UNA pregunta a la vez
- SIEMPRE mantén el hilo de la conversación aunque el cliente se vaya por las ramas
- Si llevas 3 mensajes sin entender al cliente: resume lo que entendiste y pregunta si vas bien

═══════════════════════════════════════
MODO VENDEDOR HUMANO — MUY IMPORTANTE
═══════════════════════════════════════

Eres un VENDEDOR HUMANO que conoce su catálogo de memoria. NO eres un menú interactivo.
Cuando el cliente quiere algo, TÚ lo asesoras como lo haría una persona real en una tienda.

COMPORTAMIENTO NATURAL:
- Si el cliente dice "quisiera algo para un cumpleaños" → pregunta qué tipo, presupuesto, para quién
- Cuando tengas suficiente info → muestra 2-3 opciones del catálogo con sus fotos usando ENVIAR_IMAGENES
- Habla como vendedor: "Mira, tenemos este ramo que es perfecto para eso..." / "Este le encanta a todo el mundo para cumpleaños..."
- Si el cliente dice "sí ese me gusta" o "el primero" → confirma cuál eligió y avanza al pedido
- Si el cliente manda foto de referencia: ya fue analizada, está en el historial — úsala y muestra los productos más parecidos de tu catálogo

CUÁNDO USAR ENVIAR_IMAGENES:
- Cuando presentes opciones al cliente: pon los IDs de los productos que mencionas
- Cuando el cliente pregunta "¿tienes X?": muestra el producto si existe
- Cuando hagas una propuesta personalizada: muestra los productos que la componen
- Máximo 3 imágenes a la vez para no abrumar
- SIEMPRE acompaña las imágenes con un texto tuyo explicando por qué ese producto es buena opción

CONSTRUIR PEDIDO CONVERSACIONALMENTE:
1. Cliente expresa lo que quiere (vago o específico)
2. Tú preguntas lo necesario (UNA pregunta a la vez): ocasión, presupuesto, preferencias, colores
3. Propones opciones concretas + muestras fotos (ENVIAR_IMAGENES)
4. Cliente elige → confirmas: "Perfecto, te anoto [producto] por $X, ¿algo más?"
5. Cierras el pedido naturalmente y avanzas a datos de entrega
6. Si algo no está en catálogo: "No tengo exactamente eso pero tengo algo muy similar..."
7. NUNCA le digas "ve al catálogo" — tú eres el catálogo

Al FINAL de cada respuesta escribe EXACTAMENTE esto (sin omitir nada):
ETAPA: [inicio|consultando|cotizando|confirmando|delivery|pago|confirmado|cancelado]
PEDIDO_JSON: {"items":[{"id":1,"nombre":"","precio":0,"cantidad":1,"emoji":"","extras_precio":0,"modificadores_txt":""}],"subtotal":0,"total":0,"es_domicilio":false,"nombre_cliente":"","direccion":"","fecha_entrega":"","hora_entrega":"","notas":"","metodo_pago":"transferencia","descuento":0,"cambio_solicitado":0}
ENVIAR_IMAGENES: []
MOSTRAR_PAGO: false
APLICAR_CUPON: 
NOMBRE_CLIENTE: `;

  conv.historial.push({ role: 'user', content: mensajeUsuario });
  const response = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages: conv.historial });
  const full = response.content[0].text;
  const lineas = full.split('\n');
  let msg = [], etapa = conv.etapa, pedidoJSON = null, imgs = [], mostrarPago = false, aplicarCupon = '', nombreCliente = '', enviarCatalogo = false, pedidoDesdeCatalogo = false;

  for (const l of lineas) {
    if (l.startsWith('ETAPA:')) etapa = l.replace('ETAPA:', '').trim();
    else if (l.startsWith('PEDIDO_JSON:')) { try { pedidoJSON = JSON.parse(l.replace('PEDIDO_JSON:', '').trim()); } catch {} }
    else if (l.startsWith('ENVIAR_IMAGENES:')) { try { imgs = JSON.parse(l.replace('ENVIAR_IMAGENES:', '').trim()); } catch {} }
    else if (l.startsWith('MOSTRAR_PAGO:')) mostrarPago = l.includes('true');
    else if (l.startsWith('APLICAR_CUPON:')) aplicarCupon = l.replace('APLICAR_CUPON:', '').trim();
    else if (l.startsWith('NOMBRE_CLIENTE:')) nombreCliente = l.replace('NOMBRE_CLIENTE:', '').trim();
    else if (l.startsWith('ENVIAR_CATALOGO:')) enviarCatalogo = l.includes('true');
    else if (l.startsWith('PEDIDO_DESDE_CATALOGO:')) pedidoDesdeCatalogo = l.includes('true');
    else msg.push(l);
  }

  const mensajeFinal = msg.join('\n').trim();
  conv.etapa = etapa;

  if (pedidoJSON) {
    conv.pedido = { ...conv.pedido, ...pedidoJSON };
    if (pedidoJSON.items?.length > 0) {
      // FIX: sumar precio base + extras de modificadores
      conv.pedido.subtotal = pedidoJSON.items.reduce((a, i) => {
        const precioTotal = ((i.precio || 0) + (i.extras_precio || 0)) * i.cantidad;
        return a + precioTotal;
      }, 0);
      conv.pedido.total = conv.pedido.subtotal - (conv.pedido.descuento || 0) + (conv.pedido.costo_delivery || 0);
    }
  }

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

  return { mensaje: mensajeFinal, imagenesIds: imgs, mostrarPago, enviarCatalogo, pedidoDesdeCatalogo };
}

// ─── PROCESAR MENSAJE ENTRANTE (Baileys) ──────────────────────────────────────
async function procesarMensajeBaileys(msg, negocioBase, sock) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@g.us')) return; // ignorar grupos

    // Número limpio sin @s.whatsapp.net
    const numero = jid.replace('@s.whatsapp.net', '');
    // Obtener negocio FRESCO del cache (por si el dueno cambio datos desde el panel)
    const negocio = cargarNegocios().find(n => n.id === negocioBase.id) || negocioBase;
    const enviar = (dest, texto) => enviarMensaje(dest, texto, negocio.id);

    // ── LISTA BLANCA: si el número está en la lista, el bot no responde ──
    if (estaEnListaBlanca(numero, negocio)) {
      return;
    }

    if (negocio.bot_activo === false) return;

    // Verificar suscripción activa
    if (negocio.suscripcion_activa === false) return;
    if (negocio.fecha_vencimiento) {
      const venc = new Date(negocio.fecha_vencimiento);
      venc.setHours(23, 59, 59, 999);
      if (new Date() > venc) return;
    }
    if (negocio.modo_vacaciones) {
      await enviar(numero, negocio.mensaje_vacaciones || negocio.mensajes?.vacaciones || ('Hola! ' + negocio.nombre + ' esta de vacaciones. Volvemos pronto!'));
      return;
    }
    if (!estaAbiertoAhora(negocio)) {
      // Armar horario dinámico desde el panel
      const zona = 'America/Guayaquil';
      const ahoraEC = new Date(new Date().toLocaleString('en-US', { timeZone: zona }));
      const diasNombres = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
      let horarioTexto = '';
      if (negocio.horarios) {
        const lineas = Object.entries(negocio.horarios)
          .filter(([, h]) => h && h.abierto)
          .map(([dia, h]) => dia + ': ' + h.desde + ' - ' + h.hasta);
        horarioTexto = lineas.length ? lineas.join('\n') : 'Horario no configurado';
      } else {
        horarioTexto = 'Lunes a Sábado: 8:00 - 18:00';
      }
      await enviar(numero, 'Hola! ' + negocio.nombre + ' esta fuera de horario en este momento.\n\nNuestro horario de atención:\n' + horarioTexto + '\n\nEscríbenos en horario de atención y con gusto te ayudamos!');
      return;
    }

    const conv = getOrCreateConversacion(numero, negocio);
    const cliente = obtenerCliente(numero);

    // Detectar tipo de mensaje
    const tipo = msg.message?.imageMessage ? 'image'
      : msg.message?.audioMessage ? 'audio'
      : msg.message?.documentMessage ? 'document'
      : msg.message?.locationMessage ? 'location'
      : msg.message?.conversation || msg.message?.extendedTextMessage ? 'text'
      : 'otro';

    // ── IMAGEN (comprobante de pago) ──
    if (tipo === 'image') {
      if (conv.esperando === 'boucher') {
        await enviar(numero, 'Analizando tu comprobante...');
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const b64 = buffer.toString('base64');
          const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
          const resultado = await validarBoucher(b64, mimeType, conv.pedido.total || 0);
          if (resultado.valido) {
            conv.etapa = 'confirmado'; conv.esperando = null;
            if (conv.pedido.cupon) usarCupon(conv.pedido.cupon);
            const puntosGanados = agregarPuntos(numero, conv.pedido.total, 'Pedido en ' + negocio.nombre);
            const puntosActuales = obtenerPuntos(numero).total;
            // Usar el repartidor ya asignado (cotizó el delivery), o asignar uno si no hay
            let repWhatsapp = conv.pedido.repartidor_whatsapp;
            let repNombre = conv.pedido.repartidor_nombre;
            if (!repWhatsapp && conv.pedido.es_domicilio) {
              const repAleatorio = asignarRepartidor(negocio);
              if (repAleatorio) { repWhatsapp = repAleatorio.whatsapp; repNombre = repAleatorio.nombre; }
            }
            // Notificar al repartidor asignado con todos los detalles
            if (repWhatsapp && conv.pedido.es_domicilio) {
              conv.pedido.repartidor = repNombre;
              const itemsRep = (conv.pedido.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad + (i.modificadores_txt ? ' (' + i.modificadores_txt + ')' : '')).join('\n');
              const msgRep = '🟢 *PAGO CONFIRMADO — IR A RECOGER*\n\n' +
                'Negocio: ' + negocio.nombre + '\n' +
                'Cliente: ' + (conv.pedido.nombre_cliente || numero) + '\n' +
                'WhatsApp cliente: ' + numero + '\n\n' +
                'Pedido:\n' + itemsRep + '\n\n' +
                'Total: $' + (conv.pedido.total || 0).toFixed(2) + '\n' +
                'Pago: ' + (conv.pedido.metodo_pago === 'efectivo' ? 'Efectivo' : 'Transferencia verificada') + '\n' +
                'Entrega: ' + (conv.pedido.fecha_entrega || 'Lo antes posible') + ' ' + (conv.pedido.hora_entrega || '') + '\n' +
                'Direccion: ' + (conv.pedido.direccion || '') + '\n\n' +
                (conv.pedido.notas ? 'Notas: ' + conv.pedido.notas + '\n\n' : '') +
                'Responde *CONFIRMAR* para confirmar que lo entregaras.';
              await enviarMensaje(repWhatsapp, msgRep, negocio.id);
              conv.pedido.esperando_confirmacion_rep = true;
              conv.pedido.confirmacion_rep_timestamp = Date.now();
            }
            const msgConfirm = 'Pago verificado! Tu pedido en ' + negocio.nombre + ' esta confirmado!\n\n' +
              (repNombre ? 'Repartidor: ' + repNombre + '\nTiempo estimado: ' + (negocio.tiempo_entrega || '30-45 min') : conv.pedido.es_domicilio ? 'Tiempo estimado: ' + (negocio.tiempo_entrega || '30-45 min') : 'Puedes pasar a retirarlo cuando gustes.') +
              '\n\nGanaste ' + puntosGanados + ' puntos! Total: ' + puntosActuales + ' pts' +
              (puntosActuales >= PUNTOS_PARA_REGALO ? '\n\nTienes puntos suficientes para un producto gratis! Escribe "canjear puntos" para reclamar.' : '') +
              '\n\nGracias por tu compra!';
            await enviar(numero, msgConfirm);
            registrarPedido(numero, conv.pedido, negocio.nombre);
            await notificarDueno(conv, negocio);
          } else {
            conv.intentos_boucher++;
            if (conv.intentos_boucher >= 3) {
              await enviar(numero, `No pudimos verificar tu pago. Contacta a ${negocio.nombre} directamente.`);
            } else {
              await enviar(numero, `No pude verificar el comprobante.\nMotivo: ${resultado.motivo}\n\nEnvia el comprobante del ${negocio.banco} por $${conv.pedido.total?.toFixed(2)} (intento ${conv.intentos_boucher}/3)`);
            }
          }
        } catch (e) { await enviar(numero, 'No pude procesar la imagen. Intenta de nuevo.'); }
      } else {
        // ── IMAGEN DE REFERENCIA — el cliente manda foto de lo que quiere ──
        await enviar(numero, '🔍 Analizando tu imagen...');
        try {
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          const b64 = buffer.toString('base64');
          const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';
          const caption = msg.message.imageMessage.caption || '';

          // Construir lista del catálogo para que Claude la use
          const catalogoResumen = (negocio.catalogo || [])
            .filter(p => p.activo !== false)
            .map(p => '- ' + (p.emoji || '') + ' ' + p.nombre + ' $' + p.precio.toFixed(2) + (p.descripcion ? ' (' + p.descripcion + ')' : ''))
            .join('\n');

          // Analizar la imagen con Claude Vision
          const analisis = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mimeType, data: b64 } },
                { type: 'text', text: `Eres el asistente de ${negocio.nombre}, una ${negocio.tipo}.
Un cliente te mandó esta imagen como referencia de lo que quiere${caption ? '. Su mensaje: "' + caption + '"' : ''}.

CATÁLOGO DISPONIBLE:
${catalogoResumen}

Tu tarea:
1. Describe brevemente lo que ves en la imagen (1-2 líneas, natural y cálido)
2. Identifica qué productos del catálogo se pueden usar para recrear o aproximarse a esto
3. Si faltan detalles (color, tamaño, presupuesto), haz UNA pregunta concreta para avanzar
4. Si puedes armar el pedido directo con lo del catálogo, propón la combinación

Responde de forma conversacional como si fueras un asesor humano experto en ${negocio.tipo}.
NO menciones que eres una IA. Sé entusiasta y útil.
Máximo 4 líneas de respuesta.` }
              ]
            }]
          });

          const respuestaAnalisis = analisis.content[0].text.trim();

          // Guardar la imagen en contexto para que el flujo continúe naturalmente
          conv.historial.push({
            role: 'user',
            content: `[El cliente mandó una foto de referencia${caption ? ' con el mensaje: "' + caption + '"' : ''}. Descripción de la imagen analizada por visión: ${respuestaAnalisis}]`
          });
          conv.imagen_referencia = true;

          await enviar(numero, respuestaAnalisis);
        } catch(e) {
          console.error('Error analizando imagen referencia:', e);
          await enviar(numero, '¡Recibí tu imagen! ¿Me puedes contar qué es lo que estás buscando? Así te ayudo mejor 😊');
        }
      }
      return;
    }

    if (tipo === 'audio') { await enviar(numero, 'Solo puedo atenderte por texto. Que necesitas?'); return; }
    if (tipo === 'document') {
      if (conv.esperando === 'boucher') await enviar(numero, 'Necesito el comprobante como imagen (foto o captura).');
      else await enviar(numero, 'Gracias! En que puedo ayudarte?');
      return;
    }
    if (tipo === 'location') {
      const loc = msg.message.locationMessage;
      conv.pedido.direccion = 'https://maps.google.com/?q=' + loc.degreesLatitude + ',' + loc.degreesLongitude;
      conv.pedido.es_domicilio = true;
      conv.esperando = 'costo_delivery';
      conv.etapa = 'delivery';
      // Recargar negocio fresco para tener repartidores actualizados
      const negocioFresco = cargarNegocios().find(n => n.id === negocio.id) || negocio;
      const reps = obtenerRepartidoreActivos(negocioFresco);
      console.log('[GPS] Repartidores encontrados:', reps.length, reps.map(r => r.nombre + ':' + r.whatsapp));
      if (reps.length > 0) {
        // Enviar cotización a TODOS los repartidores activos
        const itemsResumen = (conv.pedido.items || []).map(i => '• ' + i.nombre + ' x' + i.cantidad + (i.modificadores_txt ? ' (' + i.modificadores_txt + ')' : '')).join('\n');
        conv.pedido.repartidores_contactados = reps.map(r => r.whatsapp); // guardar todos
        conv.pedido.repartidor_whatsapp = null; // se asigna cuando responda
        conv.pedido.repartidor_nombre = null;
        for (const rep of reps) {
          await enviarMensaje(rep.whatsapp,
            '🛵 *Nuevo pedido — Cotización delivery*\n\n' +
            'Negocio: ' + negocio.nombre + '\n' +
            'Cliente: ' + (conv.pedido.nombre_cliente || numero) + '\n\n' +
            'Productos:\n' + itemsResumen + '\n\n' +
            'Ubicación del cliente:\n' + conv.pedido.direccion + '\n\n' +
            'Responde con el costo. Ej: *2.50*\n(El primero en responder queda asignado)',
            negocioFresco.id);
        }
        await enviar(numero, '📍 Ubicación recibida! Estamos cotizando el costo de delivery, te avisamos en un momento. 🛵');
      } else {
        conv.pedido.costo_delivery = 0;
        conv.esperando = null;
        conv.etapa = 'pago';
        await enviar(numero, 'Ubicacion recibida!\n\n' + generarMensajePago(conv, negocio));
        if (conv.pedido.metodo_pago !== 'efectivo') conv.esperando = 'boucher';
      }
      return;
    }

    if (tipo !== 'text') return;
    const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    if (!texto) return;
    const textoLower = texto.toLowerCase();

    // ── Calificación de reseña ──
    const clienteData = cargarClientes()[numero];
    const ultimoPedido = clienteData?.historial_pedidos?.[clienteData.historial_pedidos.length - 1];
    if (ultimoPedido?.esperando_resena && /^[1-5]$/.test(texto.trim())) {
      const calificacion = parseInt(texto.trim());
      const estrellas = '⭐'.repeat(calificacion);
      agregarResena(numero, negocio.nombre, calificacion, '', ultimoPedido.descripcion);
      ultimoPedido.esperando_resena = false;
      const todosClientes = cargarClientes();
      todosClientes[numero] = clienteData;
      guardarJSON('./clientes.json', todosClientes);
      await enviar(numero, `Gracias por tu calificacion ${estrellas}\n\nTu opinion nos ayuda a mejorar. Vuelve pronto!`);
      notificarPanel(negocio.slug || negocio.id, { tipo: 'nueva_resena', cliente: clienteData?.nombre || numero, calificacion });
      return;
    }

    // ── Respuesta del repartidor con costo delivery ──
    if (textoLower.startsWith('delivery $') || textoLower.startsWith('delivery$') || textoLower.match(/^delivery\s*\$/i)) {
      const costoMatch = texto.match(/delivery\s*\$?([0-9]+(?:\.[0-9]+)?)/i);
      if (costoMatch) {
        const costoDelivery = parseFloat(costoMatch[1]);
        // Buscar conversacion donde este repartidor fue contactado y aun no hay asignado
        for (const [clienteNum, clienteConv] of conversaciones.entries()) {
          const fueContactado = clienteConv.pedido?.repartidores_contactados?.includes(numero);
          const yaAsignado = clienteConv.pedido?.repartidor_whatsapp;
          if (fueContactado && !yaAsignado && clienteConv.esperando === 'costo_delivery') {
            // Este repartidor es el primero en responder — queda asignado
            clienteConv.pedido.repartidor_whatsapp = numero;
            // Buscar nombre del repartidor
            const repInfo = obtenerRepartidoreActivos(negocio).find(r => r.whatsapp === numero || r.whatsapp === numero.replace(/\D/g,''));
            clienteConv.pedido.repartidor_nombre = repInfo ? repInfo.nombre : numero;
            clienteConv.pedido.costo_delivery = costoDelivery;
            clienteConv.pedido.total = (clienteConv.pedido.subtotal || 0) - (clienteConv.pedido.descuento || 0) + costoDelivery;
            clienteConv.esperando = null;
            clienteConv.etapa = 'pago';
            // Armar resumen completo del pedido para el cliente
            const p = clienteConv.pedido;
            let resumenCliente = '✅ *Resumen de tu pedido:*\n\n';
            for (const item of (p.items || [])) {
              const precioItem = ((item.precio || 0) + (item.extras_precio || 0)) * item.cantidad;
              resumenCliente += `${item.emoji || ''} ${item.nombre} x${item.cantidad} — $${precioItem.toFixed(2)}\n`;
              if (item.modificadores_txt) resumenCliente += `   📝 ${item.modificadores_txt}\n`;
            }
            resumenCliente += `\nSubtotal: $${p.subtotal.toFixed(2)}`;
            if (p.descuento > 0) resumenCliente += `\nDescuento: -$${p.descuento.toFixed(2)}`;
            resumenCliente += `\n🛵 Delivery: $${costoDelivery.toFixed(2)}`;
            resumenCliente += `\n💰 *Total: $${p.total.toFixed(2)}*`;
            if (p.fecha_entrega) resumenCliente += `\n📅 Entrega: ${p.fecha_entrega} ${p.hora_entrega || ''}`;
            resumenCliente += '\n\n' + generarMensajePago(clienteConv, negocio);
            await enviarMensaje(clienteNum, resumenCliente, negocio.id);
            if (clienteConv.pedido.metodo_pago !== 'efectivo') clienteConv.esperando = 'boucher';
            await enviarMensaje(numero, '✅ Quedaste asignado! El cliente fue notificado.\nTotal del pedido: $' + clienteConv.pedido.total.toFixed(2) + '\nCliente: ' + (clienteConv.pedido.nombre_cliente || clienteNum), negocio.id);
            // Avisar a los demas repartidores que ya fue asignado
            for (const otroRep of (clienteConv.pedido.repartidores_contactados || [])) {
              if (otroRep !== numero) {
                await enviarMensaje(otroRep, 'Este pedido ya fue tomado por otro repartidor. Gracias!', negocio.id);
              }
            }
            return;
          }
        }
      }
    }

    // ── Repartidor confirma entrega ──
    if (textoLower === 'confirmar' || textoLower === 'confirmado' || textoLower === 'si' || textoLower === 'sí' || textoLower === 'voy') {
      for (const [clienteNum, clienteConv] of conversaciones.entries()) {
        if (clienteConv.pedido?.repartidor_whatsapp === numero && clienteConv.pedido?.esperando_confirmacion_rep) {
          clienteConv.pedido.esperando_confirmacion_rep = false;
          clienteConv.pedido.confirmado_por_rep = true;
          await enviarMensaje(numero, '✅ Confirmado! Estaras en camino a las ' + (clienteConv.pedido.hora_entrega || 'la hora acordada') + '.', negocio.id);
          return;
        }
      }
    }

    if (textoLower.startsWith('buscar ') || textoLower.startsWith('busca ')) {
      const termino = texto.replace(/^buscar?\s+/i, '').trim();
      const resultados = (negocio.catalogo || []).filter(p => p.nombre.toLowerCase().includes(termino.toLowerCase()) || p.descripcion?.toLowerCase().includes(termino.toLowerCase()));
      if (resultados.length > 0) {
        await enviar(numero, `Encontre ${resultados.length} producto(s) para "${termino}":`);
        for (const p of resultados) await enviarProducto(numero, p, negocio);
      } else {
        await enviar(numero, `No encontre productos para "${termino}". Escribe "ver catalogo" para ver todos.`);
      }
      return;
    }

    if (['cancelar', 'cancel'].includes(textoLower)) {
      if (conv.etapa === 'confirmado') { await enviar(numero, 'Tu pedido ya fue confirmado. Contacta al negocio si necesitas ayuda.'); }
      else { conversaciones.delete(`${numero}:${negocio.id}`); await enviar(numero, 'Pedido cancelado. Escribe cuando necesites algo!'); }
      return;
    }

    // Si está esperando boucher (datos bancarios ya enviados) y escribe texto = quiere reiniciar
    if (conv.esperando === 'boucher' && conv.etapa === 'pago') {
      if (['reiniciar', 'nuevo pedido', 'otro pedido', 'volver', 'menu', 'inicio'].includes(textoLower)) {
        conversaciones.delete(`${numero}:${negocio.id}`);
        await enviar(numero, 'Pedido cancelado. Escribe cuando quieras hacer un nuevo pedido!');
      } else {
        await enviar(numero, 'Estoy esperando tu comprobante de pago.\n\nEnviame una foto del comprobante para confirmar tu pedido.\n\nSi quieres cancelar escribe *cancelar*.');
      }
      return;
    }
    if (textoLower === 'mi pedido' || textoLower === 'ver pedido') {
      if (conv.pedido.items?.length > 0) await enviarResumenPedido(numero, conv);
      else await enviar(numero, 'No tienes productos aun. Que te gustaria ordenar?');
      return;
    }
    if (textoLower === 'mis compras' || textoLower === 'historial') {
      const c = cargarClientes()[numero];
      if (c?.historial_pedidos?.length > 0) {
        let hist = 'Tu historial:\n\n';
        c.historial_pedidos.slice(-5).forEach((p, i) => { hist += `${i + 1}. ${new Date(p.fecha).toLocaleDateString('es-EC')} - ${p.descripcion} ($${p.total})\n`; });
        hist += `\nTotal gastado: $${c.total_gastado?.toFixed(2) || '0.00'}\nTotal pedidos: ${c.total_pedidos}`;
        await enviar(numero, hist);
      } else { await enviar(numero, 'Aun no tienes pedidos. Animete a hacer tu primer pedido!'); }
      return;
    }
    if (textoLower === 'mis puntos' || textoLower === 'puntos') {
      const p = obtenerPuntos(numero);
      await enviar(numero, `Tus puntos: ${p.total} pts\nTotal canjeados: ${p.canjeados} pts\n\nNecesitas ${PUNTOS_PARA_REGALO - p.total > 0 ? PUNTOS_PARA_REGALO - p.total : 0} puntos mas para un producto gratis!\n\nGanas ${PUNTOS_POR_DOLAR} puntos por cada $1 gastado.`);
      return;
    }
    if (textoLower === 'canjear puntos') {
      const p = obtenerPuntos(numero);
      if (p.total >= PUNTOS_PARA_REGALO) {
        if (canjearPuntos(numero, PUNTOS_PARA_REGALO)) {
          await enviar(numero, `Felicidades! Canjeaste ${PUNTOS_PARA_REGALO} puntos por un producto gratis!\n\nDinos que producto del catalogo quieres y lo agregaremos a tu proximo pedido sin costo.`);
          await enviar(negocio.whatsapp_dueno, `Cliente ${numero} canjeo ${PUNTOS_PARA_REGALO} puntos por producto gratis!`);
        }
      } else {
        await enviar(numero, `Aun no tienes suficientes puntos. Te faltan ${PUNTOS_PARA_REGALO - p.total} puntos.\n\nSigue comprando para acumular mas!`);
      }
      return;
    }
    if (textoLower === 'promociones' || textoLower === 'ofertas') {
      const promos = cargarPromociones().filter(p => p.activa);
      const fechaEsp = obtenerFechaEspecial();
      let msg = '';
      if (fechaEsp) msg += `FECHA ESPECIAL: ${fechaEsp.nombre}\n${fechaEsp.descuento}% de descuento en todos los productos!\n\n`;
      if (promos.length > 0) { msg += 'Promociones disponibles:\n\n'; promos.forEach(p => { msg += `${p.emoji || ''} ${p.nombre}\n${p.descripcion}\n${p.descuento}\n\n`; }); }
      if (!msg) msg = 'No hay promociones activas en este momento.';
      await enviar(numero, msg);
      return;
    }
    if (textoLower === 'horario') {
      let horarioTexto = '';
      if (negocio.horarios) {
        const lineas = Object.entries(negocio.horarios)
          .filter(([, h]) => h && h.abierto)
          .map(([dia, h]) => '• ' + dia + ': ' + h.desde + ' - ' + h.hasta);
        horarioTexto = lineas.length ? lineas.join('\n') : 'Horario no configurado en el panel.';
      } else {
        horarioTexto = 'Lunes a Sábado: 8:00 - 18:00\nDomingos: Cerrado';
      }
      await enviar(numero, 'Horario de ' + negocio.nombre + ':\n\n' + horarioTexto);
      return;
    }
    if (textoLower === 'devoluciones' || textoLower === 'politica de devoluciones') {
      await enviar(numero, negocio.politica_devoluciones || `Politica de devoluciones:\n\n- 24 horas para reportar problemas.\n- Productos en estado original.\n- Contactanos por este WhatsApp.`);
      return;
    }

    // ── Citas ──
    if (textoLower === 'cita' || textoLower === 'agendar' || textoLower === 'reservar' || textoLower.includes('quiero una cita') || textoLower.includes('hacer una cita')) {
      const config = negocio.citas_config;
      if (!config?.activo || !config.servicios?.length) {
        await enviar(numero, `${negocio.nombre} no tiene sistema de citas activo. Contáctanos para más información.`);
      } else {
        const serviciosTexto = config.servicios.map((s, i) => `${i + 1}. ${s}`).join('\n');
        conv.esperando = 'cita_servicio';
        conv.citaTemp = {};
        await enviar(numero, `Para agendar tu cita en ${negocio.nombre}, elige el servicio:\n\n${serviciosTexto}\n\nResponde con el número del servicio.`);
      }
      return;
    }
    if (conv.esperando === 'cita_servicio') {
      const config = negocio.citas_config;
      const idx = parseInt(texto.trim()) - 1;
      if (isNaN(idx) || idx < 0 || idx >= config.servicios.length) { await enviar(numero, 'Por favor responde con el número del servicio.'); return; }
      conv.citaTemp.servicio = config.servicios[idx];
      conv.esperando = 'cita_fecha';
      const diasTexto = config.dias_disponibles?.join(', ') || 'Lunes a Viernes';
      await enviar(numero, `Servicio: ${conv.citaTemp.servicio}\n\nDías disponibles: ${diasTexto}\n\nEscribe la fecha deseada (ej: 15/03/2025)`);
      return;
    }
    if (conv.esperando === 'cita_fecha') {
      const config = negocio.citas_config;
      conv.citaTemp.fecha = texto.trim();
      conv.esperando = 'cita_hora';
      await enviar(numero, `Fecha: ${conv.citaTemp.fecha}\n\nHorario disponible: ${config.hora_inicio || '09:00'} — ${config.hora_fin || '18:00'} (cada ${config.duracion || 30} minutos)\n\nEscribe la hora deseada (ej: 10:00)`);
      return;
    }
    if (conv.esperando === 'cita_hora') {
      conv.citaTemp.hora = texto.trim();
      conv.esperando = null;
      const citas = cargarCitas();
      const ocupada = citas.some(c => c.negocio_id === negocio.id && c.fecha === conv.citaTemp.fecha && c.hora === conv.citaTemp.hora && c.estado !== 'cancelada');
      if (ocupada) { await enviar(numero, `Lo siento, ese horario ya está ocupado. Por favor elige otra hora.`); conv.esperando = 'cita_hora'; return; }
      const cita = { id: 'cita_' + Date.now(), negocio_id: negocio.id, numero, cliente: cliente.nombre || numero.slice(-6), servicio: conv.citaTemp.servicio, fecha: conv.citaTemp.fecha, hora: conv.citaTemp.hora, estado: 'pendiente', fecha_creacion: new Date().toISOString() };
      citas.push(cita);
      guardarCitas(citas);
      conv.citaTemp = {};
      await enviar(numero, `✅ Cita agendada!\n\n📅 Fecha: ${cita.fecha}\n⏰ Hora: ${cita.hora}\n💆 Servicio: ${cita.servicio}\n\nTe esperamos en ${negocio.nombre}. Si necesitas cancelar escríbenos.`);
      await enviar(negocio.whatsapp_dueno, `📅 Nueva cita!\n\nCliente: ${cita.cliente}\nWhatsApp: ${numero}\nServicio: ${cita.servicio}\nFecha: ${cita.fecha}\nHora: ${cita.hora}`);
      notificarPanel(negocio.slug || negocio.id, { tipo: 'nueva_cita', cliente: cita.cliente, servicio: cita.servicio, fecha: cita.fecha, hora: cita.hora });
      return;
    }

    // ── Bienvenida en primer mensaje ──
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
      await enviar(numero, bienvenida);
      conv.etapa = 'consultando';
      const saludos = ['hola', 'buenas', 'hi', 'buenos dias', 'buenas tardes', 'buenas noches', 'hey', 'ola'];
      if (!saludos.includes(textoLower) && texto.length > 6) {
        const etapaAntBienvenida = conv.etapa;
        const { mensaje: r, imagenesIds, mostrarPago: mp, enviarCatalogo: ec } = await procesarConClaude(conv, negocio, texto, cliente);
        if (r) await enviar(numero, r);
        if (ec) {
          const slug = negocio.slug || negocio.id;
          const dominio = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://vendebot-production.up.railway.app';
          await new Promise(res => setTimeout(res, 500));
          await enviar(numero, 'Aquí puedes ver todo lo que tenemos 👇\n\n' + dominio + '/catalogo/' + slug + '\n\nSelecciona lo que quieras y te llega directo aquí para terminar. O si prefieres dime qué buscas y te asesoro yo 😊');
        } else if (imagenesIds && imagenesIds.length > 0 && conv.etapa !== 'pago') {
          for (const p of (negocio.catalogo || []).filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p, negocio);
        }
        if (mp || (conv.etapa === 'pago' && etapaAntBienvenida !== 'pago')) {
          await new Promise(res => setTimeout(res, 500));
          await enviarResumenPedido(numero, conv);
          await new Promise(res => setTimeout(res, 500));
          await enviar(numero, generarMensajePago(conv, negocio));
          if (conv.pedido.metodo_pago === 'efectivo') {
            conv.etapa = 'confirmado';
            const pg = agregarPuntos(numero, conv.pedido.total, 'Pedido en ' + negocio.nombre);
            registrarPedido(numero, conv.pedido, negocio.nombre);
            await notificarDueno(conv, negocio);
            await enviar(numero, 'Ganaste ' + pg + ' puntos!');
          } else { conv.esperando = 'boucher'; }
        }
      }
      return;
    }

    if (conv.esperando === 'boucher') { await enviar(numero, `Estoy esperando tu comprobante. Envia una foto del ${negocio.banco} por $${conv.pedido.total?.toFixed(2) || '0.00'}`); return; }

    // ── Pedido desde catálogo web ──
    if (texto.startsWith('Hola! Quiero hacer un pedido 🛒') || texto.startsWith('Hola! Quiero hacer un pedido')) {
      const lineas = texto.split('\n');
      const items = [];
      let itemActual = null;
      lineas.forEach(l => {
        const match = l.match(/^•\s+(.+?)\s+x(\d+)\s+—\s+\$([\d.]+)/);
        if (match) {
          if (itemActual) items.push(itemActual);
          const nombre = match[1].trim();
          const cantidad = parseInt(match[2]);
          const precioTotal = parseFloat(match[3]);
          const prod = negocio.catalogo.find(p => p.nombre === nombre);
          if (prod) {
            itemActual = { id: prod.id, nombre: prod.nombre, precio: precioTotal / cantidad, cantidad, emoji: prod.emoji || '📦', notas_item: '' };
          } else {
            itemActual = { nombre, precio: precioTotal / cantidad, cantidad, emoji: '📦', notas_item: '' };
          }
        } else if (itemActual) {
          const mitad1 = l.match(/Mitad 1:\s*(.+)/i);
          const mitad2 = l.match(/Mitad 2:\s*(.+)/i);
          const modMatch = l.match(/^\s+(.+?):\s+(.+)/);
          if (mitad1) itemActual.mitad1 = mitad1[1].trim();
          else if (mitad2) itemActual.mitad2 = mitad2[1].trim();
          else if (modMatch) {
            if (!itemActual.modificadores) itemActual.modificadores = [];
            itemActual.modificadores.push({ grupo: modMatch[1].trim(), opciones: [modMatch[2].trim()] });
          }
        }
      });
      if (itemActual) items.push(itemActual);
      const totalMatch = texto.match(/💰 Total: \$([\d.]+)/);
      const notasMatch = texto.match(/📝 Notas: (.+)/);
      if (items.length > 0) {
        conv.pedido.items = items;
        conv.pedido.subtotal = totalMatch ? parseFloat(totalMatch[1]) : items.reduce((s, i) => s + i.precio * i.cantidad, 0);
        conv.pedido.total = conv.pedido.subtotal;
        if (notasMatch) conv.pedido.notas = notasMatch[1].trim();
        conv.etapa = 'confirmando';
      }
    }

    const etapaAnterior = conv.etapa;
    const { mensaje: respuesta, imagenesIds, mostrarPago, enviarCatalogo, pedidoDesdeCatalogo } = await procesarConClaude(conv, negocio, texto, cliente);
    if (respuesta) await enviar(numero, respuesta);

    if (enviarCatalogo) {
      const slug = negocio.slug || negocio.id;
      const dominio = process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'https://vendebot-production.up.railway.app';
      await new Promise(r => setTimeout(r, 500));
      await enviar(numero, 'Aquí puedes ver todo lo que tenemos 👇\n\n' + dominio + '/catalogo/' + slug + '\n\nSelecciona lo que quieras y te llega directo aquí para terminar. O si prefieres dime qué buscas y te asesoro yo 😊');
    } else if (pedidoDesdeCatalogo && conv.pedido.items && conv.pedido.items.length > 0) {
      // Claude ya incluye el resumen y las preguntas en su respuesta — no duplicar
      conv.etapa = 'confirmando';
    } else if (imagenesIds && imagenesIds.length > 0 && conv.etapa !== 'pago' && conv.etapa !== 'confirmado') {
      for (const p of negocio.catalogo.filter(p => imagenesIds.includes(p.id))) await enviarProducto(numero, p, negocio);
    }

    // ── Contactar repartidores cuando se transiciona a etapa delivery ──
    // Esto ocurre cuando el cliente da su dirección como texto (no GPS)
    const transicionandoADelivery = conv.etapa === 'delivery' && etapaAnterior !== 'delivery';
    if (transicionandoADelivery && conv.pedido.es_domicilio && !conv.pedido.repartidores_contactados?.length) {
      const reps = obtenerRepartidoreActivos(negocio);
      if (reps.length > 0) {
        conv.esperando = 'costo_delivery';
        const itemsResumen = (conv.pedido.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad + (i.modificadores_txt ? ' (' + i.modificadores_txt + ')' : '')).join('\n');
        conv.pedido.repartidores_contactados = reps.map(r => r.whatsapp);
        conv.pedido.repartidor_whatsapp = null;
        conv.pedido.repartidor_nombre = null;
        for (const rep of reps) {
          await enviarMensaje(rep.whatsapp,
            '🛵 *Nuevo pedido — Cotización delivery*\n\n' +
            'Negocio: ' + negocio.nombre + '\n' +
            'Cliente: ' + (conv.pedido.nombre_cliente || numero) + '\n\n' +
            'Productos:\n' + itemsResumen + '\n\n' +
            'Dirección del cliente:\n' + (conv.pedido.direccion || 'No especificada') + '\n\n' +
            'Responde con el costo. Ej: *2.50*\n(El primero en responder queda asignado)',
            negocio.id
          );
        }
        await enviar(numero, '📍 Dirección recibida! Estamos cotizando el costo de delivery, te avisamos en un momento. 🛵');
      } else {
        // Sin repartidores — ir directo a pago sin delivery
        conv.pedido.costo_delivery = 0;
        conv.esperando = null;
        conv.etapa = 'pago';
        await enviarResumenPedido(numero, conv);
        await new Promise(r => setTimeout(r, 400));
        await enviar(numero, generarMensajePago(conv, negocio));
        if (conv.pedido.metodo_pago !== 'efectivo') conv.esperando = 'boucher';
      }
    }

    // Mostrar pago SOLO cuando se transiciona a etapa pago (no en mensajes repetidos)
    const transicionandoAPago = mostrarPago || (conv.etapa === 'pago' && etapaAnterior !== 'pago');
    if (transicionandoAPago && conv.esperando !== 'boucher') {
      await new Promise(r => setTimeout(r, 500));
      await enviarResumenPedido(numero, conv);
      await new Promise(r => setTimeout(r, 500));
      await enviar(numero, generarMensajePago(conv, negocio));
      if (conv.pedido.metodo_pago === 'efectivo') {
        conv.etapa = 'confirmado';
        const puntosGanados = agregarPuntos(numero, conv.pedido.total, `Pedido en ${negocio.nombre}`);
        registrarPedido(numero, conv.pedido, negocio.nombre);
        await notificarDueno(conv, negocio);
        await enviar(numero, `Ganaste ${puntosGanados} puntos! Total: ${obtenerPuntos(numero).total} pts`);
      } else { conv.esperando = 'boucher'; }
    }

    if (conv.etapa === 'cancelado') conversaciones.delete(`${numero}:${negocio.id}`);

  } catch (err) { console.error('Error procesando mensaje:', err.message, err.stack); }
}

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
// ─── CACHE EN MEMORIA (se llena desde PostgreSQL al arrancar) ────────────────
const cache = {
  negocios: [],
  clientes: {},
  promociones: [],
  repartidores: [],
  pedidos_pendientes: [],
  cupones: [],
  puntos: {},
  resenas: [],
  citas: [],
};

// Leer desde cache (instantáneo)
function cargarJSON(archivo, defecto) {
  const clave = archivo.replace('./', '').replace('.json', '');
  if (cache[clave] !== undefined) return cache[clave];
  // Fallback a archivo si existe
  try { return JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch { return defecto; }
}

// Guardar: actualiza cache + escribe en PostgreSQL inmediatamente
function guardarJSON(archivo, data) {
  const clave = archivo.replace('./', '').replace('.json', '');
  // 1. Actualizar cache en memoria (instantáneo)
  if (cache[clave] !== undefined) cache[clave] = data;
  // 2. Guardar en PostgreSQL (permanente)
  guardarDB(clave, data).catch(() => {
    // Si falla, reintentar en 2 segundos
    setTimeout(() => guardarDB(clave, data).catch(() => {}), 2000);
  });
  // 3. Archivo local como triple seguro
  try { fs.writeFileSync(archivo, JSON.stringify(data, null, 2)); } catch {}
}

function cargarNegocios() { return cache.negocios; }
function cargarClientes() { return cache.clientes; }
function cargarPromociones() { return cache.promociones; }
function cargarRepartidores() { return cache.repartidores; }
function cargarPedidosPendientes() { return cache.pedidos_pendientes; }
function guardarPedidosPendientes(p) { guardarJSON('./pedidos_pendientes.json', p); }
function cargarCupones() { return cache.cupones; }
function cargarPuntos() { return cache.puntos; }
function guardarPuntos(p) { guardarJSON('./puntos.json', p); }

// ─── SISTEMA DE PUNTOS ────────────────────────────────────────────────────────
const PUNTOS_POR_DOLAR = 10;
const PUNTOS_PARA_REGALO = 500;

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

// ─── REFERIDOS ELIMINADO ─────────────────────────────────────────────────────
function cargarReferidos() { return {}; } // stub vacío

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
  c.historial_pedidos.push({ id: 'PED-' + Date.now(), fecha: new Date().toISOString(), negocio: negocioNombre, items: pedido.items, total: pedido.total, descripcion: pedido.items?.map(i => `${i.nombre} x${i.cantidad}`).join(', '), estado: 'confirmado', es_domicilio: pedido.es_domicilio, direccion: pedido.direccion, seguimiento_enviado: false });
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
    conversaciones.set(key, { numero, negocio_id: negocio.id, historial: [], etapa: 'inicio', pedido: { items: [], subtotal: 0, total: 0, es_domicilio: false, direccion: '', nombre_cliente: '', notas: '', metodo_pago: 'transferencia', fecha_entrega: '', hora_entrega: '', repartidor: '', cupon: null, descuento: 0, cambio_solicitado: 0 }, esperando: null, intentos_boucher: 0, ultimo_mensaje: Date.now(), citaTemp: {} });
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
setInterval(async () => {
  const ahora = Date.now();
  for (const [key, conv] of conversaciones) {
    if (conv.esperando === 'boucher' && !conv.recordatorio_pago_enviado && ahora - conv.ultimo_mensaje > 30 * 60 * 1000) {
      const negocio = cargarNegocios().find(n => n.id === conv.negocio_id);
      if (negocio && estaAbiertoAhora(negocio)) {
        await enviarMensaje(conv.numero, 'Hola! Te recuerdo que tu pedido esta pendiente de pago. Cuando puedas enviame el comprobante.', negocio.id);
        conv.recordatorio_pago_enviado = true;
      }
    }
  }
}, 30 * 60 * 1000);

// ─── RECORDATORIO AL REPARTIDOR 20 MIN ANTES + REASIGNACIÓN SI NO CONFIRMA ───
setInterval(async () => {
  const ahora = Date.now();
  const ahoraDt = horaActual();

  for (const [key, conv] of conversaciones) {
    const p = conv.pedido;
    if (!p || conv.etapa !== 'confirmado') continue;
    if (!p.es_domicilio || !p.repartidor_whatsapp) continue;

    const negocio = cargarNegocios().find(n => n.id === conv.negocio_id);
    if (!negocio) continue;

    // ── 1. Repartidor no confirmó en 5 minutos → buscar otro ──
    if (p.esperando_confirmacion_rep && p.confirmacion_rep_timestamp) {
      const minSinConfirmar = (ahora - p.confirmacion_rep_timestamp) / 60000;
      if (minSinConfirmar >= 5) {
        // Marcar al repartidor actual como que no respondió
        const repAnterior = p.repartidor_whatsapp;
        await enviarMensaje(repAnterior, '⚠️ No confirmaste a tiempo. El pedido fue reasignado a otro repartidor.', negocio.id);

        // Buscar otro repartidor disponible
        const repsDisponibles = (negocio.repartidores || []).filter(r =>
          r.activo !== false &&
          r.whatsapp.replace(/\D/g,'') !== repAnterior.replace(/\D/g,'')
        );

        if (repsDisponibles.length > 0) {
          const nuevoRep = repsDisponibles[Math.floor(Math.random() * repsDisponibles.length)];
          p.repartidor_whatsapp = nuevoRep.whatsapp;
          p.repartidor_nombre = nuevoRep.nombre;
          p.repartidor = nuevoRep.nombre;
          p.confirmacion_rep_timestamp = Date.now();
          p.esperando_confirmacion_rep = true;

          const itemsRep = (p.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad + (i.modificadores_txt ? ' (' + i.modificadores_txt + ')' : '')).join('\n');
          const msgNuevoRep = '🟢 *PEDIDO REASIGNADO — IR A RECOGER*\n\n' +
            'Negocio: ' + negocio.nombre + '\n' +
            'Cliente: ' + (p.nombre_cliente || conv.numero) + '\n' +
            'WhatsApp cliente: ' + conv.numero + '\n\n' +
            'Pedido:\n' + itemsRep + '\n\n' +
            'Total: $' + (p.total || 0).toFixed(2) + '\n' +
            'Entrega: ' + (p.fecha_entrega || 'Lo antes posible') + ' ' + (p.hora_entrega || '') + '\n' +
            'Direccion: ' + (p.direccion || '') + '\n\n' +
            (p.notas ? 'Notas: ' + p.notas + '\n\n' : '') +
            '⚡ El repartidor anterior no confirmó. Responde *CONFIRMAR* para tomar el pedido.';
          await enviarMensaje(nuevoRep.whatsapp, msgNuevoRep, negocio.id);

          // Avisar al cliente del cambio
          await enviarMensaje(conv.numero, '🔄 Hubo un cambio de repartidor. Tu pedido sigue en camino, no te preocupes!', negocio.id);
        } else {
          // No hay más repartidores — avisar al dueño
          p.esperando_confirmacion_rep = false;
          await enviarMensaje(negocio.whatsapp_dueno,
            '⚠️ URGENTE: El repartidor ' + (p.repartidor_nombre || repAnterior) + ' no confirmó el pedido de ' + (p.nombre_cliente || conv.numero) + '. No hay más repartidores disponibles. Asigna uno manualmente.',
            negocio.id
          );
        }
      }
    }

    // ── 2. Recordatorio al repartidor 20 min antes de la hora de entrega ──
    if (p.confirmado_por_rep && p.hora_entrega && !p.recordatorio_rep_enviado) {
      try {
        const [hh, mm] = p.hora_entrega.split(':').map(Number);
        const horaEntrega = new Date(ahoraDt);
        horaEntrega.setHours(hh, mm, 0, 0);
        const minRestantes = (horaEntrega - ahoraDt) / 60000;

        if (minRestantes <= 20 && minRestantes > 0) {
          p.recordatorio_rep_enviado = true;
          const itemsRep = (p.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad).join('\n');
          await enviarMensaje(p.repartidor_whatsapp,
            '⏰ *RECORDATORIO — entrega en ' + Math.round(minRestantes) + ' minutos*\n\n' +
            'Cliente: ' + (p.nombre_cliente || conv.numero) + '\n' +
            'Direccion: ' + (p.direccion || '') + '\n' +
            'Hora acordada: ' + p.hora_entrega + '\n\n' +
            'Pedido:\n' + itemsRep + '\n\n' +
            '¡Asegúrate de estar en camino!',
            negocio.id
          );
        }
      } catch(e) {}
    }
  }
}, 60 * 1000); // revisar cada 1 minuto

setInterval(async () => {
  const pendientes = cargarPedidosPendientes();
  const hoy = horaActual().toLocaleDateString('es-EC');
  let cambios = false;
  for (const p of pendientes) {
    if (!p.recordatorio_enviado && !p.entrega_confirmada && p.pedido.fecha_entrega === hoy) {
      const neg = cargarNegocios().find(n => n.nombre === p.negocio || n.id === p.negocio_id);
      if (!neg || estaAbiertoAhora(neg)) { // si no hay negocio igual avisa
        await enviarMensaje(p.numero, 'Hola! Hoy es el dia de entrega de tu pedido en ' + p.negocio + '. Nos pondremos en contacto pronto!', neg?.id);
        p.recordatorio_enviado = true; cambios = true;
      }
    }
  }
  if (cambios) guardarPedidosPendientes(pendientes);
}, 60 * 60 * 1000);

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

setInterval(async () => {
  const clientes = cargarClientes();
  const ahora = Date.now();
  let cambios = false;
  for (const [numero, cliente] of Object.entries(clientes)) {
    if (!cliente.historial_pedidos?.length) continue;
    const ultimo = cliente.historial_pedidos[cliente.historial_pedidos.length - 1];
    if (!ultimo.seguimiento_enviado) {
      const diff = ahora - new Date(ultimo.fecha).getTime();
      if (diff > 23 * 60 * 60 * 1000 && diff < 25 * 60 * 60 * 1000) {
        await enviarMensaje(numero, 'Hola ' + (cliente.nombre || '') + '! Esperamos que hayas disfrutado tu pedido. Como fue tu experiencia? Tu opinion nos ayuda a mejorar!');
        ultimo.seguimiento_enviado = true; cambios = true;
      }
    }
  }
  if (cambios) guardarJSON('./clientes.json', clientes);
}, 60 * 60 * 1000);

// ─── RECORDATORIO Y REASIGNACIÓN DE REPARTIDOR ────────────────────────────────
// Cada 5 min: revisar pedidos confirmados que tienen hora de entrega próxima
setInterval(async () => {
  const ahora = Date.now();
  const ahoraDt = horaActual();
  const hoy = ahoraDt.toLocaleDateString('es-EC');

  for (const [key, conv] of conversaciones.entries()) {
    if (conv.etapa !== 'confirmado') continue;
    if (!conv.pedido?.es_domicilio) continue;
    if (!conv.pedido?.repartidor_whatsapp) continue;

    const negocio = cargarNegocios().find(n => n.id === conv.negocio_id);
    if (!negocio) continue;

    // Calcular cuánto falta para la entrega
    const fechaEntrega = conv.pedido.fecha_entrega; // ej: "15/03/2025"
    const horaEntrega = conv.pedido.hora_entrega;   // ej: "18:00"
    if (!fechaEntrega || !horaEntrega) continue;

    // Parsear fecha y hora de entrega correctamente
    const [h, m] = horaEntrega.split(':').map(Number);
    let dtEntrega = new Date(ahoraDt);

    if (fechaEntrega && fechaEntrega.includes('/')) {
      // Formato explícito DD/MM/YYYY — el más confiable
      const partes = fechaEntrega.split('/');
      dtEntrega = new Date(parseInt(partes[2]), parseInt(partes[1])-1, parseInt(partes[0]), h, m, 0, 0);
    } else if (fechaEntrega && (fechaEntrega.toLowerCase().includes('mañana') || fechaEntrega.toLowerCase().includes('manana'))) {
      // "mañana" → día siguiente
      dtEntrega.setDate(dtEntrega.getDate() + 1);
      dtEntrega.setHours(h, m, 0, 0);
    } else {
      // "hoy", vacío, "lo antes posible", etc → hoy
      dtEntrega.setHours(h, m, 0, 0);
      // Pero si esa hora ya pasó hoy → era para mañana (edge case)
      if (dtEntrega.getTime() < ahora - 5 * 60 * 1000) {
        dtEntrega.setDate(dtEntrega.getDate() + 1);
      }
    }
    const msParaEntrega = dtEntrega.getTime() - ahora;

    // --- RECORDATORIO 20 MIN ANTES ---
    if (msParaEntrega > 0 && msParaEntrega <= 20 * 60 * 1000 && !conv.pedido.recordatorio_rep_enviado) {
      conv.pedido.recordatorio_rep_enviado = true;
      conv.pedido.esperando_confirmacion_rep = true;
      conv.pedido.confirmacion_rep_timestamp = ahora;
      conv.pedido.confirmado_por_rep = false;
      const itemsRep = (conv.pedido.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad).join('\n');
      await enviarMensaje(conv.pedido.repartidor_whatsapp,
        '⏰ *Recordatorio — Entrega en 20 minutos*\n\n' +
        'Cliente: ' + (conv.pedido.nombre_cliente || conv.numero) + '\n' +
        'Hora: ' + horaEntrega + '\n' +
        'Direccion: ' + conv.pedido.direccion + '\n\n' +
        'Pedido:\n' + itemsRep + '\n\n' +
        'Total: $' + (conv.pedido.total || 0).toFixed(2) + '\n\n' +
        'Responde *CONFIRMAR* para confirmar que vas a entregar.',
        negocio.id);
    }

    // --- SI NO CONFIRMÓ EN 10 MIN → REASIGNAR AL SIGUIENTE REPARTIDOR ---
    if (conv.pedido.esperando_confirmacion_rep && !conv.pedido.confirmado_por_rep) {
      const tiempoEsperando = ahora - (conv.pedido.confirmacion_rep_timestamp || ahora);
      if (tiempoEsperando >= 10 * 60 * 1000) {
        // Buscar siguiente repartidor disponible
        const todos = obtenerRepartidoreActivos(negocio);
        const repActual = conv.pedido.repartidor_whatsapp;
        const noConfirmados = conv.pedido.reps_no_confirmaron || [];
        noConfirmados.push(repActual);
        conv.pedido.reps_no_confirmaron = noConfirmados;
        const siguiente = todos.find(r => !noConfirmados.includes(r.whatsapp) && r.whatsapp !== repActual);
        if (siguiente) {
          // Notificar al repartidor anterior que fue reasignado
          await enviarMensaje(repActual, '⚠️ No confirmaste a tiempo. El pedido fue asignado a otro repartidor.', negocio.id);
          // Asignar siguiente
          conv.pedido.repartidor_whatsapp = siguiente.whatsapp;
          conv.pedido.repartidor_nombre = siguiente.nombre;
          conv.pedido.esperando_confirmacion_rep = true;
          conv.pedido.confirmado_por_rep = false;
          conv.pedido.confirmacion_rep_timestamp = ahora;
          const itemsRep2 = (conv.pedido.items || []).map(i => '• ' + (i.emoji||'') + ' ' + i.nombre + ' x' + i.cantidad).join('\n');
          await enviarMensaje(siguiente.whatsapp,
            '🔄 *Pedido reasignado a ti*\n\n' +
            'El repartidor anterior no confirmó. Necesitamos que hagas esta entrega:\n\n' +
            'Cliente: ' + (conv.pedido.nombre_cliente || conv.numero) + '\n' +
            'Hora entrega: ' + horaEntrega + '\n' +
            'Direccion: ' + conv.pedido.direccion + '\n\n' +
            'Pedido:\n' + itemsRep2 + '\n\n' +
            'Total: $' + (conv.pedido.total || 0).toFixed(2) + '\n\n' +
            'Responde *CONFIRMAR* para aceptar.',
            negocio.id);
          // Notificar al dueño de la reasignación
          await enviarMensaje(negocio.whatsapp_dueno,
            '⚠️ Reasignacion de repartidor\n\nEl repartidor anterior no confirmó.\nNuevo repartidor: ' + siguiente.nombre + '\nCliente: ' + (conv.pedido.nombre_cliente || conv.numero),
            negocio.id);
        } else {
          // No hay mas repartidores — avisar al dueño
          conv.pedido.esperando_confirmacion_rep = false;
          await enviarMensaje(negocio.whatsapp_dueno,
            '🚨 Sin repartidores disponibles!\n\nNingun repartidor confirmó el pedido de ' + (conv.pedido.nombre_cliente || conv.numero) + '\nEntrega: ' + horaEntrega + '\nDireccion: ' + conv.pedido.direccion + '\n\nPor favor atiende este pedido manualmente.',
            negocio.id);
        }
      }
    }
  }
}, 5 * 60 * 1000); // revisar cada 5 minutos

// ─── ENVÍO MENSAJES ───────────────────────────────────────────────────────────

// ─── API ADMIN ────────────────────────────────────────────────────────────────
app.get('/admin/negocios', authAdmin, (req, res) => res.json(cargarNegocios()));
app.post('/admin/negocios', authAdmin, (req, res) => {
  const negocios = cargarNegocios();
  const nuevo = { id: 'negocio_' + Date.now(), activo: true, catalogo: [], modo_vacaciones: false, tiempo_entrega: '30-45 minutos', politica_devoluciones: '', mensajes: { bienvenida: 'Hola! Bienvenido/a. En que puedo ayudarte?', tono: 'amigable' }, ...req.body };
  negocios.push(nuevo);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, negocio: nuevo });
});
app.put('/admin/negocios/:id', authAdmin, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx] = { ...negocios[idx], ...req.body };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.delete('/admin/negocios/:id', authAdmin, (req, res) => {
  const negocios = cargarNegocios().filter(n => n.id !== req.params.id);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.put('/admin/negocios/:id/vacaciones', authAdmin, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].modo_vacaciones = req.body.activo;
  negocios[idx].mensaje_vacaciones = req.body.mensaje || '';
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
app.get('/admin/clientes', authAdmin, (req, res) => res.json(cargarClientes()));
app.get('/admin/puntos', authAdmin, (req, res) => res.json(cargarPuntos()));
app.get('/admin/cupones', authAdmin, (req, res) => res.json(cargarCupones()));
app.post('/admin/cupones', authAdmin, (req, res) => {
  const cupones = cargarCupones();
  const nuevo = { id: 'cupon_' + Date.now(), activo: true, usos_actuales: 0, ...req.body };
  cupones.push(nuevo);
  guardarJSON('./cupones.json', cupones);
  res.json({ ok: true, cupon: nuevo });
});
app.delete('/admin/cupones/:id', authAdmin, (req, res) => { guardarJSON('./cupones.json', cargarCupones().filter(c => c.id !== req.params.id)); res.json({ ok: true }); });
// Ruta de referidos eliminada
app.get('/admin/repartidores', authAdmin, (req, res) => res.json(cargarRepartidores()));
app.post('/admin/repartidores', authAdmin, (req, res) => {
  const reps = cargarRepartidores();
  const nuevo = { id: 'rep_' + Date.now(), activo: true, disponible: true, ...req.body };
  reps.push(nuevo);
  guardarJSON('./repartidores.json', reps);
  res.json({ ok: true });
});
app.get('/admin/promociones', authAdmin, (req, res) => res.json(cargarPromociones()));
app.post('/admin/promociones', authAdmin, (req, res) => {
  const promos = cargarPromociones();
  promos.push({ id: 'promo_' + Date.now(), activa: true, ...req.body });
  guardarJSON('./promociones.json', promos);
  res.json({ ok: true });
});
app.delete('/admin/promociones/:id', authAdmin, (req, res) => { guardarJSON('./promociones.json', cargarPromociones().filter(p => p.id !== req.params.id)); res.json({ ok: true }); });

app.post('/admin/masivo', authAdmin, async (req, res) => {
  const { mensaje, solo_frecuentes } = req.body;
  if (!mensaje) return res.status(400).json({ error: 'Mensaje requerido' });
  const clientes = cargarClientes();
  let enviados = 0;
  const lista = Object.values(clientes).filter(c => c.total_pedidos > 0 && (!solo_frecuentes || c.es_frecuente));
  res.json({ ok: true, total: lista.length, mensaje: 'Enviando en segundo plano...' });
  for (const cliente of lista) {
    await enviarMensaje(cliente.numero, mensaje);
    enviados++;
    await new Promise(r => setTimeout(r, 1500));
  }
});

app.get('/admin/pedidos', authAdmin, (req, res) => res.json(cargarPedidosPendientes()));
app.get('/admin/stats', authAdmin, (req, res) => {
  const n = cargarNegocios();
  const c = cargarClientes();
  const clientes = Object.values(c);
  const hoy = horaActual().toLocaleDateString('es-EC');
  res.json({ negocios_activos: n.filter(x => x.activo).length, conversaciones_activas: conversaciones.size, total_clientes: clientes.length, clientes_frecuentes: clientes.filter(c => c.es_frecuente).length, pedidos_hoy: clientes.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length || 0), 0), ventas_hoy: clientes.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total || 0), 0) || 0), 0), total_puntos_activos: Object.values(cargarPuntos()).reduce((a, p) => a + p.total, 0), cupones_activos: cargarCupones().filter(c => c.activo).length });
});
app.get('/', (req, res) => res.json({ status: 'VendeBot v10.0 activo', conversaciones: conversaciones.size, en_horario: estaEnHorario() }));

// ─── AUTENTICACIÓN ────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vendebot2024admin';
const tokens = new Map();

function generarToken() { return crypto.randomBytes(32).toString('hex'); }
function verificarToken(token) { return tokens.has(token) && Date.now() - tokens.get(token).tiempo < 24 * 60 * 60 * 1000; }
function verificarTokenPanel(token, slug) { const t = tokens.get(token); return t && t.slug === slug && Date.now() - t.tiempo < 7 * 24 * 60 * 60 * 1000; }

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

// ── Middleware suscripción activa ──────────────────────────────────────────
function requireSuscripcion(req, res, next) {
  const slug = req.params.slug;
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === slug);
  if (!negocio) return next(); // si no existe, que lo maneje la ruta
  if (negocio.suscripcion_activa === false) {
    // Si es petición de API JSON
    if (req.headers.accept?.includes('application/json') || req.path.includes('-data') || req.method !== 'GET') {
      return res.status(402).json({ error: 'Suscripción suspendida', suspendido: true });
    }
    // Si es página HTML, devuelve pantalla de suspendido
    return res.status(402).send(paginaSuspendida(negocio.nombre));
  }
  // Verificar vencimiento automático
  if (negocio.fecha_vencimiento) {
    const venc = new Date(negocio.fecha_vencimiento);
    venc.setHours(23, 59, 59, 999);
    if (new Date() > venc) {
      if (req.headers.accept?.includes('application/json') || req.path.includes('-data') || req.method !== 'GET') {
        return res.status(402).json({ error: 'Suscripción vencida', suspendido: true });
      }
      return res.status(402).send(paginaSuspendida(negocio.nombre, true));
    }
  }
  next();
}

function paginaSuspendida(nombre, vencido = false) {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Servicio suspendido</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',system-ui,sans-serif;background:#020509;color:#cce8ff;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;}
.box{max-width:420px;}
.icon{font-size:64px;margin-bottom:24px;}
h1{font-size:24px;font-weight:700;margin-bottom:12px;color:#fff;}
p{font-size:15px;color:rgba(255,255,255,.55);line-height:1.6;margin-bottom:24px;}
.btn{display:inline-block;padding:12px 28px;background:rgba(0,148,255,.15);border:1px solid rgba(0,200,255,.3);color:#00c8ff;border-radius:10px;text-decoration:none;font-size:14px;font-weight:600;}
.neg{font-family:monospace;font-size:12px;color:rgba(255,255,255,.2);margin-top:32px;}
</style></head><body>
<div class="box">
  <div class="icon">${vencido ? '⏰' : '⛔'}</div>
  <h1>${vencido ? 'Suscripción vencida' : 'Servicio suspendido'}</h1>
  <p>${vencido
    ? `El plan de mantenimiento de <strong>${nombre}</strong> ha vencido. Renueva tu suscripción para volver a tener acceso.`
    : `El servicio de <strong>${nombre}</strong> ha sido suspendido temporalmente. Contacta a tu proveedor para reactivarlo.`
  }</p>
  <a class="btn" href="https://wa.me/?text=Hola, necesito reactivar mi servicio VendeBot - ${encodeURIComponent(nombre)}">💬 Contactar por WhatsApp</a>
  <div class="neg">${nombre} · VendeBot</div>
</div>
</body></html>`;
}

// ─── RUTAS DE PANELES ─────────────────────────────────────────────────────────
const HTML_NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'Surrogate-Control': 'no-store',
};
app.get('/admin', (req, res) => {
  res.set(HTML_NO_CACHE);
  res.sendFile('admin.html', { root: '.' });
});
app.get('/panel/:slug', requireSuscripcion, (req, res) => {
  res.set(HTML_NO_CACHE);
  res.sendFile('panel.html', { root: '.' });
});

app.get('/panel/:slug/negocio', authPanel, requireSuscripcion, (req, res) => {
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
app.put('/panel/:slug/bot-activo', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].bot_activo = req.body.activo;
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, bot_activo: negocios[idx].bot_activo });
});
app.get('/panel/:slug/stats', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json({});
  const clientes = cargarClientes();
  const todos = Object.values(clientes).filter(c => c.historial_pedidos?.some(p => p.negocio === negocio.nombre));
  const hoy = horaActual().toLocaleDateString('es-EC');
  res.json({ ventas_hoy: todos.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).reduce((s, p) => s + (p.total||0), 0)||0), 0), pedidos_hoy: todos.reduce((acc, c) => acc + (c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === hoy).length||0), 0), total_clientes: todos.length, clientes_frecuentes: todos.filter(c => c.es_frecuente).length });
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
app.delete('/panel/:slug/promociones/:id', authPanel, (req, res) => { guardarJSON('./promociones.json', cargarPromociones().filter(p => p.id !== req.params.id)); res.json({ ok: true }); });
app.get('/panel/:slug/cupones', authPanel, (req, res) => res.json(cargarCupones()));
app.post('/panel/:slug/cupones', authPanel, (req, res) => {
  const cupones = cargarCupones();
  cupones.push({ id: 'cupon_' + Date.now(), activo: true, usos_actuales: 0, ...req.body });
  guardarJSON('./cupones.json', cupones);
  res.json({ ok: true });
});
app.delete('/panel/:slug/cupones/:id', authPanel, (req, res) => { guardarJSON('./cupones.json', cargarCupones().filter(c => c.id !== req.params.id)); res.json({ ok: true }); });
app.get('/panel/:slug/repartidores', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  res.json(negocio.repartidores || []);
});
app.post('/panel/:slug/repartidores', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  if (!negocios[idx].repartidores) negocios[idx].repartidores = [];
  const nuevo = { id: 'rep_' + Date.now(), activo: true, disponible: true, ...req.body };
  negocios[idx].repartidores.push(nuevo);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, ...nuevo });
});
app.delete('/panel/:slug/repartidores/:id', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].repartidores = (negocios[idx].repartidores || []).filter(r => r.id !== req.params.id);
  guardarJSON('./negocios.json', negocios);
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

// UPLOAD IMAGENES
const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/panel/:slug/upload', uploadMiddleware.single('imagen'), async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!verificarTokenPanel(token, req.params.slug)) return res.status(401).json({ error: 'No autorizado' });
  try {
    const resultado = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream({ folder: 'vendebot/' + req.params.slug, resource_type: 'image' }, (error, result) => error ? reject(error) : resolve(result)).end(req.file.buffer);
    });
    res.json({ url: resultado.secure_url });
  } catch (e) { console.error('Error Cloudinary:', e.message); res.status(500).json({ error: 'Error al subir imagen' }); }
});

// ─── ALERTAS DE STOCK BAJO ────────────────────────────────────
const STOCK_MINIMO = 3;
setInterval(async () => {
  const negocios = cargarNegocios();
  for (const negocio of negocios.filter(n => n.activo)) {
    const stockBajo = (negocio.catalogo || []).filter(p => p.stock !== undefined && p.stock <= STOCK_MINIMO && p.stock > 0);
    for (const producto of stockBajo) {
      const key = `stock_alerta_${negocio.id}_${producto.id}`;
      if (!global[key]) {
        await enviarMensaje(negocio.whatsapp_dueno, `⚠️ Stock bajo en ${negocio.nombre}\n\nProducto: ${producto.emoji || ''} ${producto.nombre}\nStock restante: ${producto.stock} unidades\n\nActualiza el stock desde tu panel.`);
        global[key] = true;
        setTimeout(() => { global[key] = false; }, 24 * 60 * 60 * 1000);
      }
    }
    let cambios = false;
    (negocio.catalogo || []).forEach(p => {
      if (p.stock === 0 && p.activo !== false) { p.activo = false; cambios = true; }
      if (p.stock > 0 && p.activo === false) { p.activo = true; cambios = true; }
    });
    if (cambios) guardarJSON('./negocios.json', negocios);
  }
}, 60 * 60 * 1000);

// ─── NOTIFICACIONES EN TIEMPO REAL (SSE) ─────────────────────
const sseClients = new Map();

app.get('/panel/:slug/events', (req, res) => {
  const token = req.query.token;
  if (!verificarTokenPanel(token, req.params.slug)) return res.status(401).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const slug = req.params.slug;
  if (!sseClients.has(slug)) sseClients.set(slug, new Set());
  sseClients.get(slug).add(res);
  res.write('data: {"tipo":"conectado"}\n\n');
  req.on('close', () => { sseClients.get(slug)?.delete(res); });
});

function notificarPanel(slug, evento) {
  const clients = sseClients.get(slug);
  if (!clients) return;
  const data = JSON.stringify(evento);
  for (const client of clients) {
    try { client.write(`data: ${data}\n\n`); } catch {}
  }
}

// ─── CHAT EN VIVO ─────────────────────────────────────────────
app.get('/panel/:slug/conversaciones', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json([]);
  const activas = [];
  for (const [key, conv] of conversaciones) {
    if (conv.negocio_id === negocio.id) {
      const cliente = cargarClientes()[conv.numero] || {};
      activas.push({ numero: conv.numero, nombre: cliente.nombre || conv.numero.slice(-6), etapa: conv.etapa, ultimo_mensaje: conv.ultimo_mensaje, historial: conv.historial.slice(-10), pedido: conv.pedido });
    }
  }
  activas.sort((a, b) => b.ultimo_mensaje - a.ultimo_mensaje);
  res.json(activas);
});

app.post('/panel/:slug/responder', authPanel, async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
  await enviarMensaje(numero, mensaje);
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (negocio) {
    const key = `${numero}:${negocio.id}`;
    const conv = conversaciones.get(key);
    if (conv) conv.historial.push({ role: 'assistant', content: `[Dueno]: ${mensaje}` });
  }
  res.json({ ok: true });
});

// ─── CHAT MANUAL (alias de /responder para compatibilidad panel) ──────────────
app.post('/panel/:slug/chat-manual', authPanel, async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!numero || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
  await enviarMensaje(numero, mensaje);
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (negocio) {
    const key = `${numero}:${negocio.id}`;
    const conv = conversaciones.get(key);
    if (conv) conv.historial.push({ role: 'assistant', content: `[Dueño]: ${mensaje}` });
  }
  res.json({ ok: true });
});

// ─── CONFIG DEL NEGOCIO (guardar configuración avanzada) ─────────────────────
app.post('/panel/:slug/config', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx] = { ...negocios[idx], ...req.body };
  cache.negocios = negocios; // ← actualizar cache en memoria inmediatamente
  guardarJSON('./negocios.json', negocios);
  guardarDB('negocios', negocios).catch(() => {}); // ← también persistir en DB
  res.json({ ok: true });
});

// ─── BOT ON/OFF ───────────────────────────────────────────────────────────────
app.post('/panel/:slug/bot', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].bot_activo = req.body.activo;
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, bot_activo: negocios[idx].bot_activo });
});

// ─── CATÁLOGO — editar producto y stock ───────────────────────────────────────
app.put('/panel/:slug/catalogo/:id', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const pIdx = negocios[idx].catalogo.findIndex(p => p.id == req.params.id);
  if (pIdx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  negocios[idx].catalogo[pIdx] = { ...negocios[idx].catalogo[pIdx], ...req.body };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});

// Stock: acepta { stock } absoluto o { delta } relativo, y POST o PUT
app.put('/panel/:slug/catalogo/:id/stock', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const pIdx = negocios[idx].catalogo.findIndex(p => p.id == req.params.id);
  if (pIdx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  const actual = negocios[idx].catalogo[pIdx].stock ?? 0;
  negocios[idx].catalogo[pIdx].stock = req.body.delta !== undefined
    ? Math.max(0, actual + req.body.delta)
    : req.body.stock;
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, stock: negocios[idx].catalogo[pIdx].stock });
});
app.post('/panel/:slug/catalogo/:id/stock', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const pIdx = negocios[idx].catalogo.findIndex(p => p.id == req.params.id);
  if (pIdx === -1) return res.status(404).json({ error: 'Producto no encontrado' });
  const actual = negocios[idx].catalogo[pIdx].stock ?? 0;
  negocios[idx].catalogo[pIdx].stock = req.body.delta !== undefined
    ? Math.max(0, actual + req.body.delta)
    : req.body.stock;
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, stock: negocios[idx].catalogo[pIdx].stock });
});


// ─── CATÁLOGO — crear y eliminar ─────────────────────────────────────────────
app.post('/panel/:slug/catalogo', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  if (!negocios[idx].catalogo) negocios[idx].catalogo = [];
  const maxId = negocios[idx].catalogo.reduce((m, p) => Math.max(m, p.id || 0), 0);
  const nuevo = { id: maxId + 1, activo: true, ...req.body };
  negocios[idx].catalogo.push(nuevo);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, id: nuevo.id, ...nuevo });
});

app.delete('/panel/:slug/catalogo/:id', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].catalogo = (negocios[idx].catalogo || []).filter(p => String(p.id) !== String(req.params.id));
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});
// ─── CITAS CONFIG ─────────────────────────────────────────────────────────────
app.get('/panel/:slug/citas/config', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  res.json(negocio.citas_config || {});
});

app.post('/panel/:slug/citas/config', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].citas_config = { ...negocios[idx].citas_config, ...req.body, activo: true };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true });
});

// ─── CITAS PRÓXIMAS ───────────────────────────────────────────────────────────
app.get('/panel/:slug/citas/proximas', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json([]);
  const ahora = new Date();
  const proximas = cargarCitas()
    .filter(c => c.negocio_id === negocio.id && c.estado !== 'cancelada')
    .filter(c => { try { return new Date(c.fecha + 'T' + c.hora) >= ahora; } catch { return false; } })
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora))
    .slice(0, 10);
  res.json(proximas);
});



// ─── REPORTES EXPORTABLES ─────────────────────────────────────
app.get('/panel/:slug/reporte', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const clientes = cargarClientes();
  const todos = Object.values(clientes).filter(c => c.historial_pedidos?.some(p => p.negocio === negocio.nombre));
  const { desde, hasta } = req.query;
  const pedidos = [];
  todos.forEach(c => {
    c.historial_pedidos?.filter(p => {
      if (p.negocio !== negocio.nombre) return false;
      if (desde && new Date(p.fecha) < new Date(desde)) return false;
      if (hasta && new Date(p.fecha) > new Date(hasta)) return false;
      return true;
    }).forEach(p => pedidos.push({ cliente: c.nombre || c.numero, numero: c.numero, fecha: new Date(p.fecha).toLocaleDateString('es-EC'), descripcion: p.descripcion, total: p.total, entrega: p.es_domicilio ? 'Domicilio' : 'Retiro' }));
  });
  pedidos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  res.json({ negocio: negocio.nombre, pedidos, total_pedidos: pedidos.length, total_ventas: pedidos.reduce((s, p) => s + (p.total || 0), 0), generado: new Date().toLocaleString('es-EC') });
});

// ─── RESEÑAS ─────────────────────────────────────────────────
function cargarResenas() { return cache.resenas; }
function guardarResenas(r) { guardarJSON('./resenas.json', r); }

function agregarResena(numero, negocioNombre, calificacion, comentario, pedidoDesc) {
  const resenas = cargarResenas();
  const cliente = cargarClientes()[numero];
  resenas.push({ id: 'res_' + Date.now(), numero, cliente: cliente?.nombre || numero.slice(-6), negocio: negocioNombre, calificacion, comentario: comentario || '', pedido: pedidoDesc || '', fecha: new Date().toISOString() });
  guardarResenas(resenas);
}

setInterval(async () => {
  const clientes = cargarClientes();
  const ahora = Date.now();
  let cambios = false;
  for (const [numero, cliente] of Object.entries(clientes)) {
    if (!cliente.historial_pedidos?.length) continue;
    const ultimo = cliente.historial_pedidos[cliente.historial_pedidos.length - 1];
    if (!ultimo.resena_solicitada) {
      const diff = ahora - new Date(ultimo.fecha).getTime();
      if (diff > 2 * 60 * 60 * 1000 && diff < 4 * 60 * 60 * 1000) {
        await enviarMensaje(numero, `Hola ${cliente.nombre || ''}! Como calificarias tu pedido reciente?\n\nResponde con un numero del 1 al 5:\n⭐ 1 - Muy malo\n⭐⭐ 2 - Malo\n⭐⭐⭐ 3 - Regular\n⭐⭐⭐⭐ 4 - Bueno\n⭐⭐⭐⭐⭐ 5 - Excelente`);
        ultimo.resena_solicitada = true;
        ultimo.esperando_resena = true;
        cambios = true;
      }
    }
  }
  if (cambios) guardarJSON('./clientes.json', clientes);
}, 30 * 60 * 1000);

app.get('/panel/:slug/resenas', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json([]);
  const resenas = cargarResenas().filter(r => r.negocio === negocio.nombre);
  res.json(resenas);
});

app.get('/panel/:slug/buscar', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json([]);
  const q = (req.query.q || '').toLowerCase();
  const resultados = negocio.catalogo.filter(p => p.nombre.toLowerCase().includes(q) || p.descripcion?.toLowerCase().includes(q));
  res.json(resultados);
});

// PWA
app.get('/manifest.json', (req, res) => {
  res.json({ name: 'VendeBot Panel', short_name: 'VendeBot', start_url: '/panel/' + (req.query.slug || ''), display: 'standalone', background_color: '#f8f9fc', theme_color: '#7c3aed', icons: [{ src: 'https://i.imgur.com/placeholder.png', sizes: '192x192', type: 'image/png' }, { src: 'https://i.imgur.com/placeholder.png', sizes: '512x512', type: 'image/png' }] });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`self.addEventListener('install', e => self.skipWaiting());\nself.addEventListener('activate', e => e.waitUntil(clients.claim()));\nself.addEventListener('fetch', e => { return; });`);
});

// ─── CITAS ────────────────────────────────────────────────────
function cargarCitas() { return cache.citas; }
function guardarCitas(c) { guardarJSON('./citas.json', c); }

app.get('/panel/:slug/citas', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.json([]);
  const { fecha } = req.query;
  let citas = cargarCitas().filter(c => c.negocio_id === negocio.id);
  if (fecha) citas = citas.filter(c => c.fecha === fecha);
  citas.sort((a, b) => a.hora.localeCompare(b.hora));
  res.json(citas);
});

app.post('/panel/:slug/citas', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const citas = cargarCitas();
  citas.push({ id: 'cita_' + Date.now(), negocio_id: negocio.id, estado: 'pendiente', fecha_creacion: new Date().toISOString(), ...req.body });
  guardarCitas(citas);
  res.json({ ok: true });
});

app.put('/panel/:slug/citas/:id', authPanel, (req, res) => {
  const citas = cargarCitas();
  const idx = citas.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  citas[idx] = { ...citas[idx], ...req.body };
  guardarCitas(citas);
  if (req.body.estado === 'cancelada') {
    enviarMensaje(citas[idx].numero, `Tu cita del ${citas[idx].fecha} a las ${citas[idx].hora} ha sido cancelada. Contáctanos para reagendar.`);
  }
  res.json({ ok: true });

app.delete('/panel/:slug/citas/:id', authPanel, (req, res) => {
  const citas = cargarCitas();
  const idx = citas.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const negocio = cargarNegocios().find(n => (n.slug||n.id) === req.params.slug);
  citas[idx].estado = 'cancelada';
  guardarCitas(citas);
  if (negocio) enviarMensaje(citas[idx].numero, `Tu cita del ${citas[idx].fecha} a las ${citas[idx].hora} ha sido cancelada. Contáctanos para reagendar.`, negocio.id);
  res.json({ ok: true });
});});

// ─── HORARIO DINÁMICO ─────────────────────────────────────────
function estaAbiertoAhora(negocio) {
  if (negocio.modo_vacaciones) return false;
  const zona = 'America/Guayaquil';
  const ahoraEC = new Date(new Date().toLocaleString('en-US', { timeZone: zona }));
  const horarios = negocio.horarios;
  // Sin horarios configurados → asumir abierto (no bloquear al negocio)
  if (!horarios) return true;
  // Si ningún día tiene abierto=true → horarios no configurados → asumir abierto
  const algunoAbierto = Object.values(horarios).some(h => h && h.abierto);
  if (!algunoAbierto) return true;
  const dias = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const hoy = dias[ahoraEC.getDay()];
  const horario = horarios[hoy];
  // Si el día de hoy no tiene horario o no está abierto → cerrado
  if (!horario || !horario.abierto || !horario.desde || !horario.hasta) return false;
  const [dH, dM] = horario.desde.split(':').map(Number);
  const [hH, hM] = horario.hasta.split(':').map(Number);
  const minActual = ahoraEC.getHours() * 60 + ahoraEC.getMinutes();
  return minActual >= dH * 60 + dM && minActual < hH * 60 + hM;
}

// ─── CATÁLOGO PÚBLICO ─────────────────────────────────────────
// FIX PRINCIPAL: no-cache headers para que nunca sirva versión cacheada
app.get('/catalogo/:slug', requireSuscripcion, (req, res) => {
  res.set(HTML_NO_CACHE);
  res.sendFile('catalogo.html', { root: '.' });
});

// API de datos del catálogo
app.get('/catalogo-data/:slug', (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const { password, ...pub } = negocio;
  pub.esta_abierto = estaAbiertoAhora(negocio);
  // Incluir tema con defaults para white-label en el catálogo público
  pub.tema = { ...TEMA_DEFAULT, ...(negocio.tema || {}) };
  res.json(pub);
});

// PÁGINA DE PERSONALIZACIÓN
app.get('/personalizar/:slug/:productoId', (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).send('<h1>No encontrado</h1>');
  const producto = negocio.catalogo.find(p => p.id == req.params.productoId);
  if (!producto) return res.status(404).send('<h1>Producto no encontrado</h1>');
  const modificadores = producto.modificadores || [];
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Personalizar — ${producto.nombre}</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Segoe UI',sans-serif;background:#f8f9fc;color:#1a1a2e;max-width:480px;margin:0 auto;}header{background:linear-gradient(135deg,#7c3aed,#00c47a);color:#fff;padding:16px 20px;}header h1{font-size:18px;font-weight:700;}.producto-header{background:#fff;padding:16px;display:flex;gap:14px;align-items:center;border-bottom:1px solid #e2e6ef;}.producto-img{width:80px;height:80px;border-radius:10px;object-fit:cover;background:#f1f3f8;display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;}.producto-nombre{font-size:17px;font-weight:700;}.producto-precio{color:#7c3aed;font-size:16px;font-weight:700;margin-top:4px;}.grupo{background:#fff;margin-top:10px;padding:16px;}.grupo-titulo{font-weight:700;font-size:15px;margin-bottom:4px;}.grupo-sub{font-size:12px;color:#6b7280;margin-bottom:12px;}.opcion{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f3f8;}.opcion:last-child{border-bottom:none;}.opcion-label{display:flex;align-items:center;gap:10px;cursor:pointer;}.opcion-label input{width:18px;height:18px;cursor:pointer;accent-color:#7c3aed;}.opcion-nombre{font-size:14px;}.opcion-precio{font-size:13px;font-weight:600;color:#7c3aed;}.footer{position:sticky;bottom:0;background:#fff;border-top:1px solid #e2e6ef;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;}.total{font-size:18px;font-weight:700;}.total span{color:#7c3aed;}.btn-agregar{background:#25D366;color:#fff;border:none;border-radius:12px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;}</style></head><body><header><h1>Personaliza tu pedido</h1></header><div class="producto-header">${producto.imagen ? `<img class="producto-img" src="${producto.imagen}" alt="${producto.nombre}">` : `<div class="producto-img">${producto.emoji || '📦'}</div>`}<div><div class="producto-nombre">${producto.nombre}</div><div class="producto-precio" id="precioBase">$${producto.precio.toFixed(2)}</div>${producto.descripcion ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${producto.descripcion}</div>` : ''}</div></div>${modificadores.map((grupo, gi) => `<div class="grupo"><div class="grupo-titulo">${grupo.nombre} ${grupo.obligatorio ? '<span style="color:#ef4444;font-size:11px;">*Obligatorio</span>' : ''}</div><div class="grupo-sub">${grupo.tipo === 'unico' ? 'Elige una opción' : 'Puedes elegir varias'}</div>${grupo.opciones.map((op, oi) => `<div class="opcion"><label class="opcion-label"><input type="${grupo.tipo === 'unico' ? 'radio' : 'checkbox'}" name="grupo_${gi}" value="${op.precio || 0}" data-nombre="${op.nombre}" onchange="calcularTotal()"><span class="opcion-nombre">${op.nombre}</span></label><span class="opcion-precio">${op.precio > 0 ? '+$' + op.precio.toFixed(2) : op.precio < 0 ? '-$' + Math.abs(op.precio).toFixed(2) : 'Incluido'}</span></div>`).join('')}</div>`).join('')}<div style="height:80px;"></div><div class="footer"><div class="total">Total: <span id="totalFinal">$${producto.precio.toFixed(2)}</span></div><button class="btn-agregar" onclick="agregarAlPedido()">Agregar al pedido →</button></div><script>const precioBase=${producto.precio};const numero=new URLSearchParams(window.location.search).get('n')||'';function calcularTotal(){let extra=0;document.querySelectorAll('input[type=checkbox]:checked,input[type=radio]:checked').forEach(input=>{extra+=parseFloat(input.value)||0;});document.getElementById('totalFinal').textContent='$'+(precioBase+extra).toFixed(2);}function agregarAlPedido(){const selecciones=[];${modificadores.map((grupo, gi) => `const sel_${gi}=Array.from(document.querySelectorAll('input[name="grupo_${gi}"]:checked')).map(i=>i.dataset.nombre);if(${grupo.obligatorio}&&sel_${gi}.length===0){alert('Por favor selecciona una opción en: ${grupo.nombre}');return;}if(sel_${gi}.length>0)selecciones.push('${grupo.nombre}: '+sel_${gi}.join(', '));`).join('')}const total=document.getElementById('totalFinal').textContent;const descripcion='${producto.nombre}'+(selecciones.length>0?' ('+selecciones.join(' | ')+')':'');const msg=encodeURIComponent('Quiero agregar a mi pedido:\\n'+descripcion+'\\nTotal: '+total);if(numero){window.location.href='https://wa.me/'+numero+'?text='+msg;}else{window.location.href='https://wa.me/${negocio.whatsapp_dueno?.replace(/\D/g,'')}?text='+msg;}}</script></body></html>`;
  res.send(html);
});

// RESUMEN MATUTINO
setInterval(async () => {
  const ahora = horaActual();
  if (ahora.getHours() !== 8 || ahora.getMinutes() > 5) return;
  const negocios = cargarNegocios().filter(n => n.activo);
  const clientes = cargarClientes();
  const ayer = new Date(ahora); ayer.setDate(ayer.getDate() - 1);
  const fechaAyer = ayer.toLocaleDateString('es-EC');
  for (const negocio of negocios) {
    const pedidosAyer = [];
    Object.values(clientes).forEach(c => { c.historial_pedidos?.filter(p => p.negocio === negocio.nombre && new Date(p.fecha).toLocaleDateString('es-EC') === fechaAyer).forEach(p => pedidosAyer.push({ ...p, cliente: c.nombre || c.numero })); });
    if (!pedidosAyer.length) continue;
    const total = pedidosAyer.reduce((s, p) => s + (p.total || 0), 0);
    const msg = `☀️ Buenos días! Resumen de ayer en ${negocio.nombre}:\n\n📦 Pedidos: ${pedidosAyer.length}\n💰 Total ventas: $${total.toFixed(2)}\n\n${pedidosAyer.map(p => `• ${p.cliente} — $${p.total}`).join('\n')}`;
    await enviarMensaje(negocio.whatsapp_dueno, msg);
  }
}, 5 * 60 * 1000);

app.get('/privacidad', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Política de Privacidad - VendeBot</title><style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:20px;line-height:1.6}</style></head><body><h1>Política de Privacidad</h1><p><strong>Última actualización:</strong> Marzo 2025</p><h2>1. Información que recopilamos</h2><p>VendeBot recopila números de teléfono de WhatsApp y mensajes enviados por los usuarios con el único fin de procesar pedidos a través de negocios registrados en nuestra plataforma.</p><h2>2. Uso de la información</h2><p>La información recopilada se usa exclusivamente para: procesar pedidos, notificar al negocio correspondiente y mejorar la experiencia del usuario.</p><h2>3. Compartir información</h2><p>No vendemos ni compartimos datos personales con terceros. Los datos del pedido son compartidos únicamente con el negocio al que el usuario escribió.</p><h2>4. Retención de datos</h2><p>Los datos de conversación se almacenan temporalmente durante la sesión activa y no se guardan de forma permanente.</p><h2>5. Contacto</h2><p>Para cualquier consulta sobre privacidad escríbenos a: vendebot@contacto.com</p></body></html>`);
});

// ─── RUTAS WHATSAPP / QR / LISTA BLANCA ──────────────────────────────────────

// Ver estado de conexión WhatsApp de un negocio
app.get('/panel/:slug/whatsapp/estado', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const sesion = sesiones.get(negocio.id);
  res.json({
    estado: sesion?.estado || 'desconectado',
    qr: sesion?.qr || null,
  });
});

// Iniciar/reconectar sesión WhatsApp de un negocio
app.post('/panel/:slug/whatsapp/conectar', authPanel, async (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const sesionActual = sesiones.get(negocio.id);
  if (sesionActual?.estado === 'conectado') return res.json({ ok: true, estado: 'conectado' });
  await iniciarSesion(negocio);
  res.json({ ok: true, mensaje: 'Iniciando sesión, espera el QR...' });
});

// Desconectar / cerrar sesión WhatsApp
app.post('/panel/:slug/whatsapp/reset-sesion', authPanel, async (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const id = negocio.id;
  // Cerrar sesión activa
  const sesion = sesiones.get(id);
  if (sesion?.sock) { try { sesion.sock.end(); } catch {} }
  sesiones.delete(id);
  // Borrar archivos locales
  try { fs.rmSync(dirSesion(id), { recursive: true }); } catch {}
  // Borrar de PostgreSQL
  try { await db.query('DELETE FROM wa_sessions WHERE negocio_id=$1', [id]); } catch(e) { console.error(e.message); }
  console.log('[Sessions] Reset completo para:', id);
  // Reiniciar sesión limpia
  setTimeout(() => iniciarSesion(negocio), 2000);
  res.json({ ok: true, mensaje: 'Sesión reseteada, escanea el QR en el panel' });
});

app.post('/panel/:slug/whatsapp/desconectar', authPanel, async (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const sesion = sesiones.get(negocio.id);
  if (sesion?.sock) {
    try { await sesion.sock.logout(); } catch {}
  }
  sesiones.delete(negocio.id);
  try { fs.rmSync(dirSesion(negocio.id), { recursive: true }); } catch {}
  res.json({ ok: true });
});

// ── LISTA BLANCA ──────────────────────────────────────────────────────────────

// Ver lista blanca
app.get('/panel/:slug/lista-blanca', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  res.json(negocio.lista_blanca || []);
});

// Agregar número a lista blanca
app.post('/panel/:slug/lista-blanca', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const numero = (req.body.numero || '').replace(/\D/g, '');
  if (!numero) return res.status(400).json({ error: 'Número inválido' });
  if (!negocios[idx].lista_blanca) negocios[idx].lista_blanca = [];
  if (!negocios[idx].lista_blanca.includes(numero)) {
    negocios[idx].lista_blanca.push(numero);
    guardarJSON('./negocios.json', negocios);
  }
  res.json({ ok: true, lista_blanca: negocios[idx].lista_blanca });
});

// Eliminar número de lista blanca
app.delete('/panel/:slug/lista-blanca/:numero', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  const numero = req.params.numero.replace(/\D/g, '');
  negocios[idx].lista_blanca = (negocios[idx].lista_blanca || []).filter(n => n.replace(/\D/g, '') !== numero);
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, lista_blanca: negocios[idx].lista_blanca });
});

// ─── WHITE-LABEL: TEMA DEL NEGOCIO ───────────────────────────────────────────

const TEMA_DEFAULT = {
  color_primario: '#00c8ff',
  color_secundario: '#00e5a0',
  color_fondo: '#020509',
  color_texto: '#cce8ff',
  color_tarjeta: 'rgba(0,148,255,0.08)',
  color_boton: '#00c8ff',
  color_precio: '#00e5a0',
  fuente: 'Space Grotesk',
  border_radius: '12px',
  layout: '2',
  efecto: 'none',
  banner_opacity: 0.55,
  logo_url: '',
  banner_url: '',
};

// GET tema actual
app.get('/panel/:slug/tema', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ...TEMA_DEFAULT, ...(negocio.tema || {}) });
});

// PUT guardar tema
app.put('/panel/:slug/tema', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  // Validar campos permitidos
  const camposPermitidos = ['color_primario','color_secundario','color_fondo','color_texto','color_tarjeta','color_boton','color_precio','fuente','border_radius','layout','efecto','banner_opacity'];
  const temaActual = negocios[idx].tema || {};
  const temaActualizado = { ...temaActual };
  for (const campo of camposPermitidos) {
    if (req.body[campo] !== undefined) temaActualizado[campo] = req.body[campo];
  }
  negocios[idx].tema = temaActualizado;
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, tema: { ...TEMA_DEFAULT, ...temaActualizado } });
});

// POST reset tema a defaults
app.post('/panel/:slug/tema/reset', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].tema = { ...TEMA_DEFAULT };
  guardarJSON('./negocios.json', negocios);
  res.json({ ok: true, tema: TEMA_DEFAULT });
});

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

// Health check cada 30 minutos — verifica sesiones y reconecta las caídas
setInterval(async () => {
  const negocios = cargarNegocios().filter(n => n.activo);
  for (const negocio of negocios) {
    const sesion = sesiones.get(negocio.id);
    if (!sesion || sesion.estado === 'desconectado') {
      console.log(`[Health check] Reconectando ${negocio.nombre}...`);
      await iniciarSesion(negocio);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}, 30 * 60 * 1000);
const PORT = process.env.PORT || 3000;
// Restaurar JSONs desde PostgreSQL al arrancar (por si hubo redeploy)
async function restaurarDesdeDB() {
  // Cargar claves kiosco dinámicamente desde DB
  let clavesKiosco = [];
  try {
    const r = await db.query("SELECT clave FROM datos WHERE clave LIKE 'kiosco_pedidos_%'");
    clavesKiosco = r.rows.map(row => row.clave);
  } catch {}
  const claves = ['negocios','clientes','cupones','puntos','pedidos_pendientes','promociones','repartidores','resenas','citas', ...clavesKiosco];
  for (const clave of claves) {
    try {
      const r = await db.query('SELECT valor FROM datos WHERE clave = $1', [clave]);
      if (r.rows.length > 0) {
        const dataDB = r.rows[0].valor;
        // Cargar en cache siempre (aunque esté vacío, es el estado real)
        cache[clave] = dataDB;
        // También escribir en archivo local como respaldo
        try { fs.writeFileSync('./' + clave + '.json', JSON.stringify(dataDB, null, 2)); } catch {}
        const cantidad = Array.isArray(dataDB) ? dataDB.length + ' registros' : Object.keys(dataDB).length + ' entradas';
        console.log('✓ Cache cargado desde DB:', clave, '(' + cantidad + ')');
      } else {
        // No hay datos en DB todavía — intentar cargar desde archivo local
        try {
          const local = JSON.parse(fs.readFileSync('./' + clave + '.json', 'utf8'));
          cache[clave] = local;
          // Guardar en DB para que la próxima vez ya esté ahí
          await guardarDB(clave, local);
          console.log('✓ Cache cargado desde archivo local:', clave, '(migrado a DB)');
        } catch {}
      }
    } catch (e) {
      console.error('Error cargando', clave, e.message);
    }
  }
  console.log('✓ Negocios en memoria:', cache.negocios.length);
}

// ═══════════════════════════════════════════════════════════════════
// MÓDULO KIOSCO DIGITAL — VendeBot
// Pega este bloque completo ANTES de la línea: app.listen(PORT, ...
// ═══════════════════════════════════════════════════════════════════

// ── Contador de pedidos kiosco por negocio (en memoria) ──────────
const kioscoContadores = {};      // { negocioId: numero_actual }
const kioscoSSE = {};             // { negocioId: [res1, res2, ...] }

// ── Helpers ──────────────────────────────────────────────────────
function getKioscoPedidos(negocioId) {
  const key = `kiosco_pedidos_${negocioId}`;
  return cache[key] || [];
}
function saveKioscoPedidos(negocioId, pedidos) {
  const key = `kiosco_pedidos_${negocioId}`;
  cache[key] = pedidos;
  guardarJSON(key, pedidos);
}

function proximoNumero(negocioId) {
  // Reinicia a 1 si cambia el día
  const hoy = new Date().toLocaleDateString('es-EC');
  if (!kioscoContadores[negocioId] || kioscoContadores[negocioId].fecha !== hoy) {
    kioscoContadores[negocioId] = { fecha: hoy, num: 0 };
  }
  kioscoContadores[negocioId].num++;
  return kioscoContadores[negocioId].num;
}

function emitirKiosco(negocioId, evento, data) {
  const clientes = kioscoSSE[negocioId] || [];
  const msg = `event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`;
  clientes.forEach(res => { try { res.write(msg); } catch {} });
}

// ── Middleware kiosco activo ──────────────────────────────────────
function requireKiosco(req, res, next) {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).json({ error: 'Negocio no encontrado' });
  if (!negocio.kiosco_activo) return res.status(403).json({ error: 'Módulo kiosco no activo para este negocio' });
  if (negocio.kiosco_pausado) return res.status(503).json({ error: 'Kiosco pausado temporalmente' });
  req.negocio = negocio;
  next();
}

// ══════════════════════════════════════════════════════════════════
// RUTAS PÚBLICAS DEL KIOSCO
// ══════════════════════════════════════════════════════════════════

// Sirve la pantalla del kiosco (cliente)
app.get('/kiosco/:slug', requireSuscripcion, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).send('<h1 style="font-family:sans-serif;padding:40px">Negocio no encontrado</h1>');
  if (!negocio.kiosco_activo) return res.status(403).send('<h1 style="font-family:sans-serif;padding:40px">Módulo kiosco no activo</h1>');
  res.set({ 'Cache-Control': 'no-store' });
  res.sendFile('kiosco.html', { root: '.' });
});

// Sirve la pantalla de cocina
app.get('/cocina/:slug', (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).send('<h1 style="font-family:sans-serif;padding:40px">Negocio no encontrado</h1>');
  if (!negocio.kiosco_activo) return res.status(403).send('<h1 style="font-family:sans-serif;padding:40px">Módulo kiosco no activo</h1>');
  res.set({ 'Cache-Control': 'no-store' });
  res.sendFile('cocina.html', { root: '.' });
});

// API de datos del negocio para el kiosco y cocina
app.get('/kiosco-data/:slug', (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  if (!negocio.kiosco_activo) return res.status(403).json({ error: 'Kiosco no activo' });
  const { password, ...pub } = negocio;
  res.json({
    id: pub.id,
    nombre: pub.nombre,
    logo: pub.logo || null,
    emoji: pub.emoji || '🏪',
    pausado: !!pub.kiosco_pausado,
    catalogo: (pub.catalogo || []).filter(p => p.activo !== false),
  });
});

// ── Crear pedido desde el kiosco ──────────────────────────────────
app.post('/kiosco/:slug/pedido', requireKiosco, (req, res) => {
  const { items, total } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'Pedido vacío' });

  const negocio = req.negocio;
  const numero = proximoNumero(negocio.id);
  const pedido = {
    id: `k_${negocio.id}_${Date.now()}`,
    numero,
    items,
    total: parseFloat(total) || items.reduce((s,i) => s + i.precio * i.cantidad, 0),
    estado: 'pendiente',  // pendiente | listo
    fecha: new Date().toISOString(),
  };

  const pedidos = getKioscoPedidos(negocio.id);
  // Guardar solo pedidos de hoy
  const hoy = new Date().toLocaleDateString('es-EC');
  const pedidosHoy = pedidos.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy);
  pedidosHoy.unshift(pedido);
  saveKioscoPedidos(negocio.id, pedidosHoy);

  // Notificar a pantalla de cocina via SSE
  emitirKiosco(negocio.id, 'nuevo_pedido', pedido);

  // Notificar al dueño por WhatsApp (opcional, reusa el sistema existente)
  if (negocio.whatsapp_dueno) {
    const resumen = items.map(i => `• ${i.nombre} x${i.cantidad} = $${(i.precio*i.cantidad).toFixed(2)}`).join('\n');
    const msg = `🖥️ *Nuevo pedido kiosco #${numero}*\n\n${resumen}\n\n*Total: $${pedido.total.toFixed(2)}*\n\nEl cliente pagará en ventanilla.`;
    enviarMensaje(negocio.whatsapp_dueno, msg).catch(() => {});
  }

  res.json({ ok: true, numero, id: pedido.id });
});

// ── Obtener pedidos del día ────────────────────────────────────────
app.get('/kiosco/:slug/pedidos', requireKiosco, (req, res) => {
  const negocio = req.negocio;
  const pedidos = getKioscoPedidos(negocio.id);
  const hoy = new Date().toLocaleDateString('es-EC');
  res.json(pedidos.filter(p => new Date(p.fecha).toLocaleDateString('es-EC') === hoy));
});

// ── Marcar pedido como listo (desde cocina) ───────────────────────
app.post('/kiosco/:slug/pedidos/:id/listo', requireKiosco, (req, res) => {
  const negocio = req.negocio;
  const pedidos = getKioscoPedidos(negocio.id);
  const idx = pedidos.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Pedido no encontrado' });
  pedidos[idx].estado = 'listo';
  pedidos[idx].fecha_listo = new Date().toISOString();
  saveKioscoPedidos(negocio.id, pedidos);
  emitirKiosco(negocio.id, 'pedido_listo', { id: req.params.id });
  res.json({ ok: true });
});

// ── SSE de cocina — recibe eventos en tiempo real ─────────────────
app.get('/kiosco/:slug/events', (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug && n.activo);
  if (!negocio || !negocio.kiosco_activo) return res.status(403).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.flushHeaders();
  res.write(': conectado\n\n');

  if (!kioscoSSE[negocio.id]) kioscoSSE[negocio.id] = [];
  kioscoSSE[negocio.id].push(res);

  // Ping cada 25s para mantener viva la conexión
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    kioscoSSE[negocio.id] = (kioscoSSE[negocio.id] || []).filter(r => r !== res);
  });
});

// ══════════════════════════════════════════════════════════════════
// RUTAS DEL PANEL — Gestión del módulo kiosco
// ══════════════════════════════════════════════════════════════════

// Activar / desactivar kiosco para un negocio
app.put('/panel/:slug/kiosco/toggle', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].kiosco_activo = !negocios[idx].kiosco_activo;
  guardarJSON('negocios', negocios);
  res.json({ ok: true, kiosco_activo: negocios[idx].kiosco_activo });
});

// Estado del kiosco
app.get('/panel/:slug/kiosco/estado', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const pedidosHoy = getKioscoPedidos(negocio.id).filter(p => {
    const hoy = new Date().toLocaleDateString('es-EC');
    return new Date(p.fecha).toLocaleDateString('es-EC') === hoy;
  });
  res.json({
    kiosco_activo: !!negocio.kiosco_activo,
    kiosco_url: `/kiosco/${negocio.slug || negocio.id}`,
    cocina_url: `/cocina/${negocio.slug || negocio.id}`,
    pedidos_hoy: pedidosHoy.length,
    pendientes: pedidosHoy.filter(p => p.estado === 'pendiente').length,
    total_hoy: pedidosHoy.reduce((s,p) => s + (p.total||0), 0),
  });
});

// Pedidos del día para el panel
app.get('/panel/:slug/kiosco/pedidos', authPanel, (req, res) => {
  const negocio = cargarNegocios().find(n => (n.slug || n.id) === req.params.slug);
  if (!negocio) return res.status(404).json({ error: 'No encontrado' });
  const hoy = new Date().toLocaleDateString('es-EC');
  const pedidos = getKioscoPedidos(negocio.id).filter(p =>
    new Date(p.fecha).toLocaleDateString('es-EC') === hoy
  );
  res.json(pedidos);
});

// Pausa/reactiva el kiosco desde el panel del negocio
app.post('/panel/:slug/kiosco/pausa', authPanel, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => (n.slug || n.id) === req.params.slug);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  // Solo puede pausar/reactivar si el admin ya lo activó
  if (!negocios[idx].kiosco_activo && req.body.activo) {
    return res.status(403).json({ error: 'El admin debe activar el módulo kiosco primero' });
  }
  negocios[idx].kiosco_pausado = !req.body.activo;
  guardarJSON('negocios', negocios);
  res.json({ ok: true, kiosco_pausado: negocios[idx].kiosco_pausado });
});

// ══════════════════════════════════════════════════════════════════
// RUTA ADMIN — activar kiosco desde el panel admin SaaS
// ══════════════════════════════════════════════════════════════════

app.put('/admin/negocios/:id/kiosco', authAdmin, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  negocios[idx].kiosco_activo = !!req.body.activo;
  guardarJSON('negocios', negocios);
  res.json({ ok: true, kiosco_activo: negocios[idx].kiosco_activo });
});

// ── Gestión de suscripción desde el admin ─────────────────────────────────
app.put('/admin/negocios/:id/suscripcion', authAdmin, (req, res) => {
  const negocios = cargarNegocios();
  const idx = negocios.findIndex(n => n.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  const { activo, fecha_vencimiento, plan_activo } = req.body;
  if (activo !== undefined) negocios[idx].suscripcion_activa = !!activo;
  if (fecha_vencimiento !== undefined) negocios[idx].fecha_vencimiento = fecha_vencimiento || null;
  if (plan_activo !== undefined) negocios[idx].plan_activo = plan_activo || null;
  guardarJSON('negocios', negocios);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// FIN MÓDULO KIOSCO
// ══════════════════════════════════════════════════════════════════


app.listen(PORT, async () => {
  console.log('VendeBot v11.0 iniciado en puerto ' + PORT);
  await inicializarDB();
  await restaurarDesdeDB();
  await restaurarTokens();
  // Iniciar sesiones WhatsApp de todos los negocios activos
  await iniciarTodasLasSesiones();
});
 
