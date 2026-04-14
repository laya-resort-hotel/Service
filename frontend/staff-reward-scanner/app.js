import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';

const appConfig = window.APP_CONFIG;
if (!appConfig?.firebaseConfig) {
  throw new Error('Missing APP_CONFIG. Copy frontend/shared/firebase-config.js and fill your Firebase config first.');
}

const app = initializeApp(appConfig.firebaseConfig);
const auth = getAuth(app);
const functions = getFunctions(app, appConfig.functionsRegion || 'asia-southeast1');

const els = {
  startBtn: document.getElementById('start-scan-btn'),
  stopBtn: document.getElementById('stop-scan-btn'),
  submitBtn: document.getElementById('submit-code-btn'),
  clearBtn: document.getElementById('clear-form-btn'),
  manualCode: document.getElementById('manual-code'),
  notes: document.getElementById('notes'),
  status: document.getElementById('staff-status'),
  authUser: document.getElementById('auth-user'),
  redemptionId: document.getElementById('result-redemption-id'),
  guestUid: document.getElementById('result-guest-uid'),
  rewardId: document.getElementById('result-reward-id'),
  requestId: document.getElementById('result-request-id'),
  tokenId: document.getElementById('result-token-id'),
  fulfilledAt: document.getElementById('result-fulfilled-at'),
  history: document.getElementById('history'),
};

let scanner = null;
let isProcessing = false;
let lastScannedCode = null;

function setStatus(message, mode = 'default') {
  els.status.textContent = message;
  els.status.className = `status${mode === 'default' ? '' : ` ${mode}`}`;
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

function addHistoryLine(text) {
  const empty = els.history.querySelector('.history-item.muted');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'history-item small';
  item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  els.history.prepend(item);
}

function playSuccessTone() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.04;
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.start();
    setTimeout(() => {
      oscillator.stop();
      audioCtx.close();
    }, 140);
  } catch (error) {
    console.warn('Unable to play success tone', error);
  }
}

function applyResult(result) {
  els.redemptionId.textContent = result.redemptionId || '-';
  els.guestUid.textContent = result.guestUid || '-';
  els.rewardId.textContent = result.rewardId || '-';
  els.requestId.textContent = result.requestId || '-';
  els.tokenId.textContent = result.tokenId || '-';
  els.fulfilledAt.textContent = formatIso(result.fulfilledAt);
  setStatus(result.alreadyFulfilled ? 'รายการนี้ fulfilled ไปแล้ว' : 'มอบรางวัลสำเร็จ', 'ok');
  addHistoryLine(`${result.redemptionId} → ${result.alreadyFulfilled ? 'already fulfilled' : 'fulfilled'}`);
  playSuccessTone();
}

async function submitCode(scannedCode) {
  const code = (scannedCode || els.manualCode.value || '').trim();
  const notes = (els.notes.value || '').trim();

  if (!code) {
    setStatus('กรุณากรอกหรือสแกน QR code ก่อน', 'warn');
    return;
  }

  if (isProcessing) {
    return;
  }

  if (lastScannedCode === code) {
    setStatus('กำลังประมวลผล code เดิมอยู่', 'warn');
    return;
  }

  isProcessing = true;
  lastScannedCode = code;
  setStatus('กำลังยืนยันการมอบรางวัล...');

  try {
    const fulfillRedemption = httpsCallable(functions, 'fulfillRedemption');
    const response = await fulfillRedemption({ scannedCode: code, notes });
    applyResult(response.data);
    els.manualCode.value = '';
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'ยืนยันการมอบรางวัลไม่สำเร็จ', 'warn');
    addHistoryLine(`error → ${error?.message || 'unknown error'}`);
  } finally {
    isProcessing = false;
    setTimeout(() => {
      lastScannedCode = null;
    }, 1500);
  }
}

async function startScanner() {
  if (!window.Html5QrcodeScanner) {
    setStatus('ไม่พบ scanner library', 'warn');
    return;
  }

  if (scanner) {
    setStatus('scanner ทำงานอยู่แล้ว');
    return;
  }

  setStatus('กำลังเปิดกล้อง...');

  scanner = new window.Html5QrcodeScanner(
    'qr-reader',
    {
      fps: 10,
      qrbox: { width: 240, height: 240 },
      rememberLastUsedCamera: true,
      showTorchButtonIfSupported: true,
      showZoomSliderIfSupported: true,
    },
    false,
  );

  scanner.render(
    (decodedText) => {
      els.manualCode.value = decodedText;
      submitCode(decodedText);
    },
    () => {
      // suppress noisy per-frame decode errors
    },
  );

  setStatus('กล้องพร้อมสแกน', 'ok');
}

async function stopScanner() {
  if (!scanner) {
    setStatus('scanner ยังไม่ได้เริ่ม');
    return;
  }

  try {
    await scanner.clear();
    scanner = null;
    document.getElementById('qr-reader').innerHTML = '';
    setStatus('ปิดกล้องแล้ว');
  } catch (error) {
    console.error(error);
    setStatus('ปิดกล้องไม่สำเร็จ', 'warn');
  }
}

els.startBtn.addEventListener('click', startScanner);
els.stopBtn.addEventListener('click', stopScanner);
els.submitBtn.addEventListener('click', () => submitCode(''));
els.clearBtn.addEventListener('click', () => {
  els.manualCode.value = '';
  els.notes.value = '';
  setStatus('ล้างข้อมูลแล้ว');
});

onAuthStateChanged(auth, (user) => {
  els.authUser.textContent = user ? user.uid : 'Not signed in';
  if (!user) {
    setStatus('ยังไม่ได้ล็อกอิน staff account', 'warn');
    return;
  }
  setStatus('พร้อมใช้งาน', 'ok');
});
