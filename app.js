import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
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
const REDIRECT_DELAY_MS = 1200;
const ROOM_PATTERN = /^[ABCD]\d+$/;
const GUEST_DAILY_COLLECTION = 'guest_daily';
const LOGIN_LOG_COLLECTION = 'guest_portal_sessions';

const form = document.getElementById('guestForm');
const roomNoInput = document.getElementById('roomNo');
const consentInput = document.getElementById('consent');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const openMenuBtn = document.getElementById('openMenuBtn');
const openPortalBtn = document.getElementById('openPortalBtn');

let db = null;
let auth = null;
let firebaseReady = false;

try {
  if (firebaseWebConfig && firebaseWebConfig.apiKey) {
    const app = initializeApp(firebaseWebConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    firebaseReady = true;
  }
} catch (error) {
  console.error('Firebase init failed:', error);
}

openMenuBtn.addEventListener('click', () => {
  window.location.href = MENU_URL;
});

openPortalBtn.addEventListener('click', () => {
  window.location.href = DEPARTMENTS_URL;
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
    showStatus('ยังไม่ได้เชื่อม Firebase ของระบบ Check-in กรุณาใส่ค่าใน firebase-config.js ก่อนใช้งานจริง', 'error');
    return;
  }

  setSubmitting(true);

  try {
    await ensureAnonymousAuth();

    const guestRecord = await findGuestDailyRecordByRoom(roomNo);
    if (!guestRecord) {
      showStatus(`ไม่พบข้อมูลห้อง ${roomNo} ในระบบ Check-in / IHN วันนี้หรือข้อมูลล่าสุด กรุณาติดต่อพนักงานโรงแรม`, 'error');
      return;
    }

    const payload = buildGuestSessionPayload(roomNo, guestRecord);

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
      loginMode: 'room_lookup_sync',
      createdAt: serverTimestamp(),
      createdAtISO: payload.syncedAtISO,
    });

    showStatus(
      `พบข้อมูลห้อง ${payload.roomNo} · ${payload.guestName || 'Guest'} · Package ${payload.packageName || '-'} กำลังเข้าสู่หน้ารวมแผนก...`,
      'success'
    );

    form.reset();
    redirectToDepartmentsWithDelay();
  } catch (error) {
    console.error(error);
    showStatus('เกิดข้อผิดพลาดในการดึงข้อมูลจากระบบ Check-in กรุณาลองใหม่อีกครั้ง', 'error');
  } finally {
    setSubmitting(false);
  }
});

async function ensureAnonymousAuth() {
  if (auth.currentUser) return auth.currentUser;
  const result = await signInAnonymously(auth);
  return result.user;
}

async function findGuestDailyRecordByRoom(roomNo) {
  const roomFields = ['room', 'room_no', 'roomNo', 'roomNormalized', 'roomNoNormalized'];
  const results = new Map();

  for (const fieldName of roomFields) {
    try {
      const roomQuery = query(collection(db, GUEST_DAILY_COLLECTION), where(fieldName, '==', roomNo), limit(10));
      const snapshot = await getDocs(roomQuery);
      snapshot.forEach((docSnap) => {
        if (!results.has(docSnap.id)) {
          results.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
        }
      });
    } catch (error) {
      console.warn(`Room lookup failed for field ${fieldName}:`, error);
    }
  }

  const docs = Array.from(results.values());
  if (!docs.length) return null;

  const bangkokToday = getBangkokDateKey();
  const scored = docs
    .map((doc) => ({ doc, score: getGuestDocScore(doc, bangkokToday) }))
    .sort((a, b) => b.score - a.score);

  return scored[0].doc;
}

function buildGuestSessionPayload(roomNo, guestRecord) {
  const guestName = firstNonEmpty([
    guestRecord.guest_name,
    guestRecord.guestName,
    guestRecord.name,
    guestRecord.fullName,
  ]);

  const packageName = firstNonEmpty([
    guestRecord.package,
    guestRecord.mealplan,
    guestRecord.breakfastPackage,
    guestRecord.breakfast_package,
    guestRecord.specialPackage,
    guestRecord.special_package,
  ]);

  const pax = guestRecord.pax ?? guestRecord.adults ?? guestRecord.guest_count ?? guestRecord.guestCount ?? null;
  const businessDate = firstNonEmpty([
    guestRecord.businessDate,
    guestRecord.business_date,
    guestRecord.dateKey,
    guestRecord.date,
  ]);

  return {
    roomNo,
    guestName: guestName || 'Guest',
    packageName: packageName || '-',
    pax: pax ?? '-',
    breakfastEligible: guestRecord.eligible ?? guestRecord.breakfastEligible ?? null,
    businessDate: businessDate || '',
    sourceDocId: guestRecord.id || '',
    sourceCollection: GUEST_DAILY_COLLECTION,
    syncedAtISO: new Date().toISOString(),
    loginMode: 'room_lookup_sync',
  };
}

function getGuestDocScore(doc, bangkokToday) {
  let score = 0;

  const businessDate = firstNonEmpty([
    doc.businessDate,
    doc.business_date,
    doc.dateKey,
    doc.date,
  ]);

  if (businessDate && String(businessDate).trim() === bangkokToday) {
    score += 1000000000000;
  }

  const createdAt = toMillis(doc.createdAt) || toMillis(doc.updatedAt) || toMillis(doc.importedAt) || 0;
  score += createdAt;

  return score;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return '';
}

function getBangkokDateKey() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function normalizeRoomNo(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
}

function isValidRoomNo(roomNo) {
  return ROOM_PATTERN.test(roomNo);
}

function redirectToDepartmentsWithDelay() {
  window.setTimeout(() => {
    window.location.href = DEPARTMENTS_URL;
  }, REDIRECT_DELAY_MS);
}

function showStatus(message, type) {
  statusBox.textContent = message;
  statusBox.classList.remove('hidden', 'success', 'error');
  statusBox.classList.add(type === 'success' ? 'success' : 'error');
}

function setSubmitting(isSubmitting) {
  submitBtn.disabled = isSubmitting;
  submitBtn.textContent = isSubmitting ? 'กำลังค้นหาข้อมูล...' : 'ค้นหาข้อมูลและเข้าสู่ระบบ';
}
