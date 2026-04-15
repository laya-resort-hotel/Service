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
const REDIRECT_DELAY_MS = 1200;
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
const openPortalBtn = document.getElementById('openPortalBtn');
const testGuestDailyBtn = document.getElementById('testGuestDailyBtn');
const clearDebugBtn = document.getElementById('clearDebugBtn');
const debugOutput = document.getElementById('debugOutput');
const debugPanel = document.getElementById('debugPanel');

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

openPortalBtn.addEventListener('click', () => {
  window.location.href = DEPARTMENTS_URL;
});

if (testGuestDailyBtn) {
  testGuestDailyBtn.addEventListener('click', runGuestDailyDebug);
}

if (clearDebugBtn) {
  clearDebugBtn.addEventListener('click', () => {
    debugOutput.textContent = 'ยังไม่มีข้อมูล debug';
  });
}

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
    await ensureAnonymousAuth(true);

    const guestRecord = await findGuestDailyRecordByRoom(roomNo);
    if (!guestRecord) {
      showStatus(`ไม่พบข้อมูลห้อง ${roomNo} ในระบบ Check-in / IHN วันนี้หรือข้อมูลล่าสุด กรุณาติดต่อพนักงานโรงแรม`, 'error');
      await runGuestDailyDebug(roomNo);
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
      loginMode: 'room_lookup_direct',
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
    const message = String(error?.message || error || '');
    if (isPermissionError(error)) {
      showStatus('ระบบเชื่อม Firebase ได้ แต่ยังไม่มีสิทธิ์อ่าน guest_daily หรือ auth ยังไม่พร้อม กรุณาเช็ก Anonymous Auth, Firestore Rules และลองรีเฟรชหน้าเว็บอีกครั้ง', 'error');
    } else {
      showStatus(`เกิดข้อผิดพลาดในการดึงข้อมูลจากระบบ Check-in: ${message || 'กรุณาลองใหม่อีกครั้ง'}`, 'error');
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
    } catch (_) {
      // ignore token refresh error and continue with current user state
    }
    return auth.currentUser;
  }

  const result = await signInAnonymously(auth);
  await waitForAuthStateReady();
  if (result?.user) {
    try {
      await result.user.getIdToken(true);
    } catch (_) {
      // ignore token refresh error
    }
  }
  await sleep(250);
  return auth.currentUser || result.user;
}

async function ensureAnonymousAuth(forceRefresh = false) {
  if (!auth) throw new Error('auth_not_ready');

  if (authBootstrapPromise) {
    await authBootstrapPromise;
  }

  let user = auth.currentUser;

  if (!user) {
    user = await bootstrapAnonymousAuth();
    authBootstrapPromise = Promise.resolve(user);
  }

  if (!user) {
    throw new Error('anonymous_auth_failed');
  }

  try {
    await user.getIdToken(forceRefresh);
  } catch (_) {
    // Continue and retry bootstrap once below
  }

  if (!auth.currentUser) {
    user = await bootstrapAnonymousAuth();
    authBootstrapPromise = Promise.resolve(user);
  }

  await waitForAuthStateReady();
  await sleep(150);

  return auth.currentUser || user;
}

function waitForAuthStateReady(timeoutMs = AUTH_WAIT_MS) {
  return new Promise((resolve) => {
    if (!auth) {
      resolve(null);
      return;
    }

    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try { unsubscribe(); } catch (_) {}
      resolve(auth.currentUser || null);
    }, timeoutMs);

    const unsubscribe = onAuthStateChanged(
      auth,
      (user) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        unsubscribe();
        resolve(user || null);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        try { unsubscribe(); } catch (_) {}
        resolve(auth.currentUser || null);
      }
    );
  });
}

async function getDocsWithAuthRetry(firestoreQuery) {
  try {
    await ensureAnonymousAuth(false);
    return await getDocs(firestoreQuery);
  } catch (error) {
    if (!isPermissionError(error)) throw error;
    await ensureAnonymousAuth(true);
    await sleep(250);
    return await getDocs(firestoreQuery);
  }
}

async function findGuestDailyRecordByRoom(roomNo) {
  await ensureAnonymousAuth(false);

  const roomFields = ['room', 'room_no', 'roomNo', 'roomNormalized', 'roomNoNormalized', 'Room'];
  const roomVariants = buildRoomVariants(roomNo);
  const results = new Map();
  let hadPermissionError = false;

  for (const fieldName of roomFields) {
    for (const roomVariant of roomVariants) {
      try {
        const roomQuery = query(collection(db, GUEST_DAILY_COLLECTION), where(fieldName, '==', roomVariant), limit(20));
        const snapshot = await getDocsWithAuthRetry(roomQuery);
        snapshot.forEach((docSnap) => {
          if (!results.has(docSnap.id)) {
            results.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
          }
        });
      } catch (error) {
        console.warn(`Room lookup failed for field ${fieldName}:`, error);
        if (isPermissionError(error)) {
          hadPermissionError = true;
        }
      }
    }
  }

  if (!results.size) {
    try {
      const fallbackSnapshot = await getDocsWithAuthRetry(query(collection(db, GUEST_DAILY_COLLECTION), limit(800)));
      fallbackSnapshot.forEach((docSnap) => {
        const data = { id: docSnap.id, ...docSnap.data() };
        const docRoom = extractRoomNo(data);
        if (docRoom && buildRoomVariants(docRoom).includes(roomNo)) {
          if (!results.has(docSnap.id)) {
            results.set(docSnap.id, data);
          }
        }
      });
    } catch (error) {
      console.warn('Fallback guest_daily scan failed:', error);
      if (isPermissionError(error)) {
        hadPermissionError = true;
      }
    }
  }

  const docs = Array.from(results.values());
  if (!docs.length) {
    if (hadPermissionError) {
      throw new Error('permission_denied_guest_daily');
    }
    return null;
  }

  const bangkokToday = getBangkokDateKey();
  const scored = docs
    .map((doc) => ({ doc, score: getGuestDocScore(doc, bangkokToday) }))
    .sort((a, b) => b.score - a.score);

  return scored[0].doc;
}

