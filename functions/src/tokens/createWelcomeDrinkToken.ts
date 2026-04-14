import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

import {
  HOTEL_TIMEZONE,
  type AppUserDoc,
  type CreateWelcomeDrinkTokenRequest,
  type CreateWelcomeDrinkTokenResponse,
  type DailyFeaturedDrinkDoc,
  type GameRulesDoc,
  type GuestProfileDoc,
  type MissionDoc,
  type QuestClaimDoc,
  type RewardTokenDoc,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

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
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function generateSecureRandom(length = 12): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .toUpperCase();
}

function isMissionActive(mission: MissionDoc, now: Timestamp): boolean {
  if (!mission.isActive) return false;
  if (mission.startAt && now.toMillis() < mission.startAt.toMillis()) return false;
  if (mission.endAt && now.toMillis() > mission.endAt.toMillis()) return false;
  return true;
}

function buildStayClaimId(stayId: string, missionId: string): string {
  return `claim_${stayId}_${missionId}`;
}

function buildWelcomeDrinkTokenId(guestUid: string, stayId: string, dayKey: string): string {
  return `token_wd_${sanitizeId(guestUid)}_${sanitizeId(stayId)}_${dayKey}`;
}

export const createWelcomeDrinkToken = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<CreateWelcomeDrinkTokenResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as CreateWelcomeDrinkTokenRequest;
    if (!data.stayId || typeof data.stayId !== 'string') {
      throw new HttpsError('invalid-argument', 'stayId is required.');
    }

    const callerUid = request.auth.uid;
    const callerRef = db.collection('users').doc(callerUid);
    const callerSnap = await callerRef.get();

    if (!callerSnap.exists) {
      throw new HttpsError('permission-denied', 'Caller profile not found.');
    }

    const caller = callerSnap.data() as AppUserDoc;
    const isAdmin = caller.role === 'admin';
    const guestUid = isAdmin ? data.guestUid ?? '' : callerUid;
    const stayId = data.stayId;
    const forceReissue = data.forceReissue === true;

    if (!guestUid) {
      throw new HttpsError('invalid-argument', 'guestUid is required for admin calls.');
    }

    const todayKey = getHotelDateKey(new Date(), HOTEL_TIMEZONE);
    const now = Timestamp.now();
    const tokenId = buildWelcomeDrinkTokenId(guestUid, stayId, todayKey);

    const guestRef = db.collection('users').doc(guestUid);
    const guestProfileRef = db.collection('guest_profiles').doc(guestUid);
    const gameRulesRef = db.collection('system_config').doc('game_rules');
    const dailyDrinkRef = db.collection('daily_featured_drinks').doc(todayKey);
    const tokenRef = db.collection('reward_tokens').doc(tokenId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [guestSnap, guestProfileSnap, gameRulesSnap, dailyDrinkSnap, tokenSnap] =
          await Promise.all([
            tx.get(guestRef),
            tx.get(guestProfileRef),
            tx.get(gameRulesRef),
            tx.get(dailyDrinkRef),
            tx.get(tokenRef),
          ]);

        if (!guestSnap.exists || !guestProfileSnap.exists) {
          throw new HttpsError('not-found', 'guest-not-found');
        }

        const guest = guestSnap.data() as AppUserDoc;
        const guestProfile = guestProfileSnap.data() as GuestProfileDoc;
        const gameRules = gameRulesSnap.exists
          ? (gameRulesSnap.data() as GameRulesDoc)
          : {};
        const dailyDrink = dailyDrinkSnap.exists
          ? (dailyDrinkSnap.data() as DailyFeaturedDrinkDoc)
          : null;

        if (guest.role !== 'guest' || !guest.active || guestProfile.status !== 'active') {
          throw new HttpsError('failed-precondition', 'guest-not-active');
        }

        if (guestProfile.stayId !== stayId) {
          throw new HttpsError('failed-precondition', 'stay-mismatch');
        }

        if (gameRules.welcomeDrinkEnabled === false) {
          throw new HttpsError('failed-precondition', 'feature-disabled');
        }

        if (!dailyDrink || !dailyDrink.isActive) {
          throw new HttpsError('not-found', 'daily-drink-not-found');
        }

        const missionRef = db.collection('missions').doc(dailyDrink.missionId);
        const missionSnap = await tx.get(missionRef);
        if (!missionSnap.exists) {
          throw new HttpsError('not-found', 'mission-not-found');
        }

        const mission = missionSnap.data() as MissionDoc;
        if (!isMissionActive(mission, now)) {
          throw new HttpsError('failed-precondition', 'mission-inactive');
        }

        const claimRef = db
          .collection('quest_claims')
          .doc(buildStayClaimId(stayId, dailyDrink.missionId));
        const claimSnap = await tx.get(claimRef);
        if (claimSnap.exists && !forceReissue) {
          const existingClaim = claimSnap.data() as QuestClaimDoc;
          logger.info('Welcome drink already claimed for stay', {
            guestUid,
            stayId,
            claimId: claimRef.id,
            existingClaim,
          });
          throw new HttpsError('already-exists', 'already-claimed');
        }

        if (tokenSnap.exists) {
          const existingToken = tokenSnap.data() as RewardTokenDoc;
          const isStillLive =
            existingToken.status === 'unused' &&
            existingToken.expiresAt.toMillis() > now.toMillis();

          if (isStillLive && !forceReissue) {
            return {
              ok: true,
              tokenId,
              qrCodeValue: existingToken.qrCodeValue,
              expiresAt: existingToken.expiresAt.toDate().toISOString(),
              missionId: dailyDrink.missionId,
              drinkTitle: dailyDrink.title,
              drinkTitleTh: dailyDrink.titleTh,
              reused: true,
            } satisfies CreateWelcomeDrinkTokenResponse;
          }

          if (
            existingToken.status === 'used' &&
            claimSnap.exists &&
            !forceReissue
          ) {
            throw new HttpsError('already-exists', 'already-claimed');
          }
        }

        const expiresHours = Number(gameRules.defaultWelcomeDrinkExpiresHours ?? 24);
        const expiresAt = Timestamp.fromMillis(
          now.toMillis() + expiresHours * 60 * 60 * 1000,
        );
        const qrCodeValue = `WD_${generateSecureRandom(12)}`;

        tx.set(tokenRef, {
          guestUid,
          stayId,
          tokenType: 'welcome_drink',
          relatedMissionId: dailyDrink.missionId,
          dailyDrinkId: todayKey,
          qrCodeValue,
          status: 'unused',
          issuedAt: now,
          expiresAt,
          usedAt: null,
          usedBy: null,
          usedByRole: null,
        } satisfies RewardTokenDoc);

        tx.set(
          guestProfileRef,
          {
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: guestUid,
          actionType: 'issue_welcome_drink_token',
          entityType: 'token',
          entityId: tokenId,
          meta: {
            missionId: dailyDrink.missionId,
            dailyDrinkId: todayKey,
            forceReissue,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          tokenId,
          qrCodeValue,
          expiresAt: expiresAt.toDate().toISOString(),
          missionId: dailyDrink.missionId,
          drinkTitle: dailyDrink.title,
          drinkTitleTh: dailyDrink.titleTh,
          reused: false,
        } satisfies CreateWelcomeDrinkTokenResponse;
      });

      logger.info('Welcome drink token prepared', {
        guestUid,
        stayId,
        tokenId: result.tokenId,
        reused: result.reused,
      });

      return result;
    } catch (error) {
      if (error instanceof HttpsError) {
        throw error;
      }

      logger.error('createWelcomeDrinkToken failed', {
        callerUid,
        guestUid,
        stayId,
        error,
      });

      throw new HttpsError('internal', 'Unable to create welcome drink token.');
    }
  },
);
