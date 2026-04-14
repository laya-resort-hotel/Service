import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { randomBytes } from 'node:crypto';

import {
  type AppUserDoc,
  type CreateRewardPickupTokenRequest,
  type CreateRewardPickupTokenResponse,
  type GameRulesDoc,
  type RedemptionDoc,
  type RedemptionRequestDoc,
  type RewardDoc,
  type RewardTokenDoc,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

function sanitizeId(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function generateSecureRandom(length = 16): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length)
    .toUpperCase();
}

function buildRewardPickupTokenId(redemptionId: string): string {
  return `token_rp_${sanitizeId(redemptionId)}`;
}

export const createRewardPickupToken = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<CreateRewardPickupTokenResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as CreateRewardPickupTokenRequest;
    const redemptionId = typeof data.redemptionId === 'string' ? data.redemptionId.trim() : '';
    const forceReissue = data.forceReissue === true;

    if (!redemptionId) {
      throw new HttpsError('invalid-argument', 'redemptionId is required.');
    }

    const callerUid = request.auth.uid;
    const callerRef = db.collection('users').doc(callerUid);
    const redemptionRef = db.collection('redemptions').doc(redemptionId);
    const gameRulesRef = db.collection('system_config').doc('game_rules');
    const tokenId = buildRewardPickupTokenId(redemptionId);
    const tokenRef = db.collection('reward_tokens').doc(tokenId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [callerSnap, redemptionSnap, gameRulesSnap, tokenSnap] = await Promise.all([
          tx.get(callerRef),
          tx.get(redemptionRef),
          tx.get(gameRulesRef),
          tx.get(tokenRef),
        ]);

        if (!callerSnap.exists) {
          throw new HttpsError('permission-denied', 'Caller profile not found.');
        }

        if (!redemptionSnap.exists) {
          throw new HttpsError('not-found', 'Redemption not found.');
        }

        const caller = callerSnap.data() as AppUserDoc;
        const redemption = redemptionSnap.data() as RedemptionDoc;
        const gameRules = gameRulesSnap.exists ? (gameRulesSnap.data() as GameRulesDoc) : {};

        if (!caller.active) {
          throw new HttpsError('failed-precondition', 'Caller is not active.');
        }

        const isAdmin = caller.role === 'admin';
        const isGuestOwner = caller.role === 'guest' && callerUid === redemption.guestUid;
        if (!isAdmin && !isGuestOwner) {
          throw new HttpsError('permission-denied', 'Caller cannot issue pickup token for this redemption.');
        }

        if (redemption.status === 'fulfilled') {
          throw new HttpsError('already-exists', 'Reward has already been fulfilled.');
        }

        if (redemption.status !== 'approved') {
          throw new HttpsError(
            'failed-precondition',
            `Redemption must be approved before issuing pickup token. Current status: ${redemption.status}`,
          );
        }

        const rewardRef = db.collection('rewards').doc(redemption.rewardId);
        const guestRef = db.collection('users').doc(redemption.guestUid);
        const requestRef = redemption.requestId
          ? db.collection('redemption_requests').doc(redemption.requestId)
          : null;

        const [rewardSnap, guestSnap, requestSnap] = await Promise.all([
          tx.get(rewardRef),
          tx.get(guestRef),
          requestRef ? tx.get(requestRef) : Promise.resolve(null),
        ]);

        if (!rewardSnap.exists) {
          throw new HttpsError('not-found', 'Reward not found.');
        }
        if (!guestSnap.exists) {
          throw new HttpsError('not-found', 'Guest not found.');
        }

        const reward = rewardSnap.data() as RewardDoc;
        const guest = guestSnap.data() as AppUserDoc;
        const redemptionRequest = requestSnap?.exists
          ? (requestSnap.data() as RedemptionRequestDoc)
          : null;

        if (guest.role !== 'guest' || !guest.active) {
          throw new HttpsError('failed-precondition', 'Guest is not active.');
        }

        if (!reward.isActive) {
          throw new HttpsError('failed-precondition', 'Reward is inactive.');
        }

        const now = Timestamp.now();
        if (reward.availableFrom && now.toMillis() < reward.availableFrom.toMillis()) {
          throw new HttpsError('failed-precondition', 'Reward is not yet available.');
        }
        if (reward.availableTo && now.toMillis() > reward.availableTo.toMillis()) {
          throw new HttpsError('failed-precondition', 'Reward has expired.');
        }

        if (tokenSnap.exists) {
          const existingToken = tokenSnap.data() as RewardTokenDoc;
          const isLive =
            existingToken.tokenType === 'reward_pickup' &&
            existingToken.status === 'unused' &&
            existingToken.expiresAt.toMillis() > now.toMillis();

          if (isLive && !forceReissue) {
            return {
              ok: true,
              tokenId,
              qrCodeValue: existingToken.qrCodeValue,
              expiresAt: existingToken.expiresAt.toDate().toISOString(),
              redemptionId,
              rewardId: redemption.rewardId,
              requestId: redemption.requestId,
              guestUid: redemption.guestUid,
              reused: true,
            } satisfies CreateRewardPickupTokenResponse;
          }
        }

        const expiresHours = Number(gameRules.defaultRewardPickupExpiresHours ?? 24);
        const expiresAt = Timestamp.fromMillis(
          now.toMillis() + expiresHours * 60 * 60 * 1000,
        );
        const qrCodeValue = `RP_${generateSecureRandom(16)}`;

        tx.set(tokenRef, {
          guestUid: redemption.guestUid,
          stayId: redemption.stayId,
          tokenType: 'reward_pickup',
          relatedMissionId: null,
          dailyDrinkId: null,
          relatedRedemptionId: redemptionId,
          relatedRequestId: redemption.requestId,
          rewardId: redemption.rewardId,
          qrCodeValue,
          status: 'unused',
          issuedAt: now,
          expiresAt,
          usedAt: null,
          usedBy: null,
          usedByRole: null,
        } satisfies RewardTokenDoc);

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: redemption.guestUid,
          actionType: 'issue_reward_pickup_token',
          entityType: 'token',
          entityId: tokenId,
          meta: {
            redemptionId,
            rewardId: redemption.rewardId,
            requestId: redemption.requestId,
            forceReissue,
            requestStatus: redemptionRequest?.status ?? null,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          tokenId,
          qrCodeValue,
          expiresAt: expiresAt.toDate().toISOString(),
          redemptionId,
          rewardId: redemption.rewardId,
          requestId: redemption.requestId,
          guestUid: redemption.guestUid,
          reused: false,
        } satisfies CreateRewardPickupTokenResponse;
      });

      logger.info('Reward pickup token issued', {
        callerUid,
        redemptionId,
        tokenId: result.tokenId,
        reused: result.reused,
      });

      return result;
    } catch (error) {
      logger.error('createRewardPickupToken failed', {
        callerUid,
        redemptionId,
        error,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('internal', 'Unable to create reward pickup token.');
    }
  },
);
