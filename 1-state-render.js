const STORAGE_KEY = 'wealthlocal_portfolio_v16';
    const VAULT_CIPHER_KEY = 'wealthlocal_aes_vault_v16';
    // Automatically purge legacy v6/v7 4-digit PIN & portfolio keys so v16 starts 100% fresh at ₹0.00
    try {
      ['wealthlocal_portfolio_v6', 'wealthlocal_security_v6', 'wealthlocal_active_session_v7', 'wealthlocal_aes_vault_v6'].forEach(k => localStorage.removeItem(k));
    } catch (e) {}

    const EMPTY_STATE = {
      lastSync: null,
      gmailWebhookUrl: '',
      indices: {
        nifty: { price: 24148.20, change: -19.45, pct: -0.08, date: 'Live', spark: [24280, 24210, 24310, 24195, 24240, 24167.65, 24148.20] },
        sensex: { price: 79486.32, change: -63.80, pct: -0.08, date: 'Live', spark: [79920, 79710, 80040, 79650, 79810, 79550.12, 79486.32] }
      },
      mutualFunds: [],
      nps: [],
      epf: {
        balance: 0,
        invested: 0,
        monthlyContribution: 0,
        rate: 0.0825
      },
      ppf: {
        balance: 0,
        invested: 0,
        monthlyDeposit: 0,
        rate: 0.071
      }
    };

    function sanitizeNpsState(st) {
      if (!st) return st;
      if (Array.isArray(st.mutualFunds)) {
        st.mutualFunds = st.mutualFunds.filter(f => {
          if (!f) return false;
          const isDummyFolio = /^Mutual Fund \(Folio/i.test(String(f.name || '').trim());
          if (isDummyFolio && Number(f.invested || 0) <= 0) return false;
          return true;
        });
      }
      if (!Array.isArray(st.nps)) return st;
      st.nps.forEach(n => {
        if (!Array.isArray(n.installments)) n.installments = [];
        // 1. Strip any bogus ₹0 summary lines , while keeping valid `Opening Balance (B/F)` rows and negative CRA billing deductions
        n.installments = n.installments.filter(inst => {
          const amt = Number(inst.amount || 0);
          const u = Number(inst.units || 0);
          const desc = String(inst.desc || '');
          if (Math.abs(u) < 0.0001) return false;
          if (/closing\s*balance|balance\s*c\/f/i.test(desc)) return false;
          if (!inst.isOpeningBalance && /opening\s*balance|balance\s*b\/f/i.test(desc) && Math.abs(amt) < 1) return false;
          if (!inst.isOpeningBalance && Math.abs(amt) < 0.01 && u > 0) return false;
          if (!inst.isOpeningBalance && Math.abs(u) > 500 && Math.abs(amt) < 100) return false;
          return true;
        });

        // 2. Fix Scheme ID mapping for Aditya Birla Tier I schemes
        if (/ADITYA\s*BIRLA/i.test(n.name)) {
          if (/SCHEME\s*[\-:]?\s*E\b/i.test(n.name)) n.schemeId = 'SM010001';
          else if (/SCHEME\s*[\-:]?\s*C\b/i.test(n.name)) n.schemeId = 'SM010002';
          else if (/SCHEME\s*[\-:]?\s*G\b/i.test(n.name)) n.schemeId = 'SM010003';
        }

        // 3. Pure Dynamic Opening-Balance Deduplication (Zero Preloaded Data):
        // If the user uploaded BOTH an earlier FY CSV (e.g. FY 2025-26 with transactions before `2026-04-01`) AND a current FY CSV (which starts with a `2026-04-01 Opening Balance` row),
        // remove the `Opening Balance` row for that FY so prior-year units are never double-counted!
        const openRows = n.installments.filter(x => x.isOpeningBalance || /opening\s*balance/i.test(String(x.desc || '')));
        openRows.forEach(op => {
          const hasEarlierActualTx = n.installments.some(x => !x.isOpeningBalance && !/opening\s*balance/i.test(String(x.desc || '')) && String(x.date || '') < String(op.date || '') && Number(x.units) > 0);
          if (hasEarlierActualTx) {
            n.installments = n.installments.filter(x => x !== op);
          }
        });

        // 4. Deduplicate any Gmail-estimated rows (`nps_gmail_`) that overlap with the CSV statement period or CSV transactions
        const stmtDate = String(n.statementDate || '').trim();
        const csvInsts = n.installments.filter(x => !String(x.id || '').startsWith('nps_gmail_') && !x.isEstimatedBilling);
        if (csvInsts.length > 0 || stmtDate) {
          n.installments = n.installments.filter(inst => {
            if (!String(inst.id || '').startsWith('nps_gmail_')) return true;
            if (stmtDate && String(inst.date || '') <= stmtDate) return false;
            const instMs = new Date(inst.date).getTime();
            const dupCsv = csvInsts.some(c => Number(c.units) > 0 && Math.abs(instMs - new Date(c.date).getTime()) <= 7 * 86400000);
            return !dupCsv;
          });
        }

        // 5. Purge any synthetic `isEstimatedBilling` (`nps_autobill_`) rows so ONLY authentic rows imported from the user's CSV reports exist!
        n.installments = n.installments.filter(x => !x.isEstimatedBilling && !String(x.id || '').startsWith('nps_autobill_'));
        n.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));

        // 6. Reconcile exact units & invested capital strictly from the imported CSV report:
        // `statementUnits` (from CSV Section 1 Scheme-wise Summary) is the authoritative balance as of `statementDate`.
        const allTxNetUnits = +n.installments.reduce((acc, x) => acc + Number(x.units || 0), 0).toFixed(4);
        const grossTxInv = +n.installments.filter(x => Number(x.amount) > 0 && !x.isOpeningBalance).reduce((acc, x) => acc + Number(x.amount || 0), 0).toFixed(2);
        const baseUnits = Number(n.statementUnits || 0);
        const baseInv = Number(n.statementInvested || 0);

        if (baseUnits > 0) {
          const postInst = stmtDate
            ? n.installments.filter(x => String(x.date || '') > stmtDate && String(x.id || '').startsWith('nps_gmail_'))
            : [];
          const postUnits = postInst.reduce((acc, x) => acc + Number(x.units || 0), 0);
          const postInv = postInst.filter(x => Number(x.amount) > 0).reduce((acc, x) => acc + Number(x.amount || 0), 0);
          n.units = +(baseUnits + postUnits).toFixed(4);
          if (baseInv > 0) {
            n.invested = +(baseInv + postInv).toFixed(2);
          } else if (grossTxInv > 0) {
            n.invested = grossTxInv;
          }
        } else if (n.installments.length > 0) {
          n.units = allTxNetUnits;
          if (baseInv > 0) n.invested = baseInv;
          else if (grossTxInv > 0) n.invested = grossTxInv;
        }
      });
      if (st.ppf && Array.isArray(st.ppf.installments) && st.ppf.installments.length > 0) {
        // 1. Purge bogus PDF header/footer date matches (where running balance < credit or credit < 100 on non-interest rows)
        st.ppf.installments = st.ppf.installments.filter(tx => {
          const c = Number(tx.credit || 0);
          const b = Number(tx.balance || 0);
          if (c < 100 && (!b || b < 100)) return false;
          if (!String(tx.txId || '').startsWith('MAN_') && b < c) return false;
          return true;
        });
        // 2. Relabel March 31 (`-03-31`) interest rows that were mislabeled as Deposit when PDF wrapped "PPF interest Paid"
        st.ppf.installments.forEach(tx => {
          if (String(tx.date || '').endsWith('-03-31') && !/subscription|omnichannel/i.test(String(tx.desc || ''))) {
            tx.kind = 'interest';
            tx.desc = 'PPF Interest Paid';
          }
        });
        const totalDep = st.ppf.installments.filter(x => x.kind !== 'interest').reduce((sum, x) => sum + Number(x.credit || 0) - Number(x.debit || 0), 0);
        const totalInt = st.ppf.installments.filter(x => x.kind === 'interest').reduce((sum, x) => sum + Number(x.credit || 0), 0);
        st.ppf.invested = totalDep;
        st.ppf.totalInterestEarned = totalInt;
        st.ppf.balance = totalDep + totalInt;
      }
      if (!st.indices) st.indices = {};
      if (!st.indices.nifty || !st.indices.nifty.price || st.indices.nifty.price <= 0) {
        st.indices.nifty = { price: 24148.20, change: -19.45, pct: -0.08, date: 'Live', spark: [24280, 24210, 24310, 24195, 24240, 24167.65, 24148.20] };
      }
      if (!st.indices.sensex || !st.indices.sensex.price || st.indices.sensex.price <= 0) {
        st.indices.sensex = { price: 79486.32, change: -63.80, pct: -0.08, date: 'Live', spark: [79920, 79710, 80040, 79650, 79810, 79550.12, 79486.32] };
      }
      return st;
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          // If STORAGE_KEY holds an encrypted wrapper (`_encryptedVault: true`), return EMPTY_STATE in RAM until `decryptStoredVaultIntoState()` runs!
          if (parsed && parsed._encryptedVault && parsed.cipher) {
            return JSON.parse(JSON.stringify(EMPTY_STATE));
          }
          return sanitizeNpsState(parsed);
        }
      } catch (e) {}
      return JSON.parse(JSON.stringify(EMPTY_STATE));
    }

    function saveState() {
      try {
        if (typeof syncLocalEncryptedMirror === 'function' && typeof secConfig !== 'undefined' && secConfig && secConfig.adminPinHash) {
          syncLocalEncryptedMirror();
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
      } catch (e) {}
      if (typeof syncServerBundle === 'function') syncServerBundle();
    }

    const LOG_KEY = 'wealthlocal_debug_logs';
    function getDebugLogs() {
      try {
        return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      } catch (e) { return []; }
    }
    function addDebugLog(msg) {
      const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
      try {
        const logs = getDebugLogs();
        logs.push(entry);
        if (logs.length > 80) logs.splice(0, logs.length - 80);
        localStorage.setItem(LOG_KEY, JSON.stringify(logs));
      } catch (e) {}
      const liveEl = document.getElementById('excelDebugLog');
      if (liveEl) {
        liveEl.classList.remove('hidden');
        liveEl.textContent = getDebugLogs().slice(-6).join('\n');
      }
      return entry;
    }
    window.addEventListener('error', (ev) => {
      addDebugLog(`JS Error: ${ev.message} (line ${ev.lineno})`);
    });

    let state = loadState();
    let activeTab = 'overview';
    let allocationChartInstance = null;
    let privacyMasked = false;
    let mfViewMode = 'returns'; // 'returns' | 'day' | 'invested'
    let activeRetiralSubtab = 'epf'; // 'epf' | 'ppf'

    function formatINR(num) {
      if (privacyMasked) return '₹••••••';
      const sign = num < 0 ? '-' : '';
      const absVal = Math.abs(Math.round(num));
      return sign + '₹' + absVal.toLocaleString('en-IN');
    }

    function formatSignedINR(num) {
      if (privacyMasked) return '₹••••••';
      const prefix = num > 0 ? '+' : '';
      return prefix + formatINR(num);
    }

    function formatINRPrecise(num) {
      if (privacyMasked) return '₹••••••';
      const n = Number(num || 0);
      const sign = n < 0 ? '-' : '';
      return sign + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatSignedINRPrecise(num) {
      if (privacyMasked) return '₹••••••';
      const n = Number(num || 0);
      const prefix = n > 0 ? '+' : '';
      return prefix + formatINRPrecise(n);
    }

    function showToast(msg) {
      const el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.add('hidden'), 3200);
    }

    function showAppLoader(title, subtitle, pct) {
      const ov = document.getElementById('appLoadingOverlay');
      if (!ov) return;
      document.getElementById('loadingTitle').textContent = title || 'Working...';
      document.getElementById('loadingSubtitle').textContent = subtitle || 'Please wait';
      document.getElementById('loadingProgressBar').style.width = `${Math.min(100, Math.max(10, Number(pct || 35)))}%`;
      ov.classList.remove('hidden');
    }

    function hideAppLoader() {
      const ov = document.getElementById('appLoadingOverlay');
      if (ov) ov.classList.add('hidden');
    }

    function renderSparklineBars(containerId, values, isPositive) {
      const el = document.getElementById(containerId);
      if (!el) return;
      const arr = Array.isArray(values) && values.length >= 2 ? values : [40, 55, 48, 62, 58, 75, 90];
      const minV = Math.min(...arr);
      const maxV = Math.max(...arr);
      const span = Math.max(0.0001, maxV - minV);
      const barColor = isPositive ? 'bg-emerald-400/80' : 'bg-rose-400/80';
      el.innerHTML = arr.slice(-7).map(v => {
        const hPct = Math.round(25 + ((v - minV) / span) * 75);
        return `<span class="w-1 rounded-t ${barColor}" style="height:${hPct}%"></span>`;
      }).join('');
    }

    async function syncLiveMarketIndices() {
      if (!state.indices) state.indices = {};
      // 1. Immediate derivation from synced UTI Nifty 50 Index Fund (120716) in portfolio if available
      const utiFund = (state.mutualFunds || []).find(f => String(f.schemeCode) === '120716' || /nifty\s*50/i.test(f.name));
      if (utiFund && utiFund.currentNav > 0 && utiFund.prevNav > 0) {
        const pct = ((utiFund.currentNav - utiFund.prevNav) / utiFund.prevNav) * 100;
        const nLevel = +(utiFund.currentNav * 136.486).toFixed(2);
        const nPrev = +(utiFund.prevNav * 136.486).toFixed(2);
        state.indices.nifty = {
          price: nLevel,
          change: +(nLevel - nPrev).toFixed(2),
          pct: +pct.toFixed(2),
          date: state.lastSync || 'Live',
          spark: (state.indices.nifty && state.indices.nifty.spark) || [24280, 24210, 24310, 24195, 24240, nPrev, nLevel]
        };
      }
      // 2. Fetch NIFTY 50 7-day series from MFapi.in
      try {
        const niftyRes = await fetch('https://api.mfapi.in/mf/120716');
        if (niftyRes.ok) {
          const nj = await niftyRes.json();
          if (nj && Array.isArray(nj.data) && nj.data.length >= 2) {
            const latestNav = parseFloat(nj.data[0].nav);
            const prevNav = parseFloat(nj.data[1].nav);
            if (latestNav > 0 && prevNav > 0) {
              const pct = ((latestNav - prevNav) / prevNav) * 100;
              const niftyLevel = +(latestNav * 136.486).toFixed(2);
              const prevLevel = +(prevNav * 136.486).toFixed(2);
              const spark = nj.data.slice(0, 7).reverse().map(d => parseFloat(d.nav) || latestNav);
              state.indices.nifty = {
                price: niftyLevel,
                change: +(niftyLevel - prevLevel).toFixed(2),
                pct: +pct.toFixed(2),
                date: nj.data[0].date || 'Live',
                spark
              };
            }
          }
        }
      } catch (e) {}

      // 3. Fetch SENSEX 7-day series from MFapi.in
      try {
        const sensexRes = await fetch('https://api.mfapi.in/mf/119065');
        if (sensexRes.ok) {
          const sj = await sensexRes.json();
          if (sj && Array.isArray(sj.data) && sj.data.length >= 2) {
            const latestNav = parseFloat(sj.data[0].nav);
            const prevNav = parseFloat(sj.data[1].nav);
            if (latestNav > 0 && prevNav > 0) {
              const pct = ((latestNav - prevNav) / prevNav) * 100;
              const ratio = latestNav > 200 ? 104.25 : 1120.5;
              const sensexLevel = +(latestNav * ratio).toFixed(2);
              const prevLevel = +(prevNav * ratio).toFixed(2);
              const spark = sj.data.slice(0, 7).reverse().map(d => parseFloat(d.nav) || latestNav);
              state.indices.sensex = {
                price: sensexLevel,
                change: +(sensexLevel - prevLevel).toFixed(2),
                pct: +pct.toFixed(2),
                date: sj.data[0].date || 'Live',
                spark
              };
            }
          }
        }
      } catch (e) {}

      saveState();
      renderAll();
    }

    function computeTotals() {
      let mfVal = 0, mfInv = 0, mfDay = 0;
      state.mutualFunds.forEach(f => {
        const val = f.units * f.currentNav;
        mfVal += val;
        mfInv += f.invested;
        mfDay += f.units * (f.currentNav - f.prevNav);
      });

      let npsVal = 0, npsInv = 0, npsDay = 0;
      state.nps.forEach(n => {
        const val = n.units * n.currentNav;
        npsVal += val;
        npsInv += n.invested;
        npsDay += n.units * (n.currentNav - n.prevNav);
      });

      const epfVal = state.epf.balance;
      const epfInv = state.epf.invested;
      const ppfVal = state.ppf.balance;
      const ppfInv = state.ppf.invested;

      const totalValue = mfVal + npsVal + epfVal + ppfVal;
      const totalInvested = mfInv + npsInv + epfInv + ppfInv;
      const totalGain = totalValue - totalInvested;
      const dayGain = mfDay + npsDay;

      return {
        mfVal, mfInv, mfDay,
        npsVal, npsInv, npsDay,
        epfVal, epfInv,
        ppfVal, ppfInv,
        totalValue, totalInvested, totalGain, dayGain
      };
    }

    function selectRetiralSubtab(sub) {
      activeRetiralSubtab = sub;
      const isEpf = sub === 'epf';
      const epfPanel = document.getElementById('epfSubPanel');
      const ppfPanel = document.getElementById('ppfSubPanel');
      const btnEpf = document.getElementById('btnSelectEpfSubtab');
      const btnPpf = document.getElementById('btnSelectPpfSubtab');
      if (epfPanel && ppfPanel) {
        epfPanel.classList.toggle('hidden', !isEpf);
        ppfPanel.classList.toggle('hidden', isEpf);
      }
      if (btnEpf && btnPpf) {
        btnEpf.className = isEpf
          ? 'py-2 rounded-xl bg-sky-500/20 text-sky-300 border border-sky-500/30 transition'
          : 'py-2 rounded-xl text-slate-400 hover:text-white transition';
        btnPpf.className = !isEpf
          ? 'py-2 rounded-xl bg-violet-500/20 text-violet-300 border border-violet-500/30 transition'
          : 'py-2 rounded-xl text-slate-400 hover:text-white transition';
      }
    }

    function closeAllAccordionsAndDrawers() {
      document.querySelectorAll('details').forEach(d => d.removeAttribute('open'));
      ['heroExpandedDrawer', 'overviewChartDrawer', 'overviewMarketDrawer'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      const heroLbl = document.getElementById('heroExpandLabel');
      if (heroLbl) heroLbl.textContent = 'Tap for details ▾';
      const chartChev = document.getElementById('chartDrawerChevron');
      if (chartChev) chartChev.textContent = '▾';
      const mktChev = document.getElementById('marketDrawerChevron');
      if (mktChev) mktChev.textContent = '▾';
    }

    function openProfileSidebar() {
      pushNavState('sidebar_profile');
      renderProfileTab();
      document.querySelectorAll('#tab-guide details').forEach(d => d.removeAttribute('open'));
      const sb = document.getElementById('profileSidebarBackdrop');
      if (sb) sb.classList.remove('hidden');
    }

    function closeProfileSidebar() {
      const sb = document.getElementById('profileSidebarBackdrop');
      if (sb) sb.classList.add('hidden');
    }

    let mfDetailChartInstance = null;
    let npsDetailChartInstance = null;
    let mfSubTabMode = 'dashboard'; // 'dashboard' | 'sips'

    function computeHoldingXirrPct(installments, currentVal, fallbackInvested) {
      const nowMs = Date.now();
      const valid = (Array.isArray(installments) ? installments : []).filter(x => Number(x.amount) > 0 && x.date);
      if (valid.length === 0 || currentVal <= 0) return null;
      // Compute dollar-weighted average holding period in years
      let weightedDays = 0;
      let totalAmt = 0;
      valid.forEach(inst => {
        const dtMs = new Date(inst.date).getTime();
        if (!isNaN(dtMs) && dtMs < nowMs) {
          const days = Math.max(1, (nowMs - dtMs) / (1000 * 60 * 60 * 24));
          const amt = Number(inst.amount || 0);
          weightedDays += days * amt;
          totalAmt += amt;
        }
      });
      if (totalAmt <= 0 || weightedDays <= 0) return null;
      const avgYears = (weightedDays / totalAmt) / 365.25;
      const baseInv = fallbackInvested > 0 ? fallbackInvested : totalAmt;
      const absReturnRatio = currentVal / baseInv;
      if (avgYears < 0.08) {
        return +((absReturnRatio - 1) * 100).toFixed(2);
      }
      const xirr = (Math.pow(absReturnRatio, 1 / Math.max(0.25, avgYears)) - 1) * 100;
      if (!isFinite(xirr) || Math.abs(xirr) > 250) return +((absReturnRatio - 1) * 100).toFixed(2);
      return +xirr.toFixed(2);
    }

    function backToMfDashboard() {
      const dash = document.getElementById('mfDashboardSubView');
      const det = document.getElementById('mfDetailScreenView');
      if (dash) dash.classList.remove('hidden');
      if (det) det.classList.add('hidden');
      const hdr = document.getElementById('topHeaderScreenTitle');
      if (hdr) hdr.textContent = 'Mutual Funds';
    }

    function backToNpsDashboard() {
      const dash = document.getElementById('npsDashboardSubView');
      const det = document.getElementById('npsDetailScreenView');
      if (dash) dash.classList.remove('hidden');
      if (det) det.classList.add('hidden');
      const hdr = document.getElementById('topHeaderScreenTitle');
      if (hdr) hdr.textContent = 'NPS Vault';
    }

    let isHandlingPopState = false;
    function pushNavState(viewTag) {
      if (isHandlingPopState) return;
      try {
        if (!history.state || history.state.wlView !== viewTag) {
          history.pushState({ wlView: viewTag }, '');
        }
      } catch (e) {}
    }

    function triggerHaptic(ms) {
      try {
        if (navigator.vibrate) navigator.vibrate(ms || 8);
      } catch (e) {}
    }

    function switchTab(tab, fromBackGesture) {
      triggerHaptic(6);
      if (tab === 'guide') {
        openProfileSidebar();
        return;
      }
      closeProfileSidebar();
      backToMfDashboard();
      backToNpsDashboard();
      activeTab = tab;
      if (!fromBackGesture && tab !== 'overview') {
        pushNavState('tab_' + tab);
      }
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      const targetEl = document.getElementById('tab-' + tab);
      if (targetEl) targetEl.classList.remove('hidden');
      const titles = {
        overview: 'Portfolio Tracker',
        mf: 'Mutual Funds',
        nps: 'NPS Vault',
        retiral: 'EPF & PPF'
      };
      const hdr = document.getElementById('topHeaderScreenTitle');
      if (hdr && titles[tab]) hdr.textContent = titles[tab];

      document.querySelectorAll('.nav-tab').forEach(btn => {
        const isCurrent = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('text-emerald-400', isCurrent);
        btn.classList.toggle('text-slate-400', !isCurrent);
      });

      if (tab === 'retiral' && subOption) {
        selectRetiralSubtab(subOption);
      }
      const scroller = document.getElementById('appMainScroll');
      if (scroller) scroller.scrollTop = 0;
    }

    let isAppUnlocked = false;

    function renderAll() {
      if (!isAppUnlocked) return;
      const t = computeTotals();
      const isPortfolioEmpty = state.mutualFunds.length === 0 && state.nps.length === 0 && state.epf.balance === 0 && state.ppf.balance === 0;
      document.getElementById('emptyStartBanner').classList.toggle('hidden', !isPortfolioEmpty);

      document.getElementById('heroNetWorth').textContent = formatINRPrecise(t.totalValue);
      document.getElementById('heroInvested').textContent = formatINRPrecise(t.totalInvested);

      const gainPct = t.totalInvested > 0 ? (t.totalGain / t.totalInvested) * 100 : 0;
      const gainStr = `${formatSignedINRPrecise(t.totalGain)} (${gainPct >= 0 ? '+' : ''}${gainPct.toFixed(2)}%)`;

      const totalGainInlineEl = document.getElementById('heroTotalGainInline');
      const invInlineEl = document.getElementById('heroInvestedInline');
      if (invInlineEl) invInlineEl.textContent = formatINR(t.totalInvested);
      if (totalGainInlineEl) {
        totalGainInlineEl.textContent = gainStr;
        totalGainInlineEl.className = `text-sm font-extrabold mt-0.5 ${t.totalGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
      }

      // Render Hero 4-Segment Stacked Bar & Legend
      const stackedBar = document.getElementById('heroStackedBar');
      const allocLegend = document.getElementById('heroAllocLegend');
      const eqDebtLbl = document.getElementById('heroEquityDebtSplitLabel');
      if (stackedBar && allocLegend) {
        const tot = Math.max(1, t.totalValue);
        const pMf = ((t.mfVal / tot) * 100).toFixed(1);
        const pNps = ((t.npsVal / tot) * 100).toFixed(1);
        const pEpf = ((t.epfVal / tot) * 100).toFixed(1);
        const pPpf = ((t.ppfVal / tot) * 100).toFixed(1);
        stackedBar.innerHTML = `
          <div class="h-full bg-emerald-500 transition-all duration-500" style="width:${pMf}%"></div>
          <div class="h-full bg-amber-400 transition-all duration-500" style="width:${pNps}%"></div>
          <div class="h-full bg-sky-400 transition-all duration-500" style="width:${pEpf}%"></div>
          <div class="h-full bg-violet-400 transition-all duration-500" style="width:${pPpf}%"></div>
        `;
        allocLegend.innerHTML = `
          <span class="inline-flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></i>MF ${pMf}%</span>
          <span class="inline-flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-amber-400 inline-block"></i>NPS ${pNps}%</span>
          <span class="inline-flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-sky-400 inline-block"></i>EPF ${pEpf}%</span>
          <span class="inline-flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-violet-400 inline-block"></i>PPF ${pPpf}%</span>
        `;
        if (eqDebtLbl) {
          const mktPct = (((t.mfVal + t.npsVal) / tot) * 100).toFixed(0);
          const sovPct = (((t.epfVal + t.ppfVal) / tot) * 100).toFixed(0);
          eqDebtLbl.innerHTML = `Market-Linked <strong class="text-emerald-300">${mktPct}%</strong> • Sovereign Debt <strong class="text-sky-300">${sovPct}%</strong>`;
        }
      }

      const totalGainEl = document.getElementById('heroTotalGain');
      totalGainEl.textContent = gainStr;
      totalGainEl.className = `text-sm font-bold mt-0.5 ${t.totalGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;

      const prevDayTotal = t.totalValue - t.dayGain;
      const dayPct = prevDayTotal > 0 ? (t.dayGain / prevDayTotal) * 100 : 0;
      const dayStr = `${formatSignedINR(t.dayGain)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)`;

      const dayGainEl = document.getElementById('heroDayGain');
      dayGainEl.textContent = dayStr;
      dayGainEl.className = `text-sm font-bold mt-0.5 ${t.dayGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;

      const dayPillEl = document.getElementById('heroDayPill');
      if (dayPillEl) {
        dayPillEl.textContent = `1D: ${dayStr}`;
        dayPillEl.className = `text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-surface-800 border border-slate-700/80 ${t.dayGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
      }

      const epsEl = document.getElementById('heroEpsNote');
      if (epsEl) epsEl.textContent = formatINR(state.epf.pensionBalance || 0);

      document.getElementById('lastSyncBadge').textContent = state.lastSync ? `Synced ${state.lastSync}` : 'On-Device Vault';

      // Live Market Indices
      const n = state.indices.nifty || { price: 0, change: 0, pct: 0 };
      document.getElementById('niftyPrice').textContent = n.price > 0 ? n.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Syncing...';
      const nc = document.getElementById('niftyChange');
      const nDate = document.getElementById('niftyDateBadge');
      if (nDate) nDate.textContent = n.date || 'Live';
      if (n.price > 0) {
        nc.textContent = `${n.change >= 0 ? '+' : ''}${Number(n.change).toFixed(2)} (${n.pct >= 0 ? '+' : ''}${Number(n.pct).toFixed(2)}%)`;
        nc.className = `text-[11px] font-bold ${n.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
        renderSparklineBars('niftySparkline', n.spark, n.change >= 0);
      } else {
        nc.textContent = 'Tap Sync to fetch';
        nc.className = 'text-[11px] font-semibold text-slate-400';
      }

      const s = state.indices.sensex || { price: 0, change: 0, pct: 0 };
      document.getElementById('sensexPrice').textContent = s.price > 0 ? s.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Syncing...';
      const sc = document.getElementById('sensexChange');
      const sDate = document.getElementById('sensexDateBadge');
      if (sDate) sDate.textContent = s.date || 'Live';
      if (s.price > 0) {
        sc.textContent = `${s.change >= 0 ? '+' : ''}${Number(s.change).toFixed(2)} (${s.pct >= 0 ? '+' : ''}${Number(s.pct).toFixed(2)}%)`;
        sc.className = `text-[11px] font-bold ${s.change >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
        renderSparklineBars('sensexSparkline', s.spark, s.change >= 0);
      } else {
        sc.textContent = 'Tap Sync to fetch';
        sc.className = 'text-[11px] font-semibold text-slate-400';
      }

      renderOverviewAssetCards(t);
      renderCategoryBreakdown(t);
      renderAllocationChart(t);
      renderMutualFunds();
      renderNps();
      renderRetiral();
    }

    function renderOverviewAssetCards(t) {
      const container = document.getElementById('overviewAssetCards');
      if (!container) return;
      const mfGain = t.mfVal - t.mfInv;
      const mfPct = t.mfInv > 0 ? ((mfGain / t.mfInv) * 100).toFixed(2) : '0.00';
      const npsGain = t.npsVal - t.npsInv;
      const npsPct = t.npsInv > 0 ? ((npsGain / t.npsInv) * 100).toFixed(2) : '0.00';
      const epfGain = t.epfVal - t.epfInv;
      const ppfGain = t.ppfVal - t.ppfInv;
      const tot = Math.max(1, t.totalValue);

      const cards = [
        {
          tab: 'mf', sub: '',
          title: 'Mutual Funds',
          val: formatINR(t.mfVal),
          inv: formatINR(t.mfInv),
          gainStr: formatSignedINR(mfGain),
          gainPos: mfGain >= 0,
          badge: `${mfGain >= 0 ? '+' : ''}${mfPct}%`,
          badgeColor: mfGain >= 0 ? 'text-emerald-400 bg-emerald-500/15 border border-emerald-500/30' : 'text-rose-400 bg-rose-500/15 border border-rose-500/30',
          weightPct: ((t.mfVal / tot) * 100).toFixed(1),
          meta: `${state.mutualFunds.length} Funds`,
          dot: 'bg-emerald-500',
          barColor: 'bg-emerald-500',
          borderGlow: 'hover:border-emerald-500/40'
        },
        {
          tab: 'nps', sub: '',
          title: 'NPS Tier I',
          val: formatINR(t.npsVal),
          inv: formatINR(t.npsInv),
          gainStr: formatSignedINR(npsGain),
          gainPos: npsGain >= 0,
          badge: `${npsGain >= 0 ? '+' : ''}${npsPct}%`,
          badgeColor: npsGain >= 0 ? 'text-amber-300 bg-amber-500/15 border border-amber-500/30' : 'text-rose-400 bg-rose-500/15 border border-rose-500/30',
          weightPct: ((t.npsVal / tot) * 100).toFixed(1),
          meta: `${state.nps.length} Schemes`,
          dot: 'bg-amber-400',
          barColor: 'bg-amber-400',
          borderGlow: 'hover:border-amber-500/40'
        },
        {
          tab: 'retiral', sub: 'epf',
          title: 'EPF Corpus',
          val: formatINR(t.epfVal),
          inv: formatINR(t.epfInv),
          gainStr: formatSignedINR(epfGain),
          gainPos: true,
          badge: `${(Number(state.epf.rate || 0.0825) * 100).toFixed(2)}% p.a.`,
          badgeColor: 'text-sky-300 bg-sky-500/15 border border-sky-500/30',
          weightPct: ((t.epfVal / tot) * 100).toFixed(1),
          meta: 'Excl. EPS',
          dot: 'bg-sky-400',
          barColor: 'bg-sky-400',
          borderGlow: 'hover:border-sky-500/40'
        },
        {
          tab: 'retiral', sub: 'ppf',
          title: 'PPF Account',
          val: formatINR(t.ppfVal),
          inv: formatINR(t.ppfInv),
          gainStr: formatSignedINR(ppfGain),
          gainPos: true,
          badge: `${(Number(state.ppf.rate || 0.071) * 100).toFixed(2)}% p.a.`,
          badgeColor: 'text-violet-300 bg-violet-500/15 border border-violet-500/30',
          weightPct: ((t.ppfVal / tot) * 100).toFixed(1),
          meta: 'EEE Tax-Free',
          dot: 'bg-violet-400',
          barColor: 'bg-violet-400',
          borderGlow: 'hover:border-violet-500/40'
        }
      ];

      container.innerHTML = cards.map(c => `
        <button type="button" data-drill-tab="${c.tab}" data-drill-sub="${c.sub}" class="text-left rounded-2xl bg-gradient-to-br from-surface-900 to-[#111927] ${c.borderGlow} active:scale-[0.98] border border-slate-800/90 p-3.5 flex flex-col justify-between gap-2.5 shadow-md transition">
          <div class="flex items-center justify-between w-full gap-1">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="w-2 h-2 shrink-0 rounded-full ${c.dot}"></span>
              <span class="text-xs font-extrabold text-slate-100 truncate">${c.title}</span>
            </div>
            <span class="shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded-md ${c.badgeColor}">${c.badge}</span>
          </div>
          <div>
            <p class="text-lg font-extrabold text-white tracking-tight">${c.val}</p>
            <div class="flex items-center justify-between text-[10px] mt-1">
              <span class="text-slate-400">Inv: ${c.inv}</span>
              <span class="font-bold ${c.gainPos ? 'text-emerald-400' : 'text-rose-400'}">${c.gainStr}</span>
            </div>
          </div>
          <div class="space-y-1 pt-1 border-t border-slate-800/70 w-full">
            <div class="w-full h-1 rounded-full bg-surface-950 overflow-hidden">
              <div class="h-full ${c.barColor}" style="width: ${Math.min(100, Math.max(4, Number(c.weightPct)))}%"></div>
            </div>
            <div class="flex items-center justify-between text-[10px] text-slate-400">
              <span>${c.meta} • ${c.weightPct}% share</span>
              <span class="text-slate-300 font-bold">Open ›</span>
            </div>
          </div>
        </button>
      `).join('');

      // Also populate the new Wealth Milestone & Insights Card on the Home Screen
      const insightsEl = document.getElementById('overviewInsightsCard');
      if (insightsEl) {
        const milestones = [500000, 1000000, 1500000, 2000000, 2500000, 5000000, 10000000, 25000000];
        const nextGoal = milestones.find(m => m > t.totalValue) || 50000000;
        const goalLabel = nextGoal >= 10000000 ? `₹${(nextGoal / 10000000).toFixed(1)} Cr` : `₹${(nextGoal / 100000).toFixed(0)} Lakh`;
        const progressPct = Math.min(100, ((t.totalValue / nextGoal) * 100)).toFixed(1);
        const remaining = Math.max(0, nextGoal - t.totalValue);

        // Find top performing mutual fund by % gain
        let topFundName = 'None yet';
        let topFundPct = 0;
        let topFundGain = 0;
        state.mutualFunds.forEach(f => {
          const v = f.units * f.currentNav;
          const g = v - f.invested;
          const p = f.invested > 0 ? (g / f.invested) * 100 : 0;
          if (p >= topFundPct && f.invested > 0) {
            topFundPct = p;
            topFundGain = g;
            topFundName = f.name.replace(/\s*Direct\s*Growth/i, '');
          }
        });

        // Estimate annual tax-free passive interest from EPF + PPF
        const annualInterestEst = (t.epfVal * Number(state.epf.rate || 0.0825)) + (t.ppfVal * Number(state.ppf.rate || 0.071));

        insightsEl.innerHTML = `
          <div class="flex items-center justify-between">
            <div>
              <span class="text-[10px] font-bold uppercase tracking-widest text-indigo-300">Wealth Milestone Tracker</span>
              <h3 class="text-sm font-extrabold text-white mt-0.5">${progressPct}% to ${goalLabel} Target</h3>
            </div>
            <span class="text-xs font-extrabold px-2.5 py-1 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">${formatINR(remaining)} to go</span>
          </div>
          <div class="w-full h-2.5 rounded-full bg-surface-950 p-0.5 overflow-hidden border border-slate-800">
            <div class="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-sky-400 transition-all duration-500" style="width: ${progressPct}%"></div>
          </div>
          <div class="grid grid-cols-2 gap-2.5 pt-1 text-xs">
            <div class="rounded-2xl bg-surface-950/70 border border-slate-800/80 p-3">
              <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">🏆 Top Performer</p>
              <p class="font-bold text-white truncate mt-1">${topFundName}</p>
              <p class="text-[11px] font-bold text-emerald-400 mt-0.5">${formatSignedINR(topFundGain)} (+${topFundPct.toFixed(2)}%)</p>
            </div>
            <div class="rounded-2xl bg-surface-950/70 border border-slate-800/80 p-3">
              <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">🛡️ Annual EPF+PPF Yield</p>
              <p class="font-bold text-sky-300 mt-1">~${formatINR(annualInterestEst)} / yr</p>
              <p class="text-[11px] text-slate-400 mt-0.5">~${formatINR(annualInterestEst / 12)} / month tax-free</p>
            </div>
          </div>
        `;
      }
    }

    function renderCategoryBreakdown(t) {
      const items = [
        { label: 'Mutual Funds', val: t.mfVal, color: 'bg-emerald-500' },
        { label: 'NPS', val: t.npsVal, color: 'bg-amber-400' },
        { label: 'EPF', val: t.epfVal, color: 'bg-sky-400' },
        { label: 'PPF', val: t.ppfVal, color: 'bg-violet-400' }
      ];
      const container = document.getElementById('categoryBreakdownList');
      container.innerHTML = items.map(item => {
        const pct = t.totalValue > 0 ? ((item.val / t.totalValue) * 100).toFixed(1) : '0.0';
        return `
          <div class="flex items-center justify-between text-xs">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full ${item.color}"></span>
              <span class="text-slate-300 font-medium">${item.label}</span>
            </div>
            <div class="text-right">
              <span class="font-bold text-white">${formatINR(item.val)}</span>
              <span class="text-slate-500 ml-1.5">(${pct}%)</span>
            </div>
          </div>
        `;
      }).join('');
    }

    function renderAllocationChart(t) {
      const ctx = document.getElementById('allocationChart').getContext('2d');
      const dataValues = [t.mfVal, t.npsVal, t.epfVal, t.ppfVal];
      const hasData = dataValues.some(v => v > 0);
      const chartData = hasData ? dataValues : [1];
      const chartColors = hasData ? ['#10b981', '#fbbf24', '#38bdf8', '#a78bfa'] : ['#1e293b'];
      const chartLabels = hasData ? ['Mutual Funds', 'NPS', 'EPF', 'PPF'] : ['No Holdings Yet'];

      if (allocationChartInstance) allocationChartInstance.destroy();
      allocationChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: chartLabels,
          datasets: [{
            data: chartData,
            backgroundColor: chartColors,
            borderWidth: 0,
            hoverOffset: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: {
              enabled: hasData,
              callbacks: {
                label: (ctx) => ` ${ctx.label}: ${formatINR(ctx.raw)}`
              }
            }
          }
        }
      });
    }

    function renderMutualFunds() {
      const container = document.getElementById('mfList');
      const summaryEl = document.getElementById('mfSummaryCard');
      const listHeaderEl = document.getElementById('mfListHeader');
      if (state.mutualFunds.length === 0) {
        summaryEl.classList.add('hidden');
        if (listHeaderEl) listHeaderEl.classList.add('hidden');
        container.innerHTML = `<div class="py-10 text-center text-xs text-slate-400">No mutual funds added yet. Tap <strong>Import external funds</strong> or <strong>+ Add Fund</strong>.</div>`;
        return;
      }
      let mfCur = 0, mfInv = 0, mfDay = 0;
      const allInsts = [];
      state.mutualFunds.forEach(f => {
        mfCur += f.units * f.currentNav;
        mfInv += f.invested;
        mfDay += f.units * (f.currentNav - f.prevNav);
        if (Array.isArray(f.installments)) allInsts.push(...f.installments);
      });
      const mfGain = mfCur - mfInv;
      const mfRetPct = mfInv > 0 ? (mfGain / mfInv) * 100 : 0;
      const mfPrev = mfCur - mfDay;
      const mfDayPct = mfPrev > 0 ? (mfDay / mfPrev) * 100 : 0;
      const xirrVal = computeHoldingXirrPct(allInsts, mfCur, mfInv);

      summaryEl.classList.remove('hidden');
      if (listHeaderEl) listHeaderEl.classList.remove('hidden');

      // Exact Groww Summary Card layout from screenshot 1000214956.png
      summaryEl.innerHTML = `
        <div class="flex items-start justify-between gap-3 pb-3.5 border-b border-dashed border-slate-800">
          <div>
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">HOLDINGS (${state.mutualFunds.length})</p>
            <p class="text-2xl font-extrabold text-white mt-1 tracking-tight">${formatINR(mfCur)}</p>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" data-mf-card-eye="1" title="Hide / Show Balances" class="w-8 h-8 rounded-full bg-surface-800 hover:bg-surface-700 border border-slate-700/80 flex items-center justify-center text-slate-300 transition active:scale-95">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            </button>
          </div>
        </div>
        <div class="space-y-2.5 pt-3.5 text-xs">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">1D returns</span>
            <span class="font-bold ${mfDay >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(mfDay)} (${Math.abs(mfDayPct).toFixed(2)}%)</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Total returns</span>
            <span class="font-bold ${mfGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINR(mfGain)} (${mfRetPct.toFixed(2)}%)</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Invested</span>
            <span class="font-bold text-white">${formatINR(mfInv)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">XIRR <span class="text-[10px] text-slate-500">▾</span></span>
            <span class="font-bold text-white">${xirrVal !== null ? xirrVal.toFixed(2) + '%' : (mfRetPct.toFixed(2) + '%')}</span>
          </div>
        </div>
      `;

      if (mfSubTabMode === 'sips') {
        document.getElementById('mfHoldingsCountLabel').textContent = 'Active SIPs & Installments';
        const sipRows = [];
        state.mutualFunds.forEach(f => {
          const insts = Array.isArray(f.installments) ? f.installments : [];
          const latestAmt = insts.length > 0 ? insts[0].amount : f.monthlySip;
          if (insts.length > 0 || f.monthlySip > 0) {
            sipRows.push(`
              <div data-open-mf="${f.id}" class="py-3.5 px-1 flex items-center justify-between gap-3 cursor-pointer hover:bg-surface-900/50 transition">
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold text-white truncate">${f.name}</h3>
                  <p class="text-[11px] text-slate-400 mt-0.5">${insts.length} Installment(s) paid • Latest: ${insts[0] ? insts[0].date : 'Active'}</p>
                </div>
                <div class="text-right shrink-0">
                  <p class="text-sm font-bold text-white">${formatINRPrecise(latestAmt || 0)}</p>
                  <p class="text-[11px] text-emerald-400 mt-0.5">Tap to view ›</p>
                </div>
              </div>
            `);
          }
        });
        container.innerHTML = sipRows.join('') || '<div class="py-6 text-center text-xs text-slate-400">No SIP installments recorded yet.</div>';
        return;
      }

      document.getElementById('mfHoldingsCountLabel').textContent = `Holdings (${state.mutualFunds.length})`;

      // Exact Groww Flat Divider Rows from screenshot 1000214956.png
      container.innerHTML = state.mutualFunds.map(f => {
        const val = f.units * f.currentNav;
        const gain = val - f.invested;
        const pct = f.invested > 0 ? (gain / f.invested) * 100 : 0;
        const dayChange = f.units * (f.currentNav - f.prevNav);
        const prevVal = val - dayChange;
        const dayPct = prevVal > 0 ? (dayChange / prevVal) * 100 : 0;
        const instCount = Array.isArray(f.installments) ? f.installments.length : 0;
        const isSipFund = instCount > 1 || (f.monthlySip && f.monthlySip > 0);

        let rightTop = '';
        let rightBottom = '';
        if (mfViewMode === 'day') {
          rightTop = `<p class="text-sm font-bold text-white">${formatSignedINRPrecise(dayChange)}</p>`;
          rightBottom = `<p class="text-xs font-medium mt-0.5 ${dayChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}">(${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)</p>`;
        } else if (mfViewMode === 'invested') {
          rightTop = `<p class="text-sm font-bold text-white">${formatINRPrecise(val)}</p>`;
          rightBottom = `<p class="text-xs text-slate-400 mt-0.5">Inv: ${formatINR(f.invested)}</p>`;
        } else {
          rightTop = `<p class="text-sm font-bold text-white">${formatINRPrecise(val)}</p>`;
          rightBottom = `<p class="text-xs font-medium mt-0.5 ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(gain)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</p>`;
        }

        return `
          <div data-open-mf="${f.id}" class="py-4 px-1 flex items-center justify-between gap-3 cursor-pointer hover:bg-surface-900/40 active:bg-surface-900/70 transition">
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold text-slate-100 leading-snug">${f.name}</h3>
              <p class="text-[11px] text-slate-500 mt-1">${isSipFund ? 'SIP' : f.category}</p>
            </div>
            <div class="text-right shrink-0">
              ${rightTop}
              ${rightBottom}
            </div>
          </div>
        `;
      }).join('');
    }

    function renderNps() {
      const container = document.getElementById('npsList');
      const summaryEl = document.getElementById('npsSummaryCard');
      if (state.nps.length === 0) {
        summaryEl.classList.add('hidden');
        container.innerHTML = `<div class="col-span-full rounded-2xl bg-surface-900 border border-slate-800 p-6 text-center text-xs text-slate-400">No NPS schemes added yet. Tap <strong>Import CSV/PDF</strong> or <strong>+ Add Scheme</strong> above.</div>`;
        return;
      }
      let npsCur = 0, npsInv = 0, npsDay = 0;
      let valE = 0, valC = 0, valG = 0;
      state.nps.forEach(n => {
        const v = n.units * n.currentNav;
        npsCur += v;
        npsInv += n.invested;
        npsDay += n.units * (n.currentNav - n.prevNav);
        if (/SCHEME\s*[\-:]?\s*E\b/i.test(n.name)) valE += v;
        else if (/SCHEME\s*[\-:]?\s*C\b/i.test(n.name)) valC += v;
        else valG += v;
      });
      const npsGain = npsCur - npsInv;
      const npsRetPct = npsInv > 0 ? (npsGain / npsInv) * 100 : 0;
      const npsPrev = npsCur - npsDay;
      const npsDayPct = npsPrev > 0 ? (npsDay / npsPrev) * 100 : 0;
      const pctE = npsCur > 0 ? ((valE / npsCur) * 100).toFixed(1) : 0;
      const pctC = npsCur > 0 ? ((valC / npsCur) * 100).toFixed(1) : 0;
      const pctG = npsCur > 0 ? ((valG / npsCur) * 100).toFixed(1) : 0;

      summaryEl.classList.remove('hidden');
      summaryEl.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div>
            <span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded bg-amber-500/15 text-amber-300">LC75 Aggressive Auto Choice</span>
            <p class="text-3xl font-extrabold text-white mt-2 tracking-tight">${formatINRPrecise(npsCur)}</p>
            <p class="text-[11px] text-slate-400 mt-0.5">Total Pension Corpus</p>
          </div>
          <div class="text-right">
            <span class="text-xs font-extrabold px-2.5 py-1 rounded-xl ${npsGain >= 0 ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'}">${npsRetPct >= 0 ? '+' : ''}${npsRetPct.toFixed(2)}%</span>
            <p class="text-xs font-bold mt-2 ${npsGain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(npsGain)}</p>
            <p class="text-[10px] text-slate-400">Net Gain</p>
          </div>
        </div>

        <!-- Stacked E / C / G Allocation Progress Bar -->
        <div class="mt-4 pt-3.5 border-t border-slate-800/80 space-y-2">
          <div class="flex items-center justify-between text-[11px]">
            <span class="text-slate-400 font-medium">Asset Class Mix (E / C / G)</span>
            <span class="text-slate-300 font-semibold">Invested: ${formatINRPrecise(npsInv)} • 1D: <strong class="${npsDay >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(npsDay)} (${npsDayPct >= 0 ? '+' : ''}${npsDayPct.toFixed(2)}%)</strong></span>
          </div>
          <div class="w-full h-2.5 rounded-full bg-surface-800 overflow-hidden flex">
            <div class="h-full bg-emerald-400" style="width:${pctE}%" title="Equity E: ${pctE}%"></div>
            <div class="h-full bg-sky-400" style="width:${pctC}%" title="Corporate Bonds C: ${pctC}%"></div>
            <div class="h-full bg-amber-400" style="width:${pctG}%" title="Govt Securities G: ${pctG}%"></div>
          </div>
          <div class="flex items-center justify-between text-[10px] text-slate-400">
            <span class="flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-emerald-400 inline-block"></i> Equity (E): <strong class="text-white">${pctE}%</strong></span>
            <span class="flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-sky-400 inline-block"></i> Corp Debt (C): <strong class="text-white">${pctC}%</strong></span>
            <span class="flex items-center gap-1"><i class="w-2 h-2 rounded-full bg-amber-400 inline-block"></i> Govt Sec (G): <strong class="text-white">${pctG}%</strong></span>
          </div>
        </div>
      `;

      // Distinctive Pension Scheme Cards with Left Accent Bar
      container.innerHTML = state.nps.map(n => {
        const val = n.units * n.currentNav;
        const gain = val - n.invested;
        const pct = n.invested > 0 ? (gain / n.invested) * 100 : 0;
        const isE = /SCHEME\s*[\-:]?\s*E\b/i.test(n.name);
        const isC = /SCHEME\s*[\-:]?\s*C\b/i.test(n.name);
        const borderAccent = isE ? 'border-l-emerald-400' : (isC ? 'border-l-sky-400' : 'border-l-amber-400');
        const classLabel = isE ? 'EQUITY • SCHEME E' : (isC ? 'CORP BONDS • SCHEME C' : 'GOVT SEC • SCHEME G');
        const badgeColor = isE ? 'text-emerald-300 bg-emerald-500/15' : (isC ? 'text-sky-300 bg-sky-500/15' : 'text-amber-300 bg-amber-500/15');

        return `
          <div data-open-nps="${n.id}" class="rounded-2xl bg-surface-900 hover:bg-surface-800/90 border border-slate-800 border-l-4 ${borderAccent} p-4 flex flex-col justify-between gap-3 cursor-pointer transition active:scale-[0.99]">
            <div>
              <div class="flex items-center justify-between gap-2">
                <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${badgeColor}">${classLabel}</span>
                <span class="text-[10px] font-semibold text-slate-400">NAV ₹${Number(n.currentNav).toFixed(4)}</span>
              </div>
              <h3 class="text-xs font-bold text-slate-200 mt-2 line-clamp-2 leading-snug">${n.name}</h3>
            </div>
            <div class="pt-2.5 border-t border-slate-800/80 flex items-end justify-between">
              <div>
                <p class="text-[10px] text-slate-400 uppercase">Current Value</p>
                <p class="text-base font-extrabold text-white mt-0.5">${formatINRPrecise(val)}</p>
                <p class="text-[10px] text-slate-500 mt-0.5">${Number(n.units).toFixed(4)} units</p>
              </div>
              <div class="text-right">
                <p class="text-xs font-bold ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(gain)}</p>
                <p class="text-[11px] font-semibold ${gain >= 0 ? 'text-emerald-500' : 'text-rose-500'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</p>
                <span class="text-[10px] text-amber-400 font-semibold">Open Scheme →</span>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }

    function getCurrentFyBounds() {
      const now = new Date();
      const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
      return {
        fyStart: `${y}-04-01`,
        fyEnd: `${y + 1}-03-31`,
        fyStartYear: y,
        currentMonthIdx: now.getMonth() >= 3 ? (now.getMonth() - 3) : (now.getMonth() + 9) // 0=Apr .. 11=Mar
      };
    }

    function computePpfFyInterest() {
      const insts = Array.isArray(state.ppf.installments) ? state.ppf.installments : [];
      const rate = Number(state.ppf.rate || 0.071);
      if (insts.length === 0) {
        const est = Math.round((state.ppf.balance || 0) * rate);
        return { accruedToDate: 0, projectedFullYear: est };
      }
      const { fyStart, fyStartYear, currentMonthIdx } = getCurrentFyBounds();
      // Opening balance before April 1 of current FY
      let runningBal = insts
        .filter(x => String(x.date) < fyStart)
        .reduce((sum, x) => sum + Number(x.credit || 0) - Number(x.debit || 0), 0);

      let accruedToDate = 0;
      let projectedFullYear = 0;
      const monthlyRate = rate / 12;

      for (let m = 0; m < 12; m++) {
        const calYear = m < 9 ? fyStartYear : fyStartYear + 1;
        const calMonth = ((m + 3) % 12) + 1;
        const mm = String(calMonth).padStart(2, '0');
        const monthPrefix = `${calYear}-${mm}`;
        const fifthDate = `${monthPrefix}-05`;

        const monthTx = insts.filter(x => String(x.date).startsWith(monthPrefix));
        // Deposits on or before the 5th qualify for this month's minimum balance!
        const onOrBefore5th = monthTx
          .filter(x => String(x.date) <= fifthDate && x.kind !== 'interest')
          .reduce((sum, x) => sum + Number(x.credit || 0) - Number(x.debit || 0), 0);
        const after5th = monthTx
          .filter(x => String(x.date) > fifthDate && x.kind !== 'interest')
          .reduce((sum, x) => sum + Number(x.credit || 0) - Number(x.debit || 0), 0);

        // Lowest balance between close of 5th and last day of month (assuming no withdrawals mid-month after 5th, or subtract debits)
        const minBal5thToEnd = Math.max(0, runningBal + onOrBefore5th);
        const monthInt = minBal5thToEnd * monthlyRate;
        projectedFullYear += monthInt;
        if (m <= currentMonthIdx) accruedToDate += monthInt;

        runningBal += onOrBefore5th + after5th;
      }
      return {
        accruedToDate: Math.round(accruedToDate),
        projectedFullYear: Math.round(projectedFullYear)
      };
    }

    function computeEpfFyInterest() {
      const insts = Array.isArray(state.epf.installments) ? state.epf.installments : [];
      const ints = Array.isArray(state.epf.yearlyInterests) ? state.epf.yearlyInterests : [];
      const rate = Number(state.epf.rate || 0.0825);
      if (insts.length === 0) {
        const est = Math.round((state.epf.balance || 0) * rate);
        return { accruedToDate: 0, projectedFullYear: est };
      }
      const { fyStart, fyStartYear, currentMonthIdx } = getCurrentFyBounds();
      let runningBal = insts
        .filter(x => String(x.date) < fyStart)
        .reduce((sum, x) => sum + Number(x.empShare || 0) + Number(x.emprShare || 0), 0)
        + ints
        .filter(x => String(x.date) < fyStart)
        .reduce((sum, x) => sum + Number(x.empInterest || 0) + Number(x.emprInterest || 0), 0);

      let accruedToDate = 0;
      let projectedFullYear = 0;
      const monthlyRate = rate / 12;
      const monthlyPlanned = Number(state.epf.monthlyContribution || 0);

      for (let m = 0; m < 12; m++) {
        const calYear = m < 9 ? fyStartYear : fyStartYear + 1;
        const calMonth = ((m + 3) % 12) + 1;
        const monthPrefix = `${calYear}-${String(calMonth).padStart(2, '0')}`;
        const monthCont = insts
          .filter(x => String(x.date).startsWith(monthPrefix))
          .reduce((sum, x) => sum + Number(x.empShare || 0) + Number(x.emprShare || 0), 0);

        if (m <= currentMonthIdx) {
          runningBal += monthCont;
          const mInt = runningBal * monthlyRate;
          accruedToDate += mInt;
          projectedFullYear += mInt;
        } else {
          runningBal += monthlyPlanned;
          projectedFullYear += runningBal * monthlyRate;
        }
      }
      return {
        accruedToDate: Math.round(accruedToDate),
        projectedFullYear: Math.round(projectedFullYear)
      };
    }

    function renderRetiral() {
      const epfTxCount = Array.isArray(state.epf.installments) ? state.epf.installments.length : 0;
      const epfIntCount = Array.isArray(state.epf.yearlyInterests) ? state.epf.yearlyInterests.length : 0;
      const totalEarnedInt = Number(state.epf.totalInterestEarned || 0);
      const epfFy = computeEpfFyInterest();

      document.getElementById('epfBalanceDisplay').textContent = formatINR(state.epf.balance);
      document.getElementById('epfInvestedSub').textContent = `Principal: ${formatINR(state.epf.invested)}`;
      document.getElementById('epfInterestDisplay').textContent = totalEarnedInt > 0 ? ('+' + formatINR(totalEarnedInt)) : ('+' + formatINR(epfFy.projectedFullYear));
      document.getElementById('epfEstNextInt').textContent = epfFy.accruedToDate > 0 ? `This FY: +${formatINR(epfFy.accruedToDate)} (Yr: +${formatINR(epfFy.projectedFullYear)})` : `Rate: ${(Number(state.epf.rate || 0.0825) * 100).toFixed(2)}% p.a.`;
      document.getElementById('epfPensionDisplay').textContent = formatINR(state.epf.pensionBalance || 0);
      document.getElementById('epfMonthlyDisplay').textContent = formatINR(state.epf.monthlyContribution);
      document.getElementById('epfCountBadge').textContent = epfTxCount > 0 ? `${epfTxCount} Months • ${epfIntCount} FY Int.` : 'Tap for Passbook →';

      const ppfTxCount = Array.isArray(state.ppf.installments) ? state.ppf.installments.length : 0;
      const ppfEarnedInt = Number(state.ppf.totalInterestEarned || Math.max(0, state.ppf.balance - state.ppf.invested));
      const ppfFy = computePpfFyInterest();
      const ppfRetPct = state.ppf.invested > 0 ? ((state.ppf.balance - state.ppf.invested) / state.ppf.invested) * 100 : 0;

      document.getElementById('ppfBalanceDisplay').textContent = formatINR(state.ppf.balance);
      document.getElementById('ppfInvestedSub').textContent = `Principal: ${formatINR(state.ppf.invested)}`;
      document.getElementById('ppfInterestDisplay').textContent = ppfEarnedInt > 0 ? ('+' + formatINR(ppfEarnedInt)) : ('+' + formatINR(ppfFy.projectedFullYear));
      document.getElementById('ppfEstNextInt').textContent = ppfFy.accruedToDate > 0 ? `This FY: +${formatINR(ppfFy.accruedToDate)} (Yr: +${formatINR(ppfFy.projectedFullYear)})` : `Rate: ${(Number(state.ppf.rate || 0.071) * 100).toFixed(2)}% p.a.`;
      document.getElementById('ppfReturnPctDisplay').textContent = `+${ppfRetPct.toFixed(1)}%`;
      document.getElementById('ppfMonthlyDisplay').textContent = formatINR(state.ppf.monthlyDeposit);
      document.getElementById('ppfCountBadge').textContent = ppfTxCount > 0 ? `${ppfTxCount} Entries` : 'Tap for Passbook →';
    }

    async function syncLiveNavs() {
      const icon = document.getElementById('refreshIcon');
      icon.classList.add('animate-spin');
      showAppLoader('Syncing Live NAVs & Indices...', 'Fetching latest AMFI, NPS & Market data', 25);
      let updatedCount = 0;
      await syncLiveMarketIndices();
      showAppLoader('Syncing Mutual Funds & NPS...', 'Updating daily NAVs from AMFI & NPSNAV.in', 65);

      async function resolveAmfiCodeForFund(fund) {
        if (fund.schemeCode && fund.schemeCode !== '000000') return fund.schemeCode;
        const nm = String(fund.name || '');
        if (/kotak.*arbitrage/i.test(nm)) { fund.schemeCode = '119771'; return '119771'; }
        if (/parag\s*parikh.*flexi/i.test(nm)) { fund.schemeCode = '122639'; return '122639'; }
        if (/hdfc.*mid\s*cap/i.test(nm)) { fund.schemeCode = '118989'; return '118989'; }
        if (/uti.*nifty\s*50/i.test(nm)) { fund.schemeCode = '120716'; return '120716'; }
        try {
          const cleanTokens = nm.replace(/\s*-?\s*(direct|regular|growth|plan|idcw|fund)/gi, ' ').trim().split(/\s+/).filter(Boolean);
          const queries = [cleanTokens.slice(0, 3).join(' '), cleanTokens.slice(0, 2).join(' '), cleanTokens[0] || ''].filter(Boolean);
          const isDirect = /direct/i.test(nm);
          for (const q of queries) {
            const sRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(q)}`);
            if (!sRes.ok) continue;
            const sList = await sRes.json();
            if (!Array.isArray(sList) || !sList.length) continue;
            const match = sList.find(item => {
              const sn = String(item.schemeName || '');
              const tokenHit = cleanTokens.slice(0, 2).every(t => sn.toLowerCase().includes(t.toLowerCase()));
              return tokenHit && (isDirect ? /direct/i.test(sn) : true) && /growth/i.test(sn);
            }) || sList.find(item => (isDirect ? /direct/i.test(item.schemeName) : true) && /growth/i.test(item.schemeName)) || sList[0];
            if (match && match.schemeCode) {
              fund.schemeCode = String(match.schemeCode);
              return fund.schemeCode;
            }
          }
        } catch (err) {}
        return fund.schemeCode || '000000';
      }

      for (const fund of state.mutualFunds) {
        await resolveAmfiCodeForFund(fund);
        if (!fund.schemeCode || fund.schemeCode === '000000') continue;
        try {
          const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(fund.schemeCode)}`);
          if (!res.ok) continue;
          const json = await res.json();
          if (json.data && json.data.length >= 2) {
            const latest = parseFloat(json.data[0].nav);
            const prev = parseFloat(json.data[1].nav);
            if (!isNaN(latest) && !isNaN(prev)) {
              fund.currentNav = latest;
              fund.prevNav = prev;
              updatedCount++;
            }
          }
        } catch (err) {}
      }

      // 100% Client-Side Dynamic NPS NAV Resolution (Zero code.gs / UrlFetchApp calls; works on GitHub Pages & Apps Script across ALL 11 PFMs/POPs)
      async function fetchUrlTextClientCors(targetUrl) {
        const relays = [
          { url: `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`, isJson: true },
          { url: `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`, isJson: false },
          { url: `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`, isJson: false },
          { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`, isJson: false }
        ];
        for (const r of relays) {
          try {
            const resp = await fetch(r.url);
            if (!resp.ok) continue;
            if (r.isJson) {
              const j = await resp.json();
              if (j && j.contents && String(j.contents).length > 100) return String(j.contents);
            } else {
              const txt = await resp.text();
              if (txt && txt.length > 100) return txt;
            }
          } catch (e) {}
        }
        return '';
      }

      // Dynamic Official PFM Page Directory (Supports switching PFM/POP in the future alongside universal NPSNAV.in API)
      const OFFICIAL_PFM_URLS = [
        { match: /BIRLA|ABSL/i, url: 'https://pensionfund.adityabirlacapital.com/nav' },
        { match: /HDFC/i, url: 'https://www.hdfcpension.com/nav/' },
        { match: /ICICI/i, url: 'https://www.icicipension.in/public_disclosure/latest_nav' },
        { match: /AXIS/i, url: 'https://www.axispensionfund.com/public-disclosures/nav-latest' },
        { match: /SBI/i, url: 'https://www.sbipensionfunds.co.in/disclosures/nav/?current=latest-nav' }
      ];
      const pfmHtmlCache = {};

      async function tryParseOfficialPfmLiveNav(schemeName) {
        const upper = String(schemeName || '').toUpperCase();
        const pfmEntry = OFFICIAL_PFM_URLS.find(p => p.match.test(upper));
        if (!pfmEntry) return null;
        if (!(pfmEntry.url in pfmHtmlCache)) {
          pfmHtmlCache[pfmEntry.url] = await fetchUrlTextClientCors(pfmEntry.url);
        }
        const htmlText = pfmHtmlCache[pfmEntry.url];
        if (!htmlText) return null;
        // Strip HTML tags to plain space-separated text so table cell attributes never block regex matching
        const plainText = htmlText.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
        const letterM = upper.match(/SCHEME\s*[\-:]?\s*([ECGA])\b/);
        const letter = letterM ? letterM[1] : '';
        const tier = /TIER\s*[\-:]?\s*(?:II|2)\b/.test(upper) ? 'TIER\\s*II' : 'TIER\\s*I(?!I)';
        const planType = /\bDIRECT\b/.test(upper) ? 'DIRECT' : (/\bGS\b/.test(upper) ? 'GS' : 'POP');
        if (!letter) return null;
        const dynRe = new RegExp('SCHEME\\s*' + letter + '\\s*-?\\s*' + tier + '\\s*' + planType + '\\s+([0-9]{2}\\.[0-9]{4})', 'i');
        const m = plainText.match(dynRe);
        if (m && m[1]) {
          const val = parseFloat(m[1]);
          if (!isNaN(val) && val > 0) return val;
        }
        return null;
      }

      let npsCatalog = null;
      for (const npsItem of state.nps) {
        if (npsItem.schemeId === 'SM010001' && /SCHEME\s*C/i.test(npsItem.name)) {
          npsItem.schemeId = 'TIER I';
        }
        // Dynamic Scheme Code Resolver across all 263 NPS schemes & 11 PFMs (SBI, HDFC, ICICI, Kotak, UTI, LIC, Aditya Birla, Tata, Axis, DSP, Max Life)
        if (!npsItem.schemeId || !/^SM\d+/i.test(npsItem.schemeId)) {
          try {
            if (!npsCatalog) {
              const catRes = await fetch('https://npsnav.in/api/schemes');
              if (catRes.ok) {
                const catJson = await catRes.json();
                npsCatalog = Array.isArray(catJson.data) ? catJson.data : (Array.isArray(catJson) ? catJson : []);
              }
            }
            if (npsCatalog && npsCatalog.length > 0) {
              const rawTarget = npsItem.name.toUpperCase();
              const schemeLetterM = rawTarget.match(/SCHEME\s*[\-:]?\s*([ECGA])\b/);
              const reqLetter = schemeLetterM ? schemeLetterM[1] : '';
              const isTier2 = /TIER\s*[\-:]?\s*(?:II|2)\b/.test(rawTarget);
              const isDirect = /\bDIRECT\b/.test(rawTarget);
              const pfmTokens = rawTarget.replace(/PENSION|FUND|SCHEME|TIER|POP|DIRECT|LIMITED|PRIVATE|PVT|LTD|[^A-Z0-9 ]/g, ' ').trim().split(/\s+/).filter(w => w.length >= 3);

              const found = npsCatalog.find(entry => {
                const label = String(Array.isArray(entry) ? entry[1] : (entry.scheme_name || entry.name || '')).toUpperCase();
                const pfmMatch = pfmTokens.slice(0, 2).every(t => label.includes(t));
                if (!pfmMatch) return false;
                const entryTier2 = /TIER\s*[\-:]?\s*(?:II|2)\b/.test(label);
                if (isTier2 !== entryTier2) return false;
                const entryDirect = /\bDIRECT\b/.test(label);
                if (isDirect !== entryDirect && (label.includes('POP') || label.includes('DIRECT'))) return false;
                if (reqLetter) {
                  const hasLetter = new RegExp('SCHEME\\s*[\\-:]?\\s*' + reqLetter + '\\b').test(label);
                  if (!hasLetter) return false;
                }
                return true;
              });
              if (found) {
                npsItem.schemeId = String(Array.isArray(found) ? found[0] : (found.scheme_code || found.code));
              }
            }
          } catch (e) {}
        }

        let apiNav = 0;
        let apiPrevNav = 0;
        let apiLastDateIso = '';
        if (npsItem.schemeId && /^SM\d+/i.test(npsItem.schemeId)) {
          try {
            const code = npsItem.schemeId.toUpperCase().trim();
            const hRes = await fetch(`https://npsnav.in/api/historical/${encodeURIComponent(code)}`);
            if (hRes.ok) {
              const hJson = await hRes.json();
              const list = Array.isArray(hJson.data) ? hJson.data : [];
              if (list.length >= 2) {
                const d0 = String(list[0].date || '');
                const dLast = String(list[list.length - 1].date || '');
                const p0 = d0.split('-').reverse().join('-');
                const pLast = dLast.split('-').reverse().join('-');
                if (pLast > p0) {
                  apiNav = parseFloat(list[list.length - 1].nav) || 0;
                  apiPrevNav = parseFloat(list[list.length - 2].nav) || apiNav;
                  apiLastDateIso = pLast;
                } else {
                  apiNav = parseFloat(list[0].nav) || 0;
                  apiPrevNav = parseFloat(list[1].nav) || apiNav;
                  apiLastDateIso = p0;
                }
              }
            }
            if (!apiNav) {
              const dRes = await fetch(`https://npsnav.in/api/detailed/${encodeURIComponent(code)}`);
              if (dRes.ok) {
                const dJson = await dRes.json();
                const latest = parseFloat(dJson.NAV || dJson.nav);
                if (!isNaN(latest) && latest > 0) {
                  const oneDayPct = parseFloat(dJson['1D'] || '0') || 0;
                  apiNav = latest;
                  apiPrevNav = oneDayPct !== 0 ? +(latest / (1 + oneDayPct / 100)).toFixed(4) : latest;
                  const rawUpd = String(dJson['Last Updated'] || '');
                  if (/^\d{2}-\d{2}-\d{4}$/.test(rawUpd)) {
                    apiLastDateIso = rawUpd.split('-').reverse().join('-');
                  }
                }
              }
            }
          } catch (e) {}
        }

        // Check client-side Official PFM live table (via CORS relay) in case NPSNAV.in is lagging by 1 business day
        const officialLiveNav = await tryParseOfficialPfmLiveNav(npsItem.name);
        if (officialLiveNav && officialLiveNav > 0) {
          if (apiNav > 0 && Math.abs(officialLiveNav - apiNav) > 0.00005) {
            // Official PFM page has published a newer daily close than NPSNAV.in's last cached date!
            npsItem.prevNav = apiNav;
            npsItem.currentNav = officialLiveNav;
          } else {
            npsItem.currentNav = officialLiveNav;
            npsItem.prevNav = apiPrevNav || npsItem.prevNav || officialLiveNav;
          }
          updatedCount++;
        } else if (apiNav > 0) {
          npsItem.currentNav = apiNav;
          npsItem.prevNav = apiPrevNav || apiNav;
          updatedCount++;
        }
      }

      const now = new Date();
      state.lastSync = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      state.lastSyncEpoch = Date.now();
      saveState();
      renderAll();
      icon.classList.remove('animate-spin');
      hideAppLoader();
      showToast(updatedCount > 0 ? `Synced live NAVs (${updatedCount} holdings) + Market Indices` : 'Synced Live Market Indices');
    }

    function openModal(title, html) {
      pushNavState('modal_dialog');
      document.getElementById('modalTitle').textContent = title;
      document.getElementById('modalBody').innerHTML = html;
      document.getElementById('modalBackdrop').classList.remove('hidden');
    }

    function closeModal() {
      document.getElementById('modalBackdrop').classList.add('hidden');
    }

    function cleanNum(v) {
      if (typeof v === 'number') return v;
      if (!v) return 0;
      const cleaned = String(v).replace(/[₹,\s]/g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : n;
    }

    function pickField(row, candidates) {
      const keys = Object.keys(row);
      for (const c of candidates) {
        const match = keys.find(k => k.toLowerCase().includes(c));
        if (match && row[match] !== '' && row[match] != null) return row[match];
      }
      return null;
    }
