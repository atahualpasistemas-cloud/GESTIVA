// renderer.js — Lógica principal del POS
// Usa window.api (expuesto por preload.js via contextBridge)
(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════════
  // ESTADO GLOBAL
  // ══════════════════════════════════════════════════════════════
  let carrito              = [];
  let productosTodos       = [];
  let itemSeleccionado     = -1;
  let descuentoManual      = { motivo: '', valor: 0 };
  let recargoManual        = { motivo: '', valor: 0 };
  let descuentoPago        = { valor: 0 };
  let recargoPago          = { valor: 0 };
  let interesManualPercent = 0;
  let interesPagoPercent   = 0;
  let ultimaFormaDePago    = '';
  let modalFPSeleccionada  = null;
  let acTimeout            = null;

  // ══════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════
  const fmt = n => Number(n || 0).toLocaleString('es-AR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const hoy = () => new Date().toISOString().slice(0, 10);

  function toast(msg, tipo, ms) {
    if (typeof window.toast === 'function') { window.toast(msg, tipo, ms); return; }
    let cont = document.querySelector('.toast-container');
    if (!cont) {
      cont = document.createElement('div');
      cont.className = 'toast-container';
      document.body.appendChild(cont);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (tipo || 'info');
    el.textContent = msg;
    cont.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  // ══════════════════════════════════════════════════════════════
  // REFERENCIAS DOM
  // ══════════════════════════════════════════════════════════════
  const barcode             = document.getElementById('barcode');
  const qtyInput            = document.getElementById('qty');
  const buscarBtn           = document.getElementById('buscarBtn');
  const itemsTableBody      = document.querySelector('#itemsTable tbody');
  const quitarBtn           = document.getElementById('quitarBtn');
  const descuentoBtn        = document.getElementById('descuentoBtn');
  const recargoBtn          = document.getElementById('recargoBtn');
  const interesBtn          = document.getElementById('interesBtn');
  const cambiarCantidadBtn  = document.getElementById('cambiarCantidadBtn');
  const cambiarPrecioBtn    = document.getElementById('cambiarPrecioBtn');
  const cobrarBtn           = document.getElementById('cobrarBtn');
  const nuevaVentaBtn       = document.getElementById('nuevaVentaBtn');
  const formaPagoBtn        = document.getElementById('formaPagoBtn');
  const verPrecioBtn        = document.getElementById('verPrecioBtn');
  const cambiarClienteBtn   = document.getElementById('cambiarClienteBtn');
  const tipoComprobante     = document.getElementById('tipo');
  const nroComprobante      = document.getElementById('nro');
  const fechaInput          = document.getElementById('fecha');
  const elSubtotal          = document.getElementById('subtotal');
  const elDescuento         = document.getElementById('descuento');
  const elRecargo           = document.getElementById('recargo');
  const elInteres           = document.getElementById('interes');
  const elInteresPercent    = document.getElementById('interesPercent');
  const elTotal             = document.getElementById('total');
  const fpBadge             = document.getElementById('fpBadge');
  const btnGestionProd      = document.getElementById('btnGestionProd');
  const btnGestionCli       = document.getElementById('btnGestionCli');
  const btnGestionProv      = document.getElementById('btnGestionProv');
  const btnGestionVentas    = document.getElementById('btnGestionVentas');
  const btnConfig           = document.getElementById('btnConfig');
  const btnGestionCaja      = document.getElementById('btnGestionCaja');

  // Modal cobro
  const modalCobro          = document.getElementById('modalCobro');
  const btnCerrarModal      = document.getElementById('btnCerrarModal');
  const mcTipo              = document.getElementById('mcTipo');
  const mcNro               = document.getElementById('mcNro');
  const mcCliente           = document.getElementById('mcCliente');
  const mcItemsBody         = document.getElementById('mcItems');
  const mcTotal             = document.getElementById('mcTotal');
  const fpGrid              = document.getElementById('fpGrid');
  const fpImpacto           = document.getElementById('fpImpacto');
  const pagoTotalAmount     = document.getElementById('pagoTotalAmount');
  const pagoFpElegida       = document.getElementById('pagoFpElegida');
  const btnConfirmarCobro   = document.getElementById('btnConfirmarCobro');
  const btnCancelarCobro    = document.getElementById('btnCancelarCobro');

  // ══════════════════════════════════════════════════════════════
  // FORMAS DE PAGO
  // ══════════════════════════════════════════════════════════════
  const FORMAS_PAGO = [
    { clave: 'efectivo',      label: 'Efectivo',          icon: '💵', descuento: 0, recargo: 0,  interes: 0 },
    { clave: 'debito',        label: 'Tarjeta Débito',    icon: '💳', descuento: 0, recargo: 0,  interes: 0 },
    { clave: 'credito1',      label: 'Crédito 1 cuota',   icon: '💳', descuento: 0, recargo: 5,  interes: 0 },
    { clave: 'credito3',      label: 'Crédito 3 cuotas',  icon: '💳', descuento: 0, recargo: 12, interes: 0 },
    { clave: 'credito6',      label: 'Crédito 6 cuotas',  icon: '💳', descuento: 0, recargo: 20, interes: 0 },
    { clave: 'meli',          label: 'Mercado Pago',      icon: '🔵', descuento: 0, recargo: 0,  interes: 0 },
    { clave: 'transferencia', label: 'Transferencia',     icon: '🏦', descuento: 0, recargo: 0,  interes: 0 },
    { clave: 'cheque',        label: 'Cheque',            icon: '📄', descuento: 0, recargo: 0,  interes: 0 },
    { clave: 'ctacte',        label: 'Cta. Corriente',    icon: '📋', descuento: 0, recargo: 0,  interes: 0 },
  ];

  // ══════════════════════════════════════════════════════════════
  // CÁLCULO DE TOTALES
  // ══════════════════════════════════════════════════════════════
  function calcularTotalConFP(subtotalBase, descM, recM, intPct, fp) {
    const desc   = descM;
    const recFP  = fp ? (subtotalBase - descM) * (fp.recargo || 0) / 100 : 0;
    const rec    = recM + recFP;
    const baseInt = subtotalBase - desc + rec;
    const int    = intPct > 0 ? baseInt * intPct / 100 : 0;
    const total  = Math.max(0, +(baseInt + int).toFixed(2));
    return { desc, rec, recFP, int, total };
  }

  function actualizarTotales() {
    // El importe de cada ítem ya lleva el descuento de promo aplicado
    // subtotalBase = suma de importes ya con promos
    const subtotalBruto = carrito.reduce((a,b) => a + (b.unitario * b.cantidad), 0);
    const ahorroPromos  = carrito.reduce((a,b) => a + (b.ahorro_total||0), 0);
    const subtotalBase  = carrito.reduce((a,b) => a + b.importe, 0);

    const descM = (descuentoManual.valor || 0) + (descuentoPago.valor || 0) + ahorroPromos;
    const recM  = (recargoManual.valor   || 0) + (recargoPago.valor   || 0);
    const intPct = interesPagoPercent > 0 ? interesPagoPercent : (interesManualPercent || 0);
    const t = calcularTotalConFP(subtotalBase, descM - ahorroPromos, recM, intPct, null);

    if (elSubtotal) elSubtotal.textContent = fmt(subtotalBruto);

    // Mostrar promo savings en la línea de descuento
    const descEl = document.getElementById('descuentoDisplay');
    const descTotal = (descuentoManual.valor||0) + (descuentoPago.valor||0);
    if (elDescuento) elDescuento.textContent = fmt(descTotal);

    // Mostrar ahorro promos por separado si hay
    let promoSavingsEl = document.getElementById('promoSavingsRow');
    if (ahorroPromos > 0) {
      if (!promoSavingsEl) {
        promoSavingsEl = document.createElement('div');
        promoSavingsEl.id = 'promoSavingsRow';
        promoSavingsEl.className = 'side-row';
        promoSavingsEl.style.cssText = 'color:#69f0ae;font-size:12px;';
        elDescuento?.closest('.side-row')?.after(promoSavingsEl);
      }
      promoSavingsEl.innerHTML = `<span style="font-size:11px;opacity:.8">🏷️ Promos</span><span style="color:#69f0ae">−${fmt(ahorroPromos)}</span>`;
      promoSavingsEl.style.display = '';
    } else if (promoSavingsEl) {
      promoSavingsEl.style.display = 'none';
    }

    if (elRecargo)       elRecargo.textContent       = fmt(t.rec);
    if (elInteres)       elInteres.textContent       = fmt(t.int);
    if (elInteresPercent) elInteresPercent.textContent = intPct > 0 ? `(${intPct}%)` : '';
    if (elTotal)         elTotal.textContent         = fmt(subtotalBase - descTotal + t.rec + t.int);

    if (cobrarBtn) cobrarBtn.disabled = carrito.length === 0;
    actualizarBadgeFormaPago(ultimaFormaDePago);
  }

  function actualizarBadgeFormaPago(clave) {
    if (!fpBadge) return;
    if (!clave) { fpBadge.textContent = 'Sin forma de pago'; fpBadge.classList.remove('active'); return; }
    const fp = FORMAS_PAGO.find(f => f.clave === clave);
    fpBadge.textContent = fp ? fp.icon + ' ' + fp.label : clave;
    fpBadge.classList.add('active');
  }

  // ══════════════════════════════════════════════════════════════
  // TABLA DE ITEMS
  // ══════════════════════════════════════════════════════════════
  function renderTabla() {
    if (!itemsTableBody) return;
    if (carrito.length === 0) {
      itemsTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="6">— Agregá productos escaneando o buscando por nombre —</td></tr>';
      return;
    }
    itemsTableBody.innerHTML = carrito.map((it, i) => {
      const tienePromo  = it.promo_id && it.unitario_promo !== null;
      const precioMuestra = tienePromo ? it.unitario_promo : it.unitario;
      return `<tr class="${i === itemSeleccionado ? 'selected' : ''}" data-idx="${i}">
        <td>${i + 1}</td>
        <td style="font-family:monospace;font-size:11px">${it.codigo || ''}</td>
        <td>
          ${it.descripcion}
          ${tienePromo ? `<br><span style="font-size:10px;background:#e8f5e9;color:#2e7d32;padding:1px 6px;border-radius:8px;font-weight:700;">🏷️ ${it.promo_etiqueta||it.promo_nombre}</span>` : ''}
        </td>
        <td style="text-align:right">${it.cantidad}</td>
        <td style="text-align:right">
          ${tienePromo
            ? (it.promo_tipo==='2x1'||it.promo_tipo==='3x2'
                ? `<span style="color:#2ea846;font-weight:700">$${fmt(it.unitario)}</span>`
                : `<span style="text-decoration:line-through;color:#aaa;font-size:10px">$${fmt(it.unitario)}</span><br><span style="color:#2ea846;font-weight:700">$${fmt(precioMuestra)}</span>`)
            : `$${fmt(it.unitario)}`}
        </td>
        <td style="text-align:right;font-weight:700;color:${tienePromo?'#2ea846':'inherit'}">
          $${fmt(it.importe)}
        </td>
      </tr>`;
    }).join('');

    itemsTableBody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        itemSeleccionado = parseInt(tr.dataset.idx);
        renderTabla();
      });
      tr.addEventListener('dblclick', () => {
        itemSeleccionado = parseInt(tr.dataset.idx);
        abrirPanelInline('cantidad');
      });
    });
  }

  // ══════════════════════════════════════════════════════════════
  // AGREGAR PRODUCTO AL CARRITO
  // ══════════════════════════════════════════════════════════════
  async function agregarProducto(prod, cantidad) {
    const qty    = Math.max(1, parseInt(cantidad) || 1);
    const precio = prod.precio || 0;
    const idx    = carrito.findIndex(it => it.codigo === prod.codigo);

    // Agregar/actualizar en carrito SIN promo primero
    if (idx >= 0) {
      carrito[idx].cantidad += qty;
      carrito[idx].importe   = +(carrito[idx].cantidad * carrito[idx].unitario).toFixed(2);
    } else {
      carrito.push({
        codigo:         prod.codigo || '',
        descripcion:    prod.descripcion || '',
        cantidad:       qty,
        unitario:       precio,
        unitario_promo: null,
        importe:        +(precio * qty).toFixed(2),
        ahorro_total:   0,
        promo_id:       null,
        promo_nombre:   null,
        promo_etiqueta: null,
        promo_tipo:     null,
      });
    }

    // Recalcular TODAS las promos del carrito post-agregado
    await recalcularPromosCarrito();

    renderTabla();
    actualizarTotales();
    if (barcode)  barcode.value = '';
    if (qtyInput) qtyInput.value = 1;
    if (barcode)  barcode.focus();
    ocultarAC();

    const it = carrito.find(i => i.codigo === prod.codigo);
    const msg = (it?.promo_etiqueta)
      ? '🏷️ ' + (prod.descripcion||prod.codigo) + ' — ' + it.promo_etiqueta
      : '✔ ' + (prod.descripcion || prod.codigo);
    toast(msg, 'success', 1800);
  }

  // Recalcula las promos sobre el carrito completo (se llama post cada cambio)
  async function recalcularPromosCarrito() {
    if (!window.api || !window.api.promosVerificarProducto) return;
    for (let i = 0; i < carrito.length; i++) {
      const it = carrito[i];
      try {
        const res = await window.api.promosVerificarProducto({
          codigo:       it.codigo || '',
          categoria_id: it.categoria_id || null,
          precio:       it.unitario,
          cantidad:     it.cantidad,   // total en carrito
        });
        if (res?.ok && res.promos?.length > 0) {
          const p = res.promos[0];
          // Calcular importe total con promo
          let importeConPromo = it.unitario * it.cantidad;
          let ahorro = 0;
          switch(p.tipo) {
            case 'porcentaje':
              ahorro = it.unitario * it.cantidad * (Number(p.valor)/100);
              importeConPromo = it.unitario * it.cantidad - ahorro;
              break;
            case 'monto_fijo':
              ahorro = Math.min(Number(p.valor) * it.cantidad, it.unitario * it.cantidad);
              importeConPromo = it.unitario * it.cantidad - ahorro;
              break;
            case 'precio_especial':
              ahorro = (it.unitario - Number(p.valor)) * it.cantidad;
              importeConPromo = Number(p.valor) * it.cantidad;
              break;
            case '2x1': {
              const paid = Math.ceil(it.cantidad / 2);
              const free = it.cantidad - paid;
              ahorro = it.unitario * free;
              importeConPromo = it.unitario * paid;
              p.etiqueta = free > 0 ? `2×1 (${free} gratis)` : '2×1';
              break;
            }
            case '3x2': {
              const free3 = Math.floor(it.cantidad / 3);
              ahorro = it.unitario * free3;
              importeConPromo = it.unitario * (it.cantidad - free3);
              p.etiqueta = free3 > 0 ? `3×2 (${free3} gratis)` : '3×2';
              break;
            }
          }
          carrito[i].unitario_promo  = p.precio_final || it.unitario;
          carrito[i].importe         = +importeConPromo.toFixed(2);
          carrito[i].ahorro_total    = +ahorro.toFixed(2);
          carrito[i].promo_id        = p.id;
          carrito[i].promo_nombre    = p.nombre;
          carrito[i].promo_etiqueta  = p.etiqueta || '';
          carrito[i].promo_tipo      = p.tipo;
        } else {
          // Sin promo — precio normal
          carrito[i].unitario_promo  = null;
          carrito[i].importe         = +(it.unitario * it.cantidad).toFixed(2);
          carrito[i].ahorro_total    = 0;
          carrito[i].promo_id        = null;
          carrito[i].promo_nombre    = null;
          carrito[i].promo_etiqueta  = null;
          carrito[i].promo_tipo      = null;
        }
      } catch(e) {
        // Red error — keep current importe
      }
    }
  }


  // ══════════════════════════════════════════════════════════════
  // BÚSQUEDA DE PRODUCTO
  // ══════════════════════════════════════════════════════════════
  async function buscarYAgregar() {
    const q = (barcode ? barcode.value.trim() : '');
    if (!q) return;
    const qty = parseInt(qtyInput ? qtyInput.value : 1) || 1;

    // Exacto por código
    let prod = productosTodos.find(p => p.codigo && p.codigo.toLowerCase() === q.toLowerCase());
    if (prod) { agregarProducto(prod, qty); return; }

    // Por descripción parcial
    const matches = productosTodos.filter(p =>
      p.descripcion && p.descripcion.toLowerCase().includes(q.toLowerCase())
    );
    if (matches.length === 1) { agregarProducto(matches[0], qty); return; }
    if (matches.length > 1)   { mostrarAC(matches, qty); return; }

    toast('Producto no encontrado: ' + q, 'error');
  }

  // ══════════════════════════════════════════════════════════════
  // AUTOCOMPLETE
  // ══════════════════════════════════════════════════════════════
  let acBox = document.getElementById('acBox');
  if (!acBox) {
    acBox = document.createElement('div');
    acBox.id = 'acBox';
    acBox.style.display = 'none';
    document.body.appendChild(acBox);
  }

  function mostrarAC(lista, qty) {
    if (!barcode || !acBox) return;
    const rect = barcode.getBoundingClientRect();
    acBox.style.cssText =
      `left:${rect.left}px;top:${rect.bottom + 4}px;display:block;position:fixed;` +
      `background:#fff;border:1px solid #dde8dd;border-radius:6px;z-index:500;` +
      `min-width:320px;max-height:220px;overflow-y:auto;` +
      `box-shadow:0 8px 24px rgba(0,0,0,.14);font-size:13px;`;

    acBox.innerHTML = lista.slice(0, 15).map(p => `
      <div class="ac-item" data-codigo="${p.codigo}" style="padding:9px 13px;cursor:pointer;border-bottom:1px solid #f0f4f0;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span style="font-weight:500;color:#1a2e1a;">${p.descripcion}</span>
        <span style="font-weight:700;color:#1e7e34;font-family:monospace;font-size:12px;white-space:nowrap;">$${fmt(p.precio)}</span>
        <span style="font-size:11px;color:#5a7a5a;white-space:nowrap;">Stock: ${p.stock ?? '–'}</span>
      </div>`).join('');

    acBox.querySelectorAll('.ac-item').forEach(el => {
      el.addEventListener('mouseover', () => el.style.background = '#e8f5e9');
      el.addEventListener('mouseout',  () => el.style.background = '');
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        const prod = productosTodos.find(p => p.codigo === el.dataset.codigo);
        if (prod) agregarProducto(prod, qty);
      });
    });
  }

  function ocultarAC() {
    if (acBox) acBox.style.display = 'none';
  }

  if (barcode) {
    barcode.addEventListener('input', () => {
      clearTimeout(acTimeout);
      const q = barcode.value.trim();
      if (q.length < 2) { ocultarAC(); return; }
      acTimeout = setTimeout(() => {
        const matches = productosTodos.filter(p =>
          (p.descripcion && p.descripcion.toLowerCase().includes(q.toLowerCase())) ||
          (p.codigo && p.codigo.toLowerCase().startsWith(q.toLowerCase()))
        );
        if (matches.length > 0 && matches.length <= 20)
          mostrarAC(matches, parseInt(qtyInput ? qtyInput.value : 1) || 1);
        else
          ocultarAC();
      }, 180);
    });

    barcode.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); buscarYAgregar(); }
      if (e.key === 'Escape') { ocultarAC(); }
    });
  }

  document.addEventListener('click', e => {
    if (acBox && !acBox.contains(e.target) && e.target !== barcode) ocultarAC();
  });

  if (buscarBtn) buscarBtn.addEventListener('click', buscarYAgregar);

  // ══════════════════════════════════════════════════════════════
  // PANEL INLINE: DESCUENTO / RECARGO / INTERÉS / CANTIDAD / PRECIO
  // ══════════════════════════════════════════════════════════════
  function abrirPanelInline(tipo) {
    const existente = document.getElementById('panelInline');
    if (existente) existente.remove();

    const buttonsRow = document.querySelector('.buttons-row');
    if (!buttonsRow) return;

    const panel = document.createElement('div');
    panel.id = 'panelInline';
    panel.style.cssText =
      'background:#fff;border:1.5px solid #c8e6c9;border-radius:6px;padding:10px 12px;' +
      'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;';

    const labels = {
      descuento: '% Descuento',
      recargo:   '% Recargo',
      interes:   '% Interés',
      cantidad:  'Nueva cantidad',
      precio:    'Nuevo precio ($)'
    };

    const initVal = tipo === 'cantidad' && itemSeleccionado >= 0
      ? (carrito[itemSeleccionado]?.cantidad ?? 1)
      : tipo === 'precio' && itemSeleccionado >= 0
        ? (carrito[itemSeleccionado]?.unitario ?? 0)
        : 0;

    const needMotivo = tipo === 'descuento' || tipo === 'recargo';

    panel.innerHTML = `
      <label style="font-size:12px;font-weight:700;color:#1b5e20;">${labels[tipo]}:</label>
      <input type="number" id="piNum" value="${initVal}" min="0" step="0.01"
             style="width:90px;padding:6px 9px;border:1px solid #dde8dd;border-radius:5px;font-size:13px;">
      ${needMotivo ? `<input type="text" id="piMotivo" placeholder="Motivo (opcional)"
             style="flex:1;min-width:120px;padding:6px 9px;border:1px solid #dde8dd;border-radius:5px;font-size:13px;">` : ''}
      <button id="piAceptar"  style="padding:6px 14px;background:#1e7e34;color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;">Aplicar</button>
      <button id="piCancelar" style="padding:6px 14px;background:#eee;color:#333;border:none;border-radius:5px;cursor:pointer;font-size:12px;font-weight:700;">✕</button>
    `;

    buttonsRow.insertAdjacentElement('afterend', panel);
    const piNum = document.getElementById('piNum');
    if (piNum) { piNum.focus(); piNum.select(); }

    document.getElementById('piCancelar').onclick = () => panel.remove();
    document.getElementById('piAceptar').onclick  = () => aplicarPanelInline(tipo, panel);
    if (piNum) {
      piNum.addEventListener('keydown', e => {
        if (e.key === 'Enter')  aplicarPanelInline(tipo, panel);
        if (e.key === 'Escape') panel.remove();
      });
    }
  }

  function aplicarPanelInline(tipo, panel) {
    const num    = parseFloat(document.getElementById('piNum')?.value) || 0;
    const motivo = document.getElementById('piMotivo')?.value || '';
    const subtotalBase = carrito.reduce((a, b) => a + b.importe, 0);

    switch (tipo) {
      case 'descuento':
        descuentoManual = { motivo, valor: +(subtotalBase * num / 100).toFixed(2) };
        if (num > 0) toast(`Descuento ${num}% aplicado`, 'success');
        else { descuentoManual = { motivo: '', valor: 0 }; toast('Descuento eliminado', 'info'); }
        break;
      case 'recargo':
        recargoManual = { motivo, valor: +(subtotalBase * num / 100).toFixed(2) };
        if (num > 0) toast(`Recargo ${num}% aplicado`, 'success');
        else { recargoManual = { motivo: '', valor: 0 }; toast('Recargo eliminado', 'info'); }
        break;
      case 'interes':
        interesManualPercent = num;
        if (num > 0) toast(`Interés ${num}% aplicado`, 'success');
        else { interesManualPercent = 0; toast('Interés eliminado', 'info'); }
        break;
      case 'cantidad':
        if (itemSeleccionado >= 0 && carrito[itemSeleccionado]) {
          carrito[itemSeleccionado].cantidad = Math.max(1, num);
          carrito[itemSeleccionado].importe  =
            +(carrito[itemSeleccionado].cantidad * carrito[itemSeleccionado].unitario).toFixed(2);
          renderTabla();
        }
        break;
      case 'precio':
        if (itemSeleccionado >= 0 && carrito[itemSeleccionado]) {
          carrito[itemSeleccionado].unitario = num;
          carrito[itemSeleccionado].importe  =
            +(carrito[itemSeleccionado].cantidad * num).toFixed(2);
          renderTabla();
        }
        break;
    }
    panel.remove();
    actualizarTotales();
  }

  // ── Botones de acción ──────────────────────────────────────────────────────
  if (quitarBtn) quitarBtn.addEventListener('click', () => {
    if (itemSeleccionado < 0 || itemSeleccionado >= carrito.length) {
      toast('Seleccioná un producto de la lista', 'error'); return;
    }
    carrito.splice(itemSeleccionado, 1);
    itemSeleccionado = -1;
    renderTabla();
    actualizarTotales();
  });

  if (descuentoBtn)       descuentoBtn.addEventListener('click',       () => abrirPanelInline('descuento'));
  if (recargoBtn)         recargoBtn.addEventListener('click',         () => abrirPanelInline('recargo'));
  if (interesBtn)         interesBtn.addEventListener('click',         () => abrirPanelInline('interes'));
  if (cambiarCantidadBtn) cambiarCantidadBtn.addEventListener('click', () => {
    if (itemSeleccionado < 0) { toast('Seleccioná un producto', 'error'); return; }
    abrirPanelInline('cantidad');
  });
  if (cambiarPrecioBtn) cambiarPrecioBtn.addEventListener('click', () => {
    if (itemSeleccionado < 0) { toast('Seleccioná un producto', 'error'); return; }
    abrirPanelInline('precio');
  });

  // ══════════════════════════════════════════════════════════════
  // MODAL DE COBRO
  // ══════════════════════════════════════════════════════════════
  function abrirModalCobro() {
    if (carrito.length === 0) { toast('Agregá productos primero', 'error'); return; }

    // Poblar preview
    if (mcTipo)    mcTipo.textContent   = tipoComprobante ? tipoComprobante.value : 'Ticket';
    if (mcNro)     mcNro.textContent    = 'Nro. ' + String(nroComprobante ? nroComprobante.value : '').padStart(8, '0');
    if (mcCliente) mcCliente.textContent =
      (document.getElementById('cliente')?.value || 'Cliente Ocasional') + ' — ' +
      (document.getElementById('iva')?.value     || 'Consumidor Final');

    if (mcItemsBody) mcItemsBody.innerHTML = carrito.map(it => {
      const tienePromo = it.promo_etiqueta || it.promo_nombre;
      const precioMuestra = it.unitario_promo !== null && it.unitario_promo !== undefined ? it.unitario_promo : it.unitario;
      return `<tr>
        <td>${it.descripcion}${tienePromo?`<br><span style="font-size:9px;color:#2e7d32;font-weight:700">🏷️ ${it.promo_etiqueta||it.promo_nombre}</span>`:''}</td>
        <td style="text-align:right">${it.cantidad}</td>
        <td style="text-align:right">${tienePromo&&it.promo_tipo!=='2x1'&&it.promo_tipo!=='3x2'
          ? `<s style="color:#aaa;font-size:9px">$${fmt(it.unitario)}</s> $${fmt(precioMuestra)}`
          : '$ '+fmt(it.unitario)}</td>
        <td style="text-align:right${tienePromo?';color:#2e7d32;font-weight:700':''}">$ ${fmt(it.importe)}</td>
      </tr>`;
    }).join('');

    // Poblar chips de forma de pago
    if (fpGrid) {
      fpGrid.innerHTML = FORMAS_PAGO.map(fp => {
        const selClass = modalFPSeleccionada?.clave === fp.clave ? ' selected' : '';
        const tags = (fp.recargo > 0 ? `<br><small style="color:#f57c00">+${fp.recargo}% recargo</small>` : '') +
                     (fp.descuento > 0 ? `<br><small style="color:#388e3c">-${fp.descuento}% desc.</small>` : '');
        return `<div class="fp-chip${selClass}" data-clave="${fp.clave}">
          <span class="fp-ico">${fp.icon}</span>
          ${fp.label}${tags}
        </div>`;
      }).join('');

      fpGrid.querySelectorAll('.fp-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const fp = FORMAS_PAGO.find(f => f.clave === chip.dataset.clave);
          if (fp) seleccionarFP(fp);
        });
      });
    }

    actualizarModalTotales();
    // Limpiar vuelto
    const inputMonto = document.getElementById('inputMontoRecibido');
    const vueltoDisplay = document.getElementById('vueltoDisplay');
    if (inputMonto) inputMonto.value = '';
    if (vueltoDisplay) vueltoDisplay.style.display = 'none';
    if (modalCobro) modalCobro.classList.add('open');
    setTimeout(() => {
      // Si es efectivo, foco en monto recibido; si no, no
      const vueltoBox = document.getElementById('vueltoBox');
      if (vueltoBox) vueltoBox.style.display = 'none'; // reset
    }, 50);
  }

  function cerrarModalCobro() {
    if (modalCobro) modalCobro.classList.remove('open');
  }

  function seleccionarFP(fp) {
    modalFPSeleccionada = fp;
    ultimaFormaDePago   = fp.clave;
    descuentoPago = { valor: 0 };
    recargoPago   = { valor: 0 };
    interesPagoPercent = fp.interes || 0;

    if (fpGrid) fpGrid.querySelectorAll('.fp-chip').forEach(c => {
      c.classList.toggle('selected', c.dataset.clave === fp.clave);
    });

    actualizarModalTotales();
    actualizarBadgeFormaPago(fp.clave);

    // Mostrar/ocultar vuelto según forma de pago
    const vueltoBox   = document.getElementById('vueltoBox');
    const inputMonto  = document.getElementById('inputMontoRecibido');
    const vueltoDisp  = document.getElementById('vueltoDisplay');
    const montosRap   = document.getElementById('montosRapidos');
    const esEfectivo  = fp.clave === 'efectivo';
    if (vueltoBox) vueltoBox.style.display = esEfectivo ? '' : 'none';
    if (inputMonto) { inputMonto.value = ''; inputMonto.focus(); }
    if (vueltoDisp) vueltoDisp.style.display = 'none';

    // Atajos de monto rápido (billetes comunes)
    if (montosRap && esEfectivo) {
      const total = calcularTotalConFP(
        carrito.reduce((a,b)=>a+b.importe,0),
        descuentoManual.valor||0, recargoManual.valor||0,
        interesPagoPercent||interesManualPercent||0, fp
      ).total;
      const billetes = [100,200,500,1000,2000,5000,10000];
      const sugeridos = billetes.filter(b => b >= total).slice(0,4);
      // Redondear al billete más cercano
      const redondea = Math.ceil(total / 100) * 100;
      if(!sugeridos.includes(redondea)) sugeridos.unshift(redondea);
      montosRap.innerHTML = sugeridos.slice(0,5).map(b =>
        `<button onclick="document.getElementById('inputMontoRecibido').value=${b};calcularVuelto()"
          style="flex:1;padding:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.1);
          color:#fff;border-radius:5px;cursor:pointer;font-size:11px;font-weight:600;min-width:52px;">
          $${b.toLocaleString('es-AR')}
        </button>`
      ).join('');
    }

    // Mostrar impacto
    if (fpImpacto) {
      const subtotalBase = carrito.reduce((a, b) => a + b.importe, 0);
      const descM = descuentoManual.valor || 0;
      const recFP = (subtotalBase - descM) * (fp.recargo || 0) / 100;
      const intFP = fp.interes || 0;
      fpImpacto.className = 'fp-impacto show';
      if (recFP > 0) {
        fpImpacto.className += ' recargo';
        fpImpacto.textContent = `+${fp.recargo}% recargo → $ ${fmt(recFP)} adicional`;
      } else if (fp.descuento > 0) {
        fpImpacto.className += ' descuento';
        fpImpacto.textContent = `−${fp.descuento}% descuento → te ahorrás $ ${fmt((subtotalBase - descM) * fp.descuento / 100)}`;
      } else if (intFP > 0) {
        fpImpacto.className += ' interes';
        fpImpacto.textContent = `${intFP}% interés aplicado`;
      } else {
        fpImpacto.className += ' neutro';
        fpImpacto.textContent = 'Sin recargo ni descuento';
      }
    }
  }

  function actualizarModalTotales() {
    const subtotalBase = carrito.reduce((a, b) => a + b.importe, 0);
    const descM = descuentoManual.valor || 0;
    const recM  = recargoManual.valor   || 0;
    const intPct = interesPagoPercent > 0 ? interesPagoPercent :
                   interesManualPercent > 0 ? interesManualPercent : 0;

    const t = calcularTotalConFP(subtotalBase, descM, recM, intPct, modalFPSeleccionada);

    const rowDesc = document.getElementById('mcRowDesc');
    const rowRec  = document.getElementById('mcRowRec');
    const rowInt  = document.getElementById('mcRowInt');
    const rowFP   = document.getElementById('mcRowImpFP');

    if (rowDesc) rowDesc.style.display = descM > 0 ? '' : 'none';
    const mcDescEl = document.getElementById('mcDesc');
    if (mcDescEl) mcDescEl.textContent = '− $ ' + fmt(descM);

    if (rowRec) rowRec.style.display = recM > 0 ? '' : 'none';
    const mcRecEl = document.getElementById('mcRec');
    if (mcRecEl) mcRecEl.textContent = '+ $ ' + fmt(recM);

    if (rowInt) rowInt.style.display = t.int > 0 ? '' : 'none';
    const mcIntEl = document.getElementById('mcInt');
    if (mcIntEl) mcIntEl.textContent = '+ $ ' + fmt(t.int);
    const mcIntPctEl = document.getElementById('mcIntPct');
    if (mcIntPctEl) mcIntPctEl.textContent = intPct > 0 ? `(${intPct}%)` : '';

    if (rowFP) rowFP.style.display = t.recFP > 0 ? '' : 'none';
    const mcImpFPLabelEl = document.getElementById('mcImpFPLabel');
    if (mcImpFPLabelEl) mcImpFPLabelEl.textContent = 'Recargo ' + (modalFPSeleccionada?.label || '');
    const mcImpFPValEl = document.getElementById('mcImpFPVal');
    if (mcImpFPValEl) mcImpFPValEl.textContent = '+ $ ' + fmt(t.recFP);

    if (mcTotal)         mcTotal.textContent        = '$ ' + fmt(t.total);
    if (pagoTotalAmount) pagoTotalAmount.textContent = '$ ' + fmt(t.total);
    if (pagoFpElegida)   pagoFpElegida.textContent   =
      modalFPSeleccionada ? (modalFPSeleccionada.icon + ' ' + modalFPSeleccionada.label) : '—';

    if (btnConfirmarCobro) btnConfirmarCobro.disabled = !modalFPSeleccionada;
  }

  // Vuelto
  window.calcularVuelto = function() {
    const inputMonto = document.getElementById('inputMontoRecibido');
    const vueltoDisp = document.getElementById('vueltoDisplay');
    const vueltoImp  = document.getElementById('vueltoImporte');
    const total = parseFloat(document.getElementById('pagoTotalAmount')?.textContent?.replace(/[^0-9,.]/g,'').replace(',','.')) || 0;
    const recibido = parseFloat(inputMonto?.value) || 0;
    if (!vueltoDisp || !vueltoImp) return;
    if (recibido <= 0) { vueltoDisp.style.display='none'; return; }
    const vuelto = recibido - total;
    vueltoDisp.style.display = '';
    vueltoDisp.style.background = vuelto >= 0 ? 'rgba(46,168,70,.2)' : 'rgba(229,57,53,.2)';
    vueltoDisp.style.borderColor = vuelto >= 0 ? 'rgba(46,168,70,.4)' : 'rgba(229,57,53,.4)';
    vueltoImp.style.color = vuelto >= 0 ? '#69f0ae' : '#ff5252';
    vueltoImp.textContent = (vuelto < 0 ? '- ' : '') + '$ ' + Math.abs(vuelto).toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2});
    // Habilitar cobro solo si recibido >= total
    const btn = document.getElementById('btnConfirmarCobro');
    if (btn && modalFPSeleccionada?.clave === 'efectivo') {
      btn.disabled = recibido < total;
      if (recibido < total) {
        btn.innerHTML = '⚠ Monto insuficiente';
        btn.style.opacity = '.6';
      } else {
        btn.innerHTML = '✅ Confirmar y Registrar';
        btn.style.opacity = '1';
      }
    }
  };

  if (cobrarBtn)        cobrarBtn.addEventListener('click', abrirModalCobro);
  if (btnCerrarModal)   btnCerrarModal.addEventListener('click', cerrarModalCobro);
  if (btnCancelarCobro) btnCancelarCobro.addEventListener('click', cerrarModalCobro);
  if (btnConfirmarCobro) btnConfirmarCobro.addEventListener('click', registrarVenta);

  // ══════════════════════════════════════════════════════════════
  // REGISTRAR VENTA
  // ══════════════════════════════════════════════════════════════
  async function registrarVenta() {
    if (carrito.length === 0)    { toast('No hay productos en la venta', 'error'); return; }
    if (!modalFPSeleccionada)    { toast('Seleccioná una forma de pago', 'error'); return; }
    const nro = nroComprobante ? nroComprobante.value.trim() : '';
    if (!nro)                    { toast('El número de comprobante es requerido', 'error'); return; }

    const subtotalBase = carrito.reduce((a, b) => a + b.importe, 0);
    const descM = (descuentoManual.valor || 0) + (descuentoPago.valor || 0);
    const recM  = (recargoManual.valor   || 0) + (recargoPago.valor   || 0);
    const intPct = interesPagoPercent > 0 ? interesPagoPercent : (interesManualPercent || 0);
    const t = calcularTotalConFP(subtotalBase, descM, recM, intPct, modalFPSeleccionada);

    if (btnConfirmarCobro) {
      btnConfirmarCobro.disabled = true;
      btnConfirmarCobro.innerHTML = '<span class="spinner"></span>Registrando...';
    }

    // Extraer cliente_id del span oculto (puesto cuando se selecciona un cliente)
    const cliIdText = document.getElementById('clienteIdHidden')?.textContent || '';
    const cliId = cliIdText.replace('ID: ', '').trim() || null;

    const venta = {
      fecha:            fechaInput ? fechaInput.value : hoy(),
      tipo:             tipoComprobante ? tipoComprobante.value : 'Ticket',
      nro,
      cliente:          document.getElementById('cliente')?.value    || '- Cliente Ocasional -',
      cliente_id:       cliId ? parseInt(cliId) : null,
      domicilio:        document.getElementById('dom')?.value        || '',
      localidad:        document.getElementById('localidad')?.value  || '',
      telefono:         document.getElementById('telefono')?.value   || '',
      iva:              document.getElementById('iva')?.value        || 'Consumidor Final',
      observaciones:    document.getElementById('obs')?.value        || '',
      subtotal:         +subtotalBase.toFixed(2),
      descuento:        +t.desc.toFixed(2),
      recargo:          +t.rec.toFixed(2),
      interes:          +t.int.toFixed(2),
      total:            t.total,
      usuario:          document.getElementById('userName')?.textContent || 'admin',
      formapago:        modalFPSeleccionada.clave,
      formapago_motivo: modalFPSeleccionada.label,
    };

    try {
      const res = await window.api.ventaRegistrar(venta, carrito);
      if (res && res.ok) {
        cerrarModalCobro();
        ultimaFormaDePago = modalFPSeleccionada.clave;

        const _ventaModal = Object.assign({}, venta, {
          items: carrito.map(it => ({
            descripcion: it.descripcion, cantidad: it.cantidad,
            unitario: it.unitario, importe: it.importe
          }))
        });

        if (window.PostVenta) {
          window.PostVenta.mostrar(res.ventaId, _ventaModal, async () => {
            toast(`✅ ${venta.tipo} Nro.${venta.nro} — $${fmt(t.total)}`, 'success', 3500);
            limpiarEstadoPago();
            await inicializarVenta();
          });
        } else {
          toast(`✅ ${venta.tipo} Nro.${venta.nro} — $${fmt(t.total)}`, 'success', 3500);
          limpiarEstadoPago();
          await inicializarVenta();
        }
      } else {
        toast('❌ Error: ' + (res?.error || 'desconocido'), 'error', 4000);
        if (btnConfirmarCobro) {
          btnConfirmarCobro.disabled = false;
          btnConfirmarCobro.innerHTML = '✅ Confirmar y Registrar';
        }
      }
    } catch (err) {
      console.error('Error registrando venta:', err);
      toast('Error al registrar la venta', 'error');
      if (btnConfirmarCobro) {
        btnConfirmarCobro.disabled = false;
        btnConfirmarCobro.innerHTML = '✅ Confirmar y Registrar';
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // LIMPIAR / NUEVA VENTA
  // ══════════════════════════════════════════════════════════════
  function limpiarEstadoPago() {
    descuentoManual      = { motivo: '', valor: 0 };
    recargoManual        = { motivo: '', valor: 0 };
    descuentoPago        = { valor: 0 };
    recargoPago          = { valor: 0 };
    interesManualPercent = 0;
    interesPagoPercent   = 0;
    ultimaFormaDePago    = '';
    modalFPSeleccionada  = null;
    itemSeleccionado     = -1;
    actualizarBadgeFormaPago('');
    const panel = document.getElementById('panelInline');
    if (panel) panel.remove();
    if (fpImpacto) { fpImpacto.className = 'fp-impacto'; fpImpacto.textContent = ''; }
  }

  async function inicializarVenta() {
    carrito          = [];
    itemSeleccionado = -1;
    renderTabla();
    actualizarTotales();
    if (fechaInput) fechaInput.value = hoy();
    const cli = document.getElementById('cliente');
    const dom = document.getElementById('dom');
    const loc = document.getElementById('localidad');
    const tel = document.getElementById('telefono');
    const iva = document.getElementById('iva');
    const obs = document.getElementById('obs');
    if (cli) cli.value = '- Cliente Ocasional -';
    if (dom) dom.value = '';
    if (loc) loc.value = '';
    if (tel) tel.value = '';
    if (iva) iva.value = 'Consumidor Final';
    if (obs) obs.value = '';
    if (barcode) barcode.focus();

    // Obtener próximo número de comprobante
    try {
      const tipo = tipoComprobante ? tipoComprobante.value : 'Ticket';
      const res  = await window.api.ventaObtenerProximoNumero(tipo);
      if (res && res.nro) {
        if (nroComprobante) nroComprobante.value = String(res.nro).padStart(8, '0');
      } else if (res && res.numero) {
        if (nroComprobante) nroComprobante.value = String(res.numero).padStart(8, '0');
      }
    } catch (e) {
      if (nroComprobante) nroComprobante.value = '00000001';
    }
  }

  if (nuevaVentaBtn) nuevaVentaBtn.addEventListener('click', async () => {
    if (carrito.length > 0 && !confirm('¿Cancelar la venta actual y empezar una nueva?')) return;
    limpiarEstadoPago();
    await inicializarVenta();
  });

  if (formaPagoBtn) formaPagoBtn.addEventListener('click', () => {
    if (carrito.length === 0) { toast('Agregá productos primero', 'error'); return; }
    abrirModalCobro();
  });

  if (verPrecioBtn) verPrecioBtn.addEventListener('click', () => {
    const q = barcode ? barcode.value.trim() : '';
    if (!q) { toast('Escribí un código o nombre para ver el precio', 'info'); return; }
    const prod = productosTodos.find(p =>
      (p.codigo && p.codigo.toLowerCase() === q.toLowerCase()) ||
      (p.descripcion && p.descripcion.toLowerCase().includes(q.toLowerCase()))
    );
    if (prod) toast(`${prod.descripcion}: $ ${fmt(prod.precio)}`, 'info', 4000);
    else toast('Producto no encontrado', 'error');
  });

  // ══════════════════════════════════════════════════════════════
  // TIPO COMPROBANTE → ACTUALIZAR NRO
  // ══════════════════════════════════════════════════════════════
  if (tipoComprobante) tipoComprobante.addEventListener('change', async () => {
    try {
      const res = await window.api.ventaObtenerProximoNumero(tipoComprobante.value);
      if (res && res.nro && nroComprobante)     nroComprobante.value = String(res.nro).padStart(8, '0');
      else if (res && res.numero && nroComprobante) nroComprobante.value = String(res.numero).padStart(8, '0');
    } catch (e) { /* silenciar */ }
  });

  // ══════════════════════════════════════════════════════════════
  // FOOTER — NAVEGACIÓN
  // ══════════════════════════════════════════════════════════════
  if (btnGestionProd)   btnGestionProd.addEventListener('click',   () => window.api.send('open-productos'));
  if (btnGestionCli)    btnGestionCli.addEventListener('click',    () => window.api.send('open-clientes'));
  if (btnGestionProv)   btnGestionProv.addEventListener('click',   () => window.api.send('open-proveedores'));
  if (btnGestionVentas) btnGestionVentas.addEventListener('click', () => window.api.send('open-ventas'));
  if (btnConfig)        btnConfig.addEventListener('click',        () => window.api.send('open-config'));

  const btnContabilidad     = document.getElementById('btnContabilidad');
  const btnImportarProductos= document.getElementById('btnImportarProductos');
  const btnCostos           = document.getElementById('btnCostos');
  if (btnContabilidad)      btnContabilidad.addEventListener('click',      () => window.api.send('open-contabilidad'));
  if (btnImportarProductos) btnImportarProductos.addEventListener('click', () => window.api.send('open-importar-productos'));
  if (btnCostos)            btnCostos.addEventListener('click',            () => window.api.send('open-costos'));

  // Acerca, Migración, Periféricos
  document.getElementById('btnAbout')?.addEventListener('click',      () => window.api.send('open-about'));
  document.getElementById('btnMigracion')?.addEventListener('click',  () => window.api.send('open-migracion'));
  document.getElementById('btnPerifericos')?.addEventListener('click',() => window.api.send('open-perifericos'));
  if (btnGestionCaja)   btnGestionCaja.addEventListener('click',   () => window.api.send('open-caja'));

  // ── Botones nuevos del footer ───────────────────────────────────────────
  const btnProvCuentas = document.getElementById('btnProvCuentas');
  if (btnProvCuentas) btnProvCuentas.addEventListener('click', () => window.api.send('open-proveedores-cuentas'));

  const btnCliCuentas = document.getElementById('btnCliCuentas');

  const btnEstadisticas = document.getElementById('btnEstadisticas');
  if (btnEstadisticas) btnEstadisticas.addEventListener('click', () => window.api.send('open-estadisticas'));

  // ── Menú "Más" (dropdown) — posicionado dinámicamente sobre el botón ──
  const masBtn  = document.getElementById('btnMasMenu');
  const masDrop = document.getElementById('masDropdown');

  masBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = masDrop.classList.contains('open');
    if (isOpen) {
      masDrop.classList.remove('open');
      return;
    }
    // Posicionar sobre el botón
    const rect = masBtn.getBoundingClientRect();
    masDrop.style.right  = (window.innerWidth - rect.right) + 'px';
    masDrop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    masDrop.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!masDrop?.contains(e.target) && e.target !== masBtn) {
      masDrop?.classList.remove('open');
    }
  });

  // Wire up Más dropdown buttons
  const btnGestionPromos = document.getElementById('btnGestionPromos');
  if (btnGestionPromos) btnGestionPromos.addEventListener('click', () => window.api.send('open-promociones'));

  // WhatsApp button
  document.getElementById('btnWhatsApp')?.addEventListener('click', () => {
    window.api.send('open-whatsapp');
  });

  document.getElementById('btnActivarLicencia')?.addEventListener('click',
  () => window.api.send('open-activacion')
);

  // Mobile stats button — muestra QR para ver estadísticas en celular
  document.getElementById('btnMobileStats')?.addEventListener('click', async () => {
    try {
      // Intentar con preload nuevo, fallback si no está disponible
      let url = '';
      if (typeof window.api?.mobileGetUrl === 'function') {
        const res = await window.api.mobileGetUrl();
        if (res?.ok) url = res.url;
      }
      if (!url) {
        // Fallback: mostrar la URL probable con ayuda al usuario
        url = 'http://[IP-DE-LA-PC]:3099';
        const msg = 'Para acceder desde el celular, abrí esta URL en el navegador del celular (misma WiFi):\n\n' +
          '• Buscá la IP de esta PC en: Configuración → Red → o ejecutá "ipconfig" en CMD\n' +
          '• Luego abrí: http://[IP]:3099\n\n' +
          'Tip: Primero reemplazá preload.js en la raíz para obtener la IP automática.';
        alert(msg);
        return;
      }
      // Mostrar modal simple con la URL y QR
      let modal = document.getElementById('mobileQrModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'mobileQrModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = `<div style="background:#fff;border-radius:16px;padding:24px;width:300px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.4)">
          <div style="font-size:20px;margin-bottom:8px">📱 Ver en celular</div>
          <div style="font-size:12px;color:#666;margin-bottom:14px">Misma red WiFi · Sin internet</div>
          <div id="mobileQrImg" style="margin:0 auto 10px;width:180px;height:180px;background:#f5f5f5;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;"></div>
          <div id="mobileQrUrl" style="font-size:12px;font-weight:700;color:#1f8b32;margin-bottom:12px;word-break:break-all;"></div>
          <div style="display:flex;gap:8px;justify-content:center;">
            <button onclick="navigator.clipboard?.writeText(document.getElementById('mobileQrUrl').textContent)" style="padding:7px 14px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;color:#2e7d32">📋 Copiar</button>
            <button onclick="document.getElementById('mobileQrModal').remove()" style="padding:7px 14px;background:#f5f5f5;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:12px">Cerrar</button>
          </div>
        </div>`;
        modal.addEventListener('click', e => { if(e.target===modal) modal.remove(); });
        document.body.appendChild(modal);
      }
      document.getElementById('mobileQrUrl').textContent = url;
      document.getElementById('mobileQrImg').innerHTML =
        `<img src="https://api.qrserver.com/v1/create-qr-code/?size=175x175&data=${encodeURIComponent(url)}" style="width:175px;height:175px" alt="QR">`;
      modal.style.display = 'flex';
    } catch(e) { alert('Error: ' + e.message); }
  });
  masDrop?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => masDrop.classList.remove('open'));
  });

  // ── PDF Preview / Borrador de la venta en curso ──────────────────────
  document.getElementById('btnPdfPreview')?.addEventListener('click', () => {
    const items = [];
    document.querySelectorAll('#itemsVentaBody tr, #itemsVenta tr, #ventaItems tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if(tds.length >= 4 && !tr.querySelector('[colspan]')){
        items.push({
          codigo:      tds[0]?.textContent?.trim() || '',
          descripcion: tds[1]?.textContent?.trim() || '',
          cantidad:    tds[2]?.textContent?.trim() || '1',
          unitario:    tds[3]?.textContent?.trim() || '',
          importe:     tds[4]?.textContent?.trim() || tds[3]?.textContent?.trim() || ''
        });
      }
    });

    const getVal = (ids) => {
      for(const id of ids){ const el = document.getElementById(id); if(el) return el.textContent?.trim() || el.value?.trim() || ''; }
      return '';
    };

    const total    = getVal(['totalDisplay','total-display','spanTotal','totalFinal','displayTotal']);
    const subtotal = getVal(['subtotalDisplay','subtotal-display','spanSubtotal']);
    const descuento= getVal(['descuentoDisplay','discountDisplay']);
    const recargo  = getVal(['recargoDisplay','surchargeDisplay']);
    const cliente  = getVal(['clienteNombreInput','clienteNombre','inputClienteNombre']) || '— Cliente Ocasional —';
    const tipo     = (document.getElementById('tipoComprobante') || document.getElementById('tipoComprobanteSelect'))?.value || 'Ticket';
    const nro      = getVal(['nroComprobante','numeroComprobante','spanNro']) || '00000001';
    const cajero   = document.getElementById('footerUser')?.textContent?.trim() || 'admin';
    const fecha    = new Date().toLocaleDateString('es-AR');

    const filas = items.length > 0 ? items.map((it,i) => `
      <tr style="background:${i%2?'#fafafa':'#fff'}">
        <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-family:monospace;font-size:11px;color:#666">${it.codigo}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0">${it.descripcion}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;text-align:center">${it.cantidad}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;text-align:right;font-family:monospace">${it.unitario}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;text-align:right;font-family:monospace;font-weight:700">${it.importe}</td>
      </tr>`).join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:#aaa;font-size:12px">Sin ítems cargados en la venta actual</td></tr>';

    const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">
    <title>Borrador ${tipo} ${nro}</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0;}
      body{font-family:"Segoe UI",Arial,sans-serif;padding:16mm;font-size:12px;color:#1a1a1a;}
      .header{border-bottom:3px solid #2ea846;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start;}
      .empresa{font-size:20px;font-weight:700;color:#1f8b32;}
      .draft-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-35deg);font-size:72px;font-weight:900;color:rgba(0,0,0,.04);pointer-events:none;white-space:nowrap;}
      .comp{background:#2ea846;color:#fff;padding:6px 14px;border-radius:6px;text-align:center;}
      .comp-tipo{font-size:11px;opacity:.85;}
      .comp-nro{font-size:20px;font-weight:800;margin-top:2px;}
      .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
      .meta-box{background:#f8fbf8;border-radius:5px;padding:8px 10px;font-size:11px;}
      .meta-lbl{color:#888;font-size:10px;text-transform:uppercase;font-weight:700;margin-bottom:2px;}
      table{width:100%;border-collapse:collapse;margin-bottom:12px;}
      th{background:#2ea846;color:#fff;padding:7px 10px;text-align:left;font-size:11px;font-weight:700;}
      .tot{margin-left:auto;max-width:240px;}
      .tr{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;color:#555;}
      .tr.final{border-top:2px solid #2ea846;margin-top:6px;padding-top:8px;font-size:16px;font-weight:800;color:#2ea846;}
      .footer{margin-top:18px;border-top:1px solid #ddd;padding-top:8px;font-size:9px;color:#aaa;text-align:center;}
      @media print{body{padding:8mm;}.draft-watermark{font-size:90px;}}
    </style></head><body>
    <div class="draft-watermark">BORRADOR</div>
    <div class="header">
      <div>
        <div class="empresa">FacilVirtual POS</div>
        <div style="font-size:11px;color:#888;margin-top:2px">Cajero: ${cajero} · Fecha: ${fecha}</div>
      </div>
      <div class="comp">
        <div class="comp-tipo">${tipo.toUpperCase()}</div>
        <div class="comp-nro">Nro. ${nro}</div>
      </div>
    </div>
    <div class="meta">
      <div class="meta-box"><div class="meta-lbl">Cliente</div><div>${cliente}</div></div>
      <div class="meta-box"><div class="meta-lbl">Estado</div><div style="color:#f59e0b;font-weight:700">BORRADOR — Sin confirmar</div></div>
    </div>
    <table>
      <thead><tr><th>Código</th><th>Descripción</th><th style="text-align:center">Cant.</th><th style="text-align:right">Unit.</th><th style="text-align:right">Importe</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <div class="tot">
      ${subtotal?`<div class="tr"><span>Subtotal:</span><span>${subtotal}</span></div>`:''}
      ${descuento && descuento!=='$ 0,00'?`<div class="tr" style="color:#c62828"><span>Descuento:</span><span>${descuento}</span></div>`:''}
      ${recargo && recargo!=='$ 0,00'?`<div class="tr"><span>Recargo:</span><span>${recargo}</span></div>`:''}
      <div class="tr final"><span>TOTAL:</span><span>${total||'$ 0,00'}</span></div>
    </div>
    <div class="footer">FacilVirtual POS · Borrador generado el ${new Date().toLocaleString('es-AR')} · No válido como comprobante fiscal</div>
    </body></html>`;

    const w = window.open('', '_blank', 'width=840,height=700');
    if(w){ w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>w.print(),400); }
  });

  // Seleccionar cliente desde ventana clientes
  // ── MODAL BUSCAR CLIENTE ─────────────────────────────────────────────────────
  let _clientesCache = []; // cache local para búsqueda rápida
  let _ivaModal = 'Consumidor Final';

  async function precargarClientesPOS() {
    try {
      const res = await window.api.clientesListar();
      _clientesCache = Array.isArray(res) ? res : [];
    } catch(e) {}
  }
  precargarClientesPOS();

  window.abrirModalCliente = function() {
    const modal = document.getElementById('modalBuscarCliente');
    if (!modal) return;
    modal.style.display = 'flex';
    setTimeout(() => document.getElementById('buscarClientePOS')?.focus(), 100);
    window.filtrarClientesPOS(); // mostrar todos si ya hay cache
  };

  window.cerrarModalCliente = function() {
    const modal = document.getElementById('modalBuscarCliente');
    if (modal) modal.style.display = 'none';
    const inp = document.getElementById('buscarClientePOS');
    if (inp) inp.value = '';
    document.getElementById('resultadosClientesPOS').innerHTML =
      '<div style="text-align:center;padding:24px;color:#aaa;font-size:13px;">Escribí al menos 2 caracteres para buscar</div>';
  };

  window.filtrarClientesPOS = function() {
    const q = (document.getElementById('buscarClientePOS')?.value || '').trim().toLowerCase();
    const cont = document.getElementById('resultadosClientesPOS');
    if (!cont) return;

    let lista = _clientesCache;
    if (q.length >= 2) {
      lista = lista.filter(c =>
        (c.nombre||'').toLowerCase().includes(q) ||
        (c.cuit||'').replace(/\D/g,'').includes(q.replace(/\D/g,'')) ||
        (c.telefono||'').replace(/\D/g,'').includes(q.replace(/\D/g,''))
      );
    } else if (!q) {
      lista = lista.slice(0, 15); // mostrar primeros 15
    } else {
      cont.innerHTML = '<div style="text-align:center;padding:24px;color:#aaa;font-size:13px;">Escribí al menos 2 caracteres para buscar</div>';
      return;
    }

    if (!lista.length) {
      cont.innerHTML = `<div style="text-align:center;padding:24px;color:#888;font-size:13px;">
        Sin resultados para "<strong>${q}</strong>"<br>
        <button onclick="abrirNuevoClientePOS()" style="margin-top:10px;padding:8px 16px;background:#e8f5e9;border:1.5px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;color:#2e7d32;">
          ➕ Crear cliente nuevo
        </button>
      </div>`;
      return;
    }

    cont.innerHTML = lista.map(c => {
      const iva = c.iva || c.condicion_iva || 'Consumidor Final';
      const ivaShort = iva.includes('Inscripto') ? 'RI' : iva.includes('Mono') ? 'Mono' : iva.includes('Exento') ? 'Exento' : 'CF';
      return `<div class="cli-result-item" onclick="seleccionarClientePOS(${c.id})">
        <div style="width:36px;height:36px;border-radius:50%;background:#1565c0;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0;margin-right:12px;">
          ${(c.nombre||'?')[0].toUpperCase()}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.nombre||'—'}</div>
          <div style="font-size:11px;color:#888;">${c.cuit?'CUIT: '+c.cuit+' · ':''} ${c.telefono||''}</div>
        </div>
        <span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700;flex-shrink:0;">${ivaShort}</span>
      </div>`;
    }).join('');
  };

  window.seleccionarClientePOS = function(id) {
    const c = _clientesCache.find(x => x.id === id || String(x.id) === String(id));
    if (!c) return;
    const f = i => document.getElementById(i);
    if (f('cliente'))   f('cliente').value   = c.nombre || '';
    if (f('dom'))       f('dom').value        = c.domicilio || '';
    if (f('localidad')) f('localidad').value  = c.localidad || '';
    if (f('telefono'))  f('telefono').value   = c.telefono || '';
    const iva = c.iva || c.condicion_iva || 'Consumidor Final';
    if (f('iva'))       f('iva').value        = iva;
    if (f('clienteIdHidden')) f('clienteIdHidden').textContent = 'ID: ' + c.id;
    // Marcar botón de tipo activo
    document.querySelectorAll('.btn-tipo-cli').forEach(b => {
      b.classList.toggle('active', b.dataset.iva === iva);
    });
    cerrarModalCliente();
    if (typeof toast === 'function') toast('Cliente: ' + c.nombre, 'info', 1800);
  };

  window.usarClienteOcasional = function() {
    const ivaModal = document.querySelector('.btn-iva-modal.active')?.dataset?.iva || 'Consumidor Final';
    const f = i => document.getElementById(i);
    if (f('cliente'))   f('cliente').value   = '- Cliente Ocasional -';
    if (f('dom'))       f('dom').value        = '';
    if (f('localidad')) f('localidad').value  = '';
    if (f('telefono'))  f('telefono').value   = '';
    if (f('iva'))       f('iva').value        = ivaModal;
    if (f('clienteIdHidden')) f('clienteIdHidden').textContent = '';
    document.querySelectorAll('.btn-tipo-cli').forEach(b => {
      b.classList.toggle('active', b.dataset.iva === ivaModal);
    });
    cerrarModalCliente();
  };

  window.abrirNuevoClientePOS = function() {
    cerrarModalCliente();
    window.api.send('open-clientes');
  };

  if (cambiarClienteBtn) cambiarClienteBtn.addEventListener('click', () => {
    precargarClientesPOS(); // refrescar cache
    abrirModalCliente();
  });

  // Botón limpiar cliente → Cliente Ocasional
  document.getElementById('limpiarClienteBtn')?.addEventListener('click', () => {
    const f = i => document.getElementById(i);
    if (f('cliente'))   f('cliente').value   = '- Cliente Ocasional -';
    if (f('dom'))       f('dom').value        = '';
    if (f('localidad')) f('localidad').value  = '';
    if (f('telefono'))  f('telefono').value   = '';
    if (f('iva'))       f('iva').value        = 'Consumidor Final';
    if (f('clienteIdHidden')) f('clienteIdHidden').textContent = '';
    document.querySelectorAll('.btn-tipo-cli').forEach(b => b.classList.toggle('active', b.dataset.iva==='Consumidor Final'));
  });

  // Botones tipo IVA rápidos en el formulario de comprobante
  document.querySelectorAll('.btn-tipo-cli').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-tipo-cli').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const iva = btn.dataset.iva;
      const el = document.getElementById('iva');
      if (el) el.value = iva;
      // Si cambia a CF, limpiar nombre si era un cliente registrado
      if (iva === 'Consumidor Final') {
        const cliEl = document.getElementById('cliente');
        if (cliEl && cliEl.value && !cliEl.value.includes('Ocasional') && !document.getElementById('clienteIdHidden')?.textContent) {
          // nombre fue escrito a mano, solo actualizar IVA
        } else if (!document.getElementById('clienteIdHidden')?.textContent) {
          const cliEl2 = document.getElementById('cliente');
          if (cliEl2) cliEl2.value = '- Cliente Ocasional -';
        }
      }
    });
  });

  // Botones IVA dentro del modal
  document.querySelectorAll('.btn-iva-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-iva-modal').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Cerrar modal con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('modalBuscarCliente');
      if (modal && modal.style.display !== 'none') { cerrarModalCliente(); return; }
    }
  });

  // Re-cargar clientes cuando se regresa del módulo clientes
  window.api.on('clientes-actualizado', () => precargarClientesPOS());

  // ══════════════════════════════════════════════════════════════
  // IPC LISTENERS
  // ══════════════════════════════════════════════════════════════
  window.api.on('user-data', function (data) {
    const name = data?.usuario || '';
    const rol  = data?.rol || '';
    const un = document.getElementById('userName');
    if (un) un.textContent = name;
    const fu = document.getElementById('footerUser');
    if (fu) fu.textContent = name + (rol ? ' (' + rol + ')' : '');
    // Nombre comercial de la empresa
    const sn = document.getElementById('storeNombre');
    if (sn && data?.nombreComercial) sn.textContent = data.nombreComercial;
  });

  window.api.on('cliente-cargado', function (cli) {
    if (!cli) return;
    const f = id => document.getElementById(id);
    if (f('cliente'))   f('cliente').value   = cli.nombre    || '';
    if (f('dom'))       f('dom').value        = cli.domicilio || '';
    if (f('localidad')) f('localidad').value  = cli.localidad || '';
    if (f('telefono'))  f('telefono').value   = cli.telefono  || '';
    if (f('iva'))       f('iva').value        = cli.iva       || 'Consumidor Final';
    toast('Cliente: ' + (cli.nombre || ''), 'info', 2000);
  });

  // ══════════════════════════════════════════════════════════════
  // TECLADO
  // ══════════════════════════════════════════════════════════════
  document.addEventListener('keydown', function (e) {
    if (e.key === 'F1') { e.preventDefault(); if (carrito.length > 0) abrirModalCobro(); }
    if (e.key === 'F2') { e.preventDefault(); if (cobrarBtn && !cobrarBtn.disabled) abrirModalCobro(); }
    if (e.key === 'F4') { e.preventDefault(); if (nuevaVentaBtn) nuevaVentaBtn.click(); }
    if (e.key === 'F5') { e.preventDefault(); if (verPrecioBtn)  verPrecioBtn.click(); }
    if (e.key === 'Escape') {
      if (modalCobro && modalCobro.classList.contains('open')) cerrarModalCobro();
      ocultarAC();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // INICIALIZACIÓN
  // ══════════════════════════════════════════════════════════════
  async function init() {
    // Asegurarse que el modal empiece cerrado
    if (modalCobro) modalCobro.classList.remove('open');

    if (fechaInput) fechaInput.value = hoy();

    try {
      productosTodos = await window.api.productosListar() || [];
    } catch (e) {
      console.warn('Error cargando productos:', e);
      productosTodos = [];
    }

    await inicializarVenta();
  }

  init();

})();

// ── Licencia: listeners de eventos desde main process ──────────────────────
if (window.api?.on) {
  window.api.on('licencia-expirada', () => {
    window.api.send('open-activacion');
  });

  window.api.on('licencia-por-vencer', (dias) => {
    const plural = dias !== 1 ? 's' : '';
    const activar = confirm(
      `⚠️ Tu licencia demo vence en ${dias} día${plural}.\n\n` +
      `Contactá a FacilVirtual para obtener tu código de activación.\n\n` +
      `¿Querés abrir la pantalla de activación ahora?`
    );
    if (activar) window.api.send('open-activacion');
  });
}
