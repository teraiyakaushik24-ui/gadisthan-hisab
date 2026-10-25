// =========================================================================
// DUES REGISTER (લેણાં અને દેવાં / બાકી હિસાબ) MODULE - HISAB PRO
// =========================================================================

window.AppDuesModule = {
  currentDuesTab: 'all', // 'all' | 'receivable' | 'payable'
  duesList: [],
  duesSummary: null,

  async openDuesModal() {
    this.openModal('modal-dues');
    const dateInp = document.getElementById('due-input-date');
    if (dateInp) dateInp.value = this.currentDate || new Date().toISOString().split('T')[0];
    const searchInp = document.getElementById('due-search-input');
    if (searchInp) searchInp.value = '';
    const statusSel = document.getElementById('due-filter-status');
    if (statusSel) statusSel.value = 'pending';

    // Attach Gujarati typing to inputs if library available
    if (window.GujaratiTyping) {
      ['due-input-name', 'due-input-desc', 'due-search-input', 'due-settle-input-note'].forEach(id => {
        const el = document.getElementById(id);
        if (el) window.GujaratiTyping.attach(el);
      });
    }

    // Default to 'all' so entries are never hidden
    await this.loadDues();
    this.switchDuesTab('all');
  },

  switchDuesTab(tab) {
    this.currentDuesTab = tab || 'all';

    const tabAll = document.getElementById('tab-due-all');
    const tabRec = document.getElementById('tab-due-receivable');
    const tabPay = document.getElementById('tab-due-payable');

    // Reset pill styles
    [tabAll, tabRec, tabPay].forEach(btn => {
      if (btn) {
        btn.style.background = 'transparent';
        btn.style.color = '#334155';
        btn.style.fontWeight = '700';
      }
    });

    if (this.currentDuesTab === 'receivable') {
      if (tabRec) {
        tabRec.style.background = '#059669';
        tabRec.style.color = '#ffffff';
        tabRec.style.fontWeight = '800';
      }
      const radioRec = document.getElementById('due-type-receivable');
      if (radioRec) { radioRec.checked = true; this.onDueTypeRadioChange(); }
    } else if (this.currentDuesTab === 'payable') {
      if (tabPay) {
        tabPay.style.background = '#dc2626';
        tabPay.style.color = '#ffffff';
        tabPay.style.fontWeight = '800';
      }
      const radioPay = document.getElementById('due-type-payable');
      if (radioPay) { radioPay.checked = true; this.onDueTypeRadioChange(); }
    } else {
      if (tabAll) {
        tabAll.style.background = '#0f172a';
        tabAll.style.color = '#ffffff';
        tabAll.style.fontWeight = '800';
      }
    }

    this.filterDuesList();
  },

  onDueTypeRadioChange() {
    const isPayable = document.getElementById('due-type-payable')?.checked;
    const submitBtn = document.getElementById('btn-due-submit');
    const btnText = document.getElementById('lbl-due-btn-text');
    const nameInput = document.getElementById('due-input-name');
    const descInput = document.getElementById('due-input-desc');
    const amountInput = document.getElementById('due-input-amount');
    const lblRec = document.getElementById('due-type-lbl-receivable');
    const lblPay = document.getElementById('due-type-lbl-payable');
    const lblName = document.getElementById('lbl-due-name');
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (isPayable) {
      if (lblPay) {
        lblPay.style.borderColor = '#dc2626';
        lblPay.style.background = '#fef2f2';
        lblPay.style.color = '#991b1b';
      }
      if (lblRec) {
        lblRec.style.borderColor = '#cbd5e1';
        lblRec.style.background = '#ffffff';
        lblRec.style.color = '#64748b';
      }
      if (submitBtn) {
        submitBtn.style.background = 'linear-gradient(135deg, #dc2626, #ef4444)';
      }
      if (btnText) btnText.textContent = isEn ? 'Add Payable' : 'આપવાના ઉમેરો';
      if (lblName) lblName.textContent = isEn ? 'Vendor / Person Name *:' : 'વેપારી કે વ્યક્તિનું નામ *:';
      if (nameInput) nameInput.placeholder = isEn ? 'Enter vendor or person name...' : 'વેપારી કે વ્યક્તિનું નામ લખો...';
      if (descInput) descInput.placeholder = isEn ? 'Details (e.g. Grocery, Painting work...)' : 'વિગત (દા.ત. કરિયાણું, કલર કામ...)';
      if (amountInput) amountInput.style.color = '#dc2626';
    } else {
      if (lblRec) {
        lblRec.style.borderColor = '#10b981';
        lblRec.style.background = '#ecfdf5';
        lblRec.style.color = '#065f46';
      }
      if (lblPay) {
        lblPay.style.borderColor = '#cbd5e1';
        lblPay.style.background = '#ffffff';
        lblPay.style.color = '#64748b';
      }
      if (submitBtn) {
        submitBtn.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      }
      if (btnText) btnText.textContent = isEn ? 'Add Receivable' : 'લેવાના ઉમેરો';
      if (lblName) lblName.textContent = isEn ? 'Person / Devotee Name *:' : 'વ્યક્તિ કે ભક્તનું નામ *:';
      if (nameInput) nameInput.placeholder = isEn ? 'Enter person or devotee name...' : 'વ્યક્તિ કે ભક્તનું નામ લખો...';
      if (descInput) descInput.placeholder = isEn ? 'Details (e.g. Temple work, Lent money...)' : 'વિગત (દા.ત. મંદિર કામ, ઉછીના આપ્યા...)';
      if (amountInput) amountInput.style.color = '#059669';
    }
  },

  async loadDues() {
    try {
      const res = await fetch('/api/dues');
      const data = await res.json();
      if (!data.success) {
        console.error('Failed to load dues:', data.error);
        return;
      }

      this.duesList = data.dues || [];
      this.duesSummary = data.summary || {
        totalReceivable: 0,
        settledReceivable: 0,
        pendingReceivable: 0,
        countReceivablePending: 0,
        totalPayable: 0,
        settledPayable: 0,
        pendingPayable: 0,
        countPayablePending: 0
      };

      this.updateDuesKPI();
      this.filterDuesList();
    } catch (err) {
      console.error('Error fetching dues:', err);
    }
  },

  updateDuesKPI() {
    const s = this.duesSummary || {};
    const recAmt = s.pendingReceivable || 0;
    const payAmt = s.pendingPayable || 0;
    const net = recAmt - payAmt;

    const elRecAmt = document.getElementById('dues-stat-receivable-amount');
    const elRecCnt = document.getElementById('dues-stat-receivable-count');
    const elPayAmt = document.getElementById('dues-stat-payable-amount');
    const elPayCnt = document.getElementById('dues-stat-payable-count');
    const elNetAmt = document.getElementById('dues-stat-net-amount');
    const elNetDesc = document.getElementById('dues-stat-net-desc');

    const badgeAllTab = document.getElementById('badge-tab-all');
    const badgeRecTab = document.getElementById('badge-tab-receivable');
    const badgePayTab = document.getElementById('badge-tab-payable');
    const headerBadge = document.getElementById('header-dues-badge');

    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (elRecAmt) elRecAmt.textContent = '₹ ' + recAmt.toLocaleString('en-IN');
    if (elRecCnt) elRecCnt.textContent = isEn ? `${s.countReceivablePending || 0} Pending` : `${s.countReceivablePending || 0} બાકી`;

    if (elPayAmt) elPayAmt.textContent = '₹ ' + payAmt.toLocaleString('en-IN');
    if (elPayCnt) elPayCnt.textContent = isEn ? `${s.countPayablePending || 0} Pending` : `${s.countPayablePending || 0} બાકી`;

    if (elNetAmt) {
      elNetAmt.textContent = (net >= 0 ? '₹ ' : '-₹ ') + Math.abs(net).toLocaleString('en-IN');
      elNetAmt.style.color = (net >= 0 ? '#15803d' : '#b91c1c');
    }
    if (elNetDesc) {
      if (net === 0) {
        elNetDesc.textContent = isEn ? 'Balanced' : 'સરભર';
        elNetDesc.style.color = '#2563eb';
      } else {
        elNetDesc.textContent = isEn
          ? (net > 0 ? 'Receivables Higher' : 'Payables Higher')
          : (net > 0 ? 'લેણાં વધુ' : 'દેવાં વધુ');
        elNetDesc.style.color = (net > 0 ? '#16a34a' : '#dc2626');
      }
    }

    const totalCount = (this.duesList || []).length;
    if (badgeAllTab) badgeAllTab.textContent = totalCount;
    if (badgeRecTab) badgeRecTab.textContent = s.countReceivablePending || 0;
    if (badgePayTab) badgePayTab.textContent = s.countPayablePending || 0;

    const totalPendingCount = (s.countReceivablePending || 0) + (s.countPayablePending || 0);
    if (headerBadge) {
      if (totalPendingCount > 0) {
        headerBadge.style.display = 'inline-block';
        headerBadge.textContent = totalPendingCount;
      } else {
        headerBadge.style.display = 'none';
      }
    }
  },

  formatDateDisplay(dateStr) {
    if (!dateStr) return '-';
    try {
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return dateStr;
    } catch (e) {
      return dateStr;
    }
  },

  filterDuesList() {
    const activeTab = this.currentDuesTab || 'all';
    const statusFilter = document.getElementById('due-filter-status')?.value || 'pending';
    const searchVal = (document.getElementById('due-search-input')?.value || '').trim().toLowerCase();

    let items = [...(this.duesList || [])];

    if (activeTab === 'receivable') {
      items = items.filter(d => d.type === 'receivable');
    } else if (activeTab === 'payable') {
      items = items.filter(d => d.type === 'payable');
    }

    if (statusFilter === 'pending') {
      items = items.filter(d => (d.remainingAmount || 0) > 0);
    } else if (statusFilter === 'settled') {
      items = items.filter(d => (d.remainingAmount || 0) === 0);
    }

    if (searchVal) {
      items = items.filter(d =>
        (d.name && d.name.toLowerCase().includes(searchVal)) ||
        (d.description && d.description.toLowerCase().includes(searchVal)) ||
        (d.date && d.date.includes(searchVal))
      );
    }

    this.renderDuesTable(items);
  },

  renderDuesTable(items) {
    const tbody = document.getElementById('dues-table-tbody');
    const tfoot = document.getElementById('dues-table-tfoot');
    if (!tbody) return;
    const isEn = (window.i18n && window.i18n.currentLang === 'en');

    if (!items || items.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align: center; padding: 36px 16px; color: #94a3b8;">
            <div style="font-size: 2rem; margin-bottom: 6px;">🤝</div>
            <div style="font-size: 0.95rem; font-weight: 800; color: #64748b;">${isEn ? 'No entries found' : 'કોઈ એન્ટ્રી મળી નથી'}</div>
            <div style="font-size: 0.78rem; color: #94a3b8; margin-top: 2px;">${isEn ? 'You can add new entries using the form above.' : 'ઉપરના ફોર્મમાંથી નવી એન્ટ્રી ઉમેરી શકો છો.'}</div>
          </td>
        </tr>
      `;
      if (tfoot) tfoot.innerHTML = '';
      const countBadge = document.getElementById('dues-items-count-badge');
      if (countBadge) countBadge.textContent = isEn ? '0 Entries' : '0 એન્ટ્રી';
      const footerTotal = document.getElementById('dues-footer-total');
      if (footerTotal) footerTotal.textContent = '₹ 0';
      return;
    }

    let sumRemaining = 0;

    tbody.innerHTML = items.map((item, idx) => {
      const amt = Number(item.amount) || 0;
      const settled = Number(item.settledAmount) || 0;
      const remaining = Number(item.remainingAmount) || 0;
      const isReceivable = (item.type === 'receivable');

      sumRemaining += remaining;

      let statusBadge = '';
      if (remaining === 0) {
        statusBadge = `<span style="background: #dcfce7; color: #15803d; border: 1px solid #86efac; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">${isEn ? '🟢 Settled' : '🟢 પૂર્ણ'}</span>`;
      } else if (settled > 0) {
        statusBadge = `<span style="background: #fef9c3; color: #854d0e; border: 1px solid #fde047; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">${isEn ? '🟡 Partial' : '🟡 આંશિક'}</span>`;
      } else {
        statusBadge = `<span style="background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 12px; padding: 2px 7px; font-size: 0.74rem; font-weight: 800;">${isEn ? '🔴 Pending' : '🔴 બાકી'}</span>`;
      }

      const formattedDate = this.formatDateDisplay(item.date);
      const typeBadge = isReceivable
        ? `<span style="background: #f0fdf4; color: #166534; border: 1px solid #86efac; border-radius: 6px; padding: 2px 6px; font-size: 0.74rem; font-weight: 800;">${isEn ? '🟢 Receivable' : '🟢 લેવાના'}</span>`
        : `<span style="background: #fef2f2; color: #991b1b; border: 1px solid #fca5a5; border-radius: 6px; padding: 2px 6px; font-size: 0.74rem; font-weight: 800;">${isEn ? '🔴 Payable' : '🔴 આપવાના'}</span>`;

      const settleBtnTitle = isReceivable ? (isEn ? 'Receive' : 'જમા લો') : (isEn ? 'Pay' : 'ચૂકવણી કરો');
      const settleBtnBg = isReceivable ? '#059669' : '#dc2626';

      return `
        <tr style="border-bottom: 1px solid #e2e8f0; transition: background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
          <td style="padding: 10px 8px; text-align: center; font-weight: 700; color: #64748b;">${idx + 1}</td>
          <td style="padding: 10px 10px; font-weight: 700; color: #334155; text-align: center; white-space: nowrap; font-size: 0.88rem;">${formattedDate}</td>
          <td style="padding: 10px 10px; text-align: center; white-space: nowrap;">${typeBadge}</td>
          <td style="padding: 10px 14px; font-weight: 800; color: #0f172a; font-size: 0.96rem;">
            ${item.name || '-'}
          </td>
          <td style="padding: 10px 14px; color: #334155; font-size: 0.88rem;">
            ${item.description || '-'}
          </td>
          <td style="padding: 10px 12px; text-align: right; white-space: nowrap;">
            <div style="font-weight: 900; color: ${remaining > 0 ? (isReceivable ? '#15803d' : '#b91c1c') : '#64748b'}; font-size: 1.05rem; font-family: var(--font-heading);">
              ₹ ${remaining.toLocaleString('en-IN')}
            </div>
            ${settled > 0 ? `
              <div style="font-size: 0.76rem; color: #64748b; margin-top: 2px;">
                ${isEn ? `Total ₹${amt.toLocaleString('en-IN')} | Settle ₹${settled.toLocaleString('en-IN')}` : `કુલ ₹${amt.toLocaleString('en-IN')} | જમા ₹${settled.toLocaleString('en-IN')}`}
              </div>
            ` : (remaining === 0 ? `
              <div style="font-size: 0.76rem; color: #15803d; font-weight: 700; margin-top: 2px;">
                ${isEn ? `Total ₹${amt.toLocaleString('en-IN')} Settled` : `કુલ ₹${amt.toLocaleString('en-IN')} પૂર્ણ`}
              </div>
            ` : '')}
          </td>
          <td style="padding: 10px 8px; text-align: center;">${statusBadge}</td>
          <td style="padding: 10px 10px; text-align: center; white-space: nowrap;">
            <div style="display: flex; gap: 6px; justify-content: center; align-items: center;">
              ${remaining > 0 ? `
                <button type="button" class="btn-primary" onclick="App.openDueSettleModal('${item.id}')"
                  style="background: ${settleBtnBg}; border-color: ${settleBtnBg}; padding: 5px 12px; font-size: 0.82rem; font-weight: 800; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;" title="${settleBtnTitle}">
                  <span>💰</span> <span>${settleBtnTitle}</span>
                </button>
              ` : `
                <button type="button" class="btn-secondary" onclick="App.openDueSettleModal('${item.id}')"
                  style="padding: 5px 12px; font-size: 0.82rem; font-weight: 700; border-radius: 6px; display: inline-flex; align-items: center; gap: 4px;" title="${isEn ? 'View History' : 'ઇતિહાસ જુઓ'}">
                  <span>📜</span> <span>${isEn ? 'History' : 'ઇતિહાસ'}</span>
                </button>
              `}
              <button type="button" class="btn-icon" onclick="App.deleteDue('${item.id}', '${(item.name || '').replace(/'/g, "\\'")}')"
                style="padding: 5px 8px; color: #dc2626; border-radius: 6px; border: 1px solid #fecaca; background: #fff5f5;" title="${isEn ? 'Delete' : 'કાઢી નાખો'}">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    if (tfoot) {
      tfoot.innerHTML = `
        <tr style="background: #f8fafc; font-weight: 900;">
          <td colspan="5" style="padding: 8px 10px; text-align: right; font-size: 0.88rem; color: #1e293b;">
            ${isEn ? `Total Outstanding (${items.length} ${items.length === 1 ? 'entry' : 'entries'}):` : `કુલ બાકી (${items.length} એન્ટ્રીઓ):`}
          </td>
          <td style="padding: 8px 8px; text-align: right; font-size: 0.95rem; color: #0f172a;">
            ₹ ${sumRemaining.toLocaleString('en-IN')}
          </td>
          <td colspan="2"></td>
        </tr>
      `;
    }

    const countBadge = document.getElementById('dues-items-count-badge');
    if (countBadge) countBadge.textContent = isEn
      ? `${items.length} Entr${items.length === 1 ? 'y' : 'ies'}`
      : `${items.length} એન્ટ્રી${items.length === 1 ? '' : 'ઓ'}`;

    const footerTotal = document.getElementById('dues-footer-total');
    if (footerTotal) {
      footerTotal.textContent = '₹ ' + sumRemaining.toLocaleString('en-IN');
      if (this.currentDuesTab === 'receivable') {
        footerTotal.style.color = '#15803d';
      } else if (this.currentDuesTab === 'payable') {
        footerTotal.style.color = '#dc2626';
      } else {
        footerTotal.style.color = 'var(--text-main)';
      }
    }
  },

  async submitAddDue() {
    const date = document.getElementById('due-input-date')?.value;
    const name = (document.getElementById('due-input-name')?.value || '').trim();
    const amount = Number(document.getElementById('due-input-amount')?.value);
    const description = (document.getElementById('due-input-desc')?.value || '').trim();
    const type = document.querySelector('input[name="due-type-choice"]:checked')?.value || (this.currentDuesTab === 'payable' ? 'payable' : 'receivable');

    if (!name) {
      this.showToast('⚠️ કૃપા કરીને નામ લખો', 'warning');
      document.getElementById('due-input-name')?.focus();
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ કૃપા કરીને માન્ય રકમ લખો', 'warning');
      document.getElementById('due-input-amount')?.focus();
      return;
    }
    if (!description) {
      this.showToast('⚠️ કૃપા કરીને વિગત લખો', 'warning');
      document.getElementById('due-input-desc')?.focus();
      return;
    }

    try {
      const res = await fetch('/api/dues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, date, name, amount, description })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      // Reset form fields
      document.getElementById('due-input-name').value = '';
      document.getElementById('due-input-amount').value = '';
      document.getElementById('due-input-desc').value = '';

      this.showToast(`✅ ${type === 'receivable' ? 'લેવાના બાકી' : 'આપવાના બાકી'} સફળતાપૂર્વક ઉમેરાયા!`, 'success');
      await this.loadDues();
      if (this.currentDuesTab !== 'all' && this.currentDuesTab !== type) {
        this.switchDuesTab(type);
      }
    } catch (err) {
      console.error('Error submitting due:', err);
      this.showToast('❌ સર્વર કનેક્શનમાં ક્ષતિ થઈ', 'danger');
    }
  },

  openDueSettleModal(dueId) {
    const due = (this.duesList || []).find(d => d.id === dueId);
    if (!due) return;

    const isReceivable = (due.type === 'receivable');

    document.getElementById('due-settle-id').value = due.id;
    document.getElementById('due-settle-input-date').value = this.currentDate || new Date().toISOString().split('T')[0];
    document.getElementById('due-settle-input-amount').value = due.remainingAmount > 0 ? due.remainingAmount : '';
    document.getElementById('due-settle-input-amount').max = due.remainingAmount;
    document.getElementById('due-settle-input-note').value = '';

    const titleEl = document.getElementById('due-settle-title');
    const subEl = document.getElementById('due-settle-subtitle');
    const totalEl = document.getElementById('due-settle-card-total');
    const settledEl = document.getElementById('due-settle-card-settled');
    const remEl = document.getElementById('due-settle-card-remaining');
    const submitBtn = document.getElementById('btn-due-settle-submit');
    const labelAmt = document.getElementById('due-settle-label-amount');

    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (titleEl) titleEl.textContent = isEn
      ? (isReceivable ? '💰 Record Receipt' : '💸 Record Payment')
      : (isReceivable ? '💰 રકમ જમા નોંધો' : '💸 ચુકવણી નોંધો');
    if (subEl) subEl.textContent = `${due.name} (${due.description || ''})`;
    if (totalEl) totalEl.textContent = '₹ ' + (due.amount || 0).toLocaleString('en-IN');
    if (settledEl) settledEl.textContent = '₹ ' + (due.settledAmount || 0).toLocaleString('en-IN');
    if (remEl) remEl.textContent = '₹ ' + (due.remainingAmount || 0).toLocaleString('en-IN');
    if (labelAmt) labelAmt.textContent = isEn
      ? (isReceivable ? 'Amount Received (₹) *' : 'Amount Paid (₹) *')
      : (isReceivable ? 'જમા રકમ (₹) *' : 'ચૂકવેલ રકમ (₹) *');

    if (submitBtn) {
      submitBtn.style.background = isReceivable ? '#059669' : '#dc2626';
      submitBtn.style.borderColor = isReceivable ? '#059669' : '#dc2626';
      submitBtn.innerHTML = isEn
        ? (isReceivable ? '<span>✅</span> <span>Record Receipt</span>' : '<span>✅</span> <span>Save Payment</span>')
        : (isReceivable ? '<span>✅</span> <span>રકમ જમા કરો</span>' : '<span>✅</span> <span>ચુકવણી સેવ કરો</span>');
    }

    // Render history
    this.renderDueSettlementHistory(due);

    this.openModal('modal-due-settle');
  },

  renderDueSettlementHistory(due) {
    const listEl = document.getElementById('due-settle-history-list');
    if (!listEl) return;

    const hist = due.history || [];
    const isEn = window.i18n && window.i18n.currentLang === 'en';
    if (hist.length === 0) {
      listEl.innerHTML = `<div style="text-align: center; color: #94a3b8; font-size: 0.82rem; padding: 10px;">${isEn ? 'No prior settlements recorded.' : 'અગાઉ કોઈ જમા/ચુકવણી થયેલ નથી.'}</div>`;
      return;
    }

    listEl.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
        <thead>
          <tr style="border-bottom: 1px solid #cbd5e1; color: #64748b; text-align: left;">
            <th style="padding: 4px 6px;">${isEn ? 'Date' : 'તારીખ'}</th>
            <th style="padding: 4px 6px;">${isEn ? 'Amount' : 'રકમ'}</th>
            <th style="padding: 4px 6px;">${isEn ? 'Note' : 'નોંધ'}</th>
            <th style="padding: 4px 6px; text-align: center;">${isEn ? 'Del' : 'રદ'}</th>
          </tr>
        </thead>
        <tbody>
          ${hist.map(h => `
            <tr style="border-bottom: 1px solid #f1f5f9;">
              <td style="padding: 5px 6px; font-weight: 600;">${this.formatDateDisplay(h.date)}</td>
              <td style="padding: 5px 6px; font-weight: 800; color: #16a34a;">₹ ${(Number(h.amount) || 0).toLocaleString('en-IN')}</td>
              <td style="padding: 5px 6px; color: #475569;">${h.note || '-'}</td>
              <td style="padding: 5px 6px; text-align: center;">
                <button type="button" class="btn-icon" onclick="App.deleteDueSettlement('${due.id}', '${h.id}')"
                  style="color: #dc2626; padding: 2px 6px; font-size: 0.75rem;" title="${isEn ? 'Cancel this installment' : 'આ હપ્તો રદ કરો'}">✕</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  },

  async submitDueSettlement() {
    const dueId = document.getElementById('due-settle-id')?.value;
    const date = document.getElementById('due-settle-input-date')?.value;
    const amount = Number(document.getElementById('due-settle-input-amount')?.value);
    const note = (document.getElementById('due-settle-input-note')?.value || '').trim();

    if (!dueId) return;
    if (isNaN(amount) || amount <= 0) {
      this.showToast('⚠️ કૃપા કરીને માન્ય રકમ લખો', 'warning');
      return;
    }

    try {
      const res = await fetch(`/api/dues/${dueId}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, amount, note })
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ રકમ સફળતાપૂર્વક સાચવાઈ ગઈ!', 'success');
      this.closeModal('modal-due-settle');
      await this.loadDues();
    } catch (err) {
      console.error('Error submitting settlement:', err);
      this.showToast('❌ સર્વર કનેક્શનમાં ક્ષતિ થઈ', 'danger');
    }
  },

  async deleteDueSettlement(dueId, settleId) {
    if (!confirm('શું તમે આ ચુકવણી/જમા હપ્તો રદ કરવા માંગો છો? બાકી રકમ ફરી પૂર્વવત થઈ જશે.')) return;

    try {
      const res = await fetch(`/api/dues/${dueId}/settle/${settleId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ હપ્તો રદ કરવામાં આવ્યો.', 'success');
      await this.loadDues();
      const updatedDue = (this.duesList || []).find(d => d.id === dueId);
      if (updatedDue) {
        this.openDueSettleModal(dueId);
      } else {
        this.closeModal('modal-due-settle');
      }
    } catch (err) {
      console.error('Error deleting settlement:', err);
    }
  },

  async deleteDue(dueId, dueName) {
    if (!confirm(`શું તમે "${dueName || 'આ રેકોર્ડ'}" કાઢી નાખવા માંગો છો?`)) return;

    try {
      const res = await fetch(`/api/dues/${dueId}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) {
        this.showToast('❌ ' + (data.error || 'ભૂલ આવી'), 'danger');
        return;
      }

      this.showToast('✅ રેકોર્ડ સફળતાપૂર્વક કાઢી નાખવામાં આવ્યો.', 'success');
      await this.loadDues();
    } catch (err) {
      console.error('Error deleting due:', err);
    }
  },

  printDuesReport() {
    const activeTab = this.currentDuesTab || 'all';
    const statusFilter = document.getElementById('due-filter-status')?.value || 'pending';
    const searchVal = (document.getElementById('due-search-input')?.value || '').trim().toLowerCase();

    let items = [...(this.duesList || [])];
    if (activeTab === 'receivable') items = items.filter(d => d.type === 'receivable');
    else if (activeTab === 'payable') items = items.filter(d => d.type === 'payable');

    if (statusFilter === 'pending') {
      items = items.filter(d => (d.remainingAmount || 0) > 0);
    } else if (statusFilter === 'settled') {
      items = items.filter(d => (d.remainingAmount || 0) === 0);
    }
    if (searchVal) {
      items = items.filter(d =>
        (d.name && d.name.toLowerCase().includes(searchVal)) ||
        (d.description && d.description.toLowerCase().includes(searchVal)) ||
        (d.date && d.date.includes(searchVal))
      );
    }

    const title = activeTab === 'receivable'
      ? 'લેવાના બાકી પૈસાનો હિસાબ રિપોર્ટ'
      : (activeTab === 'payable' ? 'ચૂકવવાના બાકી હિસાબ (દેવાં) રિપોર્ટ' : 'લેણાં અને દેવાં રજિસ્ટર (બાકી હિસાબ) રિપોર્ટ');
    const subtitle = `તારીખ: ${new Date().toLocaleDateString('en-GB')} | સ્થિતિ: ${statusFilter === 'pending' ? 'માત્ર બાકી' : (statusFilter === 'settled' ? 'પૂર્ણ થયેલ' : 'તમામ')}`;

    let totalAmt = 0;
    let totalSettled = 0;
    let totalRemaining = 0;

    items.forEach(d => {
      totalAmt += (Number(d.amount) || 0);
      totalSettled += (Number(d.settledAmount) || 0);
      totalRemaining += (Number(d.remainingAmount) || 0);
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #1e293b; }
          .header { text-align: center; border-bottom: 2px solid #0f172a; padding-bottom: 10px; margin-bottom: 16px; }
          .title { font-size: 20px; font-weight: bold; margin-bottom: 4px; color: ${activeTab === 'receivable' ? '#166534' : (activeTab === 'payable' ? '#991b1b' : '#1e3a8a')}; }
          .subtitle { font-size: 13px; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
          th { background: #f1f5f9; border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
          td { border: 1px solid #cbd5e1; padding: 7px 8px; }
          .amt { text-align: right; font-weight: bold; }
          .total-row { background: #e2e8f0; font-weight: bold; }
          .footer { margin-top: 30px; display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; }
          @media print {
            body { margin: 10mm; }
            button { display: none; }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">${title}</div>
          <div class="subtitle">${subtitle}</div>
        </div>

        <table>
          <thead>
            <tr>
              <th style="width: 30px; text-align: center;">#</th>
              <th style="width: 80px;">તારીખ</th>
              <th style="width: 80px; text-align: center;">પ્રકાર</th>
              <th>નામ</th>
              <th>વિગત / કારણ</th>
              <th class="amt" style="width: 90px;">કુલ રકમ</th>
              <th class="amt" style="width: 90px;">જમા/ચૂકવેલ</th>
              <th class="amt" style="width: 90px;">બાકી રકમ</th>
              <th style="width: 60px; text-align: center;">સ્થિતિ</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((d, i) => `
              <tr>
                <td style="text-align: center;">${i + 1}</td>
                <td>${this.formatDateDisplay(d.date)}</td>
                <td style="text-align: center; font-weight: bold; color: ${d.type === 'receivable' ? '#166534' : '#991b1b'};">${d.type === 'receivable' ? 'લેવાના' : 'આપવાના'}</td>
                <td style="font-weight: bold;">${d.name || '-'}</td>
                <td>${d.description || '-'}</td>
                <td class="amt">₹ ${(Number(d.amount) || 0).toLocaleString('en-IN')}</td>
                <td class="amt" style="color: #16a34a;">₹ ${(Number(d.settledAmount) || 0).toLocaleString('en-IN')}</td>
                <td class="amt" style="color: ${d.type === 'receivable' ? '#166534' : '#b91c1c'};">₹ ${(Number(d.remainingAmount) || 0).toLocaleString('en-IN')}</td>
                <td style="text-align: center;">${d.remainingAmount === 0 ? 'પૂર્ણ' : (d.settledAmount > 0 ? 'આંશિક' : 'બાકી')}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr class="total-row">
              <td colspan="5" style="text-align: right;">કુલ સરવાળો (${items.length} એન્ટ્રીઓ):</td>
              <td class="amt">₹ ${totalAmt.toLocaleString('en-IN')}</td>
              <td class="amt" style="color: #16a34a;">₹ ${totalSettled.toLocaleString('en-IN')}</td>
              <td class="amt">₹ ${totalRemaining.toLocaleString('en-IN')}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <div class="footer">
          <div>તૈયાર કરનાર: ______________</div>
          <div>તપાસનાર: ______________</div>
          <div>મંજૂર કરનાર: ______________</div>
        </div>
      </body>
      </html>
    `;

    this.openPrintWindow(html);
  },

  shareDuesWhatsApp() {
    const activeTab = this.currentDuesTab || 'all';
    let items = [...(this.duesList || [])].filter(d => (d.remainingAmount || 0) > 0);
    if (activeTab === 'receivable') items = items.filter(d => d.type === 'receivable');
    else if (activeTab === 'payable') items = items.filter(d => d.type === 'payable');

    if (items.length === 0) {
      this.showToast('કોઈ બાકી રકમની એન્ટ્રી નથી', 'info');
      return;
    }

    let text = `*${activeTab === 'receivable' ? '🟢 લેવાના બાકી પૈસાની યાદી' : (activeTab === 'payable' ? '🔴 ચૂકવવાના બાકી પૈસાની યાદી' : '⚖️ લેણાં અને દેવાં બાકી યાદી')}*\n`;
    text += `તારીખ: ${new Date().toLocaleDateString('en-GB')}\n`;
    text += `----------------------------------------\n`;

    let totalDue = 0;
    items.forEach((d, idx) => {
      const rem = Number(d.remainingAmount) || 0;
      totalDue += rem;
      const typeTag = d.type === 'receivable' ? '[લેવાના]' : '[આપવાના]';
      text += `${idx + 1}. *${d.name}* ${typeTag}: ₹ ${rem.toLocaleString('en-IN')}\n   વિગત: ${d.description || '-'}\n`;
    });

    text += `----------------------------------------\n`;
    text += `*કુલ બાકી રકમ: ₹ ${totalDue.toLocaleString('en-IN')}* (${items.length} એન્ટ્રીઓ)`;

    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }
};

if (typeof window !== 'undefined' && window.App) {
  Object.assign(window.App, window.AppDuesModule);
}
