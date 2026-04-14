import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  HOTEL_TIMEZONE,
  type AppUserDoc,
  type GuestProfileDoc,
  type GuestWalletDoc,
  type RegisterGuestProfileRequest,
  type RegisterGuestProfileResponse,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

type SupportedLanguage = AppUserDoc['language'];

function getHotelDateKey(date = new Date(), timeZone = HOTEL_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value ?? '1970';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';

  return `${year}-${month}-${day}`;
}

function sanitizeId(input: string): string {
  return input.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeLanguage(value?: string): SupportedLanguage {
  if (value === 'th' || value === 'zh' || value === 'ru' || value === 'en') {
    return value;
  }
  return 'en';
}

function buildStayId(roomNo: string, dateKey: string): string {
  return `stay_${dateKey.replace(/-/g, '_')}_${sanitizeId(roomNo)}`;
}

export const registerGuestProfile = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<RegisterGuestProfileResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as RegisterGuestProfileRequest;
    const callerUid = request.auth.uid;

    if (!data.fullName || typeof data.fullName !== 'string') {
      throw new HttpsError('invalid-argument', 'fullName is required.');
    }

    if (!data.roomNo || typeof data.roomNo !== 'string') {
      throw new HttpsError('invalid-argument', 'roomNo is required.');
    }

    const fullName = data.fullName.trim();
    const roomNo = data.roomNo.trim().toUpperCase();
    const language = normalizeLanguage(data.languagePreference);
    const partySize = Number.isFinite(data.partySize) ? Math.max(1, Number(data.partySize)) : 1;
    const nationality = typeof data.nationality === 'string' ? data.nationality.trim().toUpperCase() : null;
    const phone = typeof data.phone === 'string' && data.phone.trim() ? data.phone.trim() : null;
    const now = Timestamp.now();
    const dateKey = getHotelDateKey(new Date(), HOTEL_TIMEZONE);
    const stayId = data.stayId?.trim() || buildStayId(roomNo, dateKey);
    const checkInDate = data.checkInDateIso ? Timestamp.fromDate(new Date(data.checkInDateIso)) : now;
    const checkOutDate = data.checkOutDateIso
      ? Timestamp.fromDate(new Date(data.checkOutDateIso))
      : Timestamp.fromMillis(now.toMillis() + 3 * 24 * 60 * 60 * 1000);

    if (Number.isNaN(checkInDate.toMillis()) || Number.isNaN(checkOutDate.toMillis())) {
      throw new HttpsError('invalid-argument', 'Invalid check-in or check-out date.');
    }

    if (checkOutDate.toMillis() <= checkInDate.toMillis()) {
      throw new HttpsError('invalid-argument', 'checkOutDate must be after checkInDate.');
    }

    const callerRef = db.collection('users').doc(callerUid);
    const guestProfileRef = db.collection('guest_profiles').doc(callerUid);
    const guestWalletRef = db.collection('guest_wallets').doc(callerUid);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [callerSnap, profileSnap, walletSnap] = await Promise.all([
          tx.get(callerRef),
          tx.get(guestProfileRef),
          tx.get(guestWalletRef),
        ]);

        const callerExists = callerSnap.exists;
        const caller = callerExists ? (callerSnap.data() as AppUserDoc) : null;

        if (caller && caller.role !== 'guest' && caller.role !== 'admin') {
          throw new HttpsError('permission-denied', 'Only guest or admin can register a guest profile.');
        }

        const existingProfile = profileSnap.exists ? (profileSnap.data() as GuestProfileDoc) : null;
        const isSameStay = existingProfile?.stayId === stayId;

        if (!callerExists) {
          tx.set(callerRef, {
            displayName: fullName,
            role: 'guest',
            department: null,
            active: true,
            language,
            photoURL: null,
            phone,
            createdAt: now,
            updatedAt: now,
            lastLoginAt: now,
          } satisfies AppUserDoc);
        } else {
          tx.set(
            callerRef,
            {
              displayName: fullName,
              active: true,
              language,
              phone,
              updatedAt: FieldValue.serverTimestamp(),
              lastLoginAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }

        tx.set(
          guestProfileRef,
          {
            guestUid: callerUid,
            fullName,
            roomNo,
            stayId,
            checkInDate,
            checkOutDate,
            partySize,
            nationality,
            languagePreference: language,
            currentLocationId: 'lobby_main',
            mapVisible: true,
            registrationSource: data.registrationSource ?? 'qr_checkin',
            welcomeDrinkClaimed: existingProfile?.welcomeDrinkClaimed ?? false,
            tutorialCompleted: existingProfile?.tutorialCompleted ?? false,
            status: 'active',
            createdAt: existingProfile?.createdAt ?? now,
            updatedAt: now,
          } satisfies GuestProfileDoc,
          { merge: true },
        );

        if (!walletSnap.exists) {
          tx.set(guestWalletRef, {
            guestUid: callerUid,
            bronze: 0,
            silver: 0,
            gold: 0,
            totalEarnedBronze: 0,
            totalEarnedSilver: 0,
            totalEarnedGold: 0,
            totalSpentBronze: 0,
            totalSpentSilver: 0,
            totalSpentGold: 0,
            level: 1,
            xp: 0,
            updatedAt: now,
            lastRewardAt: null,
          } satisfies GuestWalletDoc);
        } else {
          tx.set(
            guestWalletRef,
            {
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller?.role ?? 'guest',
          targetUid: callerUid,
          actionType: isSameStay ? 'update_guest_profile' : 'register_guest',
          entityType: 'user',
          entityId: callerUid,
          meta: {
            roomNo,
            stayId,
            registrationSource: data.registrationSource ?? 'qr_checkin',
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          guestUid: callerUid,
          stayId,
          roomNo,
          fullName,
          languagePreference: language,
          isNewProfile: !existingProfile,
        } satisfies RegisterGuestProfileResponse;
      });

      return result;
    } catch (error) {
      logger.error('registerGuestProfile failed', {
        callerUid,
        roomNo,
        stayId,
        error,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('internal', 'Unable to register guest profile.');
    }
  },
);
