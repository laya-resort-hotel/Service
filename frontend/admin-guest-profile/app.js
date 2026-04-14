import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  where,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const appConfig = window.APP_CONFIG;
const app = initializeApp(appConfig.firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const params = new URLSearchParams(window.location.search);
const guestUid = params.get('guestUid');

const els = {
  status: document.getElementById('page-status'),
  summaryGrid: document.getElementById('summary-grid'),
  guestInfo: document.getElementById('guest-info'),
  claimsBody: document.getElementById('claims-body'),
  redemptionsBody: document.getElementById('redemptions-body'),
};

function setStatus(message, mode = 'default') {
  els.status.textContent = message;
  els.status.className = `status${mode === 'default' ? '' : ` ${mode}`}`;
}
function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
}
function formatDate(input) {
  if (!input) return '-';
  try {
    const date = typeof input?.toDate === 'function' ? input.toDate() : new Date(input);
    return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return String(input); }
}
async function requireAccess(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) throw new Error('ไม่พบ user profile');
  const data = snap.data();
  const allowed = ['admin', 'fo_npc', 'guest_relations_npc', 'mod_npc', 'gm_npc'];
  if (!data?.active || !allowed.includes(data?.role)) throw new Error('บัญชีนี้ไม่มีสิทธิ์เข้าหน้านี้');
}
function statCard(label, value, note='') {
  return `<article class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div>${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ''}</article>`;
}
async function loadProfile() {
  if (!guestUid) {
    setStatus('ไม่พบ guestUid ในลิงก์', 'warn');
    return;
  }
  setStatus('กำลังโหลดข้อมูลแขก...');
  try {
    const [userSnap, profileSnap, walletSnap, claimsSnap, redemptionsSnap] = await Promise.all([
      getDoc(doc(db, 'users', guestUid)),
      getDoc(doc(db, 'guest_profiles', guestUid)),
      getDoc(doc(db, 'guest_wallets', guestUid)),
      getDocs(query(collection(db, 'quest_claims'), where('guestUid', '==', guestUid), limit(20))),
      getDocs(query(collection(db, 'redemptions'), where('guestUid', '==', guestUid), limit(20))),
    ]);

    const user = userSnap.exists() ? userSnap.data() : null;
    const profile = profileSnap.exists() ? profileSnap.data() : null;
    const wallet = walletSnap.exists() ? walletSnap.data() : null;
    const claims = claimsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a,b) => new Date(b.createdAt?.toDate?.() || b.createdAt || 0) - new Date(a.createdAt?.toDate?.() || a.createdAt || 0));
    const redemptions = redemptionsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a,b) => new Date(b.fulfilledAt?.toDate?.() || b.createdAt?.toDate?.() || b.createdAt || 0) - new Date(a.fulfilledAt?.toDate?.() || a.createdAt?.toDate?.() || a.createdAt || 0));

    els.summaryGrid.innerHTML = [
      statCard('Guest', profile?.fullName || user?.displayName || guestUid, guestUid),
      statCard('Room', profile?.roomNo || '-', profile?.stayId || '-'),
      statCard('Bronze', String(wallet?.bronze ?? 0), 'current'),
      statCard('Silver', String(wallet?.silver ?? 0), 'current'),
      statCard('Gold', String(wallet?.gold ?? 0), 'current'),
      statCard('Status', profile?.status || (user?.active ? 'active' : 'inactive'), user?.language || '-'),
    ].join('');

    els.guestInfo.innerHTML = `
      <div class="kv-grid">
        <div class="kv-label">Guest UID</div><div class="mono">${escapeHtml(guestUid)}</div>
        <div class="kv-label">Full name</div><div>${escapeHtml(profile?.fullName || user?.displayName || '-')}</div>
        <div class="kv-label">Phone</div><div>${escapeHtml(user?.phone || '-')}</div>
        <div class="kv-label">Nationality</div><div>${escapeHtml(profile?.nationality || '-')}</div>
        <div class="kv-label">Check in</div><div>${escapeHtml(formatDate(profile?.checkInDate))}</div>
        <div class="kv-label">Check out</div><div>${escapeHtml(formatDate(profile?.checkOutDate))}</div>
        <div class="kv-label">Party size</div><div>${escapeHtml(String(profile?.partySize ?? '-'))}</div>
        <div class="kv-label">Current location</div><div>${escapeHtml(profile?.currentLocationId || '-')}</div>
      </div>`;

    els.claimsBody.innerHTML = claims.length ? claims.map((row) => `
      <tr>
        <td>${escapeHtml(formatDate(row.createdAt))}</td>
        <td>${escapeHtml(row.missionId || row.questType || '-')}</td>
        <td>${escapeHtml(row.rewardType || '-')}</td>
        <td>${escapeHtml(String(row.rewardAmount ?? '-'))}</td>
        <td>${escapeHtml(row.approvedBy || '-')}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty-cell">ยังไม่มีข้อมูล</td></tr>';

    els.redemptionsBody.innerHTML = redemptions.length ? redemptions.map((row) => `
      <tr>
        <td><span class="status-pill ${escapeHtml(row.status || 'approved')}">${escapeHtml(row.status || '-')}</span></td>
        <td>${escapeHtml(row.rewardId || '-')}</td>
        <td class="mono">${escapeHtml(row.requestId || '-')}</td>
        <td class="mono">${escapeHtml(row.id)}</td>
        <td>${escapeHtml(formatDate(row.fulfilledAt || row.createdAt))}</td>
      </tr>`).join('') : '<tr><td colspan="5" class="empty-cell">ยังไม่มีข้อมูล</td></tr>';

    setStatus('โหลดข้อมูลแขกสำเร็จ', 'ok');
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'โหลดข้อมูลแขกไม่สำเร็จ', 'warn');
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    setStatus('ยังไม่ได้ล็อกอินในแอปหลัก', 'warn');
    return;
  }
  try {
    await requireAccess(user.uid);
    await loadProfile();
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'ไม่มีสิทธิ์เข้าหน้านี้', 'warn');
  }
});
