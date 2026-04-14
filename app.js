import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';
import { firebaseWebConfig } from './frontend/shared/firebase-config.js';

const MENU_URL = 'https://laya-resort-hotel.github.io/MENU/';
const STORAGE_KEY = 'laya_guest_checkins_local';

const form = document.getElementById('guestForm');
const guestNameInput = document.getElementById('guestName');
const roomNoInput = document.getElementById('roomNo');
const consentInput = document.getElementById('consent');
const submitBtn = document.getElementById('submitBtn');
const statusBox = document.getElementById('statusBox');
const openMenuBtn = document.getElementById('openMenuBtn');

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

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const guestName = guestNameInput.value.trim();
  const roomNo = roomNoInput.value.trim().toUpperCase();
  const consent = consentInput.checked;

  if (!guestName || !roomNo || !consent) {
    showStatus('กรุณากรอกชื่อ เลขห้อง และกดยินยอมก่อนบันทึกข้อมูล', 'error');
    return;
  }

  const payload = {
    guestName,
    roomNo,
    consent,
    source: 'hotel_main_portal',
    createdAtISO: new Date().toISOString(),
  };

  setSubmitting(true);

  try {
    if (firebaseReady && db) {
      await addDoc(collection(db, 'guest_checkins'), {
        ...payload,
        createdAt: serverTimestamp(),
      });

      localStorage.setItem('laya_last_guest_checkin', JSON.stringify(payload));
      showStatus('บันทึกข้อมูลเข้าระบบเรียบร้อยแล้ว กำลังพาเข้าสู่เมนูร้านอาหาร...', 'success');
      form.reset();
      setTimeout(() => {
        window.location.href = MENU_URL;
      }, 1200);
      return;
    }

    const existing = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    existing.push(payload);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
    localStorage.setItem('laya_last_guest_checkin', JSON.stringify(payload));

    showStatus('บันทึกแบบทดสอบในเครื่องนี้แล้ว กรุณาใส่ค่า Firebase เพื่อบันทึกเข้าระบบจริง', 'success');
    form.reset();
  } catch (error) {
    console.error(error);
    showStatus('เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาลองใหม่อีกครั้ง', 'error');
  } finally {
    setSubmitting(false);
  }
});

function showStatus(message, type) {
  statusBox.textContent = message;
  statusBox.classList.remove('hidden', 'success', 'error');
  statusBox.classList.add(type === 'success' ? 'success' : 'error');
}

function setSubmitting(isSubmitting) {
  submitBtn.disabled = isSubmitting;
  submitBtn.textContent = isSubmitting ? 'กำลังบันทึก...' : 'บันทึกข้อมูลเข้าระบบ';
}