function buildRoomVariants(roomNo) {
  const normalized = normalizeRoomNo(roomNo);
  const compact = normalized.replace(/\s+/g, '');
  const withSpace = compact.replace(/^([ABCD])(\d+)$/, '$1 $2');
  const noLeadingZeros = compact.replace(/^([ABCD])0+(\d+)$/, '$1$2');

  return Array.from(new Set([
    normalized,
    compact,
    compact.toLowerCase(),
    withSpace,
    noLeadingZeros,
  ].filter(Boolean)));
}

function extractRoomNo(doc) {
  return firstNonEmpty([
    doc.room,
    doc.room_no,
    doc.roomNo,
    doc.roomNormalized,
    doc.roomNoNormalized,
    doc.Room,
  ]);
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
    loginMode: 'room_lookup_direct',
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

async function runGuestDailyDebug(roomOverride = '') {
  if (debugPanel) debugPanel.open = true;

  const roomNo = normalizeRoomNo(roomOverride || roomNoInput.value);
  const lines = [];
  const push = (label, value) => lines.push(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

  push('เวลา', new Date().toISOString());
  push('roomNoInput', roomNo || '(empty)');
  push('firebaseReady', firebaseReady);
  push('projectId', firebaseWebConfig?.projectId || '(missing)');
  push('authDomain', firebaseWebConfig?.authDomain || '(missing)');
  push('collection', GUEST_DAILY_COLLECTION);
  push('roomVariants', buildRoomVariants(roomNo || ''));

  if (!firebaseReady || !db || !auth) {
    push('result', 'Firebase not ready');
    debugOutput.textContent = lines.join("\n\n");
    return;
  }

  try {
    const user = await ensureAnonymousAuth(true);
    push('authUid', user?.uid || '(none)');
    push('authProvider', user?.isAnonymous ? 'anonymous' : 'other');
    push('authCurrentUserReady', !!auth.currentUser);
  } catch (error) {
    push('authError', String(error?.message || error || 'unknown auth error'));
    debugOutput.textContent = lines.join("\n\n");
    return;
  }

  const roomFields = ['room', 'room_no', 'roomNo', 'roomNormalized', 'roomNoNormalized', 'Room'];
  const exactHits = [];

  for (const fieldName of roomFields) {
    for (const variant of buildRoomVariants(roomNo || '')) {
      try {
        const snapshot = await getDocsWithAuthRetry(query(collection(db, GUEST_DAILY_COLLECTION), where(fieldName, '==', variant), limit(5)));
        if (!snapshot.empty) {
          snapshot.forEach((docSnap) => {
            exactHits.push({
              docId: docSnap.id,
              fieldName,
              variant,
              roomExtracted: extractRoomNo(docSnap.data()),
              guestName: firstNonEmpty([docSnap.data().guest_name, docSnap.data().guestName, docSnap.data().name, docSnap.data().fullName]),
              packageName: firstNonEmpty([docSnap.data().package, docSnap.data().mealplan]),
            });
          });
        }
      } catch (error) {
        push(`queryError ${fieldName}=${variant}`, String(error?.message || error || 'query error'));
      }
    }
  }

  push('exactHitCount', exactHits.length);
  if (exactHits.length) {
    push('exactHits', exactHits);
  }

  try {
    const sampleSnapshot = await getDocsWithAuthRetry(query(collection(db, GUEST_DAILY_COLLECTION), limit(10)));
    const samples = [];
    sampleSnapshot.forEach((docSnap) => {
      const data = docSnap.data() || {};
      samples.push({
        docId: docSnap.id,
        room: extractRoomNo(data),
        guestName: firstNonEmpty([data.guest_name, data.guestName, data.name, data.fullName]),
        packageName: firstNonEmpty([data.package, data.mealplan]),
        businessDate: firstNonEmpty([data.businessDate, data.business_date, data.dateKey, data.date]),
        rawRoomFields: {
          room: data.room ?? null,
          room_no: data.room_no ?? null,
          roomNo: data.roomNo ?? null,
          roomNormalized: data.roomNormalized ?? null,
          roomNoNormalized: data.roomNoNormalized ?? null,
          Room: data.Room ?? null,
        },
      });
    });

    push('sampleCount', samples.length);
    push('samples', samples);

    if (roomNo && !exactHits.length) {
      const normalizedTarget = normalizeRoomNo(roomNo);
      const fuzzyHits = samples.filter((item) => buildRoomVariants(item.room || '').includes(normalizedTarget));
      push('fuzzyHitsInSample', fuzzyHits);
    }
  } catch (error) {
    push('sampleReadError', String(error?.message || error || 'sample read error'));
  }

  debugOutput.textContent = lines.join("\n\n");
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

function isPermissionError(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || error || '').toLowerCase();
  return code === 'permission-denied' || message.includes('permission') || message.includes('missing or insufficient permissions');
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
