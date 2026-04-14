import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
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
const STORAGE_KEY = 'laya_guest_checkins_local';
const LAST_CHECKIN_KEY = 'laya_last_guest_checkin';
const REDIRECT_DELAY_MS = 1000;
const ROOM_PATTERN = /^[ABCD]\d+$/;

const form = document.getElementById('guestForm');
const guestNameInput = document.getElementById('guestName');
const roomNoInput = document.getElementById('roomNo');
const consentInput = document.getElementById('consent');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const openMenuBtn = document.getElementById('openMenuBtn');
const openPortalBtn = document.getElementById('openPortalBtn');

let db = null;
let firebaseReady = false;

try {
  if (firebaseWebConfig && firebaseWebConfig.apiKey) {
    const app = initializeApp(firebaseWebConfig);
    db = getFirestore(app);
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

  const guestName = guestNameInput.value.trim();
  const roomNo = normalizeRoomNo(roomNoInput.value);
  const consent = consentInput.checked;

  if (!guestName || !roomNo || !consent) {
    showStatus('กรุณากรอกชื่อ เลขห้อง และกดยินยอมก่อนบันทึกข้อมูล', 'error');
    return;
  }

  if (!isValidRoomNo(roomNo)) {
    showStatus('เลขห้องไม่ถูกต้อง กรุณาใช้รูปแบบ A/B/C/D ตามด้วยตัวเลข เช่น A203 หรือ D108', 'error');
    return;
  }

  const payload = {
    guestName,
    roomNo,
    roomNoNormalized: roomNo,
    consent,
    source: 'hotel_main_portal',
    createdAtISO: new Date().toISOString(),
  };

  setSubmitting(true);

  try {
    if (firebaseReady && db) {
      const duplicate = await checkDuplicateRoomInFirestore(roomNo);
      if (duplicate) {
        showStatus(`เลขห้อง ${roomNo} ถูกบันทึกไว้แล้ว กรุณาตรวจสอบอีกครั้งก่อนดำเนินการต่อ`, 'error');
        return;
      }

      await addDoc(collection(db, 'guest_checkins'), {
        ...payload,
        createdAt: serverTimestamp(),
      });

      localStorage.setItem(LAST_CHECKIN_KEY, JSON.stringify(payload));
      showStatus('บันทึกข้อมูลเข้าระบบเรียบร้อยแล้ว กำลังพาเข้าสู่หน้ารวมแผนก...', 'success');
      form.reset();
      redirectToDepartmentsWithDelay();
      return;
    }

    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    const hasDuplicate = existing.some((item) => normalizeRoomNo(item.roomNo || item.roomNoNormalized || '') === roomNo);

    if (hasDuplicate) {
      showStatus(`เลขห้อง ${roomNo} ถูกบันทึกไว้แล้วในเครื่องนี้ กรุณาตรวจสอบก่อนบันทึกซ้ำ`, 'error');
      return;
    }

    existing.push(payload);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    localStorage.setItem(LAST_CHECKIN_KEY, JSON.stringify(payload));

    showStatus('บันทึกข้อมูลเรียบร้อยแล้ว กำลังพาเข้าสู่หน้ารวมแผนก...', 'success');
    form.reset();
    redirectToDepartmentsWithDelay();
  } catch (error) {
    console.error(error);
    showStatus('เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง', 'error');
  } finally {
    setSubmitting(false);
  }
});

async function checkDuplicateRoomInFirestore(roomNo) {
  const guestCheckinsRef = collection(db, 'guest_checkins');

  const queriesToTry = [
    query(guestCheckinsRef, where('roomNoNormalized', '==', roomNo), limit(1)),
    query(guestCheckinsRef, where('roomNo', '==', roomNo), limit(1)),
  ];

  for (const roomQuery of queriesToTry) {
    const snapshot = await getDocs(roomQuery);
    if (!snapshot.empty) {
      return true;
    }
  }

  return false;
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
  submitBtn.textContent = isSubmitting ? 'กำลังบันทึก...' : 'บันทึกข้อมูลเข้าระบบ';
}
