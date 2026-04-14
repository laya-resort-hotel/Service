import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';

const appConfig = window.APP_CONFIG;
if (!appConfig?.firebaseConfig) {
  throw new Error('Missing APP_CONFIG. Copy frontend/shared/firebase-config.example.js and fill your Firebase config first.');
}

const app = initializeApp(appConfig.firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, appConfig.functionsRegion || 'asia-southeast1');

const els = {
  redemptionId: document.getElementById('redemption-id'),
  loadBtn: document.getElementById('load-token-btn'),
  refreshBtn: document.getElementById('refresh-token-btn'),
  status: document.getElementById('guest-status'),
  authUser: document.getElementById('auth-user'),
  guestUid: document.getElementById('guest-uid'),
  rewardId: document.getElementById('reward-id'),
  requestId: document.getElementById('request-id'),
  expiresAt: document.getElementById('expires-at'),
  pickupCode: document.getElementById('pickup-code'),
  pickupQr: document.getElementById('pickup-qr'),
  copyBtn: document.getElementById('copy-code-btn'),
};

let currentToken = null;

function setStatus(message, mode = 'default') {
  els.status.textContent = message;
  els.status.className = `status${mode === 'default' ? '' : ` ${mode}`}`;
}

function setBusy(isBusy) {
  els.loadBtn.disabled = isBusy;
  els.refreshBtn.disabled = isBusy;
}

function formatIso(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function renderQrCode(value) {
  els.pickupQr.innerHTML = '';
  if (!value) {
    els.pickupQr.innerHTML = '<div class="muted">ยังไม่มี QR</div>';
    return;
  }

  if (!window.QRCode) {
    els.pickupQr.innerHTML = '<div class="muted">QR library not available. Use fallback code below.</div>';
    return;
  }

  const canvas = document.createElement('canvas');
  els.pickupQr.appendChild(canvas);
  window.QRCode.toCanvas(canvas, value, {
    width: 280,
    margin: 1,
    errorCorrectionLevel: 'M',
  }, (error) => {
    if (error) {
      els.pickupQr.innerHTML = '<div class="muted">สร้าง QR ไม่สำเร็จ</div>';
      console.error(error);
    }
  });
}

function applyToken(result) {
  currentToken = result;
  els.guestUid.textContent = result.guestUid || '-';
  els.rewardId.textContent = result.rewardId || '-';
  els.requestId.textContent = result.requestId || '-';
  els.expiresAt.textContent = formatIso(result.expiresAt);
  els.pickupCode.textContent = result.qrCodeValue || '-';
  renderQrCode(result.qrCodeValue);
  setStatus(result.reused ? 'ใช้ token เดิมที่ยังไม่หมดอายุ' : 'สร้าง pickup token เรียบร้อยแล้ว', 'ok');
}

async function loadPickupToken(forceReissue = false) {
  const redemptionId = els.redemptionId.value.trim();
  if (!redemptionId) {
    setStatus('กรุณากรอก redemption ID ก่อน', 'warn');
    return;
  }

  setBusy(true);
  setStatus(forceReissue ? 'กำลังออก token ใหม่...' : 'กำลังโหลด pickup token...');

  try {
    const createRewardPickupToken = httpsCallable(functions, 'createRewardPickupToken');
    const response = await createRewardPickupToken({ redemptionId, forceReissue });
    applyToken(response.data);
  } catch (error) {
    console.error(error);
    const message = error?.message || 'สร้าง pickup token ไม่สำเร็จ';
    setStatus(message, 'warn');
  } finally {
    setBusy(false);
  }
}

function prefillFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const redemptionId = params.get('redemptionId');
  if (redemptionId) {
    els.redemptionId.value = redemptionId;
  }
}

els.loadBtn.addEventListener('click', () => loadPickupToken(false));
els.refreshBtn.addEventListener('click', () => loadPickupToken(true));
els.copyBtn.addEventListener('click', async () => {
  if (!currentToken?.qrCodeValue) {
    setStatus('ยังไม่มี code ให้คัดลอก', 'warn');
    return;
  }

  try {
    await navigator.clipboard.writeText(currentToken.qrCodeValue);
    setStatus('คัดลอก code แล้ว', 'ok');
  } catch (error) {
    console.error(error);
    setStatus('คัดลอก code ไม่สำเร็จ', 'warn');
  }
});

onAuthStateChanged(auth, (user) => {
  els.authUser.textContent = user ? `${user.uid}` : 'Not signed in';
  if (!user) {
    setStatus('ยังไม่ได้ล็อกอินในแอปหลัก', 'warn');
    return;
  }

  prefillFromQuery();
  if (els.redemptionId.value.trim()) {
    loadPickupToken(false);
  }
});
