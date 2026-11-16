const SECURITY_KEY = 'wealthlocal_security_v16';
    const SESSION_KEY = 'wealthlocal_active_session_v16';
    let currentUserRole = 'admin'; // 'admin' | 'viewer'
    let currentUserName = 'Admin';
    let selectedLockRole = 'admin'; // 'admin' | 'viewer'
    let authScreenTab = 'login'; // 'login' | 'register'

    function loadSecurityConfig() {
      try {
        const raw = localStorage.getItem(SECURITY_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (!parsed.sessionTimeoutMinutes) parsed.sessionTimeoutMinutes = 30;
          if (!Array.isArray(parsed.users)) parsed.users = [];
          return parsed;
        }
      } catch (e) {}
      return {
        registered: false,
        adminName: 'Admin',
        adminMobile: '',
        adminEmail: '',
        adminPinHash: '',
        viewerName: 'Family Viewer',
        viewerPinHash: '',
        secQ1: '',
        secA1Hash: '',
        secQ2: '',
        secA2Hash: '',
        recoveryKey: '',
        bioCredentialId: '',
        autoLock: true,
        sessionTimeoutMinutes: 30,
        users: []
      };
    }

    function saveSecurityConfig(cfg) {
      try {
        localStorage.setItem(SECURITY_KEY, JSON.stringify(cfg));
      } catch (e) {}
      syncServerBundle();
    }

    async function syncServerBundle() {
      try {
        let encryptedCipher = localStorage.getItem(VAULT_CIPHER_KEY) || '';
        if (secConfig && secConfig.adminPinHash && isAppUnlocked) {
          const vaultSecret = 'wl_device_key_' + secConfig.adminPinHash;
          encryptedCipher = await encryptJsonAesGcm(state, vaultSecret);
          localStorage.setItem(VAULT_CIPHER_KEY, encryptedCipher);
          // Replace plain-text STORAGE_KEY with encrypted wrapper so localStorage never holds plain-text holdings!
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            _encryptedVault: true,
            encryption: 'AES-256-GCM (PBKDF2-SHA256 100k iterations)',
            updatedAt: new Date().toISOString(),
            cipher: encryptedCipher
          }));
        }
        const bundleStr = JSON.stringify({
          _encryptedBundle: true,
          secConfig,
          encryptedStateCipher: encryptedCipher,
          updatedAt: Date.now()
        });
        if (typeof window.google !== 'undefined' && window.google.script && window.google.script.run) {
          // Store ONLY encryptedCipher (never plain-text `state`) inside Google Apps Script PropertiesService!
          window.google.script.run
            .withSuccessHandler(() => {
              const badge = document.getElementById('vaultSyncStatusBadge');
              if (badge) badge.textContent = 'AES-256 Cloud Synced';
            })
            .withFailureHandler(() => {})
            .saveServerAppBundle(bundleStr);
        } else {
          // When hosted on GitHub Pages, if a Personal Apps Script URL is saved, push the AES-256-GCM encrypted vault in the background via POST!
          const bridgeUrl = (state.gmailWebhookUrl || localStorage.getItem('wl_gas_bridge_url') || '').trim();
          if (bridgeUrl && bridgeUrl.startsWith('https://script.google.com/')) {
            fetch(bridgeUrl, {
              method: 'POST',
              mode: 'no-cors',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ action: 'saveVault', bundle: bundleStr, authHash: (secConfig && secConfig.adminPinHash) || '' })
            }).then(() => {
              const badge = document.getElementById('vaultSyncStatusBadge');
              if (badge) badge.textContent = 'AES-256 Cloud Synced';
            }).catch(() => {});
          }
        }
      } catch (e) {}
    }

    function loadActiveSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) { return null; }
    }

    function saveActiveSession(role, name) {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({
          active: true,
          role: role || currentUserRole,
          name: name || currentUserName,
          lastActiveAt: Date.now()
        }));
      } catch (e) {}
    }

    function clearActiveSession() {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch (e) {}
    }

    function isSessionStillValid() {
      if (!secConfig || !secConfig.registered || !secConfig.adminPinHash) return false;
      const sess = loadActiveSession();
      if (!sess || !sess.active || !sess.lastActiveAt) return false;
      const timeoutMins = Number(secConfig.sessionTimeoutMinutes || 30);
      const elapsedMs = Date.now() - Number(sess.lastActiveAt);
      return elapsedMs <= timeoutMins * 60 * 1000;
    }

    function simplePinHash(inputStr) {
      let h = 2166136261;
      const normalized = String(inputStr || '').trim().toLowerCase();
      const salted = 'wl_salt_v6_' + normalized;
      for (let i = 0; i < salted.length; i++) {
        h ^= salted.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    }

    function generateRecoveryKey() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      return `WL-${seg()}-${seg()}-${seg()}`;
    }

    async function deriveAesKey(passphrase, saltBytes) {
      const enc = new TextEncoder();
      const keyMaterial = await window.crypto.subtle.importKey(
        'raw',
        enc.encode(String(passphrase)),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );
      return window.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    function bytesToBase64(bytes) {
      let binary = '';
      const arr = new Uint8Array(bytes);
      for (let i = 0; i < arr.byteLength; i++) binary += String.fromCharCode(arr[i]);
      return btoa(binary);
    }

    function base64ToBytes(b64) {
      const binary = atob(b64);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      return arr;
    }

    async function encryptJsonAesGcm(plainObj, passphrase) {
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveAesKey(passphrase, salt);
      const enc = new TextEncoder();
      const plainBytes = enc.encode(JSON.stringify(plainObj));
      const cipherBuf = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
      return JSON.stringify({
        v: 'WL-AES256-GCM-V6',
        kdf: 'PBKDF2-SHA256-100000',
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ct: bytesToBase64(cipherBuf),
        ts: new Date().toISOString()
      });
    }

    async function decryptJsonAesGcm(envelopeStr, passphrase) {
      const env = typeof envelopeStr === 'string' ? JSON.parse(envelopeStr) : envelopeStr;
      const salt = base64ToBytes(env.salt);
      const iv = base64ToBytes(env.iv);
      const ct = base64ToBytes(env.ct);
      const key = await deriveAesKey(passphrase, salt);
      const plainBuf = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      const dec = new TextDecoder();
      return JSON.parse(dec.decode(plainBuf));
    }

    async function syncLocalEncryptedMirror() {
      try {
        if (!secConfig || !secConfig.adminPinHash || !isAppUnlocked) return;
        const vaultSecret = 'wl_device_key_' + secConfig.adminPinHash;
        const cipherStr = await encryptJsonAesGcm(state, vaultSecret);
        localStorage.setItem(VAULT_CIPHER_KEY, cipherStr);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          _encryptedVault: true,
          encryption: 'AES-256-GCM (PBKDF2-SHA256 100k iterations)',
          updatedAt: new Date().toISOString(),
          cipher: cipherStr
        }));
      } catch (e) {}
    }

    async function decryptStoredVaultIntoState() {
      try {
        if (!secConfig || !secConfig.adminPinHash) return false;
        const vaultSecret = 'wl_device_key_' + secConfig.adminPinHash;
        let cipherStr = localStorage.getItem(VAULT_CIPHER_KEY) || '';
        const rawStorage = localStorage.getItem(STORAGE_KEY);
        if (rawStorage) {
          const parsed = JSON.parse(rawStorage);
          if (parsed && parsed._encryptedVault && parsed.cipher) {
            cipherStr = parsed.cipher;
          } else if (parsed && Array.isArray(parsed.mutualFunds)) {
            // One-time migration from legacy plain-text state -> encrypt immediately!
            state = sanitizeNpsState(parsed);
            await syncLocalEncryptedMirror();
            await syncServerBundle();
            return true;
          }
        }
        if (cipherStr) {
          const decryptedObj = await decryptJsonAesGcm(cipherStr, vaultSecret);
          if (decryptedObj && typeof decryptedObj === 'object') {
            state = sanitizeNpsState(decryptedObj);
            return true;
          }
        }
      } catch (e) {}
      return false;
    }

    let secConfig = loadSecurityConfig();
    let enteredPin = '';
    let selectedProfileId = 'usr_primary_admin';
    let lockoutTimerId = null;

    function getInitials(nameStr) {
      const parts = String(nameStr || 'Admin').trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return String(parts[0] || 'AD').slice(0, 2).toUpperCase();
    }

    // Build canonical list of registered user profiles with unique IDs (`usr_primary_admin`, `usr_primary_viewer`, `usr_...`)
    function getRegisteredProfilesList() {
      const list = [];
      if (secConfig.adminPinHash) {
        list.push({
          id: 'usr_primary_admin',
          name: secConfig.adminName || 'Admin',
          role: 'admin',
          badge: '👑 Admin',
          email: secConfig.adminEmail || 'Primary Owner',
          pinHash: secConfig.adminPinHash,
          pinLen: Number(secConfig.adminPinLen || 0)
        });
      }
      if (secConfig.viewerPinHash) {
        list.push({
          id: 'usr_primary_viewer',
          name: secConfig.viewerName || 'Family Viewer',
          role: 'viewer',
          badge: '👁️ Viewer',
          email: 'Read-Only Access',
          pinHash: secConfig.viewerPinHash,
          pinLen: Number(secConfig.viewerPinLen || 0)
        });
      }
      (secConfig.users || []).forEach(u => {
        if (!u || !u.pinHash) return;
        list.push({
          id: String(u.id || ('usr_' + u.name)),
          name: u.name || 'User',
          role: u.role === 'admin' ? 'admin' : 'viewer',
          badge: u.role === 'admin' ? '👑 Co-Admin' : '👁️ Viewer',
          email: u.email || (u.role === 'admin' ? 'Full Access' : 'Read-Only'),
          pinHash: u.pinHash,
          pinLen: Number(u.pinLen || 0)
        });
      });
      return list;
    }

    function getSelectedLockProfile() {
      const profiles = getRegisteredProfilesList();
      if (profiles.length === 0) return null;
      return profiles.find(p => p.id === selectedProfileId) || profiles[0];
    }

    function isAnyAdminPinHash(pinHashCandidate) {
      if (!pinHashCandidate) return false;
      if (secConfig.adminPinHash && pinHashCandidate === secConfig.adminPinHash) return true;
      if (Array.isArray(secConfig.users)) {
        return secConfig.users.some(u => u.role === 'admin' && u.pinHash === pinHashCandidate);
      }
      return false;
    }

    function isLockoutActive() {
      const until = Number(secConfig.lockoutUntilEpoch || 0);
      return until > Date.now();
    }

    function startLockoutCountdownIfNeeded() {
      clearInterval(lockoutTimerId);
      const errEl = document.getElementById('lockErrorMsg');
      const updateTick = () => {
        const until = Number(secConfig.lockoutUntilEpoch || 0);
        const remMs = until - Date.now();
        if (remMs <= 0) {
          clearInterval(lockoutTimerId);
          if (secConfig.lockoutUntilEpoch) {
            secConfig.lockoutUntilEpoch = 0;
            secConfig.failedPinAttempts = 0;
            saveSecurityConfig(secConfig);
          }
          if (errEl) errEl.textContent = '';
          document.querySelectorAll('#lockKeypadPanel .pin-key').forEach(b => { b.disabled = false; b.classList.remove('opacity-40'); });
          return;
        }
        const mins = Math.floor(remMs / 60000);
        const secs = Math.floor((remMs % 60000) / 1000);
        if (errEl) {
          errEl.textContent = `🔒 5 Failed Attempts! Keypad locked for ${mins}m ${String(secs).padStart(2, '0')}s`;
        }
        document.querySelectorAll('#lockKeypadPanel .pin-key').forEach(b => { b.disabled = true; b.classList.add('opacity-40'); });
      };
      if (isLockoutActive()) {
        updateTick();
        lockoutTimerId = setInterval(updateTick, 1000);
      } else {
        document.querySelectorAll('#lockKeypadPanel .pin-key').forEach(b => { b.disabled = false; b.classList.remove('opacity-40'); });
      }
    }

    function renderProfileTab() {
      const isAdmin = currentUserRole === 'admin';
      const dispName = currentUserName || (isAdmin ? (secConfig.adminName || 'Admin') : (secConfig.viewerName || 'Family Viewer'));
      const initials = getInitials(dispName);

      const headerAvatar = document.getElementById('headerAvatarCircle');
      const btnSettings = document.getElementById('btnOpenSettings');
      if (headerAvatar) {
        headerAvatar.textContent = initials;
        headerAvatar.className = 'w-full h-full rounded-full bg-surface-900 flex items-center justify-center text-[11px] font-extrabold text-white leading-none select-none';
      }
      if (btnSettings) {
        btnSettings.className = isAdmin
          ? 'w-9 h-9 shrink-0 rounded-full p-0.5 bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center active:scale-95 transition shadow-md shadow-emerald-500/15'
          : 'w-9 h-9 shrink-0 rounded-full p-0.5 bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center active:scale-95 transition shadow-md shadow-sky-500/15';
      }

      const tabAvatar = document.getElementById('profileTabAvatar');
      const tabName = document.getElementById('profileTabName');
      const tabRolePill = document.getElementById('profileTabRolePill');
      const tabEmail = document.getElementById('profileTabEmail');
      const tabMobile = document.getElementById('profileTabMobile');
      if (tabAvatar) tabAvatar.textContent = initials;
      if (tabName) tabName.textContent = dispName;
      if (tabRolePill) {
        tabRolePill.textContent = isAdmin ? '👑 Admin (Full Access)' : '👁️ Read-Only Viewer';
        tabRolePill.className = isAdmin
          ? 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300'
          : 'text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300';
      }
      if (tabEmail) tabEmail.textContent = isAdmin ? (secConfig.adminEmail || 'Tap Edit Profile below to add email') : 'Read-Only Session';
      if (tabMobile) tabMobile.textContent = isAdmin ? (secConfig.adminMobile || `Session timeout: ${secConfig.sessionTimeoutMinutes || 30} mins`) : `Session timeout: ${secConfig.sessionTimeoutMinutes || 30} mins`;

      const viewerNotice = document.getElementById('viewerRestrictedNotice');
      const adminContainer = document.getElementById('adminSettingsContainer');
      if (viewerNotice) viewerNotice.classList.toggle('hidden', isAdmin);
      if (adminContainer) adminContainer.classList.toggle('hidden', !isAdmin);

      if (isAdmin) {
        const inName = document.getElementById('profInputName');
        const inMob = document.getElementById('profInputMobile');
        const inEm = document.getElementById('profInputEmail');
        const timeoutSel = document.getElementById('profSessionTimeoutSelect');
        const bioToggle = document.getElementById('profBiometricToggle');
        const autoSyncToggle = document.getElementById('profAutoSyncLoginToggle');
        if (inName) inName.value = secConfig.adminName || '';
        if (inMob) inMob.value = secConfig.adminMobile || '';
        if (inEm) inEm.value = secConfig.adminEmail || '';
        if (timeoutSel) timeoutSel.value = String(secConfig.sessionTimeoutMinutes || 30);
        if (bioToggle) bioToggle.checked = Boolean(secConfig.biometricsEnabled);
        if (autoSyncToggle) autoSyncToggle.checked = secConfig.autoSyncOnLogin !== false;

        // Render Registered Profiles Directory
        const dirEl = document.getElementById('profileUsersDirectoryList');
        if (dirEl) {
          const rows = [];
          // 1. Primary Admin
          rows.push(`
            <div class="rounded-xl bg-surface-800/80 border border-slate-700/80 p-2.5 flex items-center justify-between gap-2">
              <div class="flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 font-bold text-[11px]">${getInitials(secConfig.adminName || 'Admin')}</div>
                <div>
                  <p class="font-bold text-white text-xs">${secConfig.adminName || 'Admin'} <span class="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 ml-1">👑 Primary Admin</span></p>
                  <p class="text-[10px] text-slate-400">${secConfig.adminEmail || 'Owner Account'} • 6-Digit PIN Active</p>
                </div>
              </div>
              <span class="text-[10px] text-emerald-400 font-semibold">Active</span>
            </div>
          `);
          // 2. Primary Read-Only Viewer (if configured)
          if (secConfig.viewerPinHash) {
            rows.push(`
              <div class="rounded-xl bg-surface-800/80 border border-slate-700/80 p-2.5 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-full bg-sky-500/20 border border-sky-500/40 flex items-center justify-center text-sky-300 font-bold text-[11px]">${getInitials(secConfig.viewerName || 'Viewer')}</div>
                  <div>
                    <p class="font-bold text-white text-xs">${secConfig.viewerName || 'Family Viewer'} <span class="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 ml-1">👁️ Read-Only</span></p>
                    <p class="text-[10px] text-slate-400">Can view portfolio only (cannot edit or delete)</p>
                  </div>
                </div>
                <button type="button" data-remove-primary-viewer="1" class="text-[11px] text-rose-400 hover:underline px-2 py-1">Remove</button>
              </div>
            `);
          }
          // 3. Additional users in secConfig.users
          (secConfig.users || []).forEach(u => {
            const isCoAdmin = u.role === 'admin';
            rows.push(`
              <div class="rounded-xl bg-surface-800/80 border border-slate-700/80 p-2.5 flex items-center justify-between gap-2">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-full ${isCoAdmin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'} flex items-center justify-center font-bold text-[11px]">${getInitials(u.name)}</div>
                  <div>
                    <p class="font-bold text-white text-xs">${u.name} <span class="text-[9px] px-1.5 py-0.5 rounded ${isCoAdmin ? 'bg-emerald-500/20 text-emerald-300' : 'bg-sky-500/20 text-sky-300'} ml-1">${isCoAdmin ? '👑 Co-Admin' : '👁️ Read-Only'}</span></p>
                    <p class="text-[10px] text-slate-400">${u.email || (isCoAdmin ? 'Full Access' : 'View Only')}</p>
                  </div>
                </div>
                <button type="button" data-remove-user-id="${u.id}" class="text-[11px] text-rose-400 hover:underline px-2 py-1">Remove</button>
              </div>
            `);
          });
          dirEl.innerHTML = rows.join('');
        }
      }
    }

    function applyRolePermissions() {
      const isAdmin = currentUserRole === 'admin';
      renderProfileTab();

      const adminOnlyIds = [
        'btnSyncGmail',
        'btnImportMfExcel',
        'btnAddMf',
        'btnQuickAddMf',
        'btnImportNpsExcel',
        'btnAddNps',
        'btnImportRetiralExcel',
        'btnEditEpf',
        'btnLogEpfMonth',
        'btnEditPpf',
        'btnLogPpfMonth'
      ];
      adminOnlyIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !isAdmin);
      });
      document.querySelectorAll('.btn-edit-index').forEach(btn => {
        btn.classList.toggle('hidden', !isAdmin);
      });
    }

    function switchAuthScreenTab(mode) {
      authScreenTab = mode;
      enteredPin = '';
      document.getElementById('lockErrorMsg').textContent = '';
      document.getElementById('regErrorMsg').textContent = '';
      const btnLogin = document.getElementById('btnAuthTabLogin');
      const btnReg = document.getElementById('btnAuthTabRegister');
      const isLogin = mode === 'login';
      if (btnLogin && btnReg) {
        btnLogin.className = isLogin
          ? 'py-2 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition'
          : 'py-2 rounded-xl text-slate-400 hover:text-white transition';
        btnReg.className = !isLogin
          ? 'py-2 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/30 transition'
          : 'py-2 rounded-xl text-slate-400 hover:text-white transition';
      }
      updateLockScreenUI();
    }

    function selectLockRolePill(role) {
      selectedLockRole = role;
      enteredPin = '';
      document.getElementById('lockErrorMsg').textContent = '';
      const btnAdmin = document.getElementById('btnLockSelectAdmin');
      const btnViewer = document.getElementById('btnLockSelectViewer');
      const isAdmin = role === 'admin';
      btnAdmin.className = isAdmin
        ? 'py-1.5 rounded-xl bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition'
        : 'py-1.5 rounded-xl text-slate-400 hover:text-white transition';
      btnViewer.className = !isAdmin
        ? 'py-1.5 rounded-xl bg-sky-500/20 text-sky-300 border border-sky-500/30 transition'
        : 'py-1.5 rounded-xl text-slate-400 hover:text-white transition';
      updateLockScreenUI();
    }

    function updateLockScreenUI() {
      const regPanel = document.getElementById('lockRegisterPanel');
      const keyPanel = document.getElementById('lockKeypadPanel');
      const recPanel = document.getElementById('lockRecoveryPanel');
      const bottomBar = document.getElementById('lockBottomBar');
      const topSwitcher = document.getElementById('authTopModeSwitcher');
      const existingAdminBox = document.getElementById('existingAdminAuthBox');
      const initialViewerBox = document.getElementById('initialViewerQuickBox');
      const regTitle = document.getElementById('regPanelTitle');
      const regSub = document.getElementById('regPanelSubtitle');
      const dots = document.querySelectorAll('#pinDotsContainer .pin-dot');

      dots.forEach((dot, idx) => {
        const filled = idx < enteredPin.length;
        dot.className = filled
          ? 'pin-dot w-3.5 h-3.5 rounded-full bg-emerald-400 border-2 border-emerald-400 scale-110 transition-all duration-150'
          : 'pin-dot w-3.5 h-3.5 rounded-full border-2 border-slate-600 transition-all duration-150';
      });

      const isAlreadyRegistered = Boolean(secConfig.registered && secConfig.adminPinHash);

      if (!isAlreadyRegistered) {
        // First-time ever setup: no Admin exists yet
        if (topSwitcher) topSwitcher.classList.add('hidden');
        if (existingAdminBox) existingAdminBox.classList.add('hidden');
        if (initialViewerBox) initialViewerBox.classList.remove('hidden');
        if (regTitle) regTitle.textContent = 'Create Primary Admin Account';
        if (regSub) regSub.textContent = 'One-time owner setup. Once registered, only you can authorize new users.';
        regPanel.classList.remove('hidden');
        keyPanel.classList.add('hidden');
        recPanel.classList.add('hidden');
        bottomBar.classList.add('hidden');
        return;
      }

      // Primary Admin already exists! Show Login | Register User switcher
      if (topSwitcher) topSwitcher.classList.remove('hidden');

      if (authScreenTab === 'register') {
        // Protected Registration Mode: Requires Existing Admin PIN!
        if (existingAdminBox) existingAdminBox.classList.remove('hidden');
        if (initialViewerBox) initialViewerBox.classList.add('hidden');
        if (regTitle) regTitle.textContent = 'Register New User Profile';
        if (regSub) regSub.textContent = 'Protected: Requires an existing Admin PIN to authorize new Admin or Viewer accounts';
        regPanel.classList.remove('hidden');
        keyPanel.classList.add('hidden');
        recPanel.classList.add('hidden');
        bottomBar.classList.add('hidden');
        return;
      }

      // Default: Login Keypad Mode
      regPanel.classList.add('hidden');
      recPanel.classList.add('hidden');
      keyPanel.classList.remove('hidden');
      bottomBar.classList.remove('hidden');

      const bioBtn = document.getElementById('btnTriggerBiometricPrompt');
      const leftKeyLabel = document.getElementById('keypadLeftActionLabel');
      const isBioEnabled = Boolean(secConfig.biometricsEnabled);
      if (bioBtn) bioBtn.classList.toggle('hidden', !isBioEnabled);
      if (leftKeyLabel) leftKeyLabel.textContent = isBioEnabled ? 'BIO' : 'CLR';

      const profiles = getRegisteredProfilesList();
      if (!profiles.some(p => p.id === selectedProfileId) && profiles.length > 0) {
        selectedProfileId = profiles[0].id;
      }
      const activeProf = getSelectedLockProfile();
      selectedLockRole = activeProf ? activeProf.role : 'admin';

      // Render Option A Profile Avatar Picker Cards
      const pickerEl = document.getElementById('lockProfilePickerList');
      if (pickerEl) {
        pickerEl.innerHTML = profiles.map(p => {
          const isSel = activeProf && p.id === activeProf.id;
          const isAdm = p.role === 'admin';
          const ringCls = isSel
            ? (isAdm ? 'border-emerald-400 bg-emerald-500/15 ring-2 ring-emerald-500/30 shadow-lg shadow-emerald-500/10' : 'border-sky-400 bg-sky-500/15 ring-2 ring-sky-500/30 shadow-lg shadow-sky-500/10')
            : 'border-slate-800 bg-surface-900/80 opacity-70 hover:opacity-100';
          const avGrad = isAdm ? 'from-emerald-500 to-teal-600' : 'from-sky-500 to-blue-600';
          return `
            <button type="button" data-select-profile-id="${p.id}" class="px-3 py-2 rounded-2xl border ${ringCls} flex items-center gap-2.5 transition active:scale-95 min-w-[130px] max-w-[180px]">
              <div class="w-9 h-9 shrink-0 rounded-full bg-gradient-to-br ${avGrad} flex items-center justify-center text-xs font-extrabold text-white shadow">
                ${getInitials(p.name)}
              </div>
              <div class="text-left min-w-0 flex-1">
                <p class="text-xs font-extrabold text-white truncate">${p.name}</p>
                <p class="text-[10px] font-bold ${isAdm ? 'text-emerald-300' : 'text-sky-300'} truncate">${p.badge}</p>
              </div>
            </button>
          `;
        }).join('');
      }

      const titleEl = document.getElementById('lockTitle');
      const subEl = document.getElementById('lockSubtitle');
      if (activeProf) {
        titleEl.textContent = `Login as ${activeProf.name}`;
        subEl.textContent = `Enter 6-digit PIN (${activeProf.badge} • ID: ${activeProf.id.replace('usr_', '')})`;
      }
      startLockoutCountdownIfNeeded();
    }

    async function unlockAppSuccess(role, userName) {
      isAppUnlocked = true;
      currentUserRole = role || 'admin';
      currentUserName = userName || (currentUserRole === 'admin' ? (secConfig.adminName || 'Admin') : (secConfig.viewerName || 'Family Viewer'));
      enteredPin = '';
      authScreenTab = 'login';
      if (secConfig.failedPinAttempts || secConfig.lockoutUntilEpoch) {
        secConfig.failedPinAttempts = 0;
        secConfig.lockoutUntilEpoch = 0;
        saveSecurityConfig(secConfig);
      }
      document.getElementById('lockErrorMsg').textContent = '';
      saveActiveSession(currentUserRole, currentUserName);
      await decryptStoredVaultIntoState();
      const shell = document.getElementById('mainAppShell');
      if (shell) shell.classList.remove('hidden');
      document.getElementById('appLockScreen').classList.add('hidden');
      closeAllAccordionsAndDrawers();
      applyRolePermissions();
      updateLockScreenUI();
      renderAll();
      await syncServerBundle();

      // Smart Auto-Sync on Login: if enabled and >30 mins since last sync (or never synced), show meaningful setup loader & sync!
      const nowMs = Date.now();
      const lastSyncMs = Number(state.lastSyncEpoch || 0);
      const shouldAutoSync = (secConfig.autoSyncOnLogin !== false) && ((nowMs - lastSyncMs) > 30 * 60 * 1000);
      if (shouldAutoSync) {
        try {
          showAppLoader('Refreshing Live Market Data...', 'Updating NIFTY 50, SENSEX & Daily NAVs (Gmail sync is manual via ✉️)', 40);
          await syncLiveMarketIndices();
          if (state.mutualFunds.length > 0 || state.nps.length > 0) {
            await syncLiveNavs();
          }
          state.lastSyncEpoch = Date.now();
          saveState();
        } catch (e) {} finally {
          hideAppLoader();
        }
      }
      showToast(`Welcome, ${currentUserName} (${currentUserRole === 'admin' ? 'Admin' : 'Read-Only'})`);
    }

    function lockAppNow() {
      isAppUnlocked = false;
      clearActiveSession();
      enteredPin = '';
      authScreenTab = 'login';
      document.getElementById('lockErrorMsg').textContent = '';
      closeModal();
      closeProfileSidebar();
      const shell = document.getElementById('mainAppShell');
      if (shell) shell.classList.add('hidden');
      // Wipe sensitive rendered DOM nodes while locked so DevTools inspection cannot read figures behind the lock screen
      ['overviewAssetCards', 'overviewInsightsCard', 'mfList', 'npsList'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
      });
      const nw = document.getElementById('heroNetWorth');
      if (nw) nw.textContent = '₹••••••';
      updateLockScreenUI();
      document.getElementById('appLockScreen').classList.remove('hidden');
    }

    document.getElementById('btnAuthTabLogin').addEventListener('click', () => switchAuthScreenTab('login'));
    document.getElementById('btnAuthTabRegister').addEventListener('click', () => switchAuthScreenTab('register'));

    // Registration Handler (Handles both Initial Owner Setup AND Admin-Authorized New User Creation)
    document.getElementById('btnCompleteRegistration').addEventListener('click', () => {
      const fullName = document.getElementById('regAdminName').value.trim();
      const userPin = document.getElementById('regAdminPin').value.trim();
      const userMobile = (document.getElementById('regAdminMobile') && document.getElementById('regAdminMobile').value.trim()) || '';
      const userEmail = (document.getElementById('regAdminEmail') && document.getElementById('regAdminEmail').value.trim()) || '';
      const q1 = document.getElementById('regSecQ1').value;
      const a1 = document.getElementById('regSecA1').value.trim();
      const q2 = document.getElementById('regSecQ2').value;
      const a2 = document.getElementById('regSecA2').value.trim();
      const errEl = document.getElementById('regErrorMsg');

      if (!fullName) {
        errEl.textContent = 'Please enter the user Full Name.';
        return;
      }
      if (!/^\d{6}$/.test(userPin)) {
        errEl.textContent = 'Login PIN must be exactly 6 digits (0-9).';
        return;
      }

      const isAlreadyRegistered = Boolean(secConfig.registered && secConfig.adminPinHash);

      if (isAlreadyRegistered) {
        // Admin Authorization Gate!
        const authPinOrKey = document.getElementById('regAuthExistingAdminPin').value.trim();
        const newRole = document.getElementById('regNewUserRole').value || 'viewer';
        const authHash = simplePinHash(authPinOrKey);
        const isAuthorizedByAdmin = isAnyAdminPinHash(authHash)
          || (secConfig.recoveryKey && authPinOrKey.toUpperCase() === secConfig.recoveryKey.toUpperCase());

        if (!isAuthorizedByAdmin) {
          errEl.textContent = 'Access Denied: Valid Existing Admin PIN is required to register a new user.';
          return;
        }

        if (!Array.isArray(secConfig.users)) secConfig.users = [];
        secConfig.users.push({
          id: 'usr_' + Date.now(),
          name: fullName,
          mobile: userMobile,
          email: userEmail,
          role: newRole,
          pinHash: simplePinHash(userPin),
          pinLen: 6,
          secQ1: q1,
          secA1Hash: a1 ? simplePinHash(a1) : '',
          secQ2: q2,
          secA2Hash: a2 ? simplePinHash(a2) : ''
        });
        if (newRole === 'viewer' && !secConfig.viewerPinHash) {
          secConfig.viewerName = fullName;
          secConfig.viewerPinHash = simplePinHash(userPin);
        }
        saveSecurityConfig(secConfig);
        document.getElementById('regAuthExistingAdminPin').value = '';
        document.getElementById('regAdminName').value = '';
        document.getElementById('regAdminPin').value = '';
        showToast(`Registered ${fullName} (${newRole.toUpperCase()})!`);
        unlockAppSuccess(newRole, fullName);
        return;
      }

      // First-time Primary Admin Registration
      const viewerName = document.getElementById('regViewerName').value.trim() || 'Family Viewer';
      const viewerPin = document.getElementById('regViewerPin').value.trim();
      if (viewerPin && !/^\d{6}$/.test(viewerPin)) {
        errEl.textContent = 'Optional Viewer PIN must be 6 digits (or leave blank).';
        return;
      }
      if (viewerPin && viewerPin === userPin) {
        errEl.textContent = 'Viewer PIN must be different from Admin PIN.';
        return;
      }
      if (a1.length < 2 || a2.length < 2) {
        errEl.textContent = 'Please answer both Security Questions for Admin PIN recovery.';
        return;
      }

      const recKey = generateRecoveryKey();
      secConfig = {
        registered: true,
        adminName: fullName,
        adminMobile: userMobile,
        adminEmail: userEmail,
        adminPinHash: simplePinHash(userPin),
        adminPinLen: 6,
        viewerName,
        viewerPinHash: viewerPin ? simplePinHash(viewerPin) : '',
        viewerPinLen: viewerPin ? 6 : 0,
        secQ1: q1,
        secA1Hash: simplePinHash(a1),
        secQ2: q2,
        secA2Hash: simplePinHash(a2),
        recoveryKey: recKey,
        bioCredentialId: secConfig.bioCredentialId || '',
        autoLock: true,
        sessionTimeoutMinutes: 30,
        users: []
      };
      saveSecurityConfig(secConfig);
      unlockAppSuccess('admin', fullName);
    });

    document.getElementById('lockProfilePickerList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-select-profile-id]');
      if (!btn) return;
      selectedProfileId = btn.getAttribute('data-select-profile-id');
      enteredPin = '';
      if (!isLockoutActive()) document.getElementById('lockErrorMsg').textContent = '';
      updateLockScreenUI();
    });
    document.getElementById('btnLockSelectAdmin').addEventListener('click', () => selectLockRolePill('admin'));
    document.getElementById('btnLockSelectViewer').addEventListener('click', () => selectLockRolePill('viewer'));

    document.getElementById('btnOpenForgotPin').addEventListener('click', () => {
      if (!secConfig.registered) return;
      document.getElementById('lockKeypadPanel').classList.add('hidden');
      document.getElementById('lockBottomBar').classList.add('hidden');
      document.getElementById('authTopModeSwitcher').classList.add('hidden');
      document.getElementById('lockRecoveryPanel').classList.remove('hidden');
      document.getElementById('recQ1Text').textContent = secConfig.secQ1 || 'Security Question 1 (or enter Master Recovery Key)';
      document.getElementById('recQ2Text').textContent = secConfig.secQ2 || 'Security Question 2';
      document.getElementById('recErrorMsg').textContent = '';
    });

    document.getElementById('btnCancelRecovery').addEventListener('click', () => {
      updateLockScreenUI();
    });

    document.getElementById('btnVerifyAndResetPin').addEventListener('click', () => {
      const a1 = document.getElementById('recA1Input').value.trim();
      const a2 = document.getElementById('recA2Input').value.trim();
      const newPin = document.getElementById('recNewAdminPin').value.trim();
      const errEl = document.getElementById('recErrorMsg');

      if (!/^\d{6}$/.test(newPin)) {
        errEl.textContent = 'Enter a valid new 6-digit Admin PIN.';
        return;
      }
      const matchesQuestions = secConfig.secA1Hash && secConfig.secA2Hash
        && simplePinHash(a1) === secConfig.secA1Hash
        && simplePinHash(a2) === secConfig.secA2Hash;
      const matchesMasterKey = secConfig.recoveryKey && a1.toUpperCase() === secConfig.recoveryKey.toUpperCase();

      if (!matchesQuestions && !matchesMasterKey) {
        errEl.textContent = 'Security answers do not match. Check spelling or use your Recovery Key.';
        return;
      }
      secConfig.adminPinHash = simplePinHash(newPin);
      secConfig.adminPinLen = 6;
      secConfig.failedPinAttempts = 0;
      secConfig.lockoutUntilEpoch = 0;
      saveSecurityConfig(secConfig);
      document.getElementById('recA1Input').value = '';
      document.getElementById('recA2Input').value = '';
      document.getElementById('recNewAdminPin').value = '';
      showToast('Admin PIN reset! Logged in as Admin.');
      unlockAppSuccess('admin', secConfig.adminName);
    });

    async function triggerBiometricAuth() {
      const errEl = document.getElementById('lockErrorMsg');
      errEl.textContent = '';
      if (!window.PublicKeyCredential || !navigator.credentials) {
        errEl.textContent = 'Biometrics unavailable here — enter your 4-digit PIN';
        return;
      }
      try {
        const challenge = new Uint8Array(32);
        window.crypto.getRandomValues(challenge);
        if (!secConfig.bioCredentialId) {
          const userId = new Uint8Array(16);
          window.crypto.getRandomValues(userId);
          const cred = await navigator.credentials.create({
            publicKey: {
              challenge,
              rp: { name: 'WealthLocal Vault' },
              user: { id: userId, name: 'admin@wealthlocal', displayName: secConfig.adminName || 'Admin' },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
              authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
              timeout: 30000
            }
          });
          if (cred && cred.rawId) {
            const b64 = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)));
            secConfig.bioCredentialId = b64;
            saveSecurityConfig(secConfig);
            unlockAppSuccess('admin', secConfig.adminName);
          }
        } else {
          const rawId = Uint8Array.from(atob(secConfig.bioCredentialId), c => c.charCodeAt(0));
          const assertion = await navigator.credentials.get({
            publicKey: {
              challenge,
              allowCredentials: [{ type: 'public-key', id: rawId }],
              userVerification: 'required',
              timeout: 30000
            }
          });
          if (assertion) {
            unlockAppSuccess('admin', secConfig.adminName);
          }
        }
      } catch (err) {
        errEl.textContent = 'Enter your 4-digit PIN above';
      }
    }

    function handlePinDigit(digit) {
      if (isLockoutActive()) {
        startLockoutCountdownIfNeeded();
        return;
      }
      if (enteredPin.length >= 6) return;
      enteredPin += String(digit);
      document.getElementById('lockErrorMsg').textContent = '';
      updateLockScreenUI();

      const activeProf = getSelectedLockProfile();
      if (!activeProf) return;

      // Strict 6-Digit PIN check

      if (enteredPin.length === 6) {
        setTimeout(() => {
          const hash6 = simplePinHash(enteredPin);
          if (hash6 === activeProf.pinHash) {
            unlockAppSuccess(activeProf.role, activeProf.name);
          } else {
            recordFailedPinAttempt();
          }
        }, 120);
      }
    }

    function recordFailedPinAttempt() {
      const dotsBox = document.getElementById('pinDotsContainer');
      dotsBox.classList.add('pin-shake');
      setTimeout(() => dotsBox.classList.remove('pin-shake'), 400);
      enteredPin = '';
      secConfig.failedPinAttempts = Number(secConfig.failedPinAttempts || 0) + 1;
      if (secConfig.failedPinAttempts >= 5) {
        secConfig.lockoutUntilEpoch = Date.now() + 15 * 60 * 1000; // 15-minute brute-force lockout
        saveSecurityConfig(secConfig);
        updateLockScreenUI();
        startLockoutCountdownIfNeeded();
      } else {
        saveSecurityConfig(secConfig);
        const rem = 5 - secConfig.failedPinAttempts;
        document.getElementById('lockErrorMsg').textContent = `Incorrect PIN — ${rem} attempt${rem === 1 ? '' : 's'} left before 15m lockout`;
        updateLockScreenUI();
      }
    }

    document.querySelectorAll('.pin-key').forEach(btn => {
      btn.addEventListener('click', () => handlePinDigit(btn.getAttribute('data-pin-key')));
    });
    document.getElementById('btnPinBackspace').addEventListener('click', () => {
      if (enteredPin.length > 0) {
        enteredPin = enteredPin.slice(0, -1);
        updateLockScreenUI();
      }
    });
    document.getElementById('btnBiometricUnlock').addEventListener('click', () => {
      if (!secConfig.biometricsEnabled) {
        enteredPin = '';
        document.getElementById('lockErrorMsg').textContent = '';
        updateLockScreenUI();
        return;
      }
      triggerBiometricAuth();
    });
    const bioToggleEl = document.getElementById('profBiometricToggle');
    if (bioToggleEl) {
      bioToggleEl.addEventListener('change', (e) => {
        if (currentUserRole !== 'admin') return;
        secConfig.biometricsEnabled = Boolean(e.target.checked);
        saveSecurityConfig(secConfig);
        updateLockScreenUI();
        showToast(secConfig.biometricsEnabled
          ? 'Biometric Login enabled (works on direct HTTPS origins)'
          : 'Biometric Login disabled (PIN-only mode)');
      });
    }
    document.getElementById('btnTriggerBiometricPrompt').addEventListener('click', triggerBiometricAuth);
    document.getElementById('btnLockAppNow').addEventListener('click', lockAppNow);

    // Keep session alive while interacting, and only lock when away longer than sessionTimeoutMinutes (default 30 mins!)
    document.addEventListener('click', () => {
      if (document.getElementById('appLockScreen').classList.contains('hidden')) {
        saveActiveSession(currentUserRole, currentUserName);
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!isSessionStillValid()) {
          lockAppNow();
        }
      }
    });

    const THEME_STORAGE_KEY = 'wealthlocal_theme_v17';

    function getActiveThemeMode() {
      try {
        return localStorage.getItem(THEME_STORAGE_KEY) || (secConfig && secConfig.theme) || 'dark';
      } catch (e) {
        return 'dark';
      }
    }

    function applyThemePreference(mode) {
      const isLight = mode === 'light';
      document.documentElement.classList.toggle('light-theme', isLight);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, isLight ? 'light' : 'dark');
      } catch (e) {}
      if (secConfig) {
        secConfig.theme = isLight ? 'light' : 'dark';
      }
      document.querySelectorAll('.theme-toggle-icon').forEach(el => {
        el.textContent = isLight ? '🌙' : '☀️';
      });
      document.querySelectorAll('.theme-toggle-label').forEach(el => {
        el.textContent = isLight ? 'Dark' : 'Light';
      });
      const metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) {
        metaTheme.setAttribute('content', isLight ? '#f1f5f9' : '#070b14');
      }
    }

    function toggleAppTheme() {
      const nextMode = getActiveThemeMode() === 'light' ? 'dark' : 'light';
      applyThemePreference(nextMode);
      saveSecurityConfig(secConfig);
      showToast(nextMode === 'light' ? '☀️ Switched to Light Theme' : '🌙 Switched to Dark Theme');
    }

    applyThemePreference(getActiveThemeMode());
    ['btnToggleTheme', 'btnLockToggleTheme', 'btnSidebarToggleTheme'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', toggleAppTheme);
    });

    // Hard Reload / Cache Refresh Button in Profile Sidebar
    const btnHardReload = document.getElementById('btnSidebarHardReload');
    if (btnHardReload) {
      btnHardReload.addEventListener('click', async () => {
        showToast('Reloading latest app version...');
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            for (const r of regs) await r.unregister();
          }
          if ('caches' in window) {
            const keys = await caches.keys();
            for (const k of keys) await caches.delete(k);
          }
        } catch (e) {}
        window.location.reload();
      });
    }

    // Native Android Hardware Back Button / Back Swipe Gesture Handler (`popstate`)
    try {
      history.replaceState({ wlView: 'root_home' }, '');
    } catch (e) {}
    window.addEventListener('popstate', () => {
      if (!isAppUnlocked) return;
      isHandlingPopState = true;
      try {
        const modalEl = document.getElementById('modalBackdrop');
        if (modalEl && !modalEl.classList.contains('hidden')) {
          closeModal();
          return;
        }
        const sideEl = document.getElementById('profileSidebarBackdrop');
        if (sideEl && !sideEl.classList.contains('hidden')) {
          closeProfileSidebar();
          return;
        }
        const mfDet = document.getElementById('mfDetailScreenView');
        if (mfDet && !mfDet.classList.contains('hidden')) {
          backToMfDashboard();
          return;
        }
        const npsDet = document.getElementById('npsDetailScreenView');
        if (npsDet && !npsDet.classList.contains('hidden')) {
          backToNpsDashboard();
          return;
        }
        if (activeTab !== 'overview') {
          switchTab('overview', true);
          return;
        }
      } finally {
        isHandlingPopState = false;
      }
    });

    // Native Mobile Pull-to-Refresh Gesture on `#appMainScroll`
    (function initPullToRefresh() {
      const scrollEl = document.getElementById('appMainScroll');
      const ptrBar = document.getElementById('pullToRefreshBar');
      const ptrText = document.getElementById('ptrStatusText');
      if (!scrollEl || !ptrBar) return;
      let startY = 0;
      let pulling = false;
      let triggered = false;

      scrollEl.addEventListener('touchstart', (e) => {
        if (scrollEl.scrollTop <= 2 && e.touches && e.touches.length === 1) {
          startY = e.touches[0].clientY;
          pulling = true;
          triggered = false;
        } else {
          pulling = false;
        }
      }, { passive: true });

      scrollEl.addEventListener('touchmove', (e) => {
        if (!pulling || scrollEl.scrollTop > 2) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 28) {
          ptrBar.classList.remove('hidden');
          if (dy > 85) {
            if (!triggered) triggerHaptic(12);
            triggered = true;
            if (ptrText) ptrText.textContent = 'Release to refresh live NAVs...';
          } else {
            triggered = false;
            if (ptrText) ptrText.textContent = 'Pull down to refresh...';
          }
        }
      }, { passive: true });

      scrollEl.addEventListener('touchend', async () => {
        if (!pulling) return;
        pulling = false;
        if (triggered) {
          if (ptrText) ptrText.textContent = 'Refreshing live NAVs & market data...';
          await syncLiveNavs();
          setTimeout(() => { ptrBar.classList.add('hidden'); }, 350);
        } else {
          ptrBar.classList.add('hidden');
        }
        triggered = false;
      }, { passive: true });
    })();

    function openSettingsModal() {
      openProfileSidebar();
    }
    document.getElementById('btnCloseProfileSidebar').addEventListener('click', closeProfileSidebar);
    document.getElementById('profileSidebarBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'profileSidebarBackdrop') closeProfileSidebar();
    });

    // Wire up Native Profile & Settings Tab Controls
    document.getElementById('btnSwitchUserLock').addEventListener('click', () => {
      lockAppNow();
      showToast('Logged out safely');
    });

    const gasUrlInputEl = document.getElementById('profGasBridgeUrlInput');
    if (gasUrlInputEl) gasUrlInputEl.value = state.gmailWebhookUrl || localStorage.getItem('wl_gas_bridge_url') || '';
    const btnSaveGasUrl = document.getElementById('btnSaveGasBridgeUrl');
    if (btnSaveGasUrl) {
      btnSaveGasUrl.addEventListener('click', () => {
        if (currentUserRole !== 'admin') return;
        const u = (document.getElementById('profGasBridgeUrlInput').value || '').trim();
        state.gmailWebhookUrl = u;
        localStorage.setItem('wl_gas_bridge_url', u);
        saveState();
        showToast(u ? 'Saved Personal Apps Script Bridge URL!' : 'Cleared Apps Script Bridge URL');
      });
    }

    document.getElementById('btnSaveProfileDetails').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      secConfig.adminName = document.getElementById('profInputName').value.trim() || 'Admin';
      secConfig.adminMobile = document.getElementById('profInputMobile').value.trim();
      secConfig.adminEmail = document.getElementById('profInputEmail').value.trim();
      currentUserName = secConfig.adminName;
      saveSecurityConfig(secConfig);
      saveActiveSession(currentUserRole, currentUserName);
      renderProfileTab();
      showToast('Profile details saved!');
    });

    // Remove User from Directory
    document.getElementById('profileUsersDirectoryList').addEventListener('click', (e) => {
      if (currentUserRole !== 'admin') return;
      const remPrimaryViewer = e.target.closest('[data-remove-primary-viewer]');
      if (remPrimaryViewer) {
        secConfig.viewerPinHash = '';
        saveSecurityConfig(secConfig);
        renderProfileTab();
        showToast('Read-Only Viewer removed');
        return;
      }
      const remUserBtn = e.target.closest('[data-remove-user-id]');
      if (remUserBtn) {
        const uid = remUserBtn.getAttribute('data-remove-user-id');
        secConfig.users = (secConfig.users || []).filter(u => u.id !== uid);
        saveSecurityConfig(secConfig);
        renderProfileTab();
        showToast('User profile removed');
      }
    });

    // Modal 1: Create New User / Role (Authorized by Current Admin PIN)
    document.getElementById('btnOpenAddUserModal').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      openModal('Create New User Profile', `
        <div class="space-y-3 text-xs">
          <div class="rounded-xl bg-emerald-500/10 border border-emerald-500/30 p-3 text-slate-300">
            Create a <strong>Read-Only Viewer</strong> (for family members to view holdings without editing) or a <strong>Co-Admin</strong>.
          </div>
          <div>
            <label class="block text-[10px] uppercase font-bold text-slate-400 mb-1">Full Name *</label>
            <input id="modalNewUserName" type="text" placeholder="e.g. Family Member Name" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white font-semibold" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-[10px] uppercase font-bold text-slate-400 mb-1">Role *</label>
              <select id="modalNewUserRole" class="w-full px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white font-bold">
                <option value="viewer">👁️ Read-Only Viewer</option>
                <option value="admin">👑 Co-Admin</option>
              </select>
            </div>
            <div>
              <label class="block text-[10px] uppercase font-bold text-slate-400 mb-1">Email / Note (Optional)</label>
              <input id="modalNewUserEmail" type="text" placeholder="Optional" class="w-full px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            </div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-[10px] uppercase font-bold text-sky-400 mb-1">Set 6-Digit PIN *</label>
              <input id="modalNewUserPin1" type="password" inputmode="numeric" maxlength="6" placeholder="6 digits" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white text-center tracking-widest font-bold" />
            </div>
            <div>
              <label class="block text-[10px] uppercase font-bold text-sky-400 mb-1">Confirm 6-Digit PIN *</label>
              <input id="modalNewUserPin2" type="password" inputmode="numeric" maxlength="6" placeholder="Repeat 6 digits" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white text-center tracking-widest font-bold" />
            </div>
          </div>
          <div class="pt-2 border-t border-slate-800">
            <label class="block text-[10px] uppercase font-bold text-amber-400 mb-1">Authorize with Your Current Admin PIN *</label>
            <input id="modalAuthAdminPinForUser" type="password" inputmode="numeric" maxlength="6" placeholder="Enter your current Admin PIN" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-amber-500/50 text-white text-center tracking-widest font-bold" />
          </div>
          <p id="modalAddUserErr" class="text-[11px] font-semibold text-rose-400 min-h-[16px]"></p>
          <button type="button" id="btnConfirmCreateUser" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold">
            Verify &amp; Create User
          </button>
        </div>
      `);

      document.getElementById('btnConfirmCreateUser').addEventListener('click', () => {
        const uName = document.getElementById('modalNewUserName').value.trim();
        const uRole = document.getElementById('modalNewUserRole').value;
        const uEmail = document.getElementById('modalNewUserEmail').value.trim();
        const p1 = document.getElementById('modalNewUserPin1').value.trim();
        const p2 = document.getElementById('modalNewUserPin2').value.trim();
        const adminPin = document.getElementById('modalAuthAdminPinForUser').value.trim();
        const errEl = document.getElementById('modalAddUserErr');

        if (!uName) { errEl.textContent = 'Enter a name for the user.'; return; }
        if (!/^\d{6}$/.test(p1)) { errEl.textContent = 'New PIN must be exactly 6 digits.'; return; }
        if (p1 !== p2) { errEl.textContent = 'PIN and Confirm PIN do not match.'; return; }
        if (!isAnyAdminPinHash(simplePinHash(adminPin))) {
          errEl.textContent = 'Incorrect Current Admin PIN — authorization failed.';
          return;
        }
        const newHash = simplePinHash(p1);
        if (uRole === 'viewer' && !secConfig.viewerPinHash) {
          secConfig.viewerName = uName;
          secConfig.viewerPinHash = newHash;
          secConfig.viewerPinLen = 6;
        } else {
          if (!Array.isArray(secConfig.users)) secConfig.users = [];
          secConfig.users.push({
            id: 'usr_' + Date.now(),
            name: uName,
            email: uEmail,
            role: uRole,
            pinHash: newHash,
            pinLen: 6
          });
        }
        saveSecurityConfig(secConfig);
        closeModal();
        renderProfileTab();
        showToast(`Created ${uName} (${uRole === 'admin' ? 'Co-Admin' : 'Read-Only Viewer'})!`);
      });
    });

    // Modal 2: Change My Admin PIN (Requires Current Admin PIN + New PIN + Confirm PIN)
    document.getElementById('btnOpenChangePinModal').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      openModal('Change Admin 6-Digit PIN', `
        <div class="space-y-3 text-xs">
          <div>
            <label class="block text-[10px] uppercase font-bold text-amber-400 mb-1">Current 6-Digit Admin PIN *</label>
            <input id="modalCurAdminPin" type="password" inputmode="numeric" maxlength="6" placeholder="Enter current PIN" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white text-center tracking-widest font-bold" />
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="block text-[10px] uppercase font-bold text-emerald-400 mb-1">New 6-Digit PIN *</label>
              <input id="modalNewAdminPin1" type="password" inputmode="numeric" maxlength="6" placeholder="New PIN" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-emerald-500/50 text-white text-center tracking-widest font-bold" />
            </div>
            <div>
              <label class="block text-[10px] uppercase font-bold text-emerald-400 mb-1">Confirm New PIN *</label>
              <input id="modalNewAdminPin2" type="password" inputmode="numeric" maxlength="6" placeholder="Confirm PIN" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-emerald-500/50 text-white text-center tracking-widest font-bold" />
            </div>
          </div>
          <p id="modalChangePinErr" class="text-[11px] font-semibold text-rose-400 min-h-[16px]"></p>
          <button type="button" id="btnConfirmChangeAdminPin" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold">
            Verify &amp; Update Admin PIN
          </button>
        </div>
      `);

      document.getElementById('btnConfirmChangeAdminPin').addEventListener('click', () => {
        const cur = document.getElementById('modalCurAdminPin').value.trim();
        const p1 = document.getElementById('modalNewAdminPin1').value.trim();
        const p2 = document.getElementById('modalNewAdminPin2').value.trim();
        const errEl = document.getElementById('modalChangePinErr');

        if (simplePinHash(cur) !== secConfig.adminPinHash) {
          errEl.textContent = 'Current Admin PIN is incorrect.';
          return;
        }
        if (!/^\d{6}$/.test(p1)) {
          errEl.textContent = 'New PIN must be 6 digits.';
          return;
        }
        if (p1 !== p2) {
          errEl.textContent = 'New PIN and Confirm PIN do not match.';
          return;
        }
        secConfig.adminPinHash = simplePinHash(p1);
        secConfig.adminPinLen = 6;
        saveSecurityConfig(secConfig);
        closeModal();
        showToast('Admin PIN updated successfully!');
      });
    });

    // Modal 3: Security Recovery Questions & Protected Master Recovery Key
    document.getElementById('btnOpenRecoverySettingsModal').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      openModal('Security Recovery Questions & Master Key', `
        <div class="space-y-3 text-xs">
          <div class="rounded-xl bg-surface-800 border border-slate-700 p-3 space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-slate-400 font-semibold">Master Recovery Key:</span>
              <button type="button" id="btnRevealMasterKey" class="text-amber-400 font-bold hover:underline">Tap to Reveal</button>
            </div>
            <code id="modalMasterKeyBox" class="hidden block text-center py-1.5 rounded bg-surface-900 text-amber-300 font-extrabold select-all">${secConfig.recoveryKey || 'WL-ADMIN-KEY'}</code>
          </div>
          <div class="space-y-2 pt-1">
            <p class="font-bold text-slate-200">Update Security Recovery Questions</p>
            <input id="modalUpdQ1" type="text" value="${secConfig.secQ1 || 'What was the model of your first vehicle?'}" class="w-full px-3 py-1.5 rounded-xl bg-surface-800 border border-slate-700 text-slate-200" />
            <input id="modalUpdA1" type="text" placeholder="New Answer 1" class="w-full px-3 py-1.5 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="modalUpdQ2" type="text" value="${secConfig.secQ2 || 'What is the name of your hometown?'}" class="w-full px-3 py-1.5 rounded-xl bg-surface-800 border border-slate-700 text-slate-200" />
            <input id="modalUpdA2" type="text" placeholder="New Answer 2" class="w-full px-3 py-1.5 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="modalUpdRecPin" type="password" inputmode="numeric" maxlength="6" placeholder="Verify with Current Admin PIN *" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-amber-500/50 text-white text-center font-bold" />
          </div>
          <p id="modalRecUpdErr" class="text-[11px] font-semibold text-rose-400 min-h-[16px]"></p>
          <button type="button" id="btnSaveUpdatedRecoveryQs" class="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">
            Save Security Questions
          </button>
        </div>
      `);

      document.getElementById('btnRevealMasterKey').addEventListener('click', () => {
        document.getElementById('modalMasterKeyBox').classList.toggle('hidden');
      });

      document.getElementById('btnSaveUpdatedRecoveryQs').addEventListener('click', () => {
        const q1 = document.getElementById('modalUpdQ1').value.trim();
        const a1 = document.getElementById('modalUpdA1').value.trim();
        const q2 = document.getElementById('modalUpdQ2').value.trim();
        const a2 = document.getElementById('modalUpdA2').value.trim();
        const pin = document.getElementById('modalUpdRecPin').value.trim();
        const errEl = document.getElementById('modalRecUpdErr');

        if (simplePinHash(pin) !== secConfig.adminPinHash) {
          errEl.textContent = 'Incorrect Current Admin PIN.';
          return;
        }
        if (a1.length < 2 || a2.length < 2) {
          errEl.textContent = 'Enter answers for both questions.';
          return;
        }
        secConfig.secQ1 = q1;
        secConfig.secA1Hash = simplePinHash(a1);
        secConfig.secQ2 = q2;
        secConfig.secA2Hash = simplePinHash(a2);
        saveSecurityConfig(secConfig);
        closeModal();
        showToast('Security Recovery Questions updated!');
      });
    });

    // Session Timeout & Auto-Sync on Login toggles
    document.getElementById('profSessionTimeoutSelect').addEventListener('change', (e) => {
      if (currentUserRole !== 'admin') return;
      const timeoutVal = parseInt(e.target.value, 10) || 30;
      secConfig.sessionTimeoutMinutes = timeoutVal;
      saveSecurityConfig(secConfig);
      saveActiveSession(currentUserRole, currentUserName);
      renderProfileTab();
      showToast(`Session timeout set to ${timeoutVal} minutes`);
    });

    document.getElementById('profAutoSyncLoginToggle').addEventListener('change', (e) => {
      if (currentUserRole !== 'admin') return;
      secConfig.autoSyncOnLogin = Boolean(e.target.checked);
      saveSecurityConfig(secConfig);
      showToast(secConfig.autoSyncOnLogin ? 'Auto-Sync on Login enabled' : 'Auto-Sync on Login disabled');
    });

    document.getElementById('btnTabExportEncVault').addEventListener('click', async () => {
      if (currentUserRole !== 'admin') return;
      const pass = document.getElementById('profVaultPassphrase').value.trim() || secConfig.adminPinHash;
      try {
        const cipherJson = await encryptJsonAesGcm(state, pass);
        const blob = new Blob([cipherJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wealthlocal-vault.enc.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast('AES-256-GCM Encrypted Vault downloaded!');
      } catch (err) {
        showToast('Encryption error: ' + err.message);
      }
    });

    document.getElementById('btnTabCloudDriveSync').addEventListener('click', async () => {
      if (currentUserRole !== 'admin') return;
      syncServerBundle();
      showToast('Synced portfolio & users to Apps Script Cloud Storage!');
    });

    const btnResetVault = document.getElementById('btnFactoryResetVault');
    if (btnResetVault) {
      btnResetVault.addEventListener('click', () => {
        if (currentUserRole !== 'admin') {
          showToast('Only an Admin can factory-reset the vault');
          return;
        }
        openModal('Factory Reset Vault (Start at ₹0.00)', `
          <div class="space-y-3 text-xs">
            <div class="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-rose-200 leading-relaxed">
              <strong>Warning:</strong> This permanently clears your encrypted portfolio and Admin/User PIN credentials from both <strong>Browser LocalStorage</strong> and <strong>Google Apps Script PropertiesService</strong>, resetting the app to <strong>₹0.00</strong> and prompting for fresh 6-digit Admin creation.
            </div>
            <div>
              <label class="block text-slate-400 mb-1">Enter Current 6-Digit Admin PIN to Confirm Wipe *</label>
              <input id="modalResetConfirmPin" type="password" inputmode="numeric" maxlength="6" placeholder="6-digit Admin PIN" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white font-bold tracking-widest" />
            </div>
            <p id="modalResetErr" class="text-rose-400 font-semibold"></p>
            <button id="btnConfirmFactoryResetNow" type="button" class="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold">Wipe Cloud &amp; Local Data Now</button>
          </div>
        `);
        document.getElementById('btnConfirmFactoryResetNow').addEventListener('click', () => {
          const pin = (document.getElementById('modalResetConfirmPin').value || '').trim();
          if (!isAnyAdminPinHash(simplePinHash(pin))) {
            document.getElementById('modalResetErr').textContent = 'Incorrect 6-digit Admin PIN.';
            return;
          }
          try {
            localStorage.clear();
          } catch (e) {}
          state = JSON.parse(JSON.stringify(EMPTY_STATE));
          secConfig = loadSecurityConfig();
          if (typeof window.google !== 'undefined' && window.google.script && window.google.script.run) {
            window.google.script.run
              .withSuccessHandler(() => {
                closeModal();
                closeProfileSidebar();
                lockAppNow();
                showToast('Vault wiped to ₹0.00 — Create your new 6-digit Admin account');
              })
              .withFailureHandler(() => {
                closeModal();
                closeProfileSidebar();
                lockAppNow();
              })
              .clearServerAppBundle();
          } else {
            closeModal();
            closeProfileSidebar();
            lockAppNow();
            showToast('Local vault wiped to ₹0.00 — Create your new 6-digit Admin account');
          }
        });
      });
    }

    document.getElementById('btnInspectRawStorage').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      const isGas = typeof window.google !== 'undefined' && window.google.script && window.google.script.run;
      const locPortfolio = localStorage.getItem(STORAGE_KEY) || '{}';
      const locSecurity = localStorage.getItem(SECURITY_KEY) || '{}';
      const locCipher = localStorage.getItem(VAULT_CIPHER_KEY) || '(none)';
      const summaryObj = {
        storageEnvironment: isGas ? 'Google Apps Script Web App (Browser localStorage + Your Google Account Script Properties)' : 'Local HTML / Browser Only (Browser localStorage on this device)',
        browserLocalStorageKeys: {
          [STORAGE_KEY]: JSON.parse(locPortfolio),
          [SECURITY_KEY]: JSON.parse(locSecurity),
          [VAULT_CIPHER_KEY]: locCipher.slice(0, 80) + (locCipher.length > 80 ? '... [AES-256-GCM encrypted]' : '')
        }
      };
      openModal('Raw Data & Storage Inspector', `
        <div class="space-y-3 text-xs">
          <div class="rounded-xl bg-surface-800 border border-slate-700 p-3 space-y-1.5 text-[11px] text-slate-300">
            <p><strong class="text-emerald-400">1. On-Device Browser Storage (<code>localStorage</code>):</strong> Stored locally inside your phone/laptop browser under keys <code>${STORAGE_KEY}</code> and <code>${SECURITY_KEY}</code>.</p>
            <p><strong class="text-amber-300">2. Google Apps Script Cloud Property (When using Web App URL):</strong> Stored privately in your own Google Account's <code>PropertiesService.getScriptProperties()</code> under key <code>WEALTHLOCAL_APP_BUNDLE_V7</code> (Viewable at <em>script.google.com → Project Settings ⚙️ → Script Properties</em>).</p>
            <p><strong class="text-sky-300">3. Zero External Servers:</strong> Gemini or third parties have zero access to this storage.</p>
          </div>
          <pre class="rounded-xl bg-black/80 border border-slate-800 p-3 text-[10px] text-emerald-300 overflow-x-auto max-h-64 whitespace-pre-wrap">${JSON.stringify(summaryObj, null, 2).replace(/</g, '&lt;')}</pre>
        </div>
      `);
    });

    document.getElementById('btnTabExportPlainJson').addEventListener('click', () => {
      if (currentUserRole !== 'admin') return;
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wealthlocal-backup.json';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Plain JSON Backup downloaded');
    });

    document.getElementById('btnTabSaveSelfHtml').addEventListener('click', () => {
      const fullHtml = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      const blob = new Blob([fullHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'portfolio_tracker.html';
      a.click();
      URL.revokeObjectURL(url);
      showToast('Saved portfolio_tracker.html');
    });

    document.getElementById('profInputRestoreFile').addEventListener('change', (e) => {
      if (currentUserRole !== 'admin') return;
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (parsed && parsed.v === 'WL-AES256-GCM-V6' && parsed.ct) {
            const passInput = document.getElementById('profVaultPassphrase').value.trim();
            let restored = null;
            const candidates = [passInput, secConfig.adminPinHash].filter(Boolean);
            for (const cand of candidates) {
              try {
                restored = await decryptJsonAesGcm(parsed, cand);
                if (restored) break;
              } catch (e2) {}
            }
            if (!restored) {
              showToast('Wrong Vault Passphrase — enter the passphrase above first');
              return;
            }
            state = sanitizeNpsState(restored);
          } else {
            state = sanitizeNpsState(parsed);
          }
          saveState();
          syncLocalEncryptedMirror();
          renderAll();
          showToast('Portfolio restored successfully!');
        } catch (err) {
          showToast('Invalid backup file');
        }
      };
      reader.readAsText(file);
    });

    // Event Listeners
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
    });

    document.getElementById('overviewAssetCards').addEventListener('click', (e) => {
      const card = e.target.closest('[data-drill-tab]');
      if (!card) return;
      const tab = card.getAttribute('data-drill-tab');
      const sub = card.getAttribute('data-drill-sub');
      switchTab(tab, sub);
    });

    document.getElementById('btnTogglePrivacy').addEventListener('click', () => {
      privacyMasked = !privacyMasked;
      renderAll();
      showToast(privacyMasked ? 'Balances hidden' : 'Balances visible');
    });

    document.getElementById('btnToggleHeroDetails').addEventListener('click', () => {
      const drawer = document.getElementById('heroExpandedDrawer');
      const lbl = document.getElementById('heroExpandLabel');
      const isHidden = drawer.classList.toggle('hidden');
      lbl.textContent = isHidden ? 'Tap for details ▾' : 'Hide details ▴';
    });

    document.getElementById('btnToggleChartDrawer').addEventListener('click', () => {
      const drawer = document.getElementById('overviewChartDrawer');
      const chev = document.getElementById('chartDrawerChevron');
      const isHidden = drawer.classList.toggle('hidden');
      chev.textContent = isHidden ? '▾' : '▴';
      if (!isHidden) renderAllocationChart(computeTotals());
    });

    document.getElementById('btnToggleMarketDrawer').addEventListener('click', () => {
      const drawer = document.getElementById('overviewMarketDrawer');
      const chev = document.getElementById('marketDrawerChevron');
      const isHidden = drawer.classList.toggle('hidden');
      chev.textContent = isHidden ? '▾' : '▴';
      if (!isHidden) syncLiveMarketIndices();
    });

    document.getElementById('btnCycleMfViewMode').addEventListener('click', () => {
      const modes = ['day', 'returns', 'invested'];
      const labels = { day: 'Day Change (%)', returns: 'Total Returns (%)', invested: 'Current (Invested)' };
      const nextIdx = (modes.indexOf(mfViewMode) + 1) % modes.length;
      mfViewMode = modes[nextIdx];
      document.getElementById('mfViewModeLabel').textContent = labels[mfViewMode];
      renderMutualFunds();
    });

    document.getElementById('btnMfSubDashboard').addEventListener('click', () => {
      mfSubTabMode = 'dashboard';
      document.getElementById('btnMfSubDashboard').className = 'pb-2.5 border-b-2 border-white text-white transition';
      document.getElementById('btnMfSubSips').className = 'pb-2.5 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition';
      renderMutualFunds();
    });

    document.getElementById('btnMfSubSips').addEventListener('click', () => {
      mfSubTabMode = 'sips';
      document.getElementById('btnMfSubSips').className = 'pb-2.5 border-b-2 border-white text-white transition';
      document.getElementById('btnMfSubDashboard').className = 'pb-2.5 border-b-2 border-transparent text-slate-400 hover:text-slate-200 transition';
      renderMutualFunds();
    });

    document.getElementById('mfSummaryCard').addEventListener('click', (e) => {
      if (e.target.closest('[data-mf-card-eye]')) {
        privacyMasked = !privacyMasked;
        renderAll();
        showToast(privacyMasked ? 'Balances hidden' : 'Balances visible');
      }
    });

    document.getElementById('btnMfSyncGmail').addEventListener('click', openGmailSyncModal);

    document.getElementById('btnSelectEpfSubtab').addEventListener('click', () => selectRetiralSubtab('epf'));
    document.getElementById('btnSelectPpfSubtab').addEventListener('click', () => selectRetiralSubtab('ppf'));

    document.getElementById('btnOpenGuideFromBanner').addEventListener('click', () => switchTab('guide'));
    document.getElementById('btnRefreshNav').addEventListener('click', syncLiveNavs);
    document.getElementById('btnOpenSettings').addEventListener('click', openSettingsModal);
    document.getElementById('btnCloseModal').addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modalBackdrop') closeModal();
    });

    document.getElementById('btnQuickAddMf').addEventListener('click', openAddMfModal);
    document.getElementById('btnAddMf').addEventListener('click', openAddMfModal);
    document.getElementById('btnAddNps').addEventListener('click', openAddNpsModal);
    document.getElementById('btnImportMfExcel').addEventListener('click', () => openExcelImportModal('mf'));
    document.getElementById('btnImportNpsExcel').addEventListener('click', () => openExcelImportModal('nps'));
    document.getElementById('btnImportRetiralExcel').addEventListener('click', () => openExcelImportModal('retiral'));
    document.getElementById('btnOpenEpfLedgerBtn').addEventListener('click', openEpfPassbookModal);
    document.getElementById('btnEditEpf').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentUserRole !== 'admin') return;
      openRetiralEditModal('epf');
    });
    document.getElementById('btnOpenPpfLedgerBtn').addEventListener('click', openPpfPassbookModal);
    document.getElementById('btnEditPpf').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentUserRole !== 'admin') return;
      openRetiralEditModal('ppf');
    });

    document.getElementById('btnLogEpfMonth').addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentUserRole !== 'admin') return;
      if (state.epf.monthlyContribution <= 0) {
        openRetiralEditModal('epf');
        showToast('Set your monthly EPF contribution first');
        return;
      }
      const now = new Date();
      const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wageMonth = `${monthsShort[now.getMonth()]}-${now.getFullYear()}`;
      const todayIso = now.toISOString().slice(0, 10);
      if (!Array.isArray(state.epf.installments)) state.epf.installments = [];
      if (state.epf.installments.some(x => x.wageMonth === wageMonth)) {
        showToast(`${wageMonth} EPF contribution is already logged!`);
        return;
      }
      const empS = state.epf.latestEmpShare || Math.round(state.epf.monthlyContribution * 0.75);
      const emprS = state.epf.latestEmprShare || (state.epf.monthlyContribution - empS);
      const penS = state.epf.latestPensionShare || 1250;
      state.epf.installments.unshift({
        id: 'epf_' + Date.now(),
        wageMonth: wageMonth,
        date: todayIso,
        epfWage: 0,
        empShare: empS,
        emprShare: emprS,
        pensionShare: penS
      });
      if (state.epf.installments.length > 1) {
        recalculateEpfFromPassbook();
      } else {
        state.epf.balance += state.epf.monthlyContribution;
        state.epf.invested += state.epf.monthlyContribution;
      }
      saveState();
      renderAll();
      showToast(`Logged ${wageMonth} (${formatINR(state.epf.monthlyContribution)}) to EPF Passbook`);
    });

    document.getElementById('btnLogPpfMonth').addEventListener('click', (e) => {
      e.stopPropagation();
      openPpfPassbookModal();
    });

    async function openMfHistoryModal(fundId) {
      const fund = state.mutualFunds.find(f => f.id === fundId);
      if (!fund) return;
      const isAdmin = currentUserRole === 'admin';
      if (!Array.isArray(fund.installments)) fund.installments = [];
      const instList = fund.installments;
      const val = fund.units * fund.currentNav;
      const gain = val - fund.invested;
      const pct = fund.invested > 0 ? (gain / fund.invested) * 100 : 0;
      const dayChange = fund.units * (fund.currentNav - fund.prevNav);
      const prevVal = val - dayChange;
      const dayPct = prevVal > 0 ? (dayChange / prevVal) * 100 : 0;
      const avgBuyNav = fund.units > 0 ? (fund.invested / fund.units) : 0;
      const fundXirr = computeHoldingXirrPct(instList, val, fund.invested);

      // Compute Long term (>1Y) vs Short term (<1Y) holding value from installments
      const oneYrAgoIso = new Date(Date.now() - 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      let ltUnits = 0;
      instList.forEach(inst => {
        if (String(inst.date || '') <= oneYrAgoIso) ltUnits += Number(inst.units || 0);
      });
      if (ltUnits > fund.units) ltUnits = fund.units;
      const ltVal = ltUnits * fund.currentNav;
      const stVal = Math.max(0, val - ltVal);

      // Switch to Full-Screen Investment Details View (Groww style screenshots 1000214957.png & 1000214958.png)
      pushNavState('detail_mf');
      document.getElementById('mfDashboardSubView').classList.add('hidden');
      const screenEl = document.getElementById('mfDetailScreenView');
      screenEl.classList.remove('hidden');
      document.getElementById('appMainScroll').scrollTop = 0;

      const rowsHtml = instList.length > 0
        ? instList.map(inst => `
            <div class="flex items-center justify-between py-2.5 border-b border-slate-800/80 text-xs">
              <div>
                <p class="font-semibold text-white">${inst.date}</p>
                <p class="text-[11px] text-slate-400">NAV: ₹${Number(inst.nav).toFixed(4)} • +${Number(inst.units).toFixed(3)} units</p>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-emerald-400">${formatINRPrecise(inst.amount)}</span>
                ${isAdmin ? `<button type="button" data-del-inst="${inst.id}" class="text-slate-500 hover:text-rose-400 px-1">✕</button>` : ''}
              </div>
            </div>
          `).join('')
        : `<div class="rounded-xl bg-surface-900 border border-slate-800 p-4 text-center text-slate-400 text-xs">
             No individual monthly SIP rows logged yet.
           </div>`;

      screenEl.innerHTML = `
        <!-- Top Back Navigation Bar (Exact Groww "← Investment details" bar) -->
        <div class="flex items-center justify-between pb-2 border-b border-slate-800/80">
          <button type="button" id="btnBackFromMfScreen" class="inline-flex items-center gap-2.5 text-sm font-bold text-white hover:text-emerald-400 transition active:scale-95">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
            <span>Investment details</span>
          </button>
          <span class="text-[11px] px-2.5 py-0.5 rounded-full bg-surface-900 border border-slate-800 text-slate-400">AMFI ${fund.schemeCode}</span>
        </div>

        <!-- Fund Identity Header -->
        <div class="flex items-start gap-3 pt-1">
          <div class="w-11 h-11 shrink-0 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 border border-slate-700/80 flex items-center justify-center text-xs font-extrabold text-emerald-300">
            ${getInitials(fund.name)}
          </div>
          <div class="min-w-0 flex-1">
            <h2 class="text-base font-extrabold text-white leading-snug">${fund.name}</h2>
            <p id="mfLiveMetaSub" class="text-xs text-slate-400 mt-0.5">${fund.category} • Direct Growth</p>
            <div class="flex flex-wrap items-center gap-2 mt-2">
              ${fund.folio ? `<span class="text-xs font-semibold text-slate-200">Folio no. ${fund.folio}</span>` : ''}
              <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-surface-800 border border-slate-700 text-slate-300">Statement Verified</span>
            </div>
          </div>
        </div>

        <!-- Live Historical Fund Performance Chart Card (Groww screenshot 1000214958.png) -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-3">
          <div class="flex items-baseline justify-between">
            <div>
              <div class="flex items-baseline gap-2">
                <span id="mfChartPeriodReturnVal" class="text-2xl font-extrabold text-emerald-400">--%</span>
                <span id="mfChartPeriodLabel" class="text-xs text-slate-400">3Y annualised</span>
              </div>
              <p class="text-xs mt-0.5"><span class="${dayPct >= 0 ? 'text-emerald-400' : 'text-rose-400'} font-bold">${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%</span> <span class="text-slate-500 ml-1">1D</span></p>
            </div>
            <span id="mfLiveNavDateBadge" class="text-[11px] text-slate-400">Live NAV: ₹${Number(fund.currentNav).toFixed(4)}</span>
          </div>

          <div class="relative h-44 w-full pt-2">
            <canvas id="mfDetailNavChart"></canvas>
          </div>

          <!-- Groww Timeframe Selector Pills: 1M | 6M | 1Y | 3Y | 5Y | All -->
          <div id="mfChartRangeBtns" class="flex items-center justify-center gap-2 pt-1 text-xs font-bold">
            <button type="button" data-mf-range="30" class="px-3 py-1 rounded-full text-slate-400 hover:text-white transition">1M</button>
            <button type="button" data-mf-range="180" class="px-3 py-1 rounded-full text-slate-400 hover:text-white transition">6M</button>
            <button type="button" data-mf-range="365" class="px-3 py-1 rounded-full text-slate-400 hover:text-white transition">1Y</button>
            <button type="button" data-mf-range="1095" class="px-3 py-1 rounded-full border border-slate-500 bg-surface-800 text-white transition">3Y</button>
            <button type="button" data-mf-range="1825" class="px-3 py-1 rounded-full text-slate-400 hover:text-white transition">5Y</button>
            <button type="button" data-mf-range="99999" class="px-3 py-1 rounded-full text-slate-400 hover:text-white transition">All</button>
          </div>
        </div>

        <!-- Groww Card 1: CURRENT, 1D returns, Total returns, Invested, XIRR, Long/Short Term (Exact match to 1000214957.png) -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-3 text-xs">
          <div class="pb-3 border-b border-dashed border-slate-800">
            <p class="text-[10px] font-bold uppercase tracking-wider text-slate-400">CURRENT</p>
            <p class="text-2xl font-extrabold text-white mt-1">${formatINRPrecise(val)}</p>
          </div>

          <div class="space-y-2.5 pb-3 border-b border-dashed border-slate-800">
            <div class="flex items-center justify-between">
              <span class="text-slate-400">1D returns</span>
              <span class="font-bold ${dayChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(dayChange)} (${Math.abs(dayPct).toFixed(2)}%)</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Total returns</span>
              <span class="font-bold ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(gain)} (${pct.toFixed(2)}%)</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Invested</span>
              <span class="font-bold text-white">${formatINRPrecise(fund.invested)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">XIRR</span>
              <span class="font-bold text-white">${fundXirr !== null && instList.length > 1 ? fundXirr.toFixed(2) + '%' : '--'}</span>
            </div>
          </div>

          <div class="space-y-2 pt-0.5">
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Long term <span class="text-slate-500">(&gt;1Y)</span></span>
              <span class="font-bold text-white">${formatINRPrecise(ltVal)}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-400">Short term <span class="text-slate-500">(&lt;1Y)</span></span>
              <span class="font-bold text-white">${formatINRPrecise(stVal)}</span>
            </div>
          </div>
        </div>

        <!-- Groww Card 2: Current NAV, Avg NAV, Redeemable units & Live Fund Metadata (Exact match to 1000214957.png) -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-2.5 text-xs">
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Current NAV</span>
            <span class="font-bold text-white">₹${Number(fund.currentNav).toFixed(4)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Avg NAV</span>
            <span class="font-bold text-white">₹${avgBuyNav.toFixed(4)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Redeemable units</span>
            <span class="font-bold text-white">${Number(fund.units).toFixed(3)}</span>
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-dashed border-slate-800">
            <span class="text-slate-400">Fund House</span>
            <span id="mfLiveFundHouse" class="font-semibold text-slate-200">Loading...</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">ISIN / Scheme Code</span>
            <span id="mfLiveIsinCode" class="font-semibold text-slate-300">${fund.schemeCode}</span>
          </div>
        </div>

        <!-- Card 3: SIP & Transaction Installments Ledger -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-3 text-xs">
          <div class="flex items-center justify-between">
            <h3 class="font-bold text-white">SIP &amp; Purchase Transactions (${instList.length})</h3>
            ${fund.statementDate ? `<span class="text-[10px] text-slate-400">Stmt Baseline: ${fund.statementDate}</span>` : ''}
          </div>
          <div id="instHistoryContainer" class="max-h-60 overflow-y-auto pr-1">${rowsHtml}</div>

          ${isAdmin ? `
          <details class="rounded-xl bg-surface-900 border border-slate-800 p-3 mt-2">
            <summary class="font-semibold text-emerald-400 cursor-pointer flex items-center justify-between">
              <span>+ Log Manual SIP / Lumpsum Installment</span>
              <span class="text-[10px]">▾</span>
            </summary>
            <div class="mt-2.5 pt-2 border-t border-slate-800 space-y-2">
              <div class="grid grid-cols-3 gap-2">
                <input id="instDate" type="date" value="${new Date().toISOString().slice(0, 10)}" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
                <input id="instAmount" type="number" step="100" placeholder="Amount ₹" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
                <input id="instNav" type="number" step="0.01" placeholder="Buy NAV ₹" value="${fund.currentNav.toFixed(2)}" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
              </div>
              <button id="btnAddInstallment" type="button" class="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Add Installment</button>
            </div>
          </details>

          <button id="btnDeleteMfInsideSheet" type="button" class="w-full py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-400 font-semibold">
            Remove Fund from Portfolio
          </button>
          ` : ''}
        </div>
      `;

      document.getElementById('btnBackFromMfScreen').addEventListener('click', backToMfDashboard);

      if (isAdmin) {
        document.getElementById('btnDeleteMfInsideSheet').addEventListener('click', () => {
          state.mutualFunds = state.mutualFunds.filter(f => f.id !== fundId);
          saveState();
          backToMfDashboard();
          renderAll();
          showToast('Fund removed');
        });

        document.getElementById('btnAddInstallment').addEventListener('click', () => {
          const dt = document.getElementById('instDate').value || new Date().toISOString().slice(0, 10);
          const amt = parseFloat(document.getElementById('instAmount').value) || 0;
          const buyNav = parseFloat(document.getElementById('instNav').value) || fund.currentNav;
          if (amt <= 0 || buyNav <= 0) {
            showToast('Enter valid SIP amount and purchase NAV');
            return;
          }
          const newUnits = amt / buyNav;
          fund.installments.push({
            id: 'inst_' + Date.now(),
            date: dt,
            amount: amt,
            nav: buyNav,
            units: newUnits
          });
          fund.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          fund.units += newUnits;
          fund.invested += amt;
          saveState();
          renderAll();
          openMfHistoryModal(fundId);
          showToast(`Logged ₹${amt} SIP (+${newUnits.toFixed(3)} units @ ₹${buyNav.toFixed(2)})`);
        });

        document.getElementById('instHistoryContainer').addEventListener('click', (ev) => {
          const delBtn = ev.target.closest('[data-del-inst]');
          if (!delBtn) return;
          const instId = delBtn.getAttribute('data-del-inst');
          const target = fund.installments.find(x => x.id === instId);
          if (target) {
            fund.units = Math.max(0, fund.units - Number(target.units || 0));
            fund.invested = Math.max(0, fund.invested - Number(target.amount || 0));
            fund.installments = fund.installments.filter(x => x.id !== instId);
            saveState();
            renderAll();
            openMfHistoryModal(fundId);
          }
        });
      }

      // Fetch Live Fund Metadata & Full Historical NAV Series from MFapi.in (`https://api.mfapi.in/mf/{schemeCode}`)
      let navHistorySeries = [];
      const drawMfNavChart = (daysLimit) => {
        if (!navHistorySeries.length) return;
        const sliceCount = Math.min(navHistorySeries.length, Math.max(5, Math.round(daysLimit * 0.68)));
        const subset = daysLimit >= 90000 ? navHistorySeries.slice().reverse() : navHistorySeries.slice(0, sliceCount).reverse();
        // Downsample to at most 80 points for smooth canvas rendering
        const step = Math.max(1, Math.floor(subset.length / 80));
        const sampled = subset.filter((_, idx) => idx % step === 0 || idx === subset.length - 1);
        const labels = sampled.map(d => d.date);
        const values = sampled.map(d => parseFloat(d.nav));
        const startNav = values[0] || 1;
        const endNav = values[values.length - 1] || 1;
        const yrs = daysLimit / 365.25;
        let retPct = 0;
        let lbl = '';
        if (daysLimit >= 365 && subset.length >= 200) {
          const actualYears = Math.max(1, subset.length / 248);
          retPct = (Math.pow(endNav / startNav, 1 / actualYears) - 1) * 100;
          lbl = daysLimit >= 90000 ? 'Since inception (CAGR)' : `${Math.round(yrs)}Y annualised`;
        } else {
          retPct = ((endNav - startNav) / startNav) * 100;
          lbl = daysLimit <= 35 ? '1M return' : (daysLimit <= 190 ? '6M return' : '1Y return');
        }
        const retEl = document.getElementById('mfChartPeriodReturnVal');
        const lblEl = document.getElementById('mfChartPeriodLabel');
        if (retEl) {
          retEl.textContent = `${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%`;
          retEl.className = `text-2xl font-extrabold ${retPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`;
        }
        if (lblEl) lblEl.textContent = lbl;

        const canvas = document.getElementById('mfDetailNavChart');
        if (!canvas || typeof Chart === 'undefined') return;
        if (mfDetailChartInstance) mfDetailChartInstance.destroy();
        mfDetailChartInstance = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels,
            datasets: [{
              data: values,
              borderColor: retPct >= 0 ? '#10b981' : '#f43f5e',
              borderWidth: 2.2,
              pointRadius: 0,
              pointHoverRadius: 4,
              tension: 0.25,
              fill: true,
              backgroundColor: retPct >= 0 ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` NAV: ₹${Number(ctx.raw).toFixed(4)}`
                }
              }
            },
            scales: {
              x: { display: false },
              y: { display: false }
            }
          }
        });
      };

      document.getElementById('mfChartRangeBtns').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-mf-range]');
        if (!btn) return;
        document.querySelectorAll('#mfChartRangeBtns [data-mf-range]').forEach(b => {
          b.className = 'px-3 py-1 rounded-full text-slate-400 hover:text-white transition';
        });
        btn.className = 'px-3 py-1 rounded-full border border-slate-500 bg-surface-800 text-white transition';
        drawMfNavChart(Number(btn.getAttribute('data-mf-range')));
      });

      // 1. Immediately draw a fallback baseline chart so the canvas is never empty while loading
      const fallbackPts = [];
      if (instList.length > 0) {
        instList.slice().reverse().forEach(inst => {
          if (inst.nav > 0) fallbackPts.push({ date: inst.date, nav: String(inst.nav) });
        });
      }
      if (avgBuyNav > 0 && fallbackPts.length === 0) {
        fallbackPts.push({ date: 'Avg Buy NAV', nav: String(avgBuyNav.toFixed(4)) });
      }
      if (fund.prevNav > 0 && fund.prevNav !== fund.currentNav) {
        fallbackPts.push({ date: 'Prev Close', nav: String(fund.prevNav) });
      }
      fallbackPts.push({ date: 'Latest NAV', nav: String(fund.currentNav) });
      navHistorySeries = fallbackPts.slice().reverse();
      drawMfNavChart(1095);

      // 2. Resolve AMFI Scheme Code automatically (including Kotak Arbitrage -> 119771) if missing or '000000'
      if (!fund.schemeCode || fund.schemeCode === '000000') {
        const nm = String(fund.name || '');
        if (/kotak.*arbitrage/i.test(nm)) fund.schemeCode = '119771';
        else if (/parag\s*parikh.*flexi/i.test(nm)) fund.schemeCode = '122639';
        else if (/hdfc.*mid\s*cap/i.test(nm)) fund.schemeCode = '118989';
        else if (/uti.*nifty\s*50/i.test(nm)) fund.schemeCode = '120716';
      }

      try {
        let codeToFetch = (fund.schemeCode && fund.schemeCode !== '000000') ? String(fund.schemeCode).trim() : '';
        if (!codeToFetch) {
          const cleanWords = String(fund.name || '').replace(/\s*-?\s*(direct|regular|growth|plan|idcw|fund)/gi, ' ').trim().split(/\s+/).filter(Boolean);
          for (const qStr of [cleanWords.slice(0, 3).join(' '), cleanWords.slice(0, 2).join(' '), cleanWords[0] || '']) {
            if (!qStr) continue;
            const sRes = await fetch(`https://api.mfapi.in/mf/search?q=${encodeURIComponent(qStr)}`);
            if (!sRes.ok) continue;
            const sList = await sRes.json();
            if (Array.isArray(sList) && sList.length > 0) {
              const best = sList.find(it => cleanWords.slice(0, 2).every(w => String(it.schemeName || '').toLowerCase().includes(w.toLowerCase())) && /direct/i.test(it.schemeName) && /growth/i.test(it.schemeName)) || sList[0];
              if (best && best.schemeCode) {
                codeToFetch = String(best.schemeCode);
                fund.schemeCode = codeToFetch;
                saveState();
                break;
              }
            }
          }
        }

        if (codeToFetch) {
          const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(codeToFetch)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.meta) {
              const fhEl = document.getElementById('mfLiveFundHouse');
              const subEl = document.getElementById('mfLiveMetaSub');
              const isinEl = document.getElementById('mfLiveIsinCode');
              if (fhEl && json.meta.fund_house) fhEl.textContent = json.meta.fund_house;
              if (subEl && json.meta.scheme_category) subEl.textContent = `${json.meta.scheme_category} • ${json.meta.scheme_type || 'Direct'}`;
              if (isinEl) isinEl.textContent = `${json.meta.isin_growth || ''} (${codeToFetch})`.trim();
            }
            if (Array.isArray(json.data) && json.data.length > 0) {
              navHistorySeries = json.data;
              const dtBadge = document.getElementById('mfLiveNavDateBadge');
              if (dtBadge && json.data[0].date) {
                dtBadge.textContent = `NAV (${json.data[0].date}): ₹${parseFloat(json.data[0].nav).toFixed(4)}`;
              }
              drawMfNavChart(1095);
            }
          }
        }
      } catch (err) {}
    }

    const APPS_SCRIPT_CODE = '// Use code.gs from the chat or ZIP package';

    function ingestGmailItems(items) {
      let newInstallments = 0;
      items.forEach(item => {
        const nav = Number(item.nav || 0);
        const amt = Number(item.amount || 0);
        if (nav <= 0 || amt <= 0) return;

        let trueUnits = Number(item.units || 0);
        if (Math.abs(trueUnits - 999.95) < 1 || trueUnits <= 0 || Math.abs(trueUnits * nav - amt) > amt * 0.15) {
          trueUnits = +(amt / nav).toFixed(3);
        }
        // Always store exact net invested (units * nav, or stamp-duty-adjusted amount)
        const netInvested = (Math.abs(trueUnits * nav - amt) <= 25) ? +(trueUnits * nav).toFixed(2) : amt;

        const cleanedSchemeTitle = String(item.schemeName || '')
          .replace(/\s+(?:SIP\s*AMOUNT|INVESTMENT\s*AMOUNT|SIP|AMOUNT|FOLIO.*)$/i, '')
          .trim();
        const rawName = cleanedSchemeTitle.toLowerCase();
        let fund = state.mutualFunds.find(f => {
          const firstWords = f.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
          return firstWords && rawName.includes(firstWords);
        });
        if (!fund) {
          if (nav >= 30 && nav < 60) {
            fund = state.mutualFunds.find(f => f.schemeCode === '119771' || /kotak/i.test(f.name));
          } else if (Math.abs(amt - 8000) < 50 || nav >= 180) {
            fund = state.mutualFunds.find(f => f.schemeCode === '118989' || /hdfc/i.test(f.name));
          } else if (Math.abs(amt - 15000) < 50 || (nav >= 65 && nav <= 120)) {
            fund = state.mutualFunds.find(f => f.schemeCode === '122639' || /parag/i.test(f.name));
          } else if (Math.abs(amt - 7000) < 50 || (nav >= 130 && nav < 180)) {
            fund = state.mutualFunds.find(f => f.schemeCode === '120716' || /uti/i.test(f.name));
          }
        }
        if (!fund && cleanedSchemeTitle && !/allocated|allotted|subject/i.test(cleanedSchemeTitle)) {
          // Auto-create the Mutual Fund holding dynamically if it was not imported yet!
          let autoCode = '000000';
          let autoCat = 'Equity';
          if (/kotak.*arbitrage/i.test(cleanedSchemeTitle)) { autoCode = '119771'; autoCat = 'Arbitrage'; }
          else if (/hdfc.*mid\s*cap/i.test(cleanedSchemeTitle)) { autoCode = '118989'; autoCat = 'Mid Cap'; }
          else if (/parag\s*parikh.*flexi/i.test(cleanedSchemeTitle)) { autoCode = '122639'; autoCat = 'Flexi Cap'; }
          else if (/uti.*nifty\s*50/i.test(cleanedSchemeTitle)) { autoCode = '120716'; autoCat = 'Large Cap'; }
          fund = {
            id: 'mf_gmail_auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name: cleanedSchemeTitle,
            schemeCode: autoCode,
            folio: '',
            category: autoCat,
            units: 0,
            invested: 0,
            currentNav: nav,
            prevNav: nav,
            monthlySip: Math.round(amt),
            installments: []
          };
          state.mutualFunds.push(fund);
        }
        if (!fund) return;
        if (!Array.isArray(fund.installments)) fund.installments = [];
        if (amt > 0 && !fund.monthlySip) fund.monthlySip = amt;

        const txKey = `${item.date}_${amt.toFixed(2)}_${nav.toFixed(4)}`;
        const existingInst = fund.installments.find(inst => inst.date === item.date && Math.abs(Number(inst.nav) - nav) < 0.01);
        if (existingInst) {
          existingInst.amount = netInvested;
          existingInst.nav = nav;
          existingInst.units = trueUnits;
        } else {
          fund.installments.push({
            id: 'gmail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            date: item.date,
            amount: netInvested,
            nav: nav,
            units: trueUnits
          });
          fund.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          newInstallments++;
        }
      });
      // Reconcile each fund safely against its statement baseline:
      state.mutualFunds.forEach(f => {
        if (!Array.isArray(f.installments) || f.installments.length === 0) return;
        const stmtDate = f.statementDate || '';
        const baseUnits = Number(f.statementUnits || 0);
        const baseInv = Number(f.statementInvested || 0);

        if (stmtDate && baseUnits > 0) {
          // Statement is the source of truth up to stmtDate; only add installments strictly AFTER stmtDate
          const postStmtInst = f.installments.filter(x => String(x.date) > stmtDate);
          const postUnits = postStmtInst.reduce((acc, x) => acc + Number(x.units || 0), 0);
          const postInv = postStmtInst.reduce((acc, x) => acc + Number(x.amount || 0), 0);
          f.units = +(baseUnits + postUnits).toFixed(3);
          f.invested = +(baseInv + postInv).toFixed(2);
        } else if (!stmtDate && baseUnits === 0) {
          // If no statement was ever imported for this fund, sum its unique installments
          f.units = +f.installments.reduce((acc, x) => acc + Number(x.units || 0), 0).toFixed(3);
          f.invested = +f.installments.reduce((acc, x) => acc + Number(x.amount || 0), 0).toFixed(2);
        }
      });
      saveState();
      renderAll();
      return newInstallments;
    }

    async function ingestNpsGmailItems(npsItems) {
      if (!Array.isArray(npsItems) || npsItems.length === 0 || state.nps.length === 0) return 0;
      let addedNpsCount = 0;

      // Allocation percentages from Protean statement: Life Cycle 75 - Aggressive (LC75) -> 75% E, 10% C, 15% G
      const getSharePct = (schemeName) => {
        if (/SCHEME\s*[\-:]?\s*E\b/i.test(schemeName)) return 0.75;
        if (/SCHEME\s*[\-:]?\s*C\b/i.test(schemeName)) return 0.10;
        if (/SCHEME\s*[\-:]?\s*G\b/i.test(schemeName)) return 0.15;
        return +(1 / state.nps.length).toFixed(4);
      };

      // Pre-fetch historical NAV maps for each NPS scheme so we can look up the exact NAV on the contribution date
      const histNavMap = {};
      for (const n of state.nps) {
        if (n.schemeId && /^SM\d+/i.test(n.schemeId)) {
          try {
            const hRes = await fetch(`https://npsnav.in/api/historical/${encodeURIComponent(n.schemeId.trim())}`);
            if (hRes.ok) {
              const hJson = await hRes.json();
              const map = {};
              (Array.isArray(hJson.data) ? hJson.data : []).forEach(row => {
                // Convert DD-MM-YYYY to YYYY-MM-DD
                const iso = normalizeNpsDate(row.date);
                const nv = parseFloat(row.nav);
                if (iso && !isNaN(nv)) map[iso] = nv;
              });
              histNavMap[n.id] = map;
            }
          } catch (e) {}
        }
      }

      for (const item of npsItems) {
        const dt = String(item.date || '').trim();
        const totalAmt = Number(item.totalAmount || item.amount || 0);
        if (!dt || totalAmt <= 0) continue;

        for (const n of state.nps) {
          if (!Array.isArray(n.installments)) n.installments = [];
          const pct = getSharePct(n.name);
          // If the email already gave a scheme-specific amount, use it; otherwise split by 75% / 10% / 15%
          const schemeAmt = item.schemeName && normName(n.name).includes(normName(item.schemeName))
            ? totalAmt
            : +(totalAmt * pct).toFixed(2);
          if (schemeAmt <= 0) continue;

          // Check if a contribution around this date (+/- 5 days) with the same scheme amount already exists (e.g. from CSV import)
          const dtMs = new Date(dt).getTime();
          const alreadyExists = n.installments.some(inst => {
            const instMs = new Date(inst.date).getTime();
            const dayDiff = Math.abs(dtMs - instMs) / (1000 * 60 * 60 * 24);
            return dayDiff <= 5 && Math.abs(Number(inst.amount) - schemeAmt) <= 2.0;
          });
          if (alreadyExists) continue;

          // Look up exact NAV on `dt` (or closest available trading day) from NPSNAV.in history, falling back to currentNav
          const map = histNavMap[n.id] || {};
          let navOnDate = map[dt] || Number(item.nav || 0) || Number(n.currentNav || 25);
          const calcUnits = +(schemeAmt / navOnDate).toFixed(4);

          n.installments.push({
            id: 'nps_gmail_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            date: dt,
            desc: 'Gmail Auto-Sync (' + Math.round(pct * 100) + '% allocation)',
            amount: schemeAmt,
            nav: navOnDate,
            units: calcUnits
          });
          n.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          addedNpsCount++;
        }
      }

      // Reconcile NPS balances safely: keep Statement Baseline up to statementDate, and add only post-statement Gmail contributions!
      state.nps.forEach(n => {
        if (!Array.isArray(n.installments) || n.installments.length === 0) return;
        const stmtDate = n.statementDate || '';
        const baseUnits = Number(n.statementUnits || 0);
        const baseInv = +n.installments.filter(x => Number(x.amount) > 0 && (!stmtDate || String(x.date) <= stmtDate)).reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2);
        if (stmtDate && baseUnits > 0) {
          const postInst = n.installments.filter(x => String(x.date) > stmtDate);
          const postUnits = postInst.reduce((s, x) => s + Number(x.units || 0), 0);
          const postInv = postInst.filter(x => Number(x.amount) > 0).reduce((s, x) => s + Number(x.amount || 0), 0);
          n.units = +(baseUnits + postUnits).toFixed(4);
          if (baseInv > 0 || postInv > 0) n.invested = +(baseInv + postInv).toFixed(2);
        } else {
          n.units = +n.installments.reduce((s, x) => s + Number(x.units || 0), 0).toFixed(4);
          n.invested = +n.installments.filter(x => Number(x.amount) > 0).reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(2);
        }
      });

      saveState();
      renderAll();
      return addedNpsCount;
    }

    // Listen for authenticated postMessage bridge from "Only myself" Google Apps Script popup
    window.addEventListener('message', async (ev) => {
      if (ev.data && ev.data.type === 'WEALTHLOCAL_GMAIL_SYNC' && ev.data.payload) {
        const data = ev.data.payload;
        const items = Array.isArray(data.items) ? data.items : [];
        const npsItems = Array.isArray(data.npsItems) ? data.npsItems : [];
        const newMf = ingestGmailItems(items);
        const newNps = await ingestNpsGmailItems(npsItems);
        showToast(`Verified Sync! MF: +${newMf} new, NPS: +${newNps} new`);
        const statusEl = document.getElementById('gmailSyncStatus');
        if (statusEl) {
          statusEl.classList.remove('hidden');
          statusEl.innerHTML = `<span class="text-emerald-400">✓ Authenticated "Only myself" Sync Complete! MF: ${items.length} emails (+${newMf} new) • NPS: ${npsItems.length} emails (+${newNps} new).</span>`;
        }
      }
    });

    function openGmailSyncModal() {
      if (currentUserRole !== 'admin') {
        showToast('Gmail Sync is restricted to Admin');
        return;
      }
      const isHostedInGas = typeof window.google !== 'undefined' && window.google.script && window.google.script.run;
      openModal('Authenticated Gmail Sync ("Only myself")', `
        <div class="space-y-3 text-xs">
          <div class="rounded-2xl bg-emerald-950/25 border border-emerald-500/30 p-3 space-y-1.5">
            <p class="font-bold text-emerald-300">🔒 Zero-Public-Access Mode ("Only myself")</p>
            <p class="text-[11px] text-slate-300 leading-relaxed">
              ${isHostedInGas
                ? 'Running directly inside your authenticated Google Apps Script container via <code>google.script.run</code>.'
                : 'Set your Apps Script deployment to <strong>Who has access: Only myself</strong>. Tapping <strong>Authenticated Popup Sync</strong> below verifies your Google Account session and beams the data back securely.'}
            </p>
          </div>

          <div>
            <label class="block text-slate-400 mb-1">Your Personal Google Apps Script Web App URL:</label>
            <input id="gmailWebhookInput" type="url" value="${state.gmailWebhookUrl || ''}" placeholder="https://script.google.com/macros/s/.../exec" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white focus:outline-none focus:border-emerald-500" />
          </div>

          <div class="grid grid-cols-2 gap-2">
            <button id="btnRunGmailSyncNow" type="button" class="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">
              ${isHostedInGas ? 'Sync via Internal RPC' : 'Authenticated Popup Sync'}
            </button>
            <button id="btnCopyAppsScript" type="button" class="py-2.5 px-3 rounded-xl bg-surface-800 hover:bg-surface-700 border border-slate-700 text-emerald-300 font-semibold">
              Copy v6.0 Code.gs
            </button>
          </div>

          <div id="gmailSyncStatus" class="hidden rounded-xl bg-surface-800 border border-slate-700 p-2.5 text-slate-200"></div>

          <details class="rounded-xl bg-surface-800/60 border border-slate-800 p-3">
            <summary class="font-semibold text-slate-300 cursor-pointer">Paste Verified Sync Data Manually</summary>
            <div class="mt-2 space-y-2">
              <textarea id="gmailJsonPasteInput" rows="2" placeholder='Paste {"status":"ok","items":[...]} here...' class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white"></textarea>
              <button id="btnImportGmailJson" type="button" class="w-full py-2 rounded-xl bg-surface-700 hover:bg-surface-600 text-white font-semibold">Import Pasted JSON</button>
            </div>
          </details>
        </div>
      `);

      document.getElementById('btnImportGmailJson').addEventListener('click', () => {
        const raw = document.getElementById('gmailJsonPasteInput').value.trim();
        const statusEl = document.getElementById('gmailSyncStatus');
        statusEl.classList.remove('hidden');
        if (!raw) {
          statusEl.innerHTML = '<span class="text-amber-300">Paste the JSON output from your authenticated script tab first.</span>';
          return;
        }
        try {
          const jsonStart = raw.indexOf('{');
          const jsonEnd = raw.lastIndexOf('}');
          const parsed = JSON.parse(jsonStart !== -1 && jsonEnd !== -1 ? raw.slice(jsonStart, jsonEnd + 1) : raw);
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const npsItems = Array.isArray(parsed.npsItems) ? parsed.npsItems : [];
          const addedMf = ingestGmailItems(items);
          ingestNpsGmailItems(npsItems).then(addedNps => {
            statusEl.innerHTML = `<span class="text-emerald-400">Imported ${items.length} MF email(s) (+${addedMf} new) and ${npsItems.length} NPS email(s) (+${addedNps} new)!</span>`;
            showToast(`Imported +${addedMf} MF & +${addedNps} NPS records!`);
          });
        } catch (err) {
          statusEl.innerHTML = `<span class="text-rose-400">Invalid JSON (${err.message}).</span>`;
        }
      });

      document.getElementById('btnCopyAppsScript').addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(APPS_SCRIPT_CODE);
          showToast('v6.0 Secure Code.gs copied!');
        } catch (e) {
          const ta = document.createElement('textarea');
          ta.value = APPS_SCRIPT_CODE;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          showToast('v6.0 Secure Code.gs copied!');
        }
      });

      document.getElementById('btnRunGmailSyncNow').addEventListener('click', async () => {
        const statusEl = document.getElementById('gmailSyncStatus');
        statusEl.classList.remove('hidden');
        const url = (document.getElementById('gmailWebhookInput').value || '').trim();
        if (url) {
          state.gmailWebhookUrl = url;
          localStorage.setItem('wl_gas_bridge_url', url);
          saveState();
        }
        await runBackgroundGmailSyncOnPage(url, statusEl);
      });
    }

    // 100% Background Same-Page Gmail Sync (Zero new tabs opened!)
    // Tries: 1) Internal google.script.run -> 2) Background CORS fetch(?mode=json) -> 3) Background JSONP <script>(?mode=jsonp) -> 4) Hidden 0x0 <iframe> postMessage
    async function runBackgroundGmailSyncOnPage(customUrl, statusEl) {
      const setStatus = (htmlMsg) => {
        if (statusEl) {
          statusEl.classList.remove('hidden');
          statusEl.innerHTML = htmlMsg;
        }
      };

      const isHostedInGas = typeof window.google !== 'undefined' && window.google.script && window.google.script.run;
      if (isHostedInGas) {
        showAppLoader('Syncing Gmail Inbox...', 'Scanning your Gmail privately in the background', 45);
        setStatus('<span class="text-slate-300">Syncing Gmail in background via Google Apps Script...</span>');
        await new Promise((resolve) => {
          window.google.script.run
            .withSuccessHandler(async (data) => {
              const items = Array.isArray(data && data.items) ? data.items : [];
              const npsItems = Array.isArray(data && data.npsItems) ? data.npsItems : [];
              const newMf = ingestGmailItems(items);
              const newNps = await ingestNpsGmailItems(npsItems);
              await syncLiveNavs();
              setStatus(`<span class="text-emerald-400">✓ Background Gmail Sync Complete! MF: ${items.length} scanned (+${newMf} new) • NPS: ${npsItems.length} scanned (+${newNps} new).</span>`);
              showToast(`✓ Gmail Synced! MF: +${newMf} new • NPS: +${newNps} new`);
              resolve();
            })
            .withFailureHandler((err) => {
              setStatus(`<span class="text-rose-400">Gmail auth error: ${err && err.message ? err.message : 'Check permissions'}</span>`);
              showToast('Gmail sync failed — check script permissions');
              resolve();
            })
            .syncGmailPortfolio();
        });
        hideAppLoader();
        return;
      }

      const bridgeUrl = (customUrl || state.gmailWebhookUrl || localStorage.getItem('wl_gas_bridge_url') || '').trim();
      if (!bridgeUrl || !bridgeUrl.startsWith('https://script.google.com/')) {
        hideAppLoader();
        openGmailSyncModal();
        return;
      }

      showAppLoader('Syncing Gmail in Background...', 'Verifying Google session & fetching SIP/NPS allotments without leaving this page', 45);
      setStatus('<span class="text-emerald-300">⟳ Syncing in background... Verifying Google login & scanning inbox...</span>');

      const sep = bridgeUrl.includes('?') ? '&' : '?';
      const authHash = (secConfig && secConfig.adminPinHash) ? secConfig.adminPinHash : '';
      let payloadData = null;

      // Attempt 1: Direct Background CORS Fetch (`?mode=json`)
      try {
        const fRes = await fetch(`${bridgeUrl}${sep}mode=json&authHash=${encodeURIComponent(authHash)}&_t=${Date.now()}`, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'follow'
        });
        if (fRes.ok) {
          const txt = await fRes.text();
          if (txt && txt.trim().startsWith('{')) {
            payloadData = JSON.parse(txt);
          }
        }
      } catch (e) {}

      // Attempt 2: Silent Background JSONP `<script>` Injection (`?mode=jsonp`) — Bypasses XHR CORS!
      if (!payloadData) {
        payloadData = await new Promise((resolve) => {
          const cbName = '__wlGmailJsonp_' + Date.now();
          const scriptEl = document.createElement('script');
          const timer = setTimeout(() => {
            cleanup();
            resolve(null);
          }, 7500);
          function cleanup() {
            clearTimeout(timer);
            try { delete window[cbName]; } catch (e) {}
            if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
          }
          window[cbName] = (data) => {
            cleanup();
            resolve(data || null);
          };
          scriptEl.onerror = () => {
            cleanup();
            resolve(null);
          };
          scriptEl.src = `${bridgeUrl}${sep}mode=jsonp&callback=${cbName}&authHash=${encodeURIComponent(authHash)}&_t=${Date.now()}`;
          document.head.appendChild(scriptEl);
        });
      }

      // Attempt 3: Hidden 0x0 Background `<iframe>` (`?mode=bridge`) with `window.top.postMessage` (Works with "Only myself" when browser allows 3P cookies)
      if (!payloadData) {
        payloadData = await new Promise((resolve) => {
          const iframeEl = document.createElement('iframe');
          iframeEl.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;z-index:-1;';
          const timer = setTimeout(() => {
            cleanup();
            resolve(null);
          }, 4500);
          function onMsg(ev) {
            if (ev.data && ev.data.type === 'WEALTHLOCAL_GMAIL_SYNC' && ev.data.payload) {
              cleanup();
              resolve(ev.data.payload);
            }
          }
          function cleanup() {
            clearTimeout(timer);
            window.removeEventListener('message', onMsg);
            if (iframeEl.parentNode) iframeEl.parentNode.removeChild(iframeEl);
          }
          window.addEventListener('message', onMsg);
          iframeEl.src = `${bridgeUrl}${sep}mode=bridge&_t=${Date.now()}`;
          document.body.appendChild(iframeEl);
        });
      }

      if (payloadData && payloadData.status === 'ok') {
        const items = Array.isArray(payloadData.items) ? payloadData.items : [];
        const npsItems = Array.isArray(payloadData.npsItems) ? payloadData.npsItems : [];
        const newMf = ingestGmailItems(items);
        const newNps = await ingestNpsGmailItems(npsItems);
        showAppLoader('Updating Live NAVs...', 'Resolving latest AMFI & NPS prices for synced holdings', 85);
        await syncLiveNavs();
        hideAppLoader();
        setStatus(`<span class="text-emerald-400">✓ Background Gmail Sync Complete! Scanned ${items.length} MF email(s) (+${newMf} new) &amp; ${npsItems.length} NPS email(s) (+${newNps} new).</span>`);
        showToast(`✓ Gmail Synced! MF: +${newMf} new • NPS: +${newNps} new`);
        return;
      }

      hideAppLoader();
      const msg = 'Could not reach Google Apps Script in background because Chrome blocks third-party Google cookies on github.io when deployment is set to "Only myself". Make sure you deployed the latest code.gs in Google Apps Script (Deploy -> Manage deployments -> Edit -> New version).';
      setStatus(`<span class="text-amber-300">⚠️ ${msg}</span>`);
      showToast('⚠️ Background Gmail Sync blocked by browser cookie policy — check Gmail Sync dialog');
      if (!statusEl) openGmailSyncModal();
    }

    async function triggerOneClickGmailSync() {
      if (currentUserRole !== 'admin') {
        showToast('Gmail Sync is restricted to Admin');
        return;
      }
      await runBackgroundGmailSyncOnPage();
    }

    document.getElementById('btnSyncGmail').addEventListener('click', triggerOneClickGmailSync);

    document.getElementById('mfList').addEventListener('click', (e) => {
      const card = e.target.closest('[data-open-mf]');
      if (card) {
        openMfHistoryModal(card.getAttribute('data-open-mf'));
      }
    });

    async function openNpsHistoryModal(npsId) {
      const npsItem = state.nps.find(n => n.id === npsId);
      if (!npsItem) return;
      const isAdmin = currentUserRole === 'admin';
      if (!Array.isArray(npsItem.installments)) npsItem.installments = [];
      const instList = npsItem.installments;
      const val = npsItem.units * npsItem.currentNav;
      const gain = val - npsItem.invested;
      const pct = npsItem.invested > 0 ? (gain / npsItem.invested) * 100 : 0;
      const dayChange = npsItem.units * (npsItem.currentNav - npsItem.prevNav);
      const avgBuyNav = npsItem.units > 0 ? (npsItem.invested / npsItem.units) : 0;

      pushNavState('detail_nps');
      document.getElementById('npsDashboardSubView').classList.add('hidden');
      const screenEl = document.getElementById('npsDetailScreenView');
      screenEl.classList.remove('hidden');
      document.getElementById('appMainScroll').scrollTop = 0;

      const rowsHtml = instList.length > 0
        ? instList.map(inst => {
            const isFee = Number(inst.amount) < 0 || Number(inst.units) < 0;
            const uSign = Number(inst.units) >= 0 ? '+' : '';
            return `
            <div class="flex items-center justify-between py-2.5 border-b border-slate-800/80 text-xs">
              <div>
                <p class="font-semibold text-white">${inst.date} ${isFee ? '<span class="text-[10px] text-rose-400 ml-1">(CRA Charge)</span>' : ''}</p>
                <p class="text-[11px] text-slate-400">NAV: ₹${Number(inst.nav).toFixed(4)} • ${uSign}${Number(inst.units).toFixed(4)} units</p>
              </div>
              <div class="flex items-center gap-2">
                <span class="font-bold ${isFee ? 'text-rose-400' : 'text-amber-400'}">${formatINRPrecise(inst.amount)}</span>
                ${isAdmin ? `<button type="button" data-del-nps-inst="${inst.id}" class="text-slate-500 hover:text-rose-400 px-1">✕</button>` : ''}
              </div>
            </div>
          `;}).join('')
        : `<div class="rounded-xl bg-surface-900 border border-slate-800 p-4 text-center text-slate-400 text-xs">
             No individual NPS contribution rows logged yet.
           </div>`;

      screenEl.innerHTML = `
        <div class="flex items-center justify-between pb-2 border-b border-slate-800/80">
          <button type="button" id="btnBackFromNpsScreen" class="inline-flex items-center gap-2.5 text-sm font-bold text-white hover:text-amber-400 transition active:scale-95">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18"/></svg>
            <span>Back to NPS Vault</span>
          </button>
          <span class="text-[11px] px-2.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 font-bold">${npsItem.schemeId || 'TIER I'}</span>
        </div>

        <div>
          <h2 class="text-base font-extrabold text-white leading-snug">${npsItem.name}</h2>
          <p class="text-xs text-slate-400 mt-0.5">Protean CRA • Tier I Pension Scheme</p>
        </div>

        <!-- Live Historical NPS NAV Chart Card -->
        <div class="rounded-2xl bg-[#161926] border border-amber-500/25 p-4 space-y-3">
          <div class="flex items-baseline justify-between">
            <div>
              <span id="npsChartPeriodReturnVal" class="text-2xl font-extrabold text-amber-400">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
              <span class="text-xs text-slate-400 ml-1.5">Scheme NAV Trend</span>
            </div>
            <span class="text-xs text-slate-300 font-semibold">Live NAV: ₹${Number(npsItem.currentNav).toFixed(4)}</span>
          </div>
          <div class="relative h-40 w-full">
            <canvas id="npsDetailNavChart"></canvas>
          </div>
        </div>

        <!-- NPS Position Breakdown Card -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-2.5 text-xs">
          <div class="flex items-center justify-between pb-2.5 border-b border-dashed border-slate-800">
            <span class="text-slate-400 uppercase font-bold">Current Value</span>
            <span class="text-xl font-extrabold text-white">${formatINRPrecise(val)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Total Contributed</span>
            <span class="font-bold text-white">${formatINRPrecise(npsItem.invested)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Total Returns</span>
            <span class="font-bold ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(gain)} (${pct.toFixed(2)}%)</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">1D Change</span>
            <span class="font-bold ${dayChange >= 0 ? 'text-emerald-400' : 'text-rose-400'}">${formatSignedINRPrecise(dayChange)}</span>
          </div>
          <div class="flex items-center justify-between pt-2 border-t border-dashed border-slate-800">
            <span class="text-slate-400">Allotted Units (4 dec.)</span>
            <span class="font-bold text-white">${Number(npsItem.units).toFixed(4)}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-slate-400">Average Buy NAV</span>
            <span class="font-bold text-white">₹${avgBuyNav.toFixed(4)}</span>
          </div>
        </div>

        <!-- Contribution Ledger Card -->
        <div class="rounded-2xl bg-[#121722] border border-slate-800/90 p-4 space-y-3 text-xs">
          <h3 class="font-bold text-white">Contribution &amp; Charge Ledger (${instList.length})</h3>
          <div id="npsInstHistoryContainer" class="max-h-60 overflow-y-auto pr-1">${rowsHtml}</div>

          ${isAdmin ? `
          <details class="rounded-xl bg-surface-900 border border-slate-800 p-3 mt-2">
            <summary class="font-semibold text-amber-400 cursor-pointer flex items-center justify-between">
              <span>+ Log Future NPS Contribution (Adds to Total Units)</span>
              <span class="text-[10px]">▾</span>
            </summary>
            <div class="mt-2.5 pt-2 border-t border-slate-800 space-y-2">
              <p class="text-[11px] text-slate-400">Enter exact allotted units from your Protean SMS/email, or leave Units blank to auto-calculate <code class="text-amber-300">Amount ÷ NAV</code>:</p>
              <div class="grid grid-cols-2 gap-2">
                <input id="npsInstDate" type="date" value="${new Date().toISOString().slice(0, 10)}" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
                <input id="npsInstAmount" type="number" step="0.01" placeholder="Amount ₹" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
                <input id="npsInstNav" type="number" step="0.0001" placeholder="Purchase NAV ₹" value="${Number(npsItem.currentNav).toFixed(4)}" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
                <input id="npsInstExactUnits" type="number" step="0.0001" placeholder="Exact Units (optional)" class="px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
              </div>
              <button id="btnAddNpsInstallment" type="button" class="w-full py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold">Add Contribution</button>
            </div>
          </details>

          <details class="rounded-xl bg-surface-900 border border-slate-800 p-3 mt-2">
            <summary class="font-semibold text-emerald-400 cursor-pointer flex items-center justify-between">
              <span>⚙️ Edit / Lock Exact Units, Invested &amp; Live NAV</span>
              <span class="text-[10px]">▾</span>
            </summary>
            <div class="mt-2.5 pt-2 border-t border-slate-800 space-y-2">
              <div class="grid grid-cols-3 gap-2">
                <div>
                  <label class="block text-[10px] text-slate-400 mb-1">Exact Units (4 dec.)</label>
                  <input id="npsEditExactUnits" type="number" step="0.0001" value="${Number(npsItem.units).toFixed(4)}" class="w-full px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white font-bold" />
                </div>
                <div>
                  <label class="block text-[10px] text-slate-400 mb-1">Contributed (₹)</label>
                  <input id="npsEditExactInvested" type="number" step="0.01" value="${Number(npsItem.invested).toFixed(2)}" class="w-full px-2.5 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white font-bold" />
                </div>
                <div>
                  <label class="block text-[10px] text-amber-300 mb-1">Live NAV (₹)</label>
                  <input id="npsEditLiveNav" type="number" step="0.0001" value="${Number(npsItem.currentNav).toFixed(4)}" class="w-full px-2.5 py-2 rounded-xl bg-surface-800 border border-amber-500/40 text-amber-300 font-bold" />
                </div>
              </div>
              <button id="btnSaveExactNpsUnits" type="button" class="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold">Save Exact Units, Invested &amp; NAV</button>
            </div>
          </details>

          <button id="btnDeleteNpsInsideSheet" type="button" class="w-full py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-400 font-semibold">
            Remove Scheme from Portfolio
          </button>
          ` : ''}
        </div>
      `;

      document.getElementById('btnBackFromNpsScreen').addEventListener('click', backToNpsDashboard);

      if (isAdmin) {
        document.getElementById('btnDeleteNpsInsideSheet').addEventListener('click', () => {
          state.nps = state.nps.filter(n => n.id !== npsId);
          saveState();
          backToNpsDashboard();
          renderAll();
          showToast('NPS scheme removed');
        });

        document.getElementById('btnAddNpsInstallment').addEventListener('click', () => {
          const dt = document.getElementById('npsInstDate').value || new Date().toISOString().slice(0, 10);
          const amt = parseFloat(document.getElementById('npsInstAmount').value) || 0;
          const buyNav = parseFloat(document.getElementById('npsInstNav').value) || npsItem.currentNav;
          const explicitUnits = parseFloat(document.getElementById('npsInstExactUnits').value);
          if (amt <= 0 && (isNaN(explicitUnits) || explicitUnits === 0)) {
            showToast('Enter valid contribution amount or exact units');
            return;
          }
          const newUnits = (!isNaN(explicitUnits) && explicitUnits !== 0)
            ? +explicitUnits.toFixed(4)
            : +(amt / buyNav).toFixed(4);
          npsItem.installments.push({
            id: 'npsinst_' + Date.now(),
            date: dt,
            desc: 'Manual Contribution',
            amount: amt,
            nav: buyNav,
            units: newUnits
          });
          npsItem.installments.sort((a, b) => String(b.date).localeCompare(String(a.date)));
          if (!npsItem.statementDate || dt > npsItem.statementDate) {
            npsItem.units = +(npsItem.units + newUnits).toFixed(4);
            npsItem.invested = +(npsItem.invested + amt).toFixed(2);
          } else {
            npsItem.statementUnits = +(Number(npsItem.statementUnits || npsItem.units) + newUnits).toFixed(4);
            npsItem.units = npsItem.statementUnits;
            npsItem.invested = +(npsItem.invested + amt).toFixed(2);
          }
          saveState();
          renderAll();
          openNpsHistoryModal(npsId);
          showToast(`Added +${newUnits.toFixed(4)} units to ${npsItem.schemeId}`);
        });

        document.getElementById('btnSaveExactNpsUnits').addEventListener('click', () => {
          const newU = parseFloat(document.getElementById('npsEditExactUnits').value);
          const newInv = parseFloat(document.getElementById('npsEditExactInvested').value);
          if (isNaN(newU) || newU < 0) {
            showToast('Enter valid units');
            return;
          }
          npsItem.units = +newU.toFixed(4);
          npsItem.statementUnits = +newU.toFixed(4);
          npsItem.statementDate = new Date().toISOString().slice(0, 10);
          if (!isNaN(newInv) && newInv >= 0) {
            npsItem.invested = +newInv.toFixed(2);
            npsItem.statementInvested = +newInv.toFixed(2);
          }
          const newLiveNav = parseFloat(document.getElementById('npsEditLiveNav').value);
          if (!isNaN(newLiveNav) && newLiveNav > 0) {
            npsItem.prevNav = npsItem.currentNav || newLiveNav;
            npsItem.currentNav = +newLiveNav.toFixed(4);
          }
          saveState();
          renderAll();
          openNpsHistoryModal(npsId);
          showToast('Locked exact statement units & invested amount');
        });

        document.getElementById('npsInstHistoryContainer').addEventListener('click', (ev) => {
          const delBtn = ev.target.closest('[data-del-nps-inst]');
          if (!delBtn) return;
          const instId = delBtn.getAttribute('data-del-nps-inst');
          const target = npsItem.installments.find(x => x.id === instId);
          if (target) {
            if (!npsItem.statementDate || target.date > npsItem.statementDate) {
              npsItem.units = Math.max(0, +(npsItem.units - Number(target.units || 0)).toFixed(4));
              npsItem.invested = Math.max(0, +(npsItem.invested - Number(target.amount || 0)).toFixed(2));
            }
            npsItem.installments = npsItem.installments.filter(x => x.id !== instId);
            saveState();
            renderAll();
            openNpsHistoryModal(npsId);
          }
        });
      }

      // Draw NPS NAV Chart from installment history or NPSNAV.in API
      const drawNpsChart = (points) => {
        const canvas = document.getElementById('npsDetailNavChart');
        if (!canvas || typeof Chart === 'undefined' || !points.length) return;
        if (npsDetailChartInstance) npsDetailChartInstance.destroy();
        npsDetailChartInstance = new Chart(canvas.getContext('2d'), {
          type: 'line',
          data: {
            labels: points.map(p => p.date),
            datasets: [{
              data: points.map(p => p.nav),
              borderColor: '#fbbf24',
              borderWidth: 2.2,
              pointRadius: 0,
              tension: 0.25,
              fill: true,
              backgroundColor: 'rgba(251, 191, 36, 0.08)'
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { display: false }, y: { display: false } }
          }
        });
      };

      const localPts = instList.slice().reverse().map(x => ({ date: x.date, nav: Number(x.nav) })).filter(x => x.nav > 0);
      if (localPts.length >= 2) drawNpsChart(localPts);

      if (npsItem.schemeId && /^SM\d+/i.test(npsItem.schemeId)) {
        try {
          const hRes = await fetch(`https://npsnav.in/api/historical/${encodeURIComponent(npsItem.schemeId.trim())}`);
          if (hRes.ok) {
            const hJson = await hRes.json();
            const arr = Array.isArray(hJson.data) ? hJson.data : [];
            if (arr.length > 5) {
              const step = Math.max(1, Math.floor(arr.length / 80));
              const sampled = arr.filter((_, i) => i % step === 0).map(r => ({ date: r.date, nav: parseFloat(r.nav) })).filter(r => r.nav > 0);
              drawNpsChart(sampled);
            }
          }
        } catch (e) {}
      }
    }

    document.getElementById('npsList').addEventListener('click', (e) => {
      const card = e.target.closest('[data-open-nps]');
      if (card) {
        openNpsHistoryModal(card.getAttribute('data-open-nps'));
      }
    });

    document.querySelectorAll('.btn-edit-index').forEach(btn => {
      btn.addEventListener('click', () => {
        if (currentUserRole !== 'admin') return;
        const key = btn.getAttribute('data-edit-index');
        const idx = state.indices[key];
        openModal(`Update ${key.toUpperCase()}`, `
          <div class="space-y-3 text-xs">
            <input id="idxPrice" type="number" step="0.01" value="${idx.price || ''}" placeholder="Index Level (e.g. 24180.50)" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="idxChange" type="number" step="0.01" value="${idx.change || ''}" placeholder="Day Change (e.g. 142.30)" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <input id="idxPct" type="number" step="0.01" value="${idx.pct || ''}" placeholder="Day Change % (e.g. 0.59)" class="w-full px-3 py-2 rounded-xl bg-surface-800 border border-slate-700 text-white" />
            <button id="btnSaveIdx" type="button" class="w-full py-2.5 rounded-xl bg-emerald-600 text-white font-bold">Update</button>
          </div>
        `);
        document.getElementById('btnSaveIdx').addEventListener('click', () => {
          idx.price = parseFloat(document.getElementById('idxPrice').value) || 0;
          idx.change = parseFloat(document.getElementById('idxChange').value) || 0;
          idx.pct = parseFloat(document.getElementById('idxPct').value) || 0;
          saveState();
          closeModal();
          renderAll();
        });
      });
    });

    // Inject Standalone PWA Manifest dynamically
    try {
      const manifestObj = {
        name: 'WealthLocal Vault',
        short_name: 'WealthLocal',
        display: 'standalone',
        background_color: '#070b14',
        theme_color: '#070b14',
        orientation: 'portrait'
      };
      const mLink = document.createElement('link');
      mLink.rel = 'manifest';
      mLink.href = 'data:application/manifest+json;charset=utf-8,' + encodeURIComponent(JSON.stringify(manifestObj));
      document.head.appendChild(mLink);
    } catch (e) {}

    // Auto-fetch live NIFTY 50 & SENSEX if not yet populated
    if (!state.indices.nifty.price || !state.indices.sensex.price) {
      syncLiveMarketIndices();
    }

    // Check if returning from automatic "Only myself" Gmail Sync bounce (`#wl_gmail_sync=<base64>`)
    async function checkIncomingGmailSyncHash() {
      try {
        const h = String(window.location.hash || '');
        if (!h.includes('wl_gmail_sync=')) return;
        const b64 = decodeURIComponent(h.split('wl_gmail_sync=')[1].split('&')[0]);
        // Clear hash immediately from address bar
        try {
          history.replaceState({ wlView: 'root_home' }, '', window.location.pathname + window.location.search);
        } catch (e) {}
        const jsonStr = decodeURIComponent(escape(atob(b64)));
        const data = JSON.parse(jsonStr);
        if (data && data.status === 'ok') {
          showAppLoader('Applying Gmail Sync Data...', 'Updating Mutual Funds & NPS holdings from verified Google session', 65);
          const items = Array.isArray(data.items) ? data.items : [];
          const npsItems = Array.isArray(data.npsItems) ? data.npsItems : [];
          const newMf = ingestGmailItems(items);
          const newNps = await ingestNpsGmailItems(npsItems);
          await syncLiveNavs();
          hideAppLoader();
          showToast(`✓ Gmail Sync Complete! MF: +${newMf} new (${items.length} emails) • NPS: +${newNps} new`);
        }
      } catch (err) {
        hideAppLoader();
      }
    }

    // Init: Restore active session ONLY if within sessionTimeoutMinutes; otherwise keep #mainAppShell hidden & unrendered!
    if (isSessionStillValid()) {
      isAppUnlocked = true;
      const sess = loadActiveSession();
      currentUserRole = (sess && sess.role) || 'admin';
      currentUserName = (sess && sess.name) || (secConfig.adminName || 'Admin');
      decryptStoredVaultIntoState().then(async () => {
        const shell = document.getElementById('mainAppShell');
        if (shell) shell.classList.remove('hidden');
        document.getElementById('appLockScreen').classList.add('hidden');
        closeAllAccordionsAndDrawers();
        applyRolePermissions();
        switchTab('overview');
        renderAll();
        await checkIncomingGmailSyncHash();
      });
    } else {
      isAppUnlocked = false;
      const shell = document.getElementById('mainAppShell');
      if (shell) shell.classList.add('hidden');
      updateLockScreenUI();
    }

    // If hosted in Google Apps Script, pull encrypted server bundle from PropertiesService
    try {
      if (typeof window.google !== 'undefined' && window.google.script && window.google.script.run) {
        window.google.script.run
          .withSuccessHandler(async (rawBundle) => {
            if (!rawBundle) return;
            try {
              const bundle = JSON.parse(rawBundle);
              if (bundle && bundle.secConfig && bundle.secConfig.registered && !secConfig.registered) {
                secConfig = bundle.secConfig;
                localStorage.setItem(SECURITY_KEY, JSON.stringify(secConfig));
                updateLockScreenUI();
                applyRolePermissions();
              }
              if (bundle && bundle.encryptedStateCipher) {
                localStorage.setItem(VAULT_CIPHER_KEY, bundle.encryptedStateCipher);
                if (isAppUnlocked) {
                  await decryptStoredVaultIntoState();
                  renderAll();
                }
              } else if (bundle && bundle.state) {
                // One-time migration from legacy unencrypted PropertiesService bundle -> encrypt immediately!
                const isLocalEmpty = state.mutualFunds.length === 0 && state.nps.length === 0 && state.epf.balance === 0 && state.ppf.balance === 0;
                if (isLocalEmpty) {
                  state = sanitizeNpsState(bundle.state);
                }
                if (isAppUnlocked) {
                  await syncServerBundle();
                  renderAll();
                }
              }
            } catch (e) {}
          })
          .loadServerAppBundle();
      }
    } catch (e) {}
