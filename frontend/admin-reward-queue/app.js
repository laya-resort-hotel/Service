import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const appConfig = window.APP_CONFIG;
if (!appConfig?.firebaseConfig) {
  throw new Error('Missing APP_CONFIG. Copy frontend/shared/firebase-config.js and fill your Firebase config first.');
}

const app = initializeApp(appConfig.firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, appConfig.functionsRegion || 'asia-southeast1');
const callCreateRewardPickupToken = httpsCallable(functions, 'createRewardPickupToken');
const callCancelRewardRedemption = httpsCallable(functions, 'cancelRewardRedemption');
const callApprovePendingRewardRequest = httpsCallable(functions, 'approvePendingRewardRequest');
const callRejectPendingRewardRequest = httpsCallable(functions, 'rejectPendingRewardRequest');

const els = {
  search: document.getElementById('queue-search'),
  statusFilter: document.getElementById('status-filter'),
  limitFilter: document.getElementById('limit-filter'),
  dateFrom: document.getElementById('date-from'),
  dateTo: document.getElementById('date-to'),
  presetButtons: Array.from(document.querySelectorAll('[data-preset-range]')),
  refreshBtn: document.getElementById('refresh-btn'),
  exportBtn: document.getElementById('export-btn'),
  clearBtn: document.getElementById('clear-btn'),
  status: document.getElementById('queue-status'),
  queueBody: document.getElementById('queue-body'),
  visibleCount: document.getElementById('visible-count'),
  statPending: document.getElementById('stat-pending'),
  statApproved: document.getElementById('stat-approved'),
  statFulfilled: document.getElementById('stat-fulfilled'),
  statExpired: document.getElementById('stat-expired'),
  statRejected: document.getElementById('stat-rejected'),
  modal: document.getElementById('detail-modal'),
  closeModalBtn: document.getElementById('close-modal-btn'),
  detailTitle: document.getElementById('detail-title'),
  detailSubtitle: document.getElementById('detail-subtitle'),
  detailStatus: document.getElementById('detail-status'),
  approveBtn: document.getElementById('approve-request-btn'),
  rejectBtn: document.getElementById('reject-request-btn'),
  reissueBtn: document.getElementById('reissue-token-btn'),
  cancelBtn: document.getElementById('cancel-request-btn'),
  openGuestBtn: document.getElementById('open-guest-btn'),
  detailSummaryGrid: document.getElementById('detail-summary-grid'),
  detailGuestRequest: document.getElementById('detail-guest-request'),
  detailToken: document.getElementById('detail-token'),
  detailTimeline: document.getElementById('detail-timeline'),
  detailLogs: document.getElementById('detail-logs'),
};

let queueRows = [];
let authReady = false;
let currentUserRole = null;
let currentDetail = null;
let filteredRows = [];

function setStatus(message, mode = 'default') {
  els.status.textContent = message;
  els.status.className = `status${mode === 'default' ? '' : ` ${mode}`}`;
}

function setBusy(isBusy) {
  els.refreshBtn.disabled = isBusy;
  els.exportBtn.disabled = isBusy;
  els.clearBtn.disabled = isBusy;
}

function setDetailStatus(message, mode = 'default') {
  els.detailStatus.textContent = message;
  els.detailStatus.className = `status${mode === 'default' ? '' : ` ${mode}`}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function toJsDate(input) {
  if (!input) return null;
  try {
    if (typeof input?.toDate === 'function') return input.toDate();
    const date = new Date(input);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

function toDateStart(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateEnd(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getBangkokTodayDateKey() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function shiftDateKey(dateKey, dayDelta) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return date.toISOString().slice(0, 10);
}

function getMonthStartDateKey(dateKey) {
  const [year, month] = String(dateKey || '').split('-').map(Number);
  if (!year || !month) return '';
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function applyDatePreset(preset) {
  const today = getBangkokTodayDateKey();
  let from = '';
  let to = '';

  switch (preset) {
    case 'today':
      from = today;
      to = today;
      break;
    case 'yesterday':
      from = shiftDateKey(today, -1);
      to = from;
      break;
    case 'last7':
      from = shiftDateKey(today, -6);
      to = today;
      break;
    case 'thisMonth':
      from = getMonthStartDateKey(today);
      to = today;
      break;
    default:
      return;
  }

  els.dateFrom.value = from;
  els.dateTo.value = to;
  applyFilters();
  setStatus(`ใช้ preset: ${preset} (${from} → ${to})`, 'ok');
}

function toCsvCell(value) {
  const str = String(value ?? '');
  return `"${str.replaceAll('"', '""')}"`;
}

