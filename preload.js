// preload.js — Bridge seguro entre renderer y main process
// contextIsolation: true — NO usar require() dentro de los métodos expuestos
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {

  // ── Login ────────────────────────────────────────────────────────────────
  login: (nombre, password) => ipcRenderer.invoke('login', { nombre, password }),

  // ── Productos / Categorías ───────────────────────────────────────────────
  productosListar:            ()        => ipcRenderer.invoke('productos:listar-full'),
  productosListarFull:        ()        => ipcRenderer.invoke('productos:listar-full'),
  productosListarTodos:       ()        => ipcRenderer.invoke('productos:listar-todos'),
  productosStockBajo:         ()        => ipcRenderer.invoke('productos:stock-bajo'),
  productoAgregar:            (prod)    => ipcRenderer.invoke('producto:agregar', prod),
  productoModificar:          (prod)    => ipcRenderer.invoke('producto:modificar', prod),
  productoEliminar:           (codigo)  => ipcRenderer.invoke('producto:eliminar', codigo),
  productoActualizarStock:    (datos)   => ipcRenderer.invoke('producto:actualizar-stock', datos),
  productosAplicarMargen:     (payload) => ipcRenderer.invoke('productos:aplicar-margen', payload),
  productosRecalcularPrecios: (datos)   => ipcRenderer.invoke('productos:recalcular-precios', datos),

  // ── Categorías ───────────────────────────────────────────────────────────
  categoriasListar: ()  => ipcRenderer.invoke('categorias:listar'),
  categoriaAgregar: (c) => ipcRenderer.invoke('categoria:agregar', c),

  // ── Marcas ───────────────────────────────────────────────────────────────
  marcasListar: ()      => ipcRenderer.invoke('marcas:listar'),
  marcaAgregar: (datos) => ipcRenderer.invoke('marca:agregar', datos),

  // ── Compras ──────────────────────────────────────────────────────────────
  comprasImportarExcel: ()     => ipcRenderer.invoke('compras:import-excel'),
  exportCompras:        (opts) => ipcRenderer.invoke('export:compras', opts),
  productosImportarExcel:   (d) => ipcRenderer.invoke('productos:importar-excel', d),
  productosImportarConfirmar:(d) => ipcRenderer.invoke('productos:importar-confirmar', d),
  productosDescargarPlantilla:() => ipcRenderer.invoke('productos:descargar-plantilla'),
  dialogOpenFile:           (d) => ipcRenderer.invoke('dialog:open-file', d),
  exportProductos:      (opts) => ipcRenderer.invoke('export:productos', opts),
  chooseExportFormat:   ()     => ipcRenderer.invoke('dialog:choose-export-format'),

  // ── Proveedores ──────────────────────────────────────────────────────────
  proveedoresListar:  ()      => ipcRenderer.invoke('proveedores:listar'),
  exportProveedores:  (opts)  => ipcRenderer.invoke('export:proveedores', opts),
  proveedorAgregar:   (prov)  => ipcRenderer.invoke('proveedor:agregar', prov),
  proveedorModificar: (prov)  => ipcRenderer.invoke('proveedor:modificar', prov),
  proveedorEliminar:  (id)    => ipcRenderer.invoke('proveedor:eliminar', id),
  proveedoresBuscar:  (query) => ipcRenderer.invoke('proveedores:buscar', query),

  // ── Clientes ─────────────────────────────────────────────────────────────
  clientesListar:    ()       => ipcRenderer.invoke('clientes:listar'),
  clientesBuscar:    (q)      => ipcRenderer.invoke('clientes:buscar', q),
  clienteAgregar:    (cli)    => ipcRenderer.invoke('cliente:agregar', cli),
  clienteModificar:  (cli)    => ipcRenderer.invoke('cliente:modificar', cli),
  clienteEliminar:   (id)     => ipcRenderer.invoke('cliente:eliminar', id),
  clienteObtener:    (id)     => ipcRenderer.invoke('cliente:obtener', id),
  exportClientes:    (opts)   => ipcRenderer.invoke('export:clientes', opts),

  // ── Ventas ───────────────────────────────────────────────────────────────
  ventasListar:              ()             => ipcRenderer.invoke('ventas:listar'),
  ventaObtenerDetalle:       (ventaId)      => ipcRenderer.invoke('venta:obtener-detalle', ventaId),
  ventaAnular:               (payload)      => ipcRenderer.invoke('venta:anular', payload),
  ventaRegistrar:            (venta, items) => ipcRenderer.invoke('venta:registrar', venta, items),
  ventaObtenerProximoNumero: (tipo)         => ipcRenderer.invoke('venta:obtener-proximo-numero', tipo),

  // ── Impresión / Export ────────────────────────────────────────────────────
  exportVentas: (opts)                   => ipcRenderer.invoke('export:ventas', opts),
  printVenta:   (ventaId, modo, preview) => ipcRenderer.invoke('print:venta', {
    ventaId, modo: modo || 'ticket', preview: preview || false
  }),
  getPrintData: () => ipcRenderer.invoke('print:venta:get-data'),
  auditLog:     (payload) => ipcRenderer.invoke('audit:log', payload),

  // ── AFIP ─────────────────────────────────────────────────────────────────
  afipRequestCAE: (payload) => ipcRenderer.invoke('afip:request-cae', payload),

  // ── Caja ─────────────────────────────────────────────────────────────────
  cajaEstadoHoy:       ()      => ipcRenderer.invoke('caja:estado-hoy'),
  cajaAbrir:           (datos) => ipcRenderer.invoke('caja:abrir',      datos),
  cajaMovimiento:      (datos) => ipcRenderer.invoke('caja:movimiento', datos),
  cajaCerrar:          (datos) => ipcRenderer.invoke('caja:cerrar',     datos),
  cajaHistorial:       ()      => ipcRenderer.invoke('caja:historial'),
  cajaDetalle:         (id)    => ipcRenderer.invoke('caja:detalle',    id),
  cajaExportDatos:     (datos) => ipcRenderer.invoke('caja:export-datos', datos),
  cajaExportHistorial: ()      => ipcRenderer.invoke('caja:export-historial'),

  // ── Pedidos de Compra ─────────────────────────────────────────────────────
  pedidosListar:           (f)  => ipcRenderer.invoke('pedidos:listar', f),
  pedidosCrear:            (d)  => ipcRenderer.invoke('pedidos:crear', d),
  pedidosActualizarEstado: (d)  => ipcRenderer.invoke('pedidos:actualizar-estado', d),
  pedidosObtener:          (id) => ipcRenderer.invoke('pedidos:obtener', id),
  pedidosProximoNro:       ()   => ipcRenderer.invoke('pedidos:proximo-nro'),

  // ── Facturas de Compra (Cuentas a Pagar) ─────────────────────────────────
  facturasCompraListar:        (f)  => ipcRenderer.invoke('facturas-compra:listar', f),
  facturasCompraCrear:         (d)  => ipcRenderer.invoke('facturas-compra:crear', d),
  facturasCompraRegistrarPago: (d)  => ipcRenderer.invoke('facturas-compra:registrar-pago', d),
  facturasCompraPagos:         (id) => ipcRenderer.invoke('facturas-compra:pagos', id),
  facturasCompraResumen:       ()   => ipcRenderer.invoke('facturas-compra:resumen'),
  proveedorEstadoCuenta:      (d)  => ipcRenderer.invoke('proveedor:estado-cuenta', d),

  // ── Cta/Cte Clientes ──────────────────────────────────────────────────────
  ctacteListarClientes: ()    => ipcRenderer.invoke('ctacte:listar-clientes'),
  ctacteMovimientos:    (d)   => ipcRenderer.invoke('ctacte:movimientos', d),
  ctacteRegistrarCobro: (d)   => ipcRenderer.invoke('ctacte:registrar-cobro', d),
  ctacteRegistrarVenta: (d)   => ipcRenderer.invoke('ctacte:registrar-venta', d),
  ctacteSaldoCliente:    (id)  => ipcRenderer.invoke('ctacte:saldo-cliente', id),
  ctacteSincronizar:    ()     => ipcRenderer.invoke('ctacte:sincronizar-desde-ventas'),

  // ── Remitos ───────────────────────────────────────────────────────────────
  remitosListar:          (f)  => ipcRenderer.invoke('remitos:listar', f),
  remitosCrear:           (d)  => ipcRenderer.invoke('remitos:crear', d),
  remitosActualizarEstado:(d)  => ipcRenderer.invoke('remitos:actualizar-estado', d),
  remitosObtener:         (id) => ipcRenderer.invoke('remitos:obtener', id),

  // ── Estadísticas ──────────────────────────────────────────────────────────
  statsResumen:          (d) => ipcRenderer.invoke('stats:resumen', d),
  statsVentasPorDia:     (d) => ipcRenderer.invoke('stats:ventas-por-dia', d),
  statsVentasPorMes:     (d) => ipcRenderer.invoke('stats:ventas-por-mes', d),
  statsComparativaMeses: ()  => ipcRenderer.invoke('stats:comparativa-meses'),
  statsTopProductos:     (d) => ipcRenderer.invoke('stats:top-productos', d),
  statsFormasPago:       (d) => ipcRenderer.invoke('stats:formas-pago', d),
  statsPorCategoria:     (d) => ipcRenderer.invoke('stats:por-categoria', d),
  statsRentabilidad:     (d) => ipcRenderer.invoke('stats:rentabilidad', d),
  statsPorHora:          (d) => ipcRenderer.invoke('stats:por-hora', d),
  statsPorUsuario:       (d) => ipcRenderer.invoke('stats:por-usuario', d),
  statsAniosDisponibles: ()  => ipcRenderer.invoke('stats:anios-disponibles'),
  statsComprasResumen:   (d) => ipcRenderer.invoke('stats:compras-resumen', d),

  // ── Promociones ──────────────────────────────────────────────────────────
  contableLibroCaja:    (d) => ipcRenderer.invoke('contable:libro-caja', d),
  contableIvaVentas:    (d) => ipcRenderer.invoke('contable:libro-iva-ventas', d),
  contableIvaCompras:   (d) => ipcRenderer.invoke('contable:libro-iva-compras', d),
  contableIngEgr:       (d) => ipcRenderer.invoke('contable:ingresos-egresos', d),
  contableEstadoRtdo:   (d) => ipcRenderer.invoke('contable:estado-resultados', d),
  // Módulo Costos y Rentabilidad
  costosListar:         (f)  => ipcRenderer.invoke('costos:listar', f),
  costosAgregar:        (d)  => ipcRenderer.invoke('costos:agregar', d),
  costosEditar:         (d)  => ipcRenderer.invoke('costos:editar', d),
  costosEliminar:       (id) => ipcRenderer.invoke('costos:eliminar', id),
  costosRentabilidad:   (p)  => ipcRenderer.invoke('costos:rentabilidad', p),
  costosDatosParaIA:    (p)  => ipcRenderer.invoke('costos:datos-para-ia', p),
  firebaseSyncNow:       ()     => ipcRenderer.invoke('firebase:sync-now'),
  firebaseSaveConfig:    (d)    => ipcRenderer.invoke('firebase:save-config', d),
  firebaseGetConfig:     ()     => ipcRenderer.invoke('firebase:get-config'),
  mobileGetUrl:          ()     => ipcRenderer.invoke('mobile:get-url'),
  waGetConfig:           ()     => ipcRenderer.invoke('wa:get-config'),
  promosListar:          (d) => ipcRenderer.invoke('promos:listar', d),
  promosCrear:           (d) => ipcRenderer.invoke('promos:crear', d),
  promosModificar:       (d) => ipcRenderer.invoke('promos:modificar', d),
  promosEliminar:        (id)=> ipcRenderer.invoke('promos:eliminar', id),
  promosToggle:          (d) => ipcRenderer.invoke('promos:toggle', d),
  promosVerificarProducto:(d)=> ipcRenderer.invoke('promos:verificar-producto', d),
  promosRegistrarUso:    (d) => ipcRenderer.invoke('promos:registrar-uso', d),

  // ── Comunicación entre ventanas ───────────────────────────────────────────
  send:        (channel, data) => ipcRenderer.send(channel, data),
  on:          (channel, func) => ipcRenderer.on(channel, (event, ...args) => func(...args)),
  closeWindow: ()              => ipcRenderer.send('close-window'),
  getAppPath:  ()              => ipcRenderer.invoke('get-app-path'),
  openExternal:(url)           => ipcRenderer.send('shell-open-url', url),

  // ── Impresión ─────────────────────────────────────────────────────────────
  impresionListarImpresoras: ()      => ipcRenderer.invoke('impresion:listar-impresoras'),
  impresionMetodo:           (datos) => ipcRenderer.invoke('impresion:metodo', datos),
  impresionGuardarConfig:    (datos) => ipcRenderer.invoke('impresion:guardar-config', datos),
  impresionCargarConfig:     ()      => ipcRenderer.invoke('impresion:cargar-config'),
  // Aliases usados por config.js
  impresionGetPrinters:      ()      => ipcRenderer.invoke('impresion:listar-impresoras'),
  impresionConfigGuardar:    (datos) => ipcRenderer.invoke('impresion:guardar-config', datos),
  impresionConfigCargar:     ()      => ipcRenderer.invoke('impresion:cargar-config'),
  impresionTest:             (datos) => ipcRenderer.invoke('impresion:test', datos),

  // ── Configuración ─────────────────────────────────────────────────────────
  configCargarTodo:              ()      => ipcRenderer.invoke('config:cargar-todo'),
  configEmpresaGuardar:          (datos) => ipcRenderer.invoke('config:empresa:guardar', datos),
  configUsuariosListar:          ()      => ipcRenderer.invoke('config:usuarios:listar'),
  configUsuarioAgregar:          (datos) => ipcRenderer.invoke('config:usuario:agregar', datos),
  configUsuarioModificar:        (datos) => ipcRenderer.invoke('config:usuario:modificar', datos),
  configUsuarioEliminar:         (id)    => ipcRenderer.invoke('config:usuario:eliminar', id),
  configAfipGuardar:             (datos) => ipcRenderer.invoke('config:afip:guardar', datos),
  configAfipGuardarCertificado:  (datos) => ipcRenderer.invoke('config:afip:guardar-certificado', datos),
  configAfipEstadoCertificado:   ()      => ipcRenderer.invoke('config:afip:estado-certificado'),
  configAfipGenerarToken:        (datos) => ipcRenderer.invoke('config:afip:generar-token', datos),
  configAfipLimpiarToken:        ()      => ipcRenderer.invoke('config:afip:limpiar-token'),
  configPvListar:                ()      => ipcRenderer.invoke('config:pv:listar'),
  configPvAgregar:               (datos) => ipcRenderer.invoke('config:pv:agregar', datos),
  configPvEliminar:              (id)    => ipcRenderer.invoke('config:pv:eliminar', id),
  configComprobantesGuardar:     (datos) => ipcRenderer.invoke('config:comprobantes:guardar', datos),
  configDisenoGuardar:           (datos) => ipcRenderer.invoke('config:diseno:guardar', datos),
  configDisenoCargar:            (tipo)  => ipcRenderer.invoke('config:diseno:cargar', tipo),
  configBackupGenerar:           ()      => ipcRenderer.invoke('config:backup:generar'),
  configBackupRestaurar:         ()      => ipcRenderer.invoke('config:backup:restaurar'),
  configSistemaGuardar:          (datos) => ipcRenderer.invoke('config:sistema:guardar', datos),
  configSistemaGetIP:            ()      => ipcRenderer.invoke('config:sistema:get-ip'),
  configSistemaElegirCarpeta:    ()      => ipcRenderer.invoke('config:sistema:elegir-carpeta'),
  configSistemaElegirArchivoDB:  ()      => ipcRenderer.invoke('config:sistema:elegir-archivo-db'),
  configSistemaTestDB:           (datos) => ipcRenderer.invoke('config:sistema:test-db', datos),
  configComunicacionesGuardar:   (datos) => ipcRenderer.invoke('config:comunicaciones:guardar', datos),
  configEmailEnviar:             (datos) => ipcRenderer.invoke('config:email:enviar', datos),
  configEmailProbar:             (datos) => ipcRenderer.invoke('config:email:probar', datos),

  // ── Licencia ──────────────────────────────────────────────────────────────
  licenciaEstado:  ()      => ipcRenderer.invoke('licencia:estado'),
  licenciaActivar: (datos) => ipcRenderer.invoke('licencia:activar', datos),

});
