// main.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const DemoLicense = require('./demo-license');
let licenseManager = null;

// ── Base de datos ───────────────────────────────────────────────────────────
// En producción (.exe instalado): DB en AppData → sobrevive actualizaciones
// En desarrollo (npm start):      DB en carpeta local 'db/'
const sqlite3 = require('sqlite3').verbose();

function resolveDbPath() {
  // app.isPackaged = true cuando está empaquetado con electron-builder
  if (app.isPackaged) {
    const dataDir = path.join(app.getPath('userData'), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const prod = path.join(dataDir, 'pos.sqlite');
    // Primera vez: migrar DB local si existía
    const legacy = path.join(process.resourcesPath, 'db', 'pos.sqlite');
    if (!fs.existsSync(prod) && fs.existsSync(legacy)) {
      try { fs.copyFileSync(legacy, prod); console.log('✅ DB migrada a AppData'); }
      catch(e) { console.warn('Migración DB:', e.message); }
    }
    return { dbPath: prod, dbDir: dataDir };
  } else {
    const dbDir = path.join(__dirname, 'db');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    return { dbPath: path.join(dbDir, 'pos.sqlite'), dbDir };
  }
}

const { dbPath, dbDir } = resolveDbPath();
console.log('📂 DB path:', dbPath);
const db = new sqlite3.Database(dbPath);

licenseManager = new DemoLicense(db);
// init() se llama en login-success una vez que la DB esta operativa

// configure busy timeout and WAL to reduce SQLITE_BUSY chances
try {
  if (typeof db.configure === 'function') {
    db.configure('busyTimeout', 5000);
  } else {
    db.run('PRAGMA busy_timeout = 5000;');
  }
  db.run('PRAGMA journal_mode = WAL;');
  db.run('PRAGMA synchronous = NORMAL;');
  console.log('SQLite: busyTimeout + WAL applied');
} catch (e) {
  console.warn('Could not set SQLite pragmas:', e && e.message ? e.message : e);
}

// Optional ExcelJS for xlsx export
let ExcelJS = null;
try { ExcelJS = require('exceljs'); } catch (e) { console.warn('exceljs not installed (optional)'); }

// ----------------- Retry helpers for SQLITE_BUSY -----------------
function runWithRetry(sql, params = [], retries = 6, delayMs = 200) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      db.run(sql, params, function (err) {
        if (!err) return resolve(this);
        const isBusy = (err && (err.code === 'SQLITE_BUSY' || /database is locked/i.test(err.message)));
        if (isBusy && n > 0) {
          setTimeout(() => attempt(n - 1, Math.min(2000, Math.floor(delay * 1.8))), delay);
        } else reject(err);
      });
    };
    attempt(retries, delayMs);
  });
}
function allWithRetry(sql, params = [], retries = 6, delayMs = 200) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      db.all(sql, params, (err, rows) => {
        if (!err) return resolve(rows || []);
        const isBusy = (err && (err.code === 'SQLITE_BUSY' || /database is locked/i.test(err.message)));
        if (isBusy && n > 0) {
          setTimeout(() => attempt(n - 1, Math.min(2000, Math.floor(delay * 1.8))), delay);
        } else reject(err);
      });
    };
    attempt(retries, delayMs);
  });
}
function getWithRetry(sql, params = [], retries = 6, delayMs = 200) {
  return new Promise((resolve, reject) => {
    const attempt = (n, delay) => {
      db.get(sql, params, (err, row) => {
        if (!err) return resolve(row || null);
        const isBusy = (err && (err.code === 'SQLITE_BUSY' || /database is locked/i.test(err.message)));
        if (isBusy && n > 0) {
          setTimeout(() => attempt(n - 1, Math.min(2000, Math.floor(delay * 1.8))), delay);
        } else reject(err);
      });
    };
    attempt(retries, delayMs);
  });
}

// ----------------- Módulo de Caja -----------------
let cajaAPI = null;
try {
  const cajaPath = path.join(__dirname, 'ipc-caja.js');
  if (fs.existsSync(cajaPath)) {
    const registerCaja = require(cajaPath);
    cajaAPI = registerCaja({ db, ipcMain, runWithRetry, allWithRetry, getWithRetry });
    console.log('ipc-caja.js loaded — registro automático de ventas activo');
  } else {
    console.warn('ipc-caja.js no encontrado — módulo de caja no disponible');
  }
} catch (e) {
  console.warn('Error cargando ipc-caja.js:', e && e.message ? e.message : e);
}

// Try to load extras early (if present)
let extrasLoaded = false;

// Comunicaciones (email, WhatsApp, shell, diseño)
const { shell } = require('electron');
try {
  require('./ipc-comunicaciones')({ ipcMain, db, app, shell, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-comunicaciones:', e.message); }

try {
  const extrasPath = path.join(__dirname, 'main-extras.js');
  if (fs.existsSync(extrasPath)) {
    const registerExtras = require(extrasPath);
    if (typeof registerExtras === 'function') {
      registerExtras({ db, ipcMain, dialog, ExcelJS, path, fs, getMainWindow: () => mainWindow, BrowserWindow });
      extrasLoaded = true;
      console.log('main-extras.js loaded');
    }
  }
} catch (e) {
  console.warn('Error loading main-extras.js', e && e.message ? e.message : e);
}

// ----------------- DB: create tables if missing -----------------
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE,
      password TEXT,
      rol TEXT
    )
  `);
  db.run(`INSERT OR IGNORE INTO usuarios (nombre, password, rol) VALUES ('admin', 'admin', 'administrador')`);
  db.run(`
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      descripcion TEXT,
      precio REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      neto REAL DEFAULT 0,
      iva REAL DEFAULT 21,
      iibb REAL DEFAULT 0,
      margin REAL,
      categoria_id INTEGER
    )
  `);

  // Migraciones: agregar columnas nuevas a tablas existentes (se ignoran si ya existen)
  db.run('ALTER TABLE ventas ADD COLUMN anulada INTEGER DEFAULT 0', () => {});
  db.run('ALTER TABLE ventas ADD COLUMN anulacion_fecha TEXT', () => {});
  db.run('ALTER TABLE ventas ADD COLUMN anulacion_motivo TEXT', () => {});
  db.run('ALTER TABLE ventas ADD COLUMN nota_credito_id INTEGER', () => {});
  db.run('ALTER TABLE ventas ADD COLUMN cliente_id INTEGER', () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS ventas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT,
      tipo TEXT,
      nro TEXT,
      cliente TEXT,
      domicilio TEXT,
      localidad TEXT,
      telefono TEXT,
      iva TEXT,
      observaciones TEXT,
      subtotal REAL,
      descuento REAL DEFAULT 0,
      recargo REAL DEFAULT 0,
      interes REAL DEFAULT 0,
      total REAL DEFAULT 0,
      usuario TEXT,
      formapago TEXT,
      descuento_motivo TEXT,
      recargo_motivo TEXT,
      interes_percent REAL DEFAULT 0,
      interes_motivo TEXT,
      formapago_motivo TEXT,
      anulada INTEGER DEFAULT 0,
      anulacion_fecha TEXT,
      anulacion_motivo TEXT,
      nota_credito_id INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS detalle_venta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venta_id INTEGER,
      producto_codigo TEXT,
      descripcion TEXT,
      cantidad INTEGER,
      unitario REAL,
      unitario_promo REAL,
      importe REAL,
      ahorro_total REAL DEFAULT 0,
      promo_id INTEGER DEFAULT NULL,
      promo_nombre TEXT DEFAULT '',
      promo_etiqueta TEXT DEFAULT '',
      promo_tipo TEXT DEFAULT '',
      FOREIGN KEY (venta_id) REFERENCES ventas(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      cuit TEXT,
      domicilio TEXT,
      localidad TEXT,
      telefono TEXT,
      iva TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT,
      cuit TEXT,
      direccion TEXT,
      telefono TEXT,
      email TEXT,
      contacto TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT UNIQUE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proveedor TEXT,
      fecha TEXT,
      tipo_comprobante TEXT,
      numero TEXT,
      total REAL,
      observaciones TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS compra_detalle (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER,
      producto_codigo TEXT,
      descripcion TEXT,
      cantidad INTEGER,
      precio_unitario REAL,
      importe REAL,
      FOREIGN KEY(compra_id) REFERENCES compras(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT,
      usuario TEXT,
      accion TEXT,
      venta_id INTEGER,
      detalles TEXT
    )
  `);
    db.run(`
    CREATE TABLE IF NOT EXISTS configuracion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      clave TEXT UNIQUE NOT NULL,
      valor TEXT,
      tipo TEXT DEFAULT 'string',
      actualizado_en TEXT
    )
  `);
  db.run(`CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS puntos_venta (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    numero      INTEGER UNIQUE NOT NULL,
    descripcion TEXT DEFAULT '',
    ubicacion   TEXT DEFAULT '',
    activo      INTEGER DEFAULT 1
  )`);
  db.run(`INSERT OR IGNORE INTO puntos_venta (numero,descripcion,ubicacion) VALUES (1,'Caja Principal','Local')`);
});

// ----------------- IPC handlers -----------------

// login
ipcMain.handle('login', async (event, { nombre, password }) => {
  try {
    const row = await getWithRetry('SELECT * FROM usuarios WHERE nombre = ? AND password = ?', [nombre, password]);
    if (row) return { ok: true, usuario: row.nombre, rol: row.rol };
    return { ok: false, error: 'Usuario o contraseña incorrectos' };
  } catch (err) {
    return { ok: false, error: 'DB error' };
  }
});