function downloadTextFile(filename, content, mimeType = 'text/plain;charset=utf-8;') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function formatDate(input) {
  if (!input) return '-';
  try {
    const date = typeof input?.toDate === 'function' ? input.toDate() : new Date(input);
    return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return String(input);
  }
}

function formatJsonInline(value) {
  if (!value || typeof value !== 'object') return escapeHtml(String(value ?? '-'));
  return `<pre class="mono">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

async function requireAdminOrStaff(user) {
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (!snap.exists()) throw new Error('ไม่พบ user profile ใน Firestore');
  const data = snap.data();
  const allowed = ['admin', 'fo_npc', 'guest_relations_npc', 'mod_npc', 'gm_npc'];
  if (!data?.active || !allowed.includes(data?.role)) {
    throw new Error('บัญชีนี้ไม่มีสิทธิ์เข้าหน้า Admin Reward Queue');
  }
  currentUserRole = data.role;
  return data;
}

async function fetchDocsWithStatus(collectionName, status, rowLimit, extraWhere = []) {
  const constraints = [...extraWhere, where('status', '==', status), orderBy('updatedAt', 'desc'), limit(rowLimit)];
  let q = query(collection(db, collectionName), ...constraints);
  try {
    const snap = await getDocs(q);
    return snap.docs;
  } catch {
    q = query(collection(db, collectionName), ...extraWhere, where('status', '==', status), limit(rowLimit));
    const snap = await getDocs(q);
    return snap.docs;
  }
}

async function fetchTokenForRedemption(redemptionId) {
  if (!redemptionId || redemptionId === '-') return null;
  const q = query(collection(db, 'reward_tokens'), where('relatedRedemptionId', '==', redemptionId), where('tokenType', '==', 'reward_pickup'), limit(1));
  const snap = await getDocs(q);
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function enrichRows(baseRows) {
  const guestUids = [...new Set(baseRows.map((row) => row.guestUid).filter(Boolean).filter((v) => v !== '-'))];
  const rewardIds = [...new Set(baseRows.map((row) => row.rewardId).filter(Boolean).filter((v) => v !== '-'))];

  const guestProfiles = new Map();
  const rewards = new Map();
  await Promise.all([
    ...guestUids.map(async (uid) => {
      const snap = await getDoc(doc(db, 'guest_profiles', uid));
      if (snap.exists()) guestProfiles.set(uid, snap.data());
    }),
    ...rewardIds.map(async (rewardId) => {
      const snap = await getDoc(doc(db, 'rewards', rewardId));
      if (snap.exists()) rewards.set(rewardId, snap.data());
    }),
  ]);

  const enriched = [];
  for (const row of baseRows) {
    const guestProfile = guestProfiles.get(row.guestUid) || null;
    const rewardDoc = rewards.get(row.rewardId) || null;
    let pickupCode = row.pickupCode;
    if ((!pickupCode || pickupCode === '-') && row.redemptionId && row.redemptionId !== '-') {
      const token = await fetchTokenForRedemption(row.redemptionId);
      if (token?.qrCodeValue) pickupCode = token.qrCodeValue;
    }
    enriched.push({
      ...row,
      roomNo: row.roomNo || guestProfile?.roomNo || '-',
      stayId: row.stayId || guestProfile?.stayId || '-',
      rewardTitle: row.rewardTitle || rewardDoc?.title || rewardDoc?.titleTh || '-',
      pickupCode: pickupCode || '-',
    });
  }
  return enriched;
}

async function loadQueue() {
  if (!authReady) return;
  setBusy(true);
  setStatus('กำลังโหลด reward queue...');
  try {
    const rowLimit = Number(els.limitFilter.value || 40);
    const [pendingSnaps, approvedSnaps, fulfilledSnaps, expiredTokenSnaps, rejectedSnaps] = await Promise.all([
      fetchDocsWithStatus('redemption_requests', 'pending', rowLimit),
      fetchDocsWithStatus('redemptions', 'approved', rowLimit),
      fetchDocsWithStatus('redemptions', 'fulfilled', rowLimit),
      fetchDocsWithStatus('reward_tokens', 'expired', rowLimit, [where('tokenType', '==', 'reward_pickup')]),
      fetchDocsWithStatus('redemption_requests', 'rejected', rowLimit),
    ]);

    const pendingRows = pendingSnaps.map((snap) => {
      const data = snap.data();
      return {
        source: 'redemption_requests', queueStatus: 'pending', guestUid: data.guestUid || '-', roomNo: '-', rewardId: data.rewardId || '-', rewardTitle: '-',
        requestId: snap.id, redemptionId: data.approvedRedemptionId || '-', pickupCode: '-', updatedAt: data.processedAt || data.requestedAt || null,
        notes: data.notes || '', stayId: data.stayId || '-', searchText: [data.guestUid, data.rewardId, snap.id, data.stayId].join(' '),
      };
    });
    const approvedRows = approvedSnaps.map((snap) => {
      const data = snap.data();
      return {
        source: 'redemptions', queueStatus: 'approved', guestUid: data.guestUid || '-', roomNo: '-', rewardId: data.rewardId || '-', rewardTitle: '-',
        requestId: data.requestId || '-', redemptionId: snap.id, pickupCode: '-', updatedAt: data.createdAt || data.updatedAt || null,
        notes: 'Approved แล้ว รอ pickup token / มอบของจริง', stayId: data.stayId || '-', searchText: [data.guestUid, data.rewardId, data.requestId, snap.id, data.stayId].join(' '),
      };
    });
    const fulfilledRows = fulfilledSnaps.map((snap) => {
      const data = snap.data();
      return {
        source: 'redemptions', queueStatus: 'fulfilled', guestUid: data.guestUid || '-', roomNo: '-', rewardId: data.rewardId || '-', rewardTitle: '-',
        requestId: data.requestId || '-', redemptionId: snap.id, pickupCode: '-', updatedAt: data.fulfilledAt || data.createdAt || null,
        notes: data.fulfillmentNotes || 'มอบของจริงแล้ว', stayId: data.stayId || '-', searchText: [data.guestUid, data.rewardId, data.requestId, snap.id, data.stayId].join(' '),
      };
    });
    const expiredRows = expiredTokenSnaps.map((snap) => {
      const data = snap.data();
      return {
        source: 'reward_tokens', queueStatus: 'expired', guestUid: data.guestUid || '-', roomNo: '-', rewardId: data.rewardId || '-', rewardTitle: '-',
        requestId: data.relatedRequestId || '-', redemptionId: data.relatedRedemptionId || '-', pickupCode: data.qrCodeValue || '-', updatedAt: data.expiresAt || null,
        notes: 'pickup token หมดอายุแล้ว', stayId: data.stayId || '-', searchText: [data.guestUid, data.rewardId, data.relatedRequestId, data.relatedRedemptionId, data.qrCodeValue, data.stayId].join(' '),
      };
    });
    const rejectedRows = rejectedSnaps.map((snap) => {
      const data = snap.data();
      return {
        source: 'redemption_requests', queueStatus: 'rejected', guestUid: data.guestUid || '-', roomNo: '-', rewardId: data.rewardId || '-', rewardTitle: '-',
        requestId: snap.id, redemptionId: data.approvedRedemptionId || '-', pickupCode: '-', updatedAt: data.processedAt || data.requestedAt || null,
        notes: data.rejectionReason || data.notes || 'คำขอนี้ถูกปฏิเสธ', stayId: data.stayId || '-', searchText: [data.guestUid, data.rewardId, snap.id, data.stayId, data.rejectionReason, data.notes].join(' '),
      };
    });

    const merged = [...pendingRows, ...approvedRows, ...fulfilledRows, ...expiredRows, ...rejectedRows].sort((a, b) => {
      const aTime = a.updatedAt?.toDate ? a.updatedAt.toDate().getTime() : new Date(a.updatedAt || 0).getTime();
      const bTime = b.updatedAt?.toDate ? b.updatedAt.toDate().getTime() : new Date(b.updatedAt || 0).getTime();
      return bTime - aTime;
    });

    queueRows = await enrichRows(merged);
    els.statPending.textContent = String(pendingRows.length);
    els.statApproved.textContent = String(approvedRows.length);
    els.statFulfilled.textContent = String(fulfilledRows.length);
    els.statExpired.textContent = String(expiredRows.length);
    els.statRejected.textContent = String(rejectedRows.length);
    applyFilters();
    setStatus(`โหลดข้อมูลสำเร็จ ${queueRows.length} แถว`, 'ok');
  } catch (error) {
    console.error(error);
    setStatus(error?.message || 'โหลด queue ไม่สำเร็จ', 'warn');
  } finally {
    setBusy(false);
  }
}

function applyFilters() {
  const keyword = normalizeText(els.search.value);
  const status = els.statusFilter.value;
  const fromDate = toDateStart(els.dateFrom.value);
  const toDate = toDateEnd(els.dateTo.value);

  const filtered = queueRows.filter((row) => {
    const statusOk = status === 'all' ? true : row.queueStatus === status;
    if (!statusOk) return false;

    const rowDate = toJsDate(row.updatedAt);
    if (fromDate && (!rowDate || rowDate < fromDate)) return false;
    if (toDate && (!rowDate || rowDate > toDate)) return false;

    if (!keyword) return true;
    const haystack = normalizeText([
      row.queueStatus,
      row.guestUid,
      row.roomNo,
      row.rewardId,
      row.rewardTitle,
      row.requestId,
      row.redemptionId,
      row.pickupCode,
      row.notes,
      row.searchText,
    ].join(' '));
    return haystack.includes(keyword);
  });

  filteredRows = filtered;
  renderRows(filteredRows);
  els.visibleCount.textContent = String(filteredRows.length);
  els.exportBtn.disabled = filteredRows.length === 0;
}

function exportFilteredCsv() {
  if (!filteredRows.length) {
    setStatus('ไม่มีข้อมูลตาม filter สำหรับ export', 'warn');
    return;
  }
  const header = [
    'status', 'guestUid', 'roomNo', 'stayId', 'rewardId', 'rewardTitle',
    'requestId', 'redemptionId', 'pickupCode', 'updatedAt', 'notes'
  ];
  const lines = [header.map(toCsvCell).join(',')];
  for (const row of filteredRows) {
    lines.push([
      row.queueStatus,
      row.guestUid,
      row.roomNo,
      row.stayId,
      row.rewardId,
      row.rewardTitle,
      row.requestId,
      row.redemptionId,
      row.pickupCode,
      toJsDate(row.updatedAt)?.toISOString() || '',
      row.notes || '',
    ].map(toCsvCell).join(','));
  }
  const datePart = [els.dateFrom.value || 'all', els.dateTo.value || 'all'].join('_to_');
  const statusPart = els.statusFilter.value || 'all';
  const filename = `reward-queue_${statusPart}_${datePart}.csv`;
  downloadTextFile(filename, lines.join('\n'), 'text/csv;charset=utf-8;');
  setStatus(`Export CSV สำเร็จ ${filteredRows.length} แถว`, 'ok');
}

function renderRows(rows) {
  if (!rows.length) {
    els.queueBody.innerHTML = '<tr><td colspan="9" class="empty-cell">ไม่พบรายการตามเงื่อนไขที่เลือก</td></tr>';
    return;
  }
  els.queueBody.innerHTML = rows.map((row) => `
    <tr>
      <td><span class="status-pill ${escapeHtml(row.queueStatus)}">${escapeHtml(row.queueStatus)}</span></td>
      <td><div>${escapeHtml(row.guestUid)}</div><div class="muted small">${escapeHtml(row.stayId || '-')}</div></td>
      <td>${escapeHtml(row.roomNo || '-')}</td>
      <td><div>${escapeHtml(row.rewardTitle || '-')}</div><div class="muted small mono">${escapeHtml(row.rewardId || '-')}</div></td>
      <td class="mono">${escapeHtml(row.requestId || '-')}</td>
      <td class="mono">${escapeHtml(row.redemptionId || '-')}</td>
      <td>${row.pickupCode && row.pickupCode !== '-' ? `<span class="code-pill mono">${escapeHtml(row.pickupCode)}</span>` : '<span class="muted">-</span>'}</td>
      <td>${escapeHtml(formatDate(row.updatedAt))}</td>
      <td class="action-cell"><button class="inline-btn secondary" data-view-detail="${escapeHtml(row.requestId || '')}__${escapeHtml(row.redemptionId || '')}">View detail</button></td>
    </tr>
  `).join('');
}

function openModal() {
  els.modal.classList.remove('hidden');
  els.modal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.modal.setAttribute('aria-hidden', 'true');
  currentDetail = null;
}

async function fetchActivityLogs(guestUid, detailRefs) {
  const q = query(collection(db, 'activity_logs'), where('targetUid', '==', guestUid), limit(50));
  const snap = await getDocs(q);
  const ids = new Set(detailRefs.filter(Boolean));
  return snap.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((log) => {
      const meta = log.meta || {};
      return ids.has(log.entityId) || ids.has(meta.requestId) || ids.has(meta.redemptionId) || ids.has(meta.relatedRedemptionId) || ids.has(meta.relatedRequestId) || ids.has(meta.rewardId);
    })
    .sort((a, b) => new Date(b.createdAt?.toDate?.() || b.createdAt || 0) - new Date(a.createdAt?.toDate?.() || a.createdAt || 0));
}

async function openDetailFromRow(row) {
  openModal();
  setDetailStatus('กำลังโหลดรายละเอียด...', 'default');
  els.detailTitle.textContent = row.rewardTitle || 'Reward Detail';
  els.detailSubtitle.textContent = `${row.guestUid} • ${row.queueStatus}`;
  els.detailSummaryGrid.innerHTML = '';
  els.detailGuestRequest.innerHTML = '';
  els.detailToken.innerHTML = '';
  els.detailTimeline.innerHTML = '';
  els.detailLogs.innerHTML = '';

  try {
    const guestUserSnapPromise = getDoc(doc(db, 'users', row.guestUid));
    const guestProfileSnapPromise = getDoc(doc(db, 'guest_profiles', row.guestUid));
    const rewardSnapPromise = row.rewardId && row.rewardId !== '-' ? getDoc(doc(db, 'rewards', row.rewardId)) : Promise.resolve(null);
    const requestSnapPromise = row.requestId && row.requestId !== '-' ? getDoc(doc(db, 'redemption_requests', row.requestId)) : Promise.resolve(null);
    const redemptionSnapPromise = row.redemptionId && row.redemptionId !== '-' ? getDoc(doc(db, 'redemptions', row.redemptionId)) : Promise.resolve(null);

    const [guestUserSnap, guestProfileSnap, rewardSnap, requestSnap, redemptionSnap] = await Promise.all([
      guestUserSnapPromise, guestProfileSnapPromise, rewardSnapPromise, requestSnapPromise, redemptionSnapPromise,
    ]);

    const guestUser = guestUserSnap?.exists?.() ? guestUserSnap.data() : null;
    const guestProfile = guestProfileSnap?.exists?.() ? guestProfileSnap.data() : null;
    const reward = rewardSnap?.exists?.() ? rewardSnap.data() : null;
    const requestDoc = requestSnap?.exists?.() ? requestSnap.data() : null;
    const redemptionDoc = redemptionSnap?.exists?.() ? redemptionSnap.data() : null;

    const tokensQuery = row.redemptionId && row.redemptionId !== '-'
      ? query(collection(db, 'reward_tokens'), where('relatedRedemptionId', '==', row.redemptionId), limit(10))
      : row.requestId && row.requestId !== '-'
        ? query(collection(db, 'reward_tokens'), where('relatedRequestId', '==', row.requestId), limit(10))
        : null;
    const tokensSnap = tokensQuery ? await getDocs(tokensQuery) : null;
    const tokens = tokensSnap ? tokensSnap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) : [];

    let fulfilledByUser = null;
    if (redemptionDoc?.fulfilledBy) {
      const snap = await getDoc(doc(db, 'users', redemptionDoc.fulfilledBy));
      fulfilledByUser = snap.exists() ? snap.data() : null;
    }

    const logs = await fetchActivityLogs(row.guestUid, [row.requestId, row.redemptionId, row.rewardId, ...tokens.map((t) => t.id)]);

    currentDetail = { row, guestUser, guestProfile, reward, requestDoc, redemptionDoc, tokens, fulfilledByUser, logs };
    renderDetail();
    setDetailStatus('โหลดรายละเอียดสำเร็จ', 'ok');
  } catch (error) {
    console.error(error);
    setDetailStatus(error?.message || 'โหลดรายละเอียดไม่สำเร็จ', 'warn');
  }
}

function buildSummaryCard(label, value, note = '') {
  return `<article class="detail-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value" style="font-size:24px;">${escapeHtml(value || '-')}</div>${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ''}</article>`;
}

function buildKvHtml(entries) {
  return `<div class="kv-grid">${entries.map(([k, v]) => `<div class="kv-label">${escapeHtml(k)}</div><div>${v}</div>`).join('')}</div>`;
}

function renderDetail() {
  if (!currentDetail) return;
  const { row, guestUser, guestProfile, reward, requestDoc, redemptionDoc, tokens, fulfilledByUser, logs } = currentDetail;

  els.detailTitle.textContent = reward?.title || row.rewardTitle || 'Reward Detail';
  els.detailSubtitle.textContent = `${row.guestUid} • ${row.queueStatus} • room ${guestProfile?.roomNo || row.roomNo || '-'}`;

  els.detailSummaryGrid.innerHTML = [
    buildSummaryCard('Guest', guestProfile?.fullName || guestUser?.displayName || row.guestUid, row.guestUid),
    buildSummaryCard('Reward', reward?.title || row.rewardTitle || row.rewardId, row.rewardId),
    buildSummaryCard('Current Status', redemptionDoc?.status || requestDoc?.status || row.queueStatus, row.requestId || '-'),
    buildSummaryCard('Fulfilled By', fulfilledByUser?.displayName || redemptionDoc?.fulfilledBy || '-', redemptionDoc?.fulfilledAt ? formatDate(redemptionDoc.fulfilledAt) : 'ยังไม่ได้มอบ'),
  ].join('');

  els.detailGuestRequest.innerHTML = buildKvHtml([
    ['Guest name', escapeHtml(guestProfile?.fullName || guestUser?.displayName || '-')],
    ['Room', escapeHtml(guestProfile?.roomNo || row.roomNo || '-')],
    ['Stay ID', `<span class="mono">${escapeHtml(guestProfile?.stayId || row.stayId || '-')}</span>`],
    ['Request ID', `<span class="mono">${escapeHtml(row.requestId || '-')}</span>`],
    ['Redemption ID', `<span class="mono">${escapeHtml(row.redemptionId || '-')}</span>`],
    ['Requested at', escapeHtml(formatDate(requestDoc?.requestedAt || row.updatedAt))],
    ['Notes', escapeHtml(requestDoc?.notes || row.notes || '-')],
  ]);

  els.detailToken.innerHTML = tokens.length
    ? tokens.map((token) => `
      <div class="detail-card">
        <div class="kv-grid">
          <div class="kv-label">Token ID</div><div class="mono">${escapeHtml(token.id)}</div>
          <div class="kv-label">Pickup code</div><div><span class="code-pill mono">${escapeHtml(token.qrCodeValue || '-')}</span></div>
          <div class="kv-label">Status</div><div><span class="status-pill ${escapeHtml(token.status || 'expired')}">${escapeHtml(token.status || '-')}</span></div>
          <div class="kv-label">Issued</div><div>${escapeHtml(formatDate(token.issuedAt))}</div>
          <div class="kv-label">Expires</div><div>${escapeHtml(formatDate(token.expiresAt))}</div>
          <div class="kv-label">Used by</div><div>${escapeHtml(token.usedBy || '-')}</div>
        </div>
      </div>`).join('')
    : '<div class="muted">ยังไม่มี pickup token</div>';

  const timeline = [];
  if (requestDoc?.requestedAt) timeline.push({ title: 'Guest created request', time: requestDoc.requestedAt, note: row.requestId });
  if (requestDoc?.processedAt) timeline.push({ title: `Request ${requestDoc.status}`, time: requestDoc.processedAt, note: requestDoc.rejectionReason || requestDoc.notes || '-' });
  if (redemptionDoc?.createdAt) timeline.push({ title: 'Redemption approved', time: redemptionDoc.createdAt, note: row.redemptionId || '-' });
  if (redemptionDoc?.fulfilledAt) timeline.push({ title: 'Reward fulfilled', time: redemptionDoc.fulfilledAt, note: fulfilledByUser?.displayName || redemptionDoc.fulfilledBy || '-' });
  tokens.forEach((token) => {
    timeline.push({ title: `Token ${token.status}`, time: token.usedAt || token.expiresAt || token.issuedAt, note: token.qrCodeValue || token.id });
  });
  timeline.sort((a, b) => new Date(b.time?.toDate?.() || b.time || 0) - new Date(a.time?.toDate?.() || a.time || 0));
  els.detailTimeline.innerHTML = timeline.length ? timeline.map((item) => `
    <div class="timeline-item">
      <h4>${escapeHtml(item.title)}</h4>
      <div class="muted small">${escapeHtml(formatDate(item.time))}</div>
      <div class="small">${escapeHtml(item.note || '-')}</div>
    </div>`).join('') : '<div class="muted">ยังไม่มี timeline</div>';

  els.detailLogs.innerHTML = logs.length ? `<div class="log-list">${logs.map((log) => `
    <div class="log-item">
      <div><strong>${escapeHtml(log.actionType || 'activity')}</strong> <span class="muted small">${escapeHtml(formatDate(log.createdAt))}</span></div>
      <div class="small">actor: ${escapeHtml(log.actorUid || '-')} • entity: ${escapeHtml(log.entityType || '-')} / ${escapeHtml(log.entityId || '-')}</div>
      <div class="small">${formatJsonInline(log.meta || {})}</div>
    </div>`).join('')}</div>` : '<div class="muted">ยังไม่มี activity logs ที่เกี่ยวข้อง</div>';

  const effectiveStatus = redemptionDoc?.status || requestDoc?.status || row.queueStatus;
  const canApprove = effectiveStatus === 'pending' && !!row.requestId && row.requestId !== '-';
  const canReject = effectiveStatus === 'pending' && !!row.requestId && row.requestId !== '-';
  const canReissue = !!row.redemptionId && row.redemptionId !== '-' && effectiveStatus === 'approved';
  const canCancel = ['pending', 'approved'].includes(effectiveStatus);
  els.approveBtn.disabled = !canApprove;
  els.rejectBtn.disabled = !canReject;
  els.reissueBtn.disabled = !canReissue;
  els.cancelBtn.disabled = !canCancel;
  els.openGuestBtn.disabled = !row.guestUid || row.guestUid === '-';
}


async function handleApproveRequest() {
  if (!currentDetail?.row?.requestId || currentDetail.row.requestId === '-') return;
  const notes = window.prompt('โน้ตเพิ่มเติมสำหรับการอนุมัติ (ไม่บังคับ)', 'approved_from_admin_queue') ?? '';
  try {
    setDetailStatus('กำลังอนุมัติ request และออก pickup token...', 'default');
    const res = await callApprovePendingRewardRequest({
      requestId: currentDetail.row.requestId,
      forceReissue: false,
      notes,
    });
    const result = res.data || {};
    setDetailStatus(`อนุมัติสำเร็จ • token ${result.qrCodeValue || '-'}${result.reusedToken ? ' (reuse)' : ''}`, 'ok');
    await loadQueue();
    const freshRow = queueRows.find((row) => row.redemptionId === result.redemptionId)
      || queueRows.find((row) => row.requestId === currentDetail.row.requestId)
      || currentDetail.row;
    await openDetailFromRow(freshRow);
  } catch (error) {
    console.error(error);
    setDetailStatus(error?.message || 'อนุมัติ request ไม่สำเร็จ', 'warn');
  }
}

async function handleRejectRequest() {
  if (!currentDetail?.row?.requestId || currentDetail.row.requestId === '-') return;
  const reason = window.prompt('ระบุเหตุผลในการปฏิเสธ', 'not_eligible_for_reward');
  if (reason === null) return;
  const notes = window.prompt('โน้ตเพิ่มเติม (ไม่บังคับ)', '') ?? '';
  try {
    setDetailStatus('กำลังปฏิเสธ request...', 'default');
    const res = await callRejectPendingRewardRequest({
      requestId: currentDetail.row.requestId,
      reason,
      notes,
    });
    const result = res.data || {};
    if (currentDetail?.requestDoc) {
      currentDetail.requestDoc.status = 'rejected';
      currentDetail.requestDoc.rejectionReason = reason;
      currentDetail.requestDoc.notes = notes || null;
      currentDetail.requestDoc.processedAt = new Date();
      currentDetail.requestDoc.processedBy = currentUserRole || 'admin';
    }
    if (currentDetail?.row) {
      currentDetail.row.queueStatus = 'rejected';
      currentDetail.row.notes = notes || reason;
      currentDetail.row.updatedAt = new Date();
    }
    renderDetail();
    setDetailStatus(result.alreadyRejected ? 'รายการนี้ถูกปฏิเสธไว้แล้ว' : 'ปฏิเสธ request เรียบร้อย รายการจะถูกนำออกจาก queue', 'ok');
    await loadQueue();
  } catch (error) {
    console.error(error);
    setDetailStatus(error?.message || 'ปฏิเสธ request ไม่สำเร็จ', 'warn');
  }
}

async function handleReissueToken() {
  if (!currentDetail?.row?.redemptionId || currentDetail.row.redemptionId === '-') return;
  try {
    setDetailStatus('กำลังออก pickup token ใหม่...', 'default');
    const res = await callCreateRewardPickupToken({ redemptionId: currentDetail.row.redemptionId, forceReissue: true });
    setDetailStatus(`ออก token สำเร็จ: ${res.data.qrCodeValue}`, 'ok');
    await loadQueue();
    const freshRow = queueRows.find((row) => row.redemptionId === currentDetail.row.redemptionId) || currentDetail.row;
    await openDetailFromRow(freshRow);
  } catch (error) {
    console.error(error);
    setDetailStatus(error?.message || 'ออก token ใหม่ไม่สำเร็จ', 'warn');
  }
}

async function handleCancelRequest() {
  if (!currentDetail) return;
  const reason = window.prompt('ระบุเหตุผลในการยกเลิก', 'cancelled_from_admin_queue');
  if (reason === null) return;
  try {
    setDetailStatus('กำลังยกเลิกรายการ...', 'default');
    const payload = { requestId: currentDetail.row.requestId !== '-' ? currentDetail.row.requestId : undefined, redemptionId: currentDetail.row.redemptionId !== '-' ? currentDetail.row.redemptionId : undefined, reason };
    const res = await callCancelRewardRedemption(payload);
    setDetailStatus(`ยกเลิกรายการแล้ว${res.data.refunded ? ' และคืนเหรียญแล้ว' : ''}`, 'ok');
    await loadQueue();
    const freshRow = queueRows.find((row) => row.requestId === currentDetail.row.requestId || row.redemptionId === currentDetail.row.redemptionId);
    if (freshRow) {
      await openDetailFromRow(freshRow);
    }
  } catch (error) {
    console.error(error);
    setDetailStatus(error?.message || 'ยกเลิกไม่สำเร็จ', 'warn');
  }
}

function handleOpenGuestProfile() {
  if (!currentDetail?.row?.guestUid || currentDetail.row.guestUid === '-') return;
  const url = `../admin-guest-profile/index.html?guestUid=${encodeURIComponent(currentDetail.row.guestUid)}`;
  window.open(url, '_blank', 'noopener');
}

els.refreshBtn.addEventListener('click', loadQueue);
els.exportBtn.addEventListener('click', exportFilteredCsv);
els.clearBtn.addEventListener('click', () => {
  els.search.value = '';
  els.statusFilter.value = 'all';
  els.dateFrom.value = '';
  els.dateTo.value = '';
  applyFilters();
});
els.search.addEventListener('input', applyFilters);
els.statusFilter.addEventListener('change', applyFilters);
els.dateFrom.addEventListener('change', applyFilters);
els.dateTo.addEventListener('change', applyFilters);
els.presetButtons.forEach((button) => {
  button.addEventListener('click', () => applyDatePreset(button.dataset.presetRange));
});
els.limitFilter.addEventListener('change', loadQueue);
els.queueBody.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-view-detail]');
  if (!btn) return;
  const [requestId, redemptionId] = btn.dataset.viewDetail.split('__');
  const row = queueRows.find((item) => (item.requestId || '') === requestId && (item.redemptionId || '') === redemptionId);
  if (row) await openDetailFromRow(row);
});
els.closeModalBtn.addEventListener('click', closeModal);
els.modal.addEventListener('click', (event) => { if (event.target?.dataset?.closeModal === '1') closeModal(); });
els.approveBtn.addEventListener('click', handleApproveRequest);
els.rejectBtn.addEventListener('click', handleRejectRequest);
els.reissueBtn.addEventListener('click', handleReissueToken);
els.cancelBtn.addEventListener('click', handleCancelRequest);
els.openGuestBtn.addEventListener('click', handleOpenGuestProfile);
window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !els.modal.classList.contains('hidden')) closeModal(); });

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    authReady = false;
    queueRows = [];
    filteredRows = [];
    renderRows([]);
    els.exportBtn.disabled = true;
    setStatus('ยังไม่ได้ล็อกอินในแอปหลัก', 'warn');
    return;
  }
  try {
    await requireAdminOrStaff(user);
    authReady = true;
    loadQueue();
  } catch (error) {
    console.error(error);
    authReady = false;
    queueRows = [];
    filteredRows = [];
    renderRows([]);
    els.exportBtn.disabled = true;
    setStatus(error?.message || 'ไม่มีสิทธิ์เข้าหน้านี้', 'warn');
  }
});
