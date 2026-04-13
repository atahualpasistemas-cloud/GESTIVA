/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  FácilVirtual POS — SISTEMA DE LICENCIA DEMO                    ║
 * ║  Archivo: demo-license.js (en la RAÍZ del proyecto)             ║
 * ║                                                                  ║
 * ║  Incluir en main.js antes de createMainWindow:                  ║
 * ║    const DemoLicense = require('./demo-license');                ║
 * ║    const license = new DemoLicense(db);                         ║
 * ║    await license.init();                                         ║
 * ║    // En createMainWindow, pasar el estado:                      ║
 * ║    mainWindow.webContents.send('license-status', license.state); ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
'use strict';

const crypto = require('crypto');

// ── CONFIGURACIÓN DEL DEMO ───────────────────────────────────────────────────
const DEMO_CONFIG = {
  dias_trial:          30,          // días de prueba
  max_productos:       30,          // límite de artículos en demo
  max_clientes:        20,          // límite de clientes
  max_ventas_por_dia:  15,          // máx ventas por día en demo
  mostrar_watermark:   true,        // watermark en pantallas
  bloquear_export:     false,       // permitir exportar en demo
  bloquear_impresion:  false,       // permitir imprimir
  nombre_en_ticket:    'DEMO - FácilVirtual POS', // aparece en tickets impresos
};

// ── CLAVE MAESTRA — cambiala por una string secreta única ────────────────────
// Esta clave se usa para generar y validar códigos de activación.
// NUNCA la compartas. Está en el binario compilado.
const MASTER_SECRET = 'GestivaNet_2026_Mi_Hija_Es_Luana_Y_Giuliana_Es_Su_Mama';

class DemoLicense {
  constructor(db) {
    this.db    = db;
    this.state = {
      modo:           'demo',   // 'demo' | 'activa' | 'expirada' | 'bloqueada'
      dias_restantes: 0,
      instalacion_id: '',
      activado_en:    null,
      expira_en:      null,
      cliente_nombre: '',
      limites:        DEMO_CONFIG,
      es_demo:        true,
    };
  }

  // ── INICIALIZACIÓN ─────────────────────────────────────────────────────────
  async init() {
    // Crear tabla de licencia si no existe
    await this._run(`
      CREATE TABLE IF NOT EXISTS licencia (
        id              INTEGER PRIMARY KEY,
        instalacion_id  TEXT UNIQUE,
        primer_uso      TEXT,
        ultimo_uso      TEXT,
        codigo_activacion TEXT,
        estado          TEXT DEFAULT 'demo',
        cliente_nombre  TEXT,
        expira_en       TEXT
      )
    `);

    // Obtener o crear ID de instalación
    let lic = await this._get('SELECT * FROM licencia WHERE id = 1');
    if (!lic) {
      const id  = this._generarId();
      const now = new Date().toISOString();
      await this._run(
        'INSERT INTO licencia (id, instalacion_id, primer_uso, ultimo_uso, estado) VALUES (1,?,?,?,?)',
        [id, now, now, 'demo']
      );
      lic = await this._get('SELECT * FROM licencia WHERE id = 1');
    }

    // Actualizar último uso
    await this._run('UPDATE licencia SET ultimo_uso = ? WHERE id = 1', [new Date().toISOString()]);

    this.state.instalacion_id = lic.instalacion_id;

    // Calcular días de trial
    const primerUso  = new Date(lic.primer_uso);
    const ahora      = new Date();
    const diasUsados = Math.floor((ahora - primerUso) / (1000 * 60 * 60 * 24));
    const diasRest   = Math.max(0, DEMO_CONFIG.dias_trial - diasUsados);

    this.state.dias_restantes = diasRest;
    this.state.activado_en    = lic.primer_uso;
    this.state.expira_en      = new Date(primerUso.getTime() + DEMO_CONFIG.dias_trial * 86400000).toISOString();

    if (lic.estado === 'activa' && lic.codigo_activacion) {
      // Verificar que el código siga siendo válido
      if (this._validarCodigo(lic.instalacion_id, lic.codigo_activacion)) {
        this.state.modo          = 'activa';
        this.state.es_demo       = false;
        this.state.cliente_nombre= lic.cliente_nombre || '';
        console.log('✅ Licencia activa para:', lic.cliente_nombre);
        return;
      } else {
        // Código inválido o manipulado
        await this._run("UPDATE licencia SET estado='bloqueada' WHERE id=1");
        this.state.modo = 'bloqueada';
        console.warn('⚠️ Código de activación inválido — licencia bloqueada');
        return;
      }
    }

    if (diasRest <= 0) {
      this.state.modo = 'expirada';
      console.warn('⚠️ Licencia demo expirada');
    } else {
      this.state.modo = 'demo';
      console.log(`📋 Modo demo: ${diasRest} días restantes`);
    }
  }