// categorias
ipcMain.handle('categorias:listar', async () => {
  try {
    const rows = await allWithRetry('SELECT * FROM categorias ORDER BY nombre', []);
    return rows;
  } catch (err) {
    return [];
  }
});
ipcMain.handle('categoria:agregar', async (event, c) => {
  try {
    const info = await runWithRetry('INSERT OR IGNORE INTO categorias (nombre) VALUES (?)', [c.nombre]);
    return { ok: true, id: info.lastID };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// productos
ipcMain.handle('productos:listar-full', async () => {
  try {
    const rows = await allWithRetry(`SELECT p.*, c.nombre AS categoria_nombre FROM productos p LEFT JOIN categorias c ON p.categoria_id = c.id ORDER BY p.descripcion`, []);
    return rows;
  } catch (err) {
    return [];
  }
});
ipcMain.handle('producto:agregar', async (event, prod) => {
  try {
    const info = await runWithRetry(`INSERT INTO productos (codigo, descripcion, precio, stock, neto, iva, iibb, margin, categoria_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [prod.codigo, prod.descripcion, prod.neto, prod.stock, prod.neto, prod.iva, prod.iibb, prod.margin, prod.categoria_id]);
    return { ok: true, id: info.lastID };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('producto:modificar', async (event, prod) => {
  try {
    const info = await runWithRetry(`UPDATE productos SET descripcion=?, precio=?, stock=?, neto=?, iva=?, iibb=?, margin=?, categoria_id=? WHERE codigo=?`,
      [prod.descripcion, prod.neto, prod.stock, prod.neto, prod.iva, prod.iibb, prod.margin, prod.categoria_id, prod.codigo]);
    return { ok: true, changes: info.changes || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('producto:eliminar', async (event, codigo) => {
  try {
    const info = await runWithRetry('DELETE FROM productos WHERE codigo=?', [codigo]);
    return { ok: true, changes: info.changes || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('productos:aplicar-margen', async (event, payload) => {
  try {
    if (payload.categoria_id) {
      const info = await runWithRetry('UPDATE productos SET margin = ? WHERE categoria_id = ?', [payload.percent, payload.categoria_id]);
      return { ok: true, changes: info.changes || 0 };
    } else {
      const info = await runWithRetry('UPDATE productos SET margin = ?', [payload.percent]);
      return { ok: true, changes: info.changes || 0 };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// proveedores
ipcMain.handle('proveedores:listar', async () => {
  try {
    return await allWithRetry('SELECT * FROM proveedores ORDER BY nombre', []);
  } catch (err) {
    return [];
  }
});
ipcMain.handle('proveedores:buscar', async (event, query) => {
  try {
    const q = `%${(query || '').trim()}%`;
    return await allWithRetry('SELECT id, nombre, cuit, telefono FROM proveedores WHERE nombre LIKE ? OR cuit LIKE ? ORDER BY nombre LIMIT 30', [q, q]);
  } catch (err) {
    return [];
  }
});
ipcMain.handle('proveedor:agregar', async (event, prov) => {
  try {
    const info = await runWithRetry('INSERT INTO proveedores (nombre, cuit, direccion, telefono, email, contacto) VALUES (?, ?, ?, ?, ?, ?)', [prov.nombre, prov.cuit || '', prov.direccion || '', prov.telefono || '', prov.email || '', prov.contacto || '']);
    return { ok: true, id: info.lastID };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('proveedor:modificar', async (event, prov) => {
  try {
    const info = await runWithRetry('UPDATE proveedores SET nombre=?, cuit=?, direccion=?, telefono=?, email=?, contacto=? WHERE id=?', [prov.nombre, prov.cuit || '', prov.direccion || '', prov.telefono || '', prov.email || '', prov.contacto || '', prov.id]);
    return { ok: true, changes: info.changes || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('proveedor:eliminar', async (event, id) => {
  try {
    const info = await runWithRetry('DELETE FROM proveedores WHERE id=?', [id]);
    return { ok: true, changes: info.changes || 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// compras: import from excel
ipcMain.handle('compras:import-excel', async () => {
  if (!ExcelJS) return { ok: false, error: 'exceljs not installed' };
  const dlg = await dialog.showOpenDialog({ title: 'Select purchases xlsx', properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }] });
  if (dlg.canceled || !dlg.filePaths || dlg.filePaths.length === 0) return { ok: false, error: 'cancelled' };
  const file = dlg.filePaths[0];
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    const sheet = workbook.getWorksheet(0);
    if (!sheet) return { ok: false, error: 'empty sheet' };

    const rows = [];
    sheet.eachRow((r, idx) => {
      if (idx === 1) return;
      const proveedor = (r.getCell(1).value || '').toString().trim();
      const fecha = (r.getCell(2).value || '').toString().trim();
      const tipo = (r.getCell(3).value || '').toString().trim();
      const numero = (r.getCell(4).value || '').toString().trim();
      const codigo = (r.getCell(5).value || '').toString().trim();
      const descripcion = (r.getCell(6).value || '').toString().trim();
      const cantidad = Number(r.getCell(7).value) || 0;
      const precio_unitario = Number(r.getCell(8).value) || 0;
      rows.push({ proveedor, fecha, tipo, numero, codigo, descripcion, cantidad, precio_unitario });
    });

    const groups = {};
    rows.forEach(r => {
      const key = `${r.proveedor}|${r.tipo}|${r.numero}|${r.fecha}`;
      groups[key] = groups[key] || { proveedor: r.proveedor, tipo: r.tipo, numero: r.numero, fecha: r.fecha, lines: [] };
      groups[key].lines.push(r);
    });

    const report = [];
    for (const key of Object.keys(groups)) {
      const g = groups[key];
      let totalComp = 0;
      const infoCompra = await runWithRetry('INSERT INTO compras (proveedor, fecha, tipo_comprobante, numero, total, observaciones) VALUES (?, ?, ?, ?, ?, ?)', [g.proveedor, g.fecha, g.tipo, g.numero, 0, 'Importada desde Excel']);
      const compraId = infoCompra.lastID;
      for (const line of g.lines) {
        const importe = line.cantidad * line.precio_unitario;
        totalComp += importe;
        await runWithRetry('INSERT INTO compra_detalle (compra_id, producto_codigo, descripcion, cantidad, precio_unitario, importe) VALUES (?, ?, ?, ?, ?, ?)', [compraId, line.codigo, line.descripcion, line.cantidad, line.precio_unitario, importe]);
        const prodRow = await getWithRetry('SELECT * FROM productos WHERE codigo = ?', [line.codigo]);
        if (prodRow) {
          const prevStock = Number(prodRow.stock || 0);
          const prevNeto = Number(prodRow.neto || prodRow.precio || 0);
          const newStock = prevStock + Number(line.cantidad);
          const newNeto = ((prevStock * prevNeto) + (line.cantidad * line.precio_unitario)) / (newStock || 1);
          await runWithRetry('UPDATE productos SET stock = ?, neto = ?, precio = ? WHERE codigo = ?', [newStock, newNeto, newNeto, line.codigo]);
        } else {
          await runWithRetry('INSERT INTO productos (codigo, descripcion, precio, stock, neto, iva, iibb) VALUES (?, ?, ?, ?, ?, ?, ?)', [line.codigo, line.descripcion, line.precio_unitario, line.cantidad, line.precio_unitario, 21, 0]);
        }
      }
      await runWithRetry('UPDATE compras SET total = ? WHERE id = ?', [totalComp, compraId]);
      report.push(`Compra ${g.tipo}-${g.numero} proveedor ${g.proveedor}: ${g.lines.length} lineas, total ${totalComp.toFixed(2)}`);
    }

    return { ok: true, report: report.join('\n') };
  } catch (err) {
    console.error('Error importing purchases:', err);
    return { ok: false, error: err.message || 'error' };
  }
});

// Helper: build csv
const buildCsvFromColumns = (rows, columns) => {
  const esc = v => {
    if (v === null || v === undefined) return '';
    return `"${String(v).replace(/"/g, '""')}"`;
  };
  const header = columns.map(c => esc(c.label || c.key)).join(',');
  const lines = rows.map(r => columns.map(c => esc(r[c.key])).join(','));
  return [header, ...lines].join('\n');
};

// Módulo de impresión
try {
  require('./ipc-impresion')({
    ipcMain, BrowserWindow, app, shell, dialog, path, fs,
    getMainWindow: () => mainWindow,
    runWithRetry, allWithRetry, getWithRetry
  });
} catch(e) { console.warn('ipc-impresion:', e.message); }

// Módulo de productos ampliado
try {
  require('./ipc-productos')({ ipcMain, db, dialog, path, fs, ExcelJS, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-productos:', e.message); }

// ── MIGRACIÓN: columnas nuevas + handlers de proveedores/clientes completos
try {
  require('./ipc-migration')({ ipcMain, db, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-migration:', e.message); }

// ── Cuentas: pedidos, facturas compra, cta/cte clientes, remitos
try {
  require('./ipc-cuentas')({ ipcMain, db, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-cuentas:', e.message); }
try {
  require('./ipc-promociones')({ ipcMain, db, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-promociones:', e.message); }


// ── Importación masiva de productos desde Excel/CSV ──────────────────────────
ipcMain.handle('productos:importar-excel', async (event, { filePath }) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ext = filePath.toLowerCase().split('.').pop();

    if (ext === 'xlsx' || ext === 'xls') {
      await wb.xlsx.readFile(filePath);
    } else {
      return { ok: false, error: 'Formato no soportado. Usá .xlsx' };
    }

    const ws = wb.worksheets[0];
    if (!ws) return { ok: false, error: 'El archivo no tiene hojas' };

    // Leer encabezados (fila 1)
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = String(cell.value || '').toLowerCase().trim();
    });

    const productos = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // saltar encabezados
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        vals[col - 1] = cell.value;
      });
      if (!vals.length || !vals[0]) return;

      const get = (keys) => {
        for (const k of keys) {
          const idx = headers.findIndex(h => h.includes(k));
          if (idx >= 0 && vals[idx] != null) return String(vals[idx]).trim();
        }
        return '';
      };
      const getNum = (keys, def = 0) => parseFloat(get(keys)) || def;

      productos.push({
        codigo:       get(['codigo','code','sku','cod ']),
        descripcion:  get(['descripcion','nombre','description','name','producto']),
        categoria:    get(['categoria','rubro','category']),
        marca:        get(['marca','brand']),
        precio_costo: getNum(['costo','cost','precio costo','precio_costo']),
        ganancia:     getNum(['ganancia','margen','margin','markup'], 30),
        iva:          getNum(['iva','tax','alicuota'], 21),
        precio:       getNum(['precio','price','precio venta','precio_venta']),
        stock:        getNum(['stock','cantidad','qty'], 0),
        stock_min:    getNum(['stock min','stock_min','minimo','min'], 0),
        unidad:       get(['unidad','unit']) || 'unidad',
        codigo_barra: get(['codigo barra','ean','upc','barcode','barra']),
      });
    });

    return { ok: true, productos, total: productos.length };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('productos:importar-confirmar', async (event, { productos, modo }) => {
  // modo: 'nuevo' = solo insertar nuevos | 'actualizar' = actualizar existentes | 'todo' = ambos
  try {
    const stats = { insertados: 0, actualizados: 0, errores: 0 };

    for (const p of productos) {
      if (!p.codigo || !p.descripcion) { stats.errores++; continue; }

      // Resolver/crear categoría
      let catId = null;
      if (p.categoria) {
        const existing = await getWithRetry('SELECT id FROM categorias WHERE LOWER(nombre)=LOWER(?)', [p.categoria]);
        if (existing) {
          catId = existing.id;
        } else {
          const info = await runWithRetry('INSERT OR IGNORE INTO categorias (nombre) VALUES (?)', [p.categoria]);
          catId = info.lastID || (await getWithRetry('SELECT id FROM categorias WHERE LOWER(nombre)=LOWER(?)', [p.categoria]))?.id;
        }
      }

      // Calcular precio si no viene
      let pv = parseFloat(p.precio) || 0;
      if (!pv && p.precio_costo > 0) {
        pv = Math.round(p.precio_costo * (1 + (p.ganancia||30)/100) * (1 + (p.iva||21)/100) * 100) / 100;
      }

      const existing = await getWithRetry('SELECT codigo FROM productos WHERE codigo=?', [p.codigo]);

      if (existing && (modo === 'actualizar' || modo === 'todo')) {
        await runWithRetry(
          `UPDATE productos SET descripcion=?,categoria_id=?,marca=?,precio_costo=?,neto=?,ganancia=?,margin=?,iva=?,precio=?,stock=?,stock_min=?,unidad=?,codigo_barra=? WHERE codigo=?`,
          [p.descripcion, catId, p.marca||'', p.precio_costo||0, p.precio_costo||0, p.ganancia||30, p.ganancia||30, p.iva||21, pv, p.stock||0, p.stock_min||0, p.unidad||'unidad', p.codigo_barra||'', p.codigo]
        );
        stats.actualizados++;
      } else if (!existing && (modo === 'nuevo' || modo === 'todo')) {
        await runWithRetry(
          `INSERT INTO productos (codigo,descripcion,categoria_id,marca,precio_costo,neto,bonificacion,precio_lista,ganancia,margin,iva,iibb,precio,stock,stock_min,stock_max,unidad,codigo_barra,activo) VALUES (?,?,?,?,?,?,0,0,?,?,?,0,?,?,?,0,?,?,1)`,
          [p.codigo, p.descripcion, catId, p.marca||'', p.precio_costo||0, p.precio_costo||0, p.ganancia||30, p.ganancia||30, p.iva||21, pv, p.stock||0, p.stock_min||0, p.unidad||'unidad', p.codigo_barra||'']
        );
        stats.insertados++;
      }
    }
    return { ok: true, ...stats };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('productos:descargar-plantilla', async () => {
  try {
    const ExcelJS = require('exceljs');
    const result = await dialog.showSaveDialog({
      title: 'Guardar plantilla',
      defaultPath: 'plantilla_productos.xlsx',
      filters: [{ name: 'Excel', extensions: ['xlsx'] }]
    });
    if (result.canceled) return { ok: false };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = [
      {header:'Codigo',key:'codigo',width:14},
      {header:'Descripcion',key:'descripcion',width:30},
      {header:'Categoria',key:'categoria',width:16},
      {header:'Marca',key:'marca',width:14},
      {header:'Precio Costo',key:'precio_costo',width:14},
      {header:'Ganancia %',key:'ganancia',width:12},
      {header:'IVA %',key:'iva',width:10},
      {header:'Precio Venta',key:'precio_venta',width:14},
      {header:'Stock',key:'stock',width:10},
      {header:'Stock Minimo',key:'stock_min',width:12},
      {header:'Unidad',key:'unidad',width:10},
      {header:'Codigo Barra',key:'codigo_barra',width:16},
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2EA846' } };
    // Ejemplo
    ws.addRow(['001','Producto Ejemplo','Bebidas','Marca1',100,30,21,0,10,2,'unidad','7790001234567']);
    ws.addRow(['002','Otro Producto','Limpieza','',200,40,21,0,5,1,'unidad','']);
    // Nota
    ws.addRow([]);
    const noteRow = ws.addRow(['NOTA: Precio Venta puede dejarse en 0 y se calcula automáticamente con Costo × (1+Ganancia%) × (1+IVA%)']);
    noteRow.font = { italic: true, color: { argb: 'FF888888' } };
    ws.mergeCells(`A${noteRow.number}:L${noteRow.number}`);

    await wb.xlsx.writeFile(result.filePath);
    return { ok: true, path: result.filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:open-file', async (event, { filters }) => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, filePath: result.filePaths[0] };
});

// ── Export Proveedores
ipcMain.handle('export:proveedores', async (event, { format } = {}) => {
  try {
    const provs = await allWithRetry('SELECT * FROM proveedores ORDER BY nombre', []);
    const ts = new Date().toISOString().slice(0,10);
    const defaultPath = `proveedores_${ts}.${format==='xlsx'?'xlsx':'csv'}`;
    const result = await dialog.showSaveDialog({
      title: 'Exportar Proveedores', defaultPath,
      filters: format==='xlsx'
        ? [{ name:'Excel', extensions:['xlsx'] }]
        : [{ name:'CSV', extensions:['csv'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelado' };
    if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Proveedores');
      ws.columns = [
        {header:'ID',key:'id',width:6},{header:'Nombre',key:'nombre',width:30},
        {header:'CUIT',key:'cuit',width:18},{header:'IVA',key:'condicion_iva',width:20},
        {header:'Dirección',key:'direccion',width:30},{header:'Localidad',key:'localidad',width:20},
        {header:'Teléfono',key:'telefono',width:16},{header:'WhatsApp',key:'whatsapp',width:18},
        {header:'Email',key:'email',width:28},{header:'Contacto',key:'contacto',width:20},
        {header:'Rubros',key:'rubros',width:20},{header:'Plazo pago',key:'plazo_pago',width:14},
        {header:'Días entrega',key:'dias_entrega',width:14},{header:'Obs.',key:'observaciones',width:30},
      ];
      ws.getRow(1).font = { bold:true, color:{argb:'FFFFFFFF'} };
      ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF2EA846'} };
      provs.forEach(p => ws.addRow(p));
      ws.autoFilter = { from:'A1', to:'N1' };
      await wb.xlsx.writeFile(result.filePath);
    } else {
      const header = 'id,nombre,cuit,condicion_iva,direccion,localidad,telefono,whatsapp,email,contacto,rubros,plazo_pago,dias_entrega,observaciones';
      const rows = provs.map(p => [p.id,p.nombre,p.cuit,p.condicion_iva,p.direccion,p.localidad,
        p.telefono,p.whatsapp,p.email,p.contacto,p.rubros,p.plazo_pago,p.dias_entrega,p.observaciones]
        .map(v=>`"${String(v||'').replace(/"/g,'""')}"`)
        .join(',')).join('\n');
      require('fs').writeFileSync(result.filePath, '\uFEFF'+header+'\n'+rows, 'utf8');
    }
    return { ok: true, path: result.filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Export Clientes (CSV/XLSX)
ipcMain.handle('export:clientes', async (event, { format } = {}) => {
  try {
    const clientes = await allWithRetry('SELECT * FROM clientes ORDER BY nombre', []);
    const ts = new Date().toISOString().slice(0,10);
    const defaultPath = `clientes_${ts}.${format === 'xlsx' ? 'xlsx' : 'csv'}`;

    const result = await dialog.showSaveDialog({
      title: 'Exportar Clientes',
      defaultPath,
      filters: format === 'xlsx'
        ? [{ name: 'Excel', extensions: ['xlsx'] }]
        : [{ name: 'CSV', extensions: ['csv'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelado' };

    if (format === 'xlsx') {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Clientes');
      ws.columns = [
        { header: 'ID',       key: 'id',         width: 6  },
        { header: 'Nombre',   key: 'nombre',      width: 30 },
        { header: 'CUIT',     key: 'cuit',        width: 18 },
        { header: 'IVA',      key: 'iva',         width: 20 },
        { header: 'Domicilio',key: 'domicilio',   width: 30 },
        { header: 'Localidad',key: 'localidad',   width: 20 },
        { header: 'Teléfono', key: 'telefono',    width: 16 },
        { header: 'WhatsApp', key: 'whatsapp',    width: 18 },
        { header: 'Email',    key: 'email',       width: 28 },
        { header: 'Contacto', key: 'contacto',    width: 20 },
        { header: 'Obs.',     key: 'observaciones',width: 30 },
      ];
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } };
      clientes.forEach(c => ws.addRow(c));
      ws.autoFilter = { from: 'A1', to: 'K1' };
      await wb.xlsx.writeFile(result.filePath);
    } else {
      const header = 'id,nombre,cuit,iva,domicilio,localidad,telefono,whatsapp,email,contacto,observaciones';
      const rows = clientes.map(c =>
        [c.id, c.nombre, c.cuit, c.iva, c.domicilio, c.localidad,
         c.telefono, c.whatsapp, c.email, c.contacto, c.observaciones]
        .map(v => `"${String(v||'').replace(/"/g,'""')}"`)
        .join(',')
      ).join('\n');
      require('fs').writeFileSync(result.filePath, '\uFEFF' + header + '\n' + rows, 'utf8');
    }
    return { ok: true, path: result.filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ── Estadísticas y analítica
try {
  require('./ipc-estadisticas')({ ipcMain, db, runWithRetry, allWithRetry, getWithRetry });
} catch(e) { console.warn('ipc-estadisticas:', e.message); }

try {
  const safeHandle = (ch, fn) => {
    try { ipcMain.handle(ch, fn); } catch(e2) { /* already registered */ }
  };
  require('./ipc-costos')(db, safeHandle);
} catch(e) { console.warn('ipc-costos:', e.message); }

// ── open-costos ────────────────────────────────────────────────────────────
ipcMain.on('open-costos', () => {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 900, minHeight: 600 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Costos y Rentabilidad — Gestiva.NET'); });
  win.loadFile(path.join(__dirname, 'renderer', 'costos.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});


// ----------------- ventas handlers -----------------
ipcMain.handle('venta:registrar', async (event, venta, items) => {
  try {
    await runWithRetry('BEGIN TRANSACTION');
    const insertSql = `
      INSERT INTO ventas (
        fecha, tipo, nro, cliente, domicilio, localidad, telefono, iva, observaciones,
        subtotal, descuento, recargo, interes, total, usuario, formapago,
        descuento_motivo, recargo_motivo, interes_percent, interes_motivo, formapago_motivo
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const params = [
      venta.fecha, venta.tipo, venta.nro, venta.cliente, venta.domicilio, venta.localidad, venta.telefono, venta.iva,
      venta.observaciones, venta.subtotal, venta.descuento || 0, venta.recargo || 0, venta.interes || 0, venta.total || 0,
      venta.usuario || 'sistema', venta.formapago || '',
      venta.descuento_motivo || '', venta.recargo_motivo || '', venta.interes_percent || 0,
      venta.interes_motivo || '', venta.formapago_motivo || ''
    ];
    const info = await runWithRetry(insertSql, params);
    const ventaId = info.lastID;

    if (!items || items.length === 0) {
      await runWithRetry('COMMIT');
      return { ok: true, ventaId };
    }

    for (const item of items) {
      await runWithRetry(
        'INSERT INTO detalle_venta (venta_id, producto_codigo, descripcion, cantidad, unitario, unitario_promo, importe, ahorro_total, promo_id, promo_nombre, promo_etiqueta, promo_tipo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [ventaId, item.codigo, item.descripcion, item.cantidad,
         item.unitario, item.unitario_promo||null,
         item.importe, item.ahorro_total||0,
         item.promo_id||null, item.promo_nombre||'', item.promo_etiqueta||'', item.promo_tipo||'']
      );
      await runWithRetry('UPDATE productos SET stock = stock - ? WHERE codigo = ?', [item.cantidad, item.codigo]);
    }

    await runWithRetry('COMMIT');

    if (cajaAPI && cajaAPI.registrarMovVenta) {
      await cajaAPI.registrarMovVenta({
        ventaId,
        nro: venta.nro || ventaId,
        tipo: venta.tipo || 'Ticket',
        total: venta.total || 0,
        formapago: venta.formapago || 'Efectivo',
        usuario: venta.usuario || 'sistema'
      });
    }

    // Registrar en Cta/Cte si la forma de pago es ctacte
    if ((venta.formapago || '').toLowerCase() === 'ctacte') {
      try {
        const cuentasAPI = require('./ipc-cuentas');
        // llamar directamente al módulo de cuentas
        // Necesitamos cliente_id — si no viene, buscarlo por nombre
        let cliId = venta.cliente_id || null;
        if (!cliId && venta.cliente && !venta.cliente.includes('Ocasional')) {
          const cliRow = await new Promise(r => db.get(
            'SELECT id FROM clientes WHERE LOWER(nombre)=LOWER(?) LIMIT 1',
            [venta.cliente], (e, row) => r(row)
          ));
          if (cliRow) cliId = cliRow.id;
        }
        if (cliId) {
          // Insertar movimiento en ctacte_clientes
          const ultSaldo = await new Promise(r => db.get(
            'SELECT saldo FROM ctacte_clientes WHERE cliente_id=? ORDER BY id DESC LIMIT 1',
            [cliId], (e, row) => r(row)
          ));
          const saldoAnterior = ultSaldo ? Number(ultSaldo.saldo) : 0;
          const nuevoSaldo = saldoAnterior + (venta.total || 0);
          const now = new Date().toISOString();
          await new Promise(r => db.run(
            'INSERT INTO ctacte_clientes (cliente_id,cliente_nombre,fecha,tipo,referencia_id,descripcion,debe,haber,saldo,usuario,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            [cliId, venta.cliente, venta.fecha || now.slice(0,10),
             'venta', ventaId,
             `${venta.tipo||'Ticket'} Nro. ${venta.nro||ventaId}`,
             venta.total || 0, 0, nuevoSaldo,
             venta.usuario || 'sistema', now],
            r
          ));
          console.log('[ctacte] Movimiento registrado para cliente', cliId, 'saldo', nuevoSaldo);
        } else {
          console.warn('[ctacte] Venta ctacte sin cliente_id — no se registró en cta/cte. Cliente:', venta.cliente);
        }
      } catch(ctaErr) {
        console.error('[ctacte] Error registrando en cta/cte:', ctaErr.message);
      }
    }

    // Subir stats a Firebase después de cada venta (sin bloquear)
    pushStatsToFirebase().catch(()=>{});

    // Notificar a todas las ventanas abiertas para refrescar caja en tiempo real
    try {
      const { BrowserWindow: BW } = require('electron');
      BW.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) {
          try { w.webContents.send('caja:venta-registrada', { total: venta.total || 0 }); } catch(_) {}
        }
      });
    } catch(_) {}

    return { ok: true, ventaId };
  } catch (err) {
    try { await runWithRetry('ROLLBACK'); } catch (_) {}
    console.error('Error registering venta:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('venta:obtener-proximo-numero', async (event, tipo) => {
  try {
    const row = await getWithRetry('SELECT MAX(CAST(nro AS INTEGER)) as maxNro FROM ventas WHERE tipo = ?', [tipo]);
    const nextNumber = (row && row.maxNro ? parseInt(row.maxNro) + 1 : 1);
    return { ok: true, numero: nextNumber };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ventas:listar', async () => {
  try {
    const rows = await allWithRetry(`SELECT id, fecha, tipo, nro, cliente, usuario, subtotal, descuento, recargo, interes, total, anulada, anulacion_fecha FROM ventas ORDER BY fecha DESC`, []);
    return rows;
  } catch (err) {
    return [];
  }
});

ipcMain.handle('venta:obtener-detalle', async (event, ventaId) => {
  try {
    const ventaRow = await getWithRetry('SELECT * FROM ventas WHERE id = ?', [ventaId]);
    if (!ventaRow) return { venta: null, detalle: [] };
    const detalleRows = await allWithRetry('SELECT * FROM detalle_venta WHERE venta_id = ?', [ventaId]);
    return { venta: ventaRow, detalle: detalleRows || [] };
  } catch (err) {
    return { venta: null, detalle: [] };
  }
});

ipcMain.handle('venta:anular', async (event, { ventaId, motivo, usuario }) => {
  try {
    const ventaRow = await getWithRetry('SELECT * FROM ventas WHERE id = ?', [ventaId]);
    if (!ventaRow) return { ok: false, error: 'Venta not found' };
    const detalleRows = await allWithRetry('SELECT * FROM detalle_venta WHERE venta_id = ?', [ventaId]);

    await runWithRetry('BEGIN TRANSACTION');
    const now = new Date().toISOString();
    await runWithRetry('UPDATE ventas SET anulada = 1, anulacion_fecha = ?, anulacion_motivo = ? WHERE id = ?', [now, motivo, ventaId]);

    const ncFecha = now;
    const ncTipo = 'NC';
    const ncNro = (ventaRow.nro ? (String(ventaRow.nro) + '-NC') : (`NC-${ventaId}`));
    const ncCliente = ventaRow.cliente || '';
    const ncDomicilio = ventaRow.domicilio || '';
    const ncLocalidad = ventaRow.localidad || '';
    const ncTelefono = ventaRow.telefono || '';
    const ncIva = ventaRow.iva || '';
    const ncObs = 'Nota de Credito por anulacion de venta ' + ventaId + (motivo ? (' - ' + motivo) : '');
    const ncSubtotal = -Number(ventaRow.subtotal || 0);
    const ncDescuento = -Number(ventaRow.descuento || 0);
    const ncRecargo = -Number(ventaRow.recargo || 0);
    const ncInteres = -Number(ventaRow.interes || 0);
    const ncTotal = -Number(ventaRow.total || 0);
    const ncUsuario = usuario || (ventaRow.usuario || 'sistema');
    const ncFormapago = 'NC';

    const infoNc = await runWithRetry(`INSERT INTO ventas (fecha, tipo, nro, cliente, domicilio, localidad, telefono, iva, observaciones, subtotal, descuento, recargo, interes, total, usuario, formapago) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ncFecha, ncTipo, ncNro, ncCliente, ncDomicilio, ncLocalidad, ncTelefono, ncIva, ncObs, ncSubtotal, ncDescuento, ncRecargo, ncInteres, ncTotal, ncUsuario, ncFormapago]);
    const ncId = infoNc.lastID;

    if ((detalleRows || []).length === 0) {
      await runWithRetry('UPDATE ventas SET nota_credito_id = ? WHERE id = ?', [ncId, ventaId]);
      await runWithRetry('COMMIT');
      return { ok: true, ncId };
    }

    for (const dr of detalleRows) {
      const negCantidad = -Number(dr.cantidad || 0);
      const negImporte = -Number(dr.importe || 0);
      await runWithRetry('INSERT INTO detalle_venta (venta_id, producto_codigo, descripcion, cantidad, unitario, importe) VALUES (?, ?, ?, ?, ?, ?)', [ncId, dr.producto_codigo, dr.descripcion, negCantidad, dr.unitario, negImporte]);
      await runWithRetry('UPDATE productos SET stock = stock + ? WHERE codigo = ?', [Number(dr.cantidad || 0), dr.producto_codigo]);
    }

    await runWithRetry('UPDATE ventas SET nota_credito_id = ? WHERE id = ?', [ncId, ventaId]);
    await runWithRetry('COMMIT');

    if (cajaAPI && cajaAPI.registrarAnulacionEnCaja) {
      await cajaAPI.registrarAnulacionEnCaja({
        ventaId,
        nro: ventaRow.nro || ventaId,
        tipo: ventaRow.tipo || 'Ticket',
        total: ventaRow.total || 0,
        usuario: usuario || (ventaRow.usuario || 'sistema')
      });
    }

    return { ok: true, ncId };
  } catch (err) {
    try { await runWithRetry('ROLLBACK'); } catch (_) {}
    console.error('Error anulando venta:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Conditional registration of extras handlers
if (!extrasLoaded) {
  ipcMain.handle('export:ventas', async (event, opts) => {
    try {
      const format = (opts && opts.format) ? String(opts.format).toLowerCase() : 'csv';
      const rows = await allWithRetry(`SELECT v.id, v.fecha, v.tipo, v.nro, v.cliente, v.usuario, v.subtotal, v.descuento, v.recargo, v.interes, v.total, v.anulada FROM ventas v ORDER BY v.fecha DESC`, []);
      const columns = [
        { key: 'id', label: 'ID' }, { key: 'fecha', label: 'Fecha' }, { key: 'tipo', label: 'Tipo' }, { key: 'nro', label: 'Numero' },
        { key: 'cliente', label: 'Cliente' }, { key: 'usuario', label: 'Cajero' }, { key: 'subtotal', label: 'Subtotal' }, { key: 'descuento', label: 'Descuento' },
        { key: 'recargo', label: 'Recargo' }, { key: 'interes', label: 'Interes' }, { key: 'total', label: 'Total' }, { key: 'anulada', label: 'Anulada' }
      ];
      const esc = v => (v === null || v === undefined) ? '' : `"${String(v).replace(/"/g, '""')}"`;
      const header = columns.map(c => esc(c.label)).join(',');
      const lines = rows.map(r => columns.map(c => esc(r[c.key])).join(','));
      const csv = [header, ...lines].join('\n');
      if (format === 'csv') {
        const dlg = await dialog.showSaveDialog({ title: 'Export ventas (CSV)', defaultPath: 'ventas.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
        if (dlg.canceled || !dlg.filePath) return { ok: false, error: 'cancelled' };
        fs.writeFileSync(dlg.filePath, csv, 'utf8');
        return { ok: true, path: dlg.filePath };
      } else if (format === 'xlsx') {
        if (!ExcelJS) return { ok: false, error: 'xlsx not available' };
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Ventas');
        sheet.addRow(columns.map(c => c.label));
        rows.forEach(r => sheet.addRow(columns.map(c => r[c.key])));
        const dlg = await dialog.showSaveDialog({ title: 'Export ventas (XLSX)', defaultPath: 'ventas.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
        if (dlg.canceled || !dlg.filePath) return { ok: false, error: 'cancelled' };
        await workbook.xlsx.writeFile(dlg.filePath);
        return { ok: true, path: dlg.filePath };
      } else {
        return { ok: false, error: 'unsupported format' };
      }
    } catch (err) {
      console.error('Error export ventas', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

// Store last print data for pull pattern
let _lastPrintData = null;

// Handler PULL: renderer asks for data after loading
try {
  ipcMain.handle('print:venta:get-data', async () => {
    return _lastPrintData;
  });
} catch(_) {}

  ipcMain.handle('print:venta', async (event, { ventaId }) => {
    try {
      const venta = await getWithRetry('SELECT * FROM ventas WHERE id = ?', [ventaId]);
      if (!venta) return { ok: false, error: 'venta not found' };
      const detalle = await allWithRetry('SELECT * FROM detalle_venta WHERE venta_id = ?', [ventaId]);

      // Cargar datos de empresa y config para el comprobante
      const empCampos = ['razon_social','nombre_comercial','cuit','domicilio','localidad',
        'provincia','telefono','email','iva','iibb','ingresos_brutos','iibb_alicuota',
        'footer_ticket','color_primario','show_firma','logo_path'];
      const empresa = {};
      for (const c of empCampos) {
        const row = await getWithRetry('SELECT valor FROM config WHERE clave = ?', ['empresa_' + c]);
        if (row) empresa[c] = row.valor;
      }
      // Leer config impresion
      const modoRow = await getWithRetry("SELECT valor FROM config WHERE clave='imp_metodo_default'", []);
      const modo = modoRow?.valor || 'ticket';

      const win = new BrowserWindow({ width: 600, height: 800, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
      await win.loadFile(path.join(__dirname, 'renderer', 'venta-print.html'));
      win.webContents.once('did-finish-load', () => {
        // Store for pull pattern (contextIsolation safe)
        _lastPrintData = { venta, detalle, empresa, modo, autoPrint: false };
        // Also try push (legacy)
        win.webContents.send('print:venta:data', { venta, detalle, empresa, modo });
        setTimeout(() => {
          win.webContents.print({ silent: false, printBackground: true }, (ok, err) => {
            setTimeout(() => win.close(), 800);
            if (err) console.error('print error', err);
          });
        }, 700);
      });
      return { ok: true };
    } catch (err) {
      console.error('Error print venta', err);
      return { ok: false, error: err.message || String(err) };
    }
  });

  try {
    ipcMain.handle('audit:log', async (event, { usuario, accion, ventaId, detalles }) => {
      try {
        const ts = new Date().toISOString();
        await runWithRetry('INSERT INTO audit_logs (ts, usuario, accion, venta_id, detalles) VALUES (?, ?, ?, ?, ?)', [ts, usuario || 'sistema', accion || '', ventaId || null, detalles || '']);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    });
  } catch (e) {
    console.warn("audit:log handler already registered by extras, skipping.");
  }
}

if (!extrasLoaded) {
  ipcMain.handle('afip:request-cae', async (event, payload) => {
    const mock = '99999999999999';
    const now = new Date();
    const vto = new Date(now.getTime() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return { ok: true, cae: mock, cae_vto: vto };
  });
}

// Windows + lifecycle
let mainWindow = null;
let loginWindow = null;

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: true,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => {
    loginWindow = null;
  });
  return loginWindow;
}

function createMainWindow(usuario, rol) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once('ready-to-show', () => {
  mainWindow.show();
  mainWindow.webContents.send('user-data', { usuario, rol });

  setTimeout(() => {
    if (!licenseManager) return;
    const { modo, dias_restantes } = licenseManager.state;

    if (modo === 'expirada' || modo === 'bloqueada') {
      // Forzar pantalla de activación
      mainWindow.webContents.send('licencia-expirada', licenseManager.state);
      // O directamente abrir ventana de activación:
      abrirVentanaActivacion();
    } else if (modo === 'demo' && dias_restantes <= 5) {
      // Aviso de vencimiento próximo
      mainWindow.webContents.send('licencia-por-vencer', dias_restantes);
    }
  }, 1500);
});

  mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', async () => {
    mainWindow.show();
    // Leer nombre comercial de la config
    let nombreComercial = 'FacilVirtual';
    try {
      const row = await new Promise(r =>
        db.get("SELECT valor FROM config WHERE clave='empresa_nombre_comercial'", [], (e, r2) => r(r2))
      );
      if (row?.valor) nombreComercial = row.valor;
    } catch(_) {}
    mainWindow.webContents.send('user-data', { usuario, rol, nombreComercial });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (loginWindow) loginWindow.close();
  });
  return mainWindow;
}

// Open windows from renderer
ipcMain.on('login-success', async (event, { usuario, rol }) => {
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
  // Esperar licencia antes de abrir ventana principal
  try {
    await licenseManager.init();
    console.log('Licencia:', licenseManager.state.modo, '| Dias:', licenseManager.state.dias_restantes);
  } catch(e) {
    console.error('Error inicializando licencia:', e);
  }
  createMainWindow(usuario, rol);
});

// ── Cerrar ventana hija ─────────────────────────────────────────────────────────

// Abrir URLs externas — shell.openExternal (WhatsApp, mailto:, links)
// Registrado como .on para evitar conflictos con ipc-comunicaciones
ipcMain.on('shell-open-url', (event, url) => {
  try { shell.openExternal(url); } catch(e) { console.error('shell-open-url:', e.message); }
});
// También manejar el invoke por si lo llaman desde otros lados
try {
  ipcMain.handle('shell:open-external', (event, url) => {
    try { shell.openExternal(url); return { ok: true }; }
    catch(e) { return { ok: false, error: e.message }; }
  });
} catch(_) {}

// ── Multi-caja: handlers de red ────────────────────────────────────────────
const os = require('os');

ipcMain.handle('config:sistema:get-ip', () => {
  try {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    return { ok: true, ips };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:sistema:elegir-carpeta', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Seleccionar carpeta de la base de datos',
      properties: ['openDirectory'],
      defaultPath: 'C:\\'
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: 'Cancelado' };
    return { ok: true, path: result.filePaths[0] };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:sistema:elegir-archivo-db', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Seleccionar base de datos del servidor',
      filters: [{ name: 'SQLite', extensions: ['sqlite','db'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, error: 'Cancelado' };
    return { ok: true, path: result.filePaths[0] };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:sistema:test-db', async (event, { path: dbTestPath }) => {
  try {
    if (!fs.existsSync(dbTestPath)) return { ok: false, error: 'El archivo no existe en esa ruta' };
    const testDb = new sqlite3.Database(dbTestPath, sqlite3.OPEN_READONLY, (err) => {
      if (err) throw err;
    });
    const count = await new Promise((res, rej) => {
      testDb.get('SELECT COUNT(*) as n FROM sqlite_master', (err, row) => {
        testDb.close();
        if (err) rej(err); else res(row?.n || 0);
      });
    });
    return { ok: true, registros: count };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.on('close-window', (event) => {
  const win = require('electron').BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});


// ── Utilidad: ventana maximizada con fallback a dimensión mínima ─────────────
function makeFullWindow({ minWidth=900, minHeight=600, webPreferences={}, extra={} } = {}) {
  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width, height,
    minWidth, minHeight,
    resizable: true,
    show: false,
    ...extra,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      ...webPreferences
    }
  };
}

ipcMain.on('open-productos', () => {
  const { screen } = require('electron');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const mainBounds = mainWindow ? mainWindow.getBounds() : { width: sw, height: sh, x: 0, y: 0 };
  // 85% del tamaño de la ventana principal, centrado sobre ella
  const winW = Math.round(mainBounds.width  * 0.85);
  const winH = Math.round(mainBounds.height * 0.85);
  const winX = mainBounds.x + Math.round((mainBounds.width  - winW) / 2);
  const winY = mainBounds.y + Math.round((mainBounds.height - winH) / 2);
  const win = new BrowserWindow({
    width: winW, height: winH,
    x: winX, y: winY,
    minWidth: 900, minHeight: 600,
    resizable: true, show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.once('ready-to-show', () => win.show());
  win.setTitle('Gestión de Productos');
  win.loadFile(path.join(__dirname, 'renderer', 'productos.html'));
});

ipcMain.on('open-clientes', () => {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 900, minHeight: 600 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.setTitle('Gestión de Clientes');
  win.loadFile(path.join(__dirname, 'renderer', 'clientes.html'));
});

ipcMain.on('open-proveedores', () => {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 860, minHeight: 580 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.setTitle('Gestión de Proveedores');
  win.loadFile(path.join(__dirname, 'renderer', 'proveedores.html'));
});

ipcMain.on('open-config', () => {
  if (!mainWindow) return;
  
  // Obtener dimensiones de la pantalla
  const screen = require('electron').screen;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  const win = new BrowserWindow({
    width: width,
    height: height,
    x: primaryDisplay.workArea.x,
    y: primaryDisplay.workArea.y,
    parent: mainWindow,
    modal: true,
    resizable: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Configuración del Sistema'); });
  win.loadFile(path.join(__dirname, 'renderer', 'config.html'));
});

ipcMain.on('open-ventas', () => {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 900, minHeight: 600 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.setTitle('Historial de Ventas');
  win.loadFile(path.join(__dirname, 'renderer', 'ventas.html'));
});

// ── Proveedores y Cuentas a Pagar
ipcMain.on('open-proveedores-cuentas', (event, params) => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 1000, minHeight: 700 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    win.setTitle('Compras — Proveedores y Cuentas a Pagar');
  });
  win.loadFile(path.join(__dirname, 'renderer', 'proveedores-cuentas.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

// ── Clientes: Cta/Cte y Remitos
ipcMain.on('open-promociones', () => {
  const { width: sw, height: sh } = require('electron').screen.getPrimaryDisplay().workAreaSize;
  const mainBounds = mainWindow ? mainWindow.getBounds() : { width: sw, height: sh, x: 0, y: 0 };
  const winW = Math.round(mainBounds.width  * 0.85);
  const winH = Math.round(mainBounds.height * 0.85);
  const winX = mainBounds.x + Math.round((mainBounds.width  - winW) / 2);
  const winY = mainBounds.y + Math.round((mainBounds.height - winH) / 2);
  const win = new BrowserWindow({
    width: winW, height: winH, x: winX, y: winY,
    minWidth: 860, minHeight: 580, resizable: true, show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.once('ready-to-show', () => win.show());
  win.setTitle('Promociones y Descuentos');
  win.loadFile(path.join(__dirname, 'renderer', 'promociones.html'));
});

// ── WhatsApp embebido (web.whatsapp.com con sesión persistente) ───────────────
let waWindow = null;

ipcMain.on('open-whatsapp', () => {
  // Si ya está abierta, traerla al frente
  if (waWindow && !waWindow.isDestroyed()) {
    waWindow.focus();
    waWindow.show();
    return;
  }

  const mb = mainWindow ? mainWindow.getBounds() : { width: 1400, height: 900, x: 0, y: 0 };
  // Ventana lateral derecha
  const winW = 420, winH = 680;
  const winX = mb.x + mb.width - winW - 10;
  const winY = mb.y + mb.height - winH - 40;

  // User agent que pasa el filtro de WhatsApp Web (Chrome real, sin Electron)
  const WA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

  // Configurar la sesión wa-session antes de crear la ventana
  const { session } = require('electron');
  const waSes = session.fromPartition('persist:wa-session');
  waSes.setUserAgent(WA_UA);

  // Interceptar headers para eliminar señales de Electron
  waSes.webRequest.onBeforeSendHeaders({ urls: ['*://web.whatsapp.com/*','*://*.whatsapp.com/*'] }, (details, cb) => {
    const headers = details.requestHeaders;
    headers['User-Agent']       = WA_UA;
    headers['Accept-Language']  = 'es-AR,es;q=0.9,en;q=0.8';
    delete headers['X-DevTools-Request-Id'];
    cb({ requestHeaders: headers });
  });

  waWindow = new BrowserWindow({
    width: winW, height: winH,
    x: Math.max(0, winX), y: Math.max(0, winY),
    minWidth: 380, minHeight: 520,
    resizable: true, alwaysOnTop: false, show: false,
    title: 'WhatsApp — FacilVirtual POS',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      partition: 'persist:wa-session',  // sesión persistente — login guardado
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    }
  });

  waWindow.once('ready-to-show', () => waWindow.show());
  waWindow.on('closed', () => { waWindow = null; });

  // Cargar WhatsApp Web — primera vez pide QR, luego queda logueado
  waWindow.loadURL('https://web.whatsapp.com', { userAgent: WA_UA });

  waWindow.webContents.on('did-navigate', (e, url) => {
    if (!waWindow?.isDestroyed()) {
      waWindow.setTitle('WhatsApp — FacilVirtual POS');
    }
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// MÓDULO CONTABLE — Libro Caja, IVA Ventas, IVA Compras, Ingresos/Egresos
// Normas: FACPCE — NIC adaptadas Argentina — RG AFIP
// ══════════════════════════════════════════════════════════════════════════════

ipcMain.on('open-contabilidad', () => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 1100, minHeight: 700 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Módulo Contable — FacilVirtual POS'); });
  win.loadFile(path.join(__dirname, 'renderer', 'contabilidad.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

ipcMain.on('open-importar-productos', () => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 900, minHeight: 650 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Importar Productos — FacilVirtual POS'); });
  win.loadFile(path.join(__dirname, 'renderer', 'importar-productos.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

// ── Handlers de datos contables ───────────────────────────────────────────────
ipcMain.handle('contable:libro-caja', async (event, { desde, hasta }) => {
  try {
    // Movimientos de caja (apertura + ventas + ingresos/egresos manuales)
    const movs = await allWithRetry(
      `SELECT cm.*, cs.fecha AS fecha_sesion
       FROM caja_movimientos cm
       JOIN caja_sesiones cs ON cm.sesion_id = cs.id
       WHERE cs.fecha >= ? AND cs.fecha <= ?
       ORDER BY cm.ts ASC`,
      [desde, hasta]
    );
    // Totales por tipo
    const cobros = await allWithRetry(
      `SELECT cc.fecha, cc.monto, cc.forma_pago, cc.cliente_nombre, cc.observaciones,
              'cobro_cliente' as origen
       FROM cobros_cliente cc
       WHERE cc.fecha >= ? AND cc.fecha <= ?
       ORDER BY cc.fecha ASC`,
      [desde, hasta]
    );
    const pagos = await allWithRetry(
      `SELECT pp.fecha, pp.monto, pp.forma_pago,
              pr.nombre as proveedor_nombre, pp.observaciones,
              'pago_proveedor' as origen
       FROM pagos_proveedor pp
       JOIN facturas_compra fc ON pp.factura_id = fc.id
       JOIN proveedores pr ON fc.proveedor_id = pr.id
       WHERE pp.fecha >= ? AND pp.fecha <= ?
       ORDER BY pp.fecha ASC`,
      [desde, hasta]
    );
    return { ok: true, movimientos: movs, cobros, pagos };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('contable:libro-iva-ventas', async (event, { desde, hasta }) => {
  try {
    const ventas = await allWithRetry(
      `SELECT v.id, v.fecha, v.tipo, v.nro, v.cliente, v.iva,
              v.subtotal, v.descuento, v.recargo, v.total,
              v.formapago, v.usuario
       FROM ventas v
       WHERE v.fecha >= ? AND v.fecha <= ? AND (v.anulada IS NULL OR v.anulada=0)
       ORDER BY v.fecha ASC, v.nro ASC`,
      [desde, hasta]
    );
    // Calcular IVA por alícuota
    const result = ventas.map(v => {
      const neto = Number(v.total) / (1 + (Number(v.iva)||21)/100);
      const ivaAmt = Number(v.total) - neto;
      return { ...v, neto_gravado: Math.round(neto*100)/100, iva_monto: Math.round(ivaAmt*100)/100 };
    });
    const totNeto = result.reduce((a,v)=>a+v.neto_gravado,0);
    const totIva  = result.reduce((a,v)=>a+v.iva_monto,0);
    const totBruto= result.reduce((a,v)=>a+Number(v.total),0);
    return { ok: true, ventas: result, totales: { neto: totNeto, iva: totIva, bruto: totBruto } };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('contable:libro-iva-compras', async (event, { desde, hasta }) => {
  try {
    let facturas = [];
    try {
      facturas = await allWithRetry(
        `SELECT f.*, pr.nombre AS proveedor_nombre, pr.cuit AS proveedor_cuit
         FROM facturas_compra f
         LEFT JOIN proveedores pr ON f.proveedor_id = pr.id
         WHERE f.fecha >= ? AND f.fecha <= ?
         ORDER BY f.fecha ASC, f.nro_comprobante ASC`,
        [desde, hasta]
      ) || [];
    } catch(_) { facturas = []; }
    const result = facturas.map(f => {
      // iva es el porcentaje (ej: 21), no el monto — calcular monto desde subtotal y total
      const neto = Number(f.subtotal||0) || Math.round(Number(f.total)/(1+(Number(f.iva||21)/100))*100)/100;
      const iva  = Math.round((Number(f.total) - neto)*100)/100;
      return { ...f, neto_gravado: neto, iva_monto_calc: iva };
    });
    const totNeto = result.reduce((a,f)=>a+f.neto_gravado,0);
    const totIva  = result.reduce((a,f)=>a+f.iva_monto_calc,0);
    const totBruto= result.reduce((a,f)=>a+Number(f.total),0);
    return { ok: true, facturas: result, totales: { neto: totNeto, iva: totIva, bruto: totBruto } };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('contable:ingresos-egresos', async (event, { desde, hasta }) => {
  try {
    // INGRESOS: ventas cobradas en efectivo/tarjeta + cobros de cta/cte
    const ventas = await allWithRetry(
      `SELECT v.fecha, v.tipo, v.nro, v.cliente, v.total, v.formapago,
              'venta' as categoria
       FROM ventas v
       WHERE v.fecha>=? AND v.fecha<=?
         AND (v.anulada IS NULL OR v.anulada=0)
       ORDER BY v.fecha`,
      [desde, hasta]
    );
    const cobros = await allWithRetry(
      `SELECT cc.fecha, cc.monto as total, cc.forma_pago as formapago,
              cc.cliente_nombre as cliente, 'Cobro Cta/Cte' as tipo, '' as nro,
              'cobro_ctacte' as categoria
       FROM cobros_cliente cc WHERE cc.fecha>=? AND cc.fecha<=? ORDER BY cc.fecha`,
      [desde, hasta]
    );
    // EGRESOS: pagos a proveedores + egresos de caja
    const pagos = await allWithRetry(
      `SELECT pp.fecha, pp.monto as total, pp.forma_pago as formapago,
              pr.nombre as proveedor, fc.tipo as tipo, fc.nro_comprobante as nro,
              'pago_proveedor' as categoria
       FROM pagos_proveedor pp
       JOIN facturas_compra fc ON pp.factura_id=fc.id
       JOIN proveedores pr ON fc.proveedor_id=pr.id
       WHERE pp.fecha>=? AND pp.fecha<=? ORDER BY pp.fecha`,
      [desde, hasta]
    );
    const egresos_caja = await allWithRetry(
      `SELECT cm.ts as fecha, cm.monto as total, 'Caja' as formapago,
              cm.concepto as descripcion, 'egreso' as tipo, '' as nro,
              'egreso_caja' as categoria
       FROM caja_movimientos cm
       JOIN caja_sesiones cs ON cm.sesion_id=cs.id
       WHERE cm.tipo='egreso' AND cs.fecha>=? AND cs.fecha<=? ORDER BY cm.ts`,
      [desde, hasta]
    );
    // Agrupar por forma de pago
    const todosIngresos = [...ventas, ...cobros];
    const byFP = {};
    todosIngresos.forEach(v => {
      const fp = (v.formapago||'Efectivo').toLowerCase();
      if (!byFP[fp]) byFP[fp] = 0;
      byFP[fp] += Number(v.total||0);
    });
    const totIngreso = todosIngresos.reduce((a,v)=>a+Number(v.total||0),0);
    const totEgreso  = [...pagos,...egresos_caja].reduce((a,v)=>a+Number(v.total||0),0);
    return { ok: true, ingresos: todosIngresos, egresos: [...pagos,...egresos_caja],
      byFormaPago: byFP, totIngreso, totEgreso, resultado: totIngreso-totEgreso };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('contable:estado-resultados', async (event, { desde, hasta }) => {
  try {
    // Ventas del período
    const vRow = await getWithRetry(
      'SELECT COALESCE(SUM(total),0) as tot, COUNT(*) as cnt FROM ventas WHERE fecha>=? AND fecha<=? AND (anulada IS NULL OR anulada=0)',
      [desde, hasta]
    );
    const ventas_netas = Number(vRow?.tot || 0);
    const ventas_cnt   = Number(vRow?.cnt || 0);

    // Costo mercaderías (facturas de compra del período)
    let costo_ventas = 0;
    try {
      const cRow = await getWithRetry(
        'SELECT COALESCE(SUM(total),0) as tot FROM facturas_compra WHERE fecha>=? AND fecha<=?',
        [desde, hasta]
      );
      costo_ventas = Number(cRow?.tot || 0);
    } catch(_) {}

    // Gastos (egresos de caja)
    let gastos = [];
    try {
      gastos = await allWithRetry(
        `SELECT cm.concepto, SUM(cm.monto) as tot
         FROM caja_movimientos cm
         JOIN caja_sesiones cs ON cm.sesion_id = cs.id
         WHERE cm.tipo = 'egreso' AND cs.fecha >= ? AND cs.fecha <= ?
         GROUP BY cm.concepto
         ORDER BY tot DESC`,
        [desde, hasta]
      ) || [];
    } catch(_) {}

    const totalGastos    = gastos.reduce((a,g) => a + Number(g.tot||0), 0);
    const utilidad_bruta = ventas_netas - costo_ventas;
    const resultado_neto = utilidad_bruta - totalGastos;

    return { ok:true, ventas_netas, costo_ventas, utilidad_bruta, gastos, totalGastos, resultado_neto, ventas_cnt };
  } catch(e) { return { ok:false, error:e.message }; }
});


// ── Acerca del sistema / Migración / Periféricos ─────────────────────────────
ipcMain.on('open-about', () => {
  const win = new BrowserWindow({
    width: 580, height: 720, resizable: true, show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.once('ready-to-show', () => { win.show(); win.setTitle('Acerca de Gestiva.NET'); });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'acerca.html'));
});

ipcMain.on('open-migracion', () => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 800, minHeight: 600 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Migración de Datos — Gestiva.NET'); });
  win.loadFile(path.join(__dirname, 'renderer', 'migracion.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

ipcMain.on('open-perifericos', () => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 800, minHeight: 600 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Test de Periféricos — Gestiva.NET'); });
  win.loadFile(path.join(__dirname, 'renderer', 'perifericos.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

// ── Servidor HTTP móvil — Estadísticas en cualquier celular de la red ─────────
const http = require('http');
let mobileServer = null;
let mobilePort   = 3099;

function getMobileIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

async function getMobileStats() {
  try {
    const hoy = new Date().toISOString().slice(0,10);
    const ayer = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const semStart = new Date(Date.now()-7*86400000).toISOString().slice(0,10);
    const mesStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);

    const [ventasHoy, ventasSemana, ventasMes, topProds, ultimasVentas, stockBajo] = await Promise.all([
      new Promise(r=>db.get('SELECT COALESCE(SUM(total),0) as tot, COUNT(*) as cnt FROM ventas WHERE fecha=? AND (anulada IS NULL OR anulada=0)',[hoy],(e,row)=>r(row||{tot:0,cnt:0}))),
      new Promise(r=>db.get('SELECT COALESCE(SUM(total),0) as tot, COUNT(*) as cnt FROM ventas WHERE fecha>=? AND (anulada IS NULL OR anulada=0)',[semStart],(e,row)=>r(row||{tot:0,cnt:0}))),
      new Promise(r=>db.get('SELECT COALESCE(SUM(total),0) as tot, COUNT(*) as cnt FROM ventas WHERE fecha>=? AND (anulada IS NULL OR anulada=0)',[mesStart],(e,row)=>r(row||{tot:0,cnt:0}))),
      new Promise(r=>db.all('SELECT d.descripcion, SUM(dv.cantidad) as qty, SUM(dv.importe) as total FROM detalle_venta dv LEFT JOIN productos d ON d.codigo=dv.producto_codigo WHERE dv.venta_id IN (SELECT id FROM ventas WHERE fecha>=? AND (anulada IS NULL OR anulada=0)) GROUP BY dv.producto_codigo ORDER BY total DESC LIMIT 5',[semStart],(e,rows)=>r(rows||[]))),
      new Promise(r=>db.all('SELECT v.fecha, v.tipo, v.nro, v.cliente, v.total, v.formapago FROM ventas v WHERE anulada=0 ORDER BY id DESC LIMIT 8',(e,rows)=>r(rows||[]))),
      new Promise(r=>db.all('SELECT codigo, descripcion, stock, stock_min FROM productos WHERE stock_min>0 AND stock<=stock_min ORDER BY stock ASC LIMIT 8',(e,rows)=>r(rows||[]))),
    ]);
    return { ventasHoy, ventasSemana, ventasMes, topProds, ultimasVentas, stockBajo, generado: new Date().toLocaleString('es-AR') };
  } catch(e) { return { error: e.message }; }
}

// ── Firebase Cloud Sync — Estadísticas accesibles desde cualquier lugar ──────
// Usa Firebase Firestore REST API (sin npm, solo https nativo)
// Config se guarda en tabla config: clave='firebase_*'

async function getFirebaseConfig() {
  try {
    const keys = ['firebase_project_id','firebase_api_key','firebase_enabled'];
    const rows = await Promise.all(keys.map(k =>
      new Promise(r => db.get('SELECT valor FROM config WHERE clave=?',[k],(e,row)=>r(row?.valor||'')))
    ));
    return {
      projectId: rows[0],
      apiKey:    rows[1],
      enabled:   rows[2] === '1'
    };
  } catch(e) { return { enabled: false }; }
}

async function pushStatsToFirebase() {
  try {
    const cfg = await getFirebaseConfig();
    if (!cfg.enabled || !cfg.projectId || !cfg.apiKey) return;

    const stats = await getMobileStats();
    const payload = {
      fields: {
        ventas_hoy_total:   { doubleValue: Number(stats.ventasHoy?.tot||0) },
        ventas_hoy_cnt:     { integerValue: Number(stats.ventasHoy?.cnt||0) },
        ventas_semana:      { doubleValue: Number(stats.ventasSemana?.tot||0) },
        ventas_mes:         { doubleValue: Number(stats.ventasMes?.tot||0) },
        stock_bajo_cnt:     { integerValue: stats.stockBajo?.length||0 },
        ultima_venta:       { stringValue: stats.ultimasVentas?.[0] ? JSON.stringify(stats.ultimasVentas[0]) : '' },
        top_productos:      { stringValue: JSON.stringify(stats.topProds||[]) },
        ultimas_ventas:     { stringValue: JSON.stringify(stats.ultimasVentas||[]) },
        stock_bajo:         { stringValue: JSON.stringify(stats.stockBajo||[]) },
        generado:           { stringValue: new Date().toISOString() },
        negocio:            { stringValue: await new Promise(r=>db.get("SELECT valor FROM config WHERE clave='empresa_nombre_comercial'",(e,row)=>r(row?.valor||'FacilVirtual POS'))) }
      }
    };

    const url = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents/estadisticas/dashboard?key=${cfg.apiKey}`;

    await new Promise((resolve, reject) => {
      const https = require('https');
      const body  = JSON.stringify(payload);
      const u     = new URL(url);
      const req   = https.request({
        hostname: u.hostname, path: u.pathname+u.search,
        method: 'PATCH',
        headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log('☁️ Estadísticas subidas a Firebase OK');
            resolve();
          } else {
            console.warn('⚠️ Firebase sync error:', res.statusCode, data.slice(0,200));
            resolve(); // no bloquear
          }
        });
      });
      req.on('error', e => { console.warn('⚠️ Firebase network error:', e.message); resolve(); });
      req.write(body);
      req.end();
    });
  } catch(e) {
    console.warn('⚠️ Firebase push error:', e.message);
  }
}

// Sync automático cada 5 minutos
let firebaseInterval = null;
app.on('ready', () => {
  setTimeout(async () => {
    const cfg = await getFirebaseConfig();
    if (cfg.enabled) {
      pushStatsToFirebase(); // sync inicial
      firebaseInterval = setInterval(pushStatsToFirebase, 5 * 60 * 1000);
    }
  }, 5000);
});

// Handler IPC para forzar sync manual y configurar
ipcMain.handle('firebase:sync-now', async () => {
  await pushStatsToFirebase();
  return { ok: true };
});

ipcMain.handle('firebase:save-config', async (event, { projectId, apiKey, enabled }) => {
  try {
    const save = (k,v) => new Promise(r=>db.run('INSERT OR REPLACE INTO config(clave,valor) VALUES(?,?)',[k,v],r));
    await save('firebase_project_id', projectId||'');
    await save('firebase_api_key',    apiKey||'');
    await save('firebase_enabled',    enabled?'1':'0');
    // Reiniciar interval
    if (firebaseInterval) { clearInterval(firebaseInterval); firebaseInterval=null; }
    if (enabled) {
      await pushStatsToFirebase();
      firebaseInterval = setInterval(pushStatsToFirebase, 5*60*1000);
    }
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('firebase:get-config', async () => {
  const cfg = await getFirebaseConfig();
  return { ok: true, ...cfg };
});

// También sincronizar cuando se registra una venta
const _origFirebasePush = pushStatsToFirebase;
// Se llama desde venta:registrar via evento
ipcMain.on('firebase:trigger-sync', () => pushStatsToFirebase());

function buildMobilePage(stats) {
  const fmt = n => '$ ' + Number(n||0).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const {ventasHoy,ventasSemana,ventasMes,topProds,ultimasVentas,stockBajo,generado} = stats;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>FacilVirtual — Estadísticas</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0f1923">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="FacilVirtual">
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f4f1;color:#1a2e1a;font-size:14px;}
    .top{background:#0f1923;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;}
    .top h1{color:#fff;font-size:16px;font-weight:700;}
    .top small{color:rgba(255,255,255,.5);font-size:11px;}
    .refresh{background:rgba(46,168,70,.3);border:1px solid rgba(46,168,70,.6);color:#69f0ae;padding:6px 12px;border-radius:20px;font-size:12px;cursor:pointer;text-decoration:none;}
    .kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px;}
    .kpi{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);}
    .kpi-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;}
    .kpi-val{font-size:20px;font-weight:800;color:#1f8b32;}
    .kpi-sub{font-size:11px;color:#aaa;margin-top:2px;}
    .kpi.alerta .kpi-val{color:#c62828;}
    .section{padding:0 12px 12px;}
    .section h2{font-size:13px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;padding-top:4px;}
    .card{background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);}
    .row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #f5f5f5;}
    .row:last-child{border-bottom:none;}
    .row-name{font-size:13px;font-weight:500;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .row-val{font-size:13px;font-weight:700;color:#1f8b32;flex-shrink:0;margin-left:8px;}
    .row-sub{font-size:11px;color:#aaa;}
    .tag{display:inline-block;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;}
    .tag-ef{background:#e8f5e9;color:#2e7d32;}
    .tag-tc{background:#e3f2fd;color:#1565c0;}
    .tag-st{background:#ffebee;color:#c62828;font-size:11px;}
    .foot{text-align:center;padding:16px;font-size:11px;color:#bbb;}
    @media(min-width:480px){.kpi-grid{grid-template-columns:repeat(3,1fr);}}
  </style>
  <script>function refresh(){location.reload();}</script>
  </head><body>
  <div class="top">
    <div><h1>📊 FacilVirtual POS</h1><small>Actualizado: ${generado}</small></div>
    <a href="/" class="refresh" onclick="refresh();return false">↺ Actualizar</a>
  </div>

  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Ventas hoy</div>
      <div class="kpi-val">${fmt(ventasHoy.tot)}</div>
      <div class="kpi-sub">${ventasHoy.cnt} transacciones</div></div>
    <div class="kpi"><div class="kpi-label">Esta semana</div>
      <div class="kpi-val">${fmt(ventasSemana.tot)}</div>
      <div class="kpi-sub">${ventasSemana.cnt} ventas</div></div>
    <div class="kpi"><div class="kpi-label">Este mes</div>
      <div class="kpi-val">${fmt(ventasMes.tot)}</div>
      <div class="kpi-sub">${ventasMes.cnt} ventas</div></div>
  </div>

  <div class="section"><h2>🔥 Más vendidos (semana)</h2>
  <div class="card">${topProds.map(p=>`<div class="row">
    <div><div class="row-name">${p.descripcion||'—'}</div>
    <div class="row-sub">${p.qty} unidades</div></div>
    <div class="row-val">${fmt(p.total)}</div></div>`).join('')||'<div class="row"><div class="row-name" style="color:#aaa">Sin ventas esta semana</div></div>'}
  </div></div>

  <div class="section"><h2>🕐 Últimas ventas</h2>
  <div class="card">${ultimasVentas.map(v=>`<div class="row">
    <div><div class="row-name">${v.cliente||'Cliente Ocasional'}</div>
    <div class="row-sub">${v.tipo} N°${v.nro} · ${v.fecha}</div></div>
    <div style="text-align:right">
      <div class="row-val">${fmt(v.total)}</div>
      <span class="tag ${v.formapago==='efectivo'?'tag-ef':'tag-tc'}">${v.formapago||'—'}</span>
    </div></div>`).join('')||'<div class="row"><div class="row-name" style="color:#aaa">Sin ventas</div></div>'}
  </div></div>

  ${stockBajo.length?`<div class="section"><h2>⚠️ Stock bajo</h2>
  <div class="card">${stockBajo.map(p=>`<div class="row">
    <div><div class="row-name">${p.descripcion}</div>
    <div class="row-sub">Código: ${p.codigo}</div></div>
    <span class="tag tag-st">Stock: ${p.stock} / mín: ${p.stock_min}</span></div>`).join('')}
  </div></div>`:''}

  <div class="foot">FacilVirtual POS · Solo visible en red local</div>
  </body></html>`;
}

function startMobileServer() {
  if (mobileServer) return;
  mobileServer = http.createServer(async (req, res) => {
    // Headers CORS para permitir embeber en app o WebView
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'X-Frame-Options': 'ALLOWALL',
      'Content-Security-Policy': "frame-ancestors *"
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders); res.end(); return;
    }

    if (req.url === '/api/stats') {
      const stats = await getMobileStats();
      res.writeHead(200, { ...corsHeaders, 'Content-Type':'application/json' });
      res.end(JSON.stringify(stats));
    } else if (req.url === '/manifest.json') {
      // PWA manifest — permite instalar como app en el celular
      const manifest = JSON.stringify({
        name: 'FacilVirtual Estadísticas',
        short_name: 'FacilVirtual',
        start_url: '/',
        display: 'standalone',
        background_color: '#f0f4f1',
        theme_color: '#0f1923',
        icons: [{ src: '/icon.png', sizes: '192x192', type: 'image/png' }]
      });
      res.writeHead(200, { ...corsHeaders, 'Content-Type':'application/json' });
      res.end(manifest);
    } else {
      const stats = await getMobileStats();
      const html = buildMobilePage(stats);
      res.writeHead(200, { ...corsHeaders, 'Content-Type':'text/html; charset=utf-8' });
      res.end(html);
    }
  });
  mobileServer.listen(mobilePort, '0.0.0.0', () => {
    console.log(`📱 Servidor móvil en http://${getMobileIP()}:${mobilePort}`);
  });
  mobileServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      mobilePort++;
      setTimeout(startMobileServer, 100);
    }
  });
}

// Iniciar servidor cuando la app esté lista
app.on('ready', () => setTimeout(startMobileServer, 2000));
app.on('quit', () => { try { mobileServer?.close(); } catch(_) {} });

ipcMain.handle('mobile:get-url', () => ({
  ok: true,
  url: `http://${getMobileIP()}:${mobilePort}`,
  ip: getMobileIP(),
  port: mobilePort
}));

// Handler para obtener número WA configurado
ipcMain.handle('wa:get-config', async () => {
  try {
    const row = await new Promise((res, rej) => {
      db.get("SELECT valor FROM config WHERE clave='empresa_whatsapp'", [], (e,r) => e ? rej(e) : res(r));
    });
    const nameRow = await new Promise((res, rej) => {
      db.get("SELECT valor FROM config WHERE clave='empresa_nombre_comercial'", [], (e,r) => e ? rej(e) : res(r));
    });
    return { ok: true, number: row?.valor || '', name: nameRow?.valor || 'FacilVirtual POS' };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.on('open-clientes-cuentas', (event, params) => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 1000, minHeight: 700 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    win.setTitle('Clientes — Cuentas Corrientes y Remitos');
    // Pasar parámetros al renderer si vienen (cliente seleccionado, tab, etc.)
    if (params && typeof params === 'object') {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('init-params', params);
      });
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'clientes-cuentas.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

// ── Estadísticas
ipcMain.on('open-estadisticas', () => {
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 1000, minHeight: 700 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.once('ready-to-show', () => win.show());
  win.setTitle('Estadísticas y Analítica');
  win.loadFile(path.join(__dirname, 'renderer', 'estadisticas.html'));
  win.on('closed', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus(); });
});

ipcMain.on('open-caja', () => {
  if (!mainWindow) return;
  const win = new BrowserWindow({
    ...makeFullWindow({ minWidth: 1000, minHeight: 700 }),
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });
  win.maximize();
  win.maximize();
  win.once('ready-to-show', () => { win.show(); win.setTitle('Control de Caja'); });
  win.loadFile(path.join(__dirname, 'renderer', 'caja.html'));
});

ipcMain.on('abrir-modal-forma-pago', (event, payload) => {
  if (!mainWindow) return;
  const subtotal = (payload && payload.subtotal) ? payload.subtotal : 0;
  const win = new BrowserWindow({
    width: 420,
    height: 380,
    parent: mainWindow,
    modal: true,
    resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'formapago.html'), { query: { subtotal: String(subtotal) } });
});

ipcMain.on('aplicar-forma-pago', (event, payload) => {
  if (mainWindow) mainWindow.webContents.send('forma-pago-aplicada', payload);
});

ipcMain.on('compra-registrada-from-renderer', (event, payload) => {
  ipcMain.emit('compra-registrada', event, payload);
});

// ════════════════════════════════════════════════════════════════════════════
// ── HANDLERS DE CONFIGURACIÓN (funcionales, con persistencia en SQLite) ───
// ════════════════════════════════════════════════════════════════════════════

// Helpers key-value sobre tabla 'config'
async function getCfg(clave, def) {
  try {
    const row = await getWithRetry('SELECT valor FROM config WHERE clave=?', [clave]);
    return row ? row.valor : (def !== undefined ? def : '');
  } catch(_) { return def !== undefined ? def : ''; }
}
async function setCfg(clave, valor) {
  await runWithRetry('INSERT OR REPLACE INTO config (clave,valor) VALUES (?,?)', [clave, String(valor ?? '')]);
}

ipcMain.handle('config:cargar-todo', async () => {
  try {
    const rows = await allWithRetry('SELECT clave,valor FROM config', []);
    const cfg = {};
    (rows || []).forEach(r => { cfg[r.clave] = r.valor; });
    return { ok: true, cfg };
  } catch(e) { return { ok: false, error: e.message, cfg: {} }; }
});

ipcMain.handle('config:usuarios:listar', async () => {
  try {
    const usuarios = await allWithRetry('SELECT id, nombre, rol FROM usuarios ORDER BY nombre', []);
    return { ok: true, usuarios: usuarios || [] };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:usuario:agregar', async (event, { nombre, password, rol }) => {
  try {
    if (!nombre || !password || !rol) return { ok: false, error: 'Campos incompletos' };
    const info = await runWithRetry('INSERT INTO usuarios (nombre,password,rol) VALUES (?,?,?)', [nombre.trim(), password, rol]);
    return { ok: true, id: info.lastID };
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return { ok: false, error: 'El usuario ya existe' };
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:usuario:modificar', async (event, { id, nombre, password, rol }) => {
  try {
    if (password) await runWithRetry('UPDATE usuarios SET nombre=?,password=?,rol=? WHERE id=?', [nombre, password, rol, id]);
    else          await runWithRetry('UPDATE usuarios SET nombre=?,rol=? WHERE id=?', [nombre, rol, id]);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:usuario:eliminar', async (event, id) => {
  try {
    const row = await getWithRetry('SELECT nombre FROM usuarios WHERE id=?', [id]);
    if (row && row.nombre === 'admin') return { ok: false, error: 'No se puede eliminar el usuario admin' };
    await runWithRetry('DELETE FROM usuarios WHERE id=?', [id]);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:pv:listar', async () => {
  try {
    const rows = await allWithRetry('SELECT * FROM puntos_venta ORDER BY numero', []);
    return { ok: true, lista: rows || [] };
  } catch(e) { return { ok: true, lista: [] }; }
});

ipcMain.handle('config:pv:agregar', async (event, { numero, descripcion, ubicacion }) => {
  try {
    if (!numero || isNaN(numero)) return { ok: false, error: 'Número de PV inválido' };
    const info = await runWithRetry('INSERT INTO puntos_venta (numero,descripcion,ubicacion) VALUES (?,?,?)',
      [parseInt(numero), descripcion||'', ubicacion||'']);
    return { ok: true, id: info.lastID };
  } catch(e) {
    if (e.message && e.message.includes('UNIQUE')) return { ok: false, error: 'Ese número de PV ya existe' };
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('config:pv:eliminar', async (event, id) => {
  try {
    await runWithRetry('DELETE FROM puntos_venta WHERE id=?', [id]);
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:afip:estado-certificado', async () => {
  try {
    const certPath  = await getCfg('afip_cert_path');
    const certNombre= await getCfg('afip_cert_nombre');
    const existe = !!(certPath && fs.existsSync(certPath));
    return { ok: true, existe, nombre: certNombre, path: certPath };
  } catch(e) { return { ok: false, existe: false }; }
});

ipcMain.handle('config:afip:guardar-certificado', async (event, { nombre, datos_base64 }) => {
  try {
    const userDataPath = app.getPath('userData');
    const certDir  = path.join(userDataPath, 'certs');
    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
    const certPath = path.join(certDir, 'afip_cert.p12');
    fs.writeFileSync(certPath, Buffer.from(datos_base64, 'base64'));
    await setCfg('afip_cert_path', certPath);
    await setCfg('afip_cert_nombre', nombre);
    return { ok: true, path: certPath };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:afip:guardar', async (event, datos) => {
  try {
    const campos = ['ambiente','webservice','punto_venta','cuit','token','sign','token_expira','cert_nombre'];
    for (const c of campos) {
      if (datos[c] !== undefined) await setCfg('afip_' + c, datos[c]);
    }
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:afip:generar-token', async (event, { password_cert }) => {
  try {
    const certPath  = await getCfg('afip_cert_path');
    const ambiente  = await getCfg('afip_ambiente', 'testing');
    const webservice= await getCfg('afip_webservice', 'wsfe');
    if (!certPath || !fs.existsSync(certPath))
      return { ok: false, error: 'No hay certificado cargado. Primero subí el archivo .p12' };
    let forge;
    try { forge = require('node-forge'); } catch(_) {
      return { ok: false, error: 'Falta node-forge. Ejecutá: npm install node-forge', ayuda: 'npm install node-forge' };
    }
    const p12Buffer = fs.readFileSync(certPath);
    const p12Der    = forge.util.createBuffer(p12Buffer.toString('binary'));
    let p12;
    try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(p12Der), false, password_cert || ''); }
    catch(e) { return { ok: false, error: 'Certificado inválido o contraseña incorrecta: ' + e.message }; }
    const keyBags  = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []);
    const certBags = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []);
    if (!keyBags.length || !certBags.length) return { ok: false, error: 'No se pudo extraer clave/certificado del .p12' };
    const privateKey = keyBags[0].key;
    const cert       = certBags[0].cert;
    const now     = new Date();
    const genTime = now.toISOString().replace(/\.\d+Z$/, '-03:00');
    const expTime = new Date(now.getTime() + 10*60*1000).toISOString().replace(/\.\d+Z$/, '-03:00');
    const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(Math.random()*2147483647)}</uniqueId><generationTime>${genTime}</generationTime><expirationTime>${expTime}</expirationTime></header><service>${webservice}</service></loginTicketRequest>`;
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(tra, 'utf8');
    p7.addCertificate(cert);
    p7.addSigner({ key: privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() }
      ]
    });
    p7.sign();
    const cmsSigned = forge.pkcs7.messageToPem(p7)
      .replace('-----BEGIN PKCS7-----','').replace('-----END PKCS7-----','').replace(/\n/g,'');
    const WSAA_URL = ambiente === 'production'
      ? 'https://wsaa.afip.gov.ar/ws/services/LoginCms'
      : 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
    const soapBody = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov.ar"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cmsSigned}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`;
    const https = require('https');
    const url   = new URL(WSAA_URL);
    const respXml = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '', 'Content-Length': Buffer.byteLength(soapBody) }
      }, res => { let d=''; res.on('data', c => d+=c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout conectando a AFIP')); });
      req.write(soapBody); req.end();
    });
    const tokenMatch = respXml.match(/<token>([^<]+)<\/token>/);
    const signMatch  = respXml.match(/<sign>([^<]+)<\/sign>/);
    const expMatch   = respXml.match(/<expirationTime>([^<]+)<\/expirationTime>/);
    if (!tokenMatch || !signMatch) {
      const err = respXml.match(/<faultstring>([^<]+)<\/faultstring>/);
      return { ok: false, error: err ? err[1] : 'AFIP no devolvió token. ' + respXml.substring(0,200) };
    }
    const token  = tokenMatch[1];
    const sign   = signMatch[1];
    const expira = expMatch ? expMatch[1] : '';
    await setCfg('afip_token', token);
    await setCfg('afip_sign',  sign);
    await setCfg('afip_token_expira', expira);
    await setCfg('afip_token_generado', new Date().toISOString());
    return { ok: true, token, sign, expira };
  } catch(e) { console.error('Error token AFIP:', e); return { ok: false, error: e.message || String(e) }; }
});

ipcMain.handle('config:afip:limpiar-token', async () => {
  try {
    await setCfg('afip_token',''); await setCfg('afip_sign',''); await setCfg('afip_token_expira','');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:empresa:guardar', async (event, datos) => {
  try {
    const campos = ['razon_social','nombre_comercial','cuit','condicion_iva','domicilio',
                    'localidad','provincia','codigo_postal','telefono','email','ingresos_brutos','inicio_actividades'];
    for (const c of campos) { if (datos[c] !== undefined) await setCfg('empresa_' + c, datos[c]); }
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:comprobantes:guardar', async (event, datos) => {
  try {
    await setCfg('comp_habilitados', JSON.stringify(datos.habilitados || []));
    await setCfg('comp_default', datos.defecto || 'ticket');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:sistema:guardar', async (event, datos) => {
  try {
    const campos = ['nombre','moneda','simbolo','formato_fecha','idioma','tema','timeout'];
    for (const c of campos) { if (datos[c] !== undefined) await setCfg('sistema_' + c, datos[c]); }
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:backup:generar', async () => {
  try {
    const origen = dbPath;
    if (!fs.existsSync(origen)) return { ok: false, error: 'No se encontró la base de datos' };
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const { filePath, canceled } = await dialog.showSaveDialog({ title: 'Guardar backup',
      defaultPath: 'backup_pos_' + ts + '.sqlite', filters: [{ name: 'SQLite', extensions: ['sqlite','db'] }] });
    if (canceled || !filePath) return { ok: false, error: 'Cancelado' };
    fs.copyFileSync(origen, filePath);
    return { ok: true, path: filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('config:backup:restaurar', async () => {
  try {
    const destino = dbPath;
    const { filePaths, canceled } = await dialog.showOpenDialog({ title: 'Seleccionar backup',
      filters: [{ name: 'SQLite', extensions: ['sqlite','db'] }], properties: ['openFile'] });
    if (canceled || !filePaths.length) return { ok: false, error: 'Cancelado' };
    if (fs.existsSync(destino)) fs.copyFileSync(destino, destino + '.pre_restore_' + Date.now());
    fs.copyFileSync(filePaths[0], destino);
    return { ok: true, mensaje: 'Backup restaurado. Reiniciá la aplicación.' };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('licencia:estado', async () => {
  return licenseManager ? licenseManager.state : null;
});
ipcMain.handle('licencia:activar', async (event, { codigo, clienteNombre }) => {
  if (!licenseManager) return { ok: false, error: 'Sistema de licencia no inicializado' };
  return licenseManager.activar(codigo, clienteNombre);
});
function abrirVentanaActivacion() {
  const win = new BrowserWindow({
    width: 500, height: 620,
    resizable: false, show: false,
    parent: mainWindow, modal: true,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.once('ready-to-show', () => { win.show(); win.setTitle('Activar FacilVirtual POS'); });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'demo-activacion.html'));
}
ipcMain.on('open-activacion', () => abrirVentanaActivacion());
ipcMain.on('licencia:continuar-demo', () => {});

// Lifecycle
app.whenReady().then(() => createLoginWindow());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createLoginWindow();
});