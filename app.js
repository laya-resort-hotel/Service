import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  limit,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseWebConfig } from './frontend/shared/firebase-config.js';

const MENU_URL = 'https://laya-resort-hotel.github.io/MENU/';
const DEPARTMENTS_URL = './departments/index.html';
const LAST_CHECKIN_KEY = 'laya_last_guest_checkin';
const ROOM_PATTERN = /^[ABCD]\d+$/;
const GUEST_DAILY_COLLECTION = 'guest_daily';
const LOGIN_LOG_COLLECTION = 'guest_portal_sessions';
const AUTH_WAIT_MS = 5000;

const form = document.getElementById('guestForm');
const roomNoInput = document.getElementById('roomNo');
const consentInput = document.getElementById('consent');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const openMenuBtn = document.getElementById('openMenuBtn');
const loadingOverlay = document.getElementById('loadingOverlay');

let db = null;
let auth = null;
let firebaseReady = false;
let authBootstrapPromise = null;

try {
  if (firebaseWebConfig && firebaseWebConfig.apiKey) {
    const app = initializeApp(firebaseWebConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    firebaseReady = true;
    authBootstrapPromise = bootstrapAnonymousAuth().catch((error) => {
      console.warn('Initial anonymous auth failed:', error);
      return null;
    });
  }
} catch (error) {
  console.error('Firebase init failed:', error);
}

openMenuBtn.addEventListener('click', () => {
  window.location.href = MENU_URL;
});

roomNoInput.addEventListener('input', () => {
  roomNoInput.value = normalizeRoomNo(roomNoInput.value);
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const roomNo = normalizeRoomNo(roomNoInput.value);
  const consent = consentInput.checked;

  if (!roomNo || !consent) {
    showStatus('กรุณากรอกเลขห้องและกดยินยอมก่อนเข้าสู่ระบบ', 'error');
    return;
  }

  if (!isValidRoomNo(roomNo)) {
    showStatus('เลขห้องไม่ถูกต้อง กรุณาใช้รูปแบบ A/B/C/D ตามด้วยตัวเลข เช่น A203 หรือ D108', 'error');
    return;
  }

  if (!firebaseReady || !db || !auth) {
    showStatus('ยังไม่ได้เชื่อม Firebase ของระบบ Check-in กรุณาตรวจสอบไฟล์ firebase-config.js ก่อนใช้งานจริง', 'error');
    return;
  }

  setSubmitting(true, 'กำลังตรวจสอบข้อมูลห้องพัก...');

  try {
    await ensureAnonymousAuth(true);

    const guestRecord = await findGuestDailyRecordByRoom(roomNo);
    if (!guestRecord) {
      showStatus(`ไม่พบข้อมูลห้อง ${roomNo} ในระบบ Check-in / IHN วันนี้หรือข้อมูลล่าสุด กรุณาติดต่อพนักงานโรงแรม`, 'error');
      return;
    }

    const payload = buildGuestSessionPayload(roomNo, guestRecord);
    payload.roomQrValue = `LAYA|ROOM|${payload.roomNo}`;

    localStorage.setItem(LAST_CHECKIN_KEY, JSON.stringify(payload));

    await addDoc(collection(db, LOGIN_LOG_COLLECTION), {
      roomNo: payload.roomNo,
      roomNoNormalized: payload.roomNo,
      guestName: payload.guestName,
      packageName: payload.packageName,
      pax: payload.pax,
      businessDate: payload.businessDate || null,
      sourceDocId: payload.sourceDocId,
      sourceCollection: GUEST_DAILY_COLLECTION,
      loginMode: 'room_lookup_direct',
      roomQrValue: payload.roomQrValue,
      createdAt: serverTimestamp(),
      createdAtISO: payload.syncedAtISO,
    });

    showStatus(
      `ยินดีต้อนรับ ${payload.guestName || 'Guest'} · ห้อง ${payload.roomNo} · Package ${payload.packageName || '-'} กำลังเข้าสู่หน้ารวมแผนก...`,
      'success'
    );

    setTimeout(() => {
      window.location.href = DEPARTMENTS_URL;
    }, 1100);
  } catch (error) {
    console.error(error);
    if (isPermissionError(error)) {
      showStatus('ไม่สามารถเชื่อมต่อข้อมูลห้องพักได้ในขณะนี้ กรุณารีเฟรชหน้าเว็บหรือติดต่อพนักงานโรงแรม', 'error');
    } else {
      showStatus('เกิดข้อผิดพลาดในการค้นหาข้อมูลห้องพัก กรุณาลองใหม่อีกครั้งหรือติดต่อพนักงานโรงแรม', 'error');
    }
  } finally {
    setSubmitting(false);
  }
});

async function bootstrapAnonymousAuth() {
  if (!auth) return null;

  if (auth.currentUser) {
    try {
      await auth.currentUser.getIdToken(true);
    } catch (_) {}
    return auth.currentUser;
  }

  const result = await signInAnonymously(auth);
  await waitForAuthStateReady();
  if (result?.user) {
    try {
      await result.user.getIdToken(true);
    } catch (_) {}
  }
  await sleep(250);
  return auth.currentUser || result.user;
}

async function ensureAnonymousAuth(forceRefresh = false) {
  if (!auth) throw new Error('auth_not_ready');
  if (authBootstrapPromise) await authBootstrapPromise;
  let user = auth.currentUser;
  if (!user) {
    user = await bootstrapAnonymousAuth();
    authBootstrapPromise = Promise.resolve(user);
  }
  if (!user) throw new Error('auth_not_ready');
  if (forceRefresh && user.getIdToken) {
    try { await user.getIdToken(true); } catch (_) {}
  }
  await sleep(180);
  return user;
}

function waitForAuthStateReady() {
  return new Promise((resolve, reject) => {
    if (!auth) return reject(new Error('auth_not_ready'));
    if (auth.currentUser) return resolve(auth.currentUser);
    const timeout = setTimeout(() => { unsubscribe(); reject(new Error('auth_state_timeout')); }, AUTH_WAIT_MS);
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        clearTimeout(timeout);
        unsubscribe();
        resolve(user);
      }
    });
  });
}

async function findGuestDailyRecordByRoom(roomNo) {
  const variants = buildRoomVariants(roomNo);
  const fieldsToTry = ['room_no', 'roomNo', 'room', 'Room', 'roomNormalized', 'room_no_normalized'];

  for (const fieldName of fieldsToTry) {
    for (const value of variants) {
      const result = await tryQuery(fieldName, value);
      if (result) return result;
    }
  }

  const samples = await getDocs(query(collection(db, GUEST_DAILY_COLLECTION), limit(200)));
  for (const snap of samples.docs) {
    const data = snap.data() || {};
    const candidate = normalizeRoomNo(data.room_no || data.roomNo || data.room || data.Room || data.roomNormalized || '');
    if (candidate && variants.includes(candidate)) {
      return { id: snap.id, data };
    }
  }
  return null;
}

async function tryQuery(fieldName, value) {
  try {
    const q = query(collection(db, GUEST_DAILY_COLLECTION), where(fieldName, '==', value), limit(1));
    const snapshot = await getDocs(q);
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return { id: doc.id, data: doc.data() };
    }
    return null;
  } catch (error) {
    if (isPermissionError(error)) throw error;
    console.warn(`Query failed on ${fieldName}=${value}`, error);
    return null;
  }
}

function buildGuestSessionPayload(roomNo, guestRecord) {
  const data = guestRecord?.data || {};
  return {
    roomNo,
    guestName: firstFilled(data.guest_name, data.guestName, data.name, data.fullName, ''),
    packageName: firstFilled(data.package, data.breakfast_package, data.special_package, data.mealplan, '-'),
    pax: Number(firstFilled(data.pax, data.adults, data.guest_count, 1)) || 1,
    businessDate: firstFilled(data.business_date, data.businessDate, ''),
    sourceDocId: guestRecord?.id || firstFilled(data.doc_id, ''),
    syncedAtISO: new Date().toISOString(),
  };
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function normalizeRoomNo(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, '').trim();
}

function buildRoomVariants(roomNo) {
  const normalized = normalizeRoomNo(roomNo);
  if (!normalized) return [];
  const spaced = normalized.replace(/^([A-Z])(\d+)$/, '$1 $2');
  return Array.from(new Set([normalized, normalized.toLowerCase(), spaced]));
}

function isValidRoomNo(value) {
  return ROOM_PATTERN.test(normalizeRoomNo(value));
}

function setSubmitting(isSubmitting, message = 'กำลังประมวลผล...') {
  submitBtn.disabled = isSubmitting;
  submitBtn.textContent = isSubmitting ? 'กำลังค้นหา...' : 'ค้นหาข้อมูลและเข้าสู่ระบบ';
  loadingOverlay.classList.toggle('hidden', !isSubmitting);
  loadingOverlay.classList.toggle('active', isSubmitting);
  if (isSubmitting) {
    statusBox.classList.add('hidden');
  }
}

function showStatus(message, type = 'success') {
  statusBox.textContent = message;
  statusBox.className = `status-box ${type}`;
}

function isPermissionError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code.includes('permission-denied') || /permission/i.test(message) || /insufficient/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