  // ── ACTIVAR CON CÓDIGO ─────────────────────────────────────────────────────
  async activar(codigo, clienteNombre) {
    const lic = await this._get('SELECT * FROM licencia WHERE id = 1');
    if (!lic) return { ok: false, error: 'No se encontró registro de instalación' };

    if (!this._validarCodigo(lic.instalacion_id, codigo)) {
      return { ok: false, error: 'Código de activación inválido' };
    }

    await this._run(
      "UPDATE licencia SET estado='activa', codigo_activacion=?, cliente_nombre=? WHERE id=1",
      [codigo, clienteNombre || '']
    );

    this.state.modo          = 'activa';
    this.state.es_demo       = false;
    this.state.cliente_nombre= clienteNombre || '';
    console.log('✅ Licencia activada para:', clienteNombre);
    return { ok: true };
  }

  // ── GENERAR CÓDIGO DE ACTIVACIÓN (solo el desarrollador lo usa) ────────────
  // Llamar: DemoLicense.generarCodigo(instalacion_id)
  static generarCodigo(instalacionId, clienteNombre = '') {
    const payload = `${instalacionId}|${MASTER_SECRET}|${clienteNombre}`.toLowerCase();
    const hash    = crypto.createHash('sha256').update(payload).digest('hex');
    // Formato: XXXX-XXXX-XXXX-XXXX (16 chars hex del hash)
    const parte   = hash.substring(0, 16).toUpperCase();
    return `${parte.slice(0,4)}-${parte.slice(4,8)}-${parte.slice(8,12)}-${parte.slice(12,16)}`;
  }

  // ── VERIFICAR LÍMITES ──────────────────────────────────────────────────────
  puedeAgregarProducto(stockActual) {
    if (!this.state.es_demo) return true;
    return stockActual < DEMO_CONFIG.max_productos;
  }
  puedeAgregarCliente(totalActual) {
    if (!this.state.es_demo) return true;
    return totalActual < DEMO_CONFIG.max_clientes;
  }
  puedeVender(ventasHoy) {
    if (this.state.modo === 'expirada' || this.state.modo === 'bloqueada') return false;
    if (!this.state.es_demo) return true;
    return ventasHoy < DEMO_CONFIG.max_ventas_por_dia;
  }

  // ── PRIVADOS ───────────────────────────────────────────────────────────────
  _generarId() {
    return crypto.randomBytes(12).toString('hex').toUpperCase();
  }

  _validarCodigo(instalacionId, codigo) {
    try {
      // Probar con clienteNombre vacío y con cualquier nombre
      // (el código se genera con clienteNombre incluido)
      const codigoNorm = (codigo || '').replace(/\s/g, '').toUpperCase();

      // Fuerza bruta con nombre vacío (para códigos generales)
      const candidato = DemoLicense.generarCodigo(instalacionId, '');
      if (codigoNorm === candidato.replace(/-/g,'')) return true;

      // El código incluye nombre → el cliente puede proveer el código completo
      // En ese caso validamos que el hash del código sea correcto derivando desde el ID
      const payload = `${instalacionId}|${MASTER_SECRET}|`.toLowerCase();
      const hash    = crypto.createHash('sha256').update(payload).digest('hex');
      const base    = hash.substring(0, 16).toUpperCase();
      const gen     = `${base.slice(0,4)}${base.slice(4,8)}${base.slice(8,12)}${base.slice(12,16)}`;
      return codigoNorm === gen;
    } catch(_) { return false; }
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err); else resolve(this);
      });
    });
  }
  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err); else resolve(row || null);
      });
    });
  }
}

module.exports = DemoLicense;
