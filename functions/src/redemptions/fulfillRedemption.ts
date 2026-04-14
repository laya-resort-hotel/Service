import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  type AppUserDoc,
  type FulfillRedemptionRequest,
  type FulfillRedemptionResponse,
  type RedemptionDoc,
  type RedemptionRequestDoc,
  type RewardDoc,
  type RewardTokenDoc,
  type StaffNpcProfileDoc,
  type UserRole,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

const STAFF_FULFILLER_ROLES: UserRole[] = [
  'fo_npc',
  'guest_relations_npc',
  'dining_npc',
  'bartender_npc',
  'recreation_npc',
  'spa_npc',
  'mod_npc',
  'gm_npc',
  'admin',
];

function canFulfillRole(role: UserRole): boolean {
  return STAFF_FULFILLER_ROLES.includes(role);
}

function sanitizeInput(input: string | null | undefined): string {
  return typeof input === 'string' ? input.trim() : '';
}

export const fulfillRedemption = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<FulfillRedemptionResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as FulfillRedemptionRequest;
    const callerUid = request.auth.uid;
    const scannedCode = sanitizeInput(data.scannedCode);
    const fallbackRedemptionId = sanitizeInput(data.redemptionId);

    if (!scannedCode && !fallbackRedemptionId) {
      throw new HttpsError('invalid-argument', 'scannedCode is required. redemptionId is deprecated fallback only.');
    }

    const callerRef = db.collection('users').doc(callerUid);
    const callerNpcRef = db.collection('staff_npc_profiles').doc(callerUid);

    let tokenRef: FirebaseFirestore.DocumentReference | null = null;
    if (scannedCode) {
      const tokenQuerySnap = await db
        .collection('reward_tokens')
        .where('qrCodeValue', '==', scannedCode)
        .limit(1)
        .get();

      if (tokenQuerySnap.empty) {
        throw new HttpsError('not-found', 'Pickup token not found.');
      }

      tokenRef = tokenQuerySnap.docs[0].ref;
    }

    const redemptionRef = fallbackRedemptionId
      ? db.collection('redemptions').doc(fallbackRedemptionId)
      : null;

    try {
      const result = await db.runTransaction(async (tx) => {
        const [callerSnap, callerNpcSnap, tokenSnapFromTx] = await Promise.all([
          tx.get(callerRef),
          tx.get(callerNpcRef),
          tokenRef ? tx.get(tokenRef) : Promise.resolve(null),
        ]);

        if (!callerSnap.exists) {
          throw new HttpsError('permission-denied', 'Caller profile not found.');
        }

        const caller = callerSnap.data() as AppUserDoc;
        const callerNpc = callerNpcSnap.exists
          ? (callerNpcSnap.data() as StaffNpcProfileDoc)
          : null;

        if (!caller.active) {
          throw new HttpsError('failed-precondition', 'Caller is not active.');
        }

        if (!canFulfillRole(caller.role)) {
          throw new HttpsError('permission-denied', 'Caller role cannot fulfill rewards.');
        }

        if (caller.role !== 'admin') {
          if (!callerNpc || !callerNpc.active) {
            throw new HttpsError('failed-precondition', 'Staff NPC profile is not active.');
          }
          if (callerNpc.shiftStatus !== 'on_duty') {
            throw new HttpsError('failed-precondition', 'Staff is not on duty.');
          }
        }

        let resolvedTokenId: string | null = null;
        let resolvedRedemptionRef: FirebaseFirestore.DocumentReference;
        let rewardPickupToken: RewardTokenDoc | null = null;

        if (tokenRef) {
          if (!tokenSnapFromTx?.exists) {
            throw new HttpsError('not-found', 'Pickup token not found.');
          }

          rewardPickupToken = tokenSnapFromTx.data() as RewardTokenDoc;
          resolvedTokenId = tokenSnapFromTx.id;

          if (rewardPickupToken.tokenType !== 'reward_pickup') {
            throw new HttpsError('failed-precondition', 'Scanned code is not a reward pickup token.');
          }

          if (!rewardPickupToken.relatedRedemptionId) {
            throw new HttpsError('failed-precondition', 'Pickup token is missing related redemption.');
          }

          resolvedRedemptionRef = db
            .collection('redemptions')
            .doc(rewardPickupToken.relatedRedemptionId);
        } else if (redemptionRef) {
          resolvedRedemptionRef = redemptionRef;
        } else {
          throw new HttpsError('invalid-argument', 'No pickup token or redemption id provided.');
        }

        const redemptionSnap = await tx.get(resolvedRedemptionRef);
        if (!redemptionSnap.exists) {
          throw new HttpsError('not-found', 'Redemption not found.');
        }

        const redemption = redemptionSnap.data() as RedemptionDoc;
        const requestRef = redemption.requestId
          ? db.collection('redemption_requests').doc(redemption.requestId)
          : null;
        const rewardRef = db.collection('rewards').doc(redemption.rewardId);
        const guestRef = db.collection('users').doc(redemption.guestUid);

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
        const requestDoc = requestSnap?.exists
          ? (requestSnap.data() as RedemptionRequestDoc)
          : null;

        if (rewardPickupToken) {
          const nowMs = Date.now();

          if (rewardPickupToken.guestUid !== redemption.guestUid || rewardPickupToken.stayId !== redemption.stayId) {
            throw new HttpsError('failed-precondition', 'Pickup token guest/stay mismatch.');
          }

          if (rewardPickupToken.rewardId && rewardPickupToken.rewardId !== redemption.rewardId) {
            throw new HttpsError('failed-precondition', 'Pickup token reward mismatch.');
          }

          if (rewardPickupToken.status === 'used') {
            return {
              ok: true,
              redemptionId: redemptionSnap.id,
              guestUid: redemption.guestUid,
              rewardId: redemption.rewardId,
              requestId: redemption.requestId,
              tokenId: resolvedTokenId,
              status: 'fulfilled',
              fulfilledAt: redemption.fulfilledAt?.toDate().toISOString() ?? new Date().toISOString(),
              alreadyFulfilled: true,
            } satisfies FulfillRedemptionResponse;
          }

          if (rewardPickupToken.status !== 'unused') {
            throw new HttpsError('failed-precondition', `Pickup token is ${rewardPickupToken.status}.`);
          }

          if (rewardPickupToken.expiresAt.toMillis() < nowMs) {
            throw new HttpsError('deadline-exceeded', 'Pickup token has expired.');
          }
        }

        if (redemption.status === 'fulfilled') {
          return {
            ok: true,
            redemptionId: redemptionSnap.id,
            guestUid: redemption.guestUid,
            rewardId: redemption.rewardId,
            requestId: redemption.requestId,
            tokenId: resolvedTokenId,
            status: 'fulfilled',
            fulfilledAt: redemption.fulfilledAt?.toDate().toISOString() ?? new Date().toISOString(),
            alreadyFulfilled: true,
          } satisfies FulfillRedemptionResponse;
        }

        if (redemption.status !== 'approved') {
          throw new HttpsError(
            'failed-precondition',
            `Redemption must be approved before fulfillment. Current status: ${redemption.status}`,
          );
        }

        if (guest.role !== 'guest' || !guest.active) {
          throw new HttpsError('failed-precondition', 'Guest is not active.');
        }

        if (reward.redeemMode !== 'staff_verify' && reward.redeemMode !== 'manual_pickup' && reward.redeemMode !== 'token_issue') {
          throw new HttpsError(
            'failed-precondition',
            `Reward redeemMode ${reward.redeemMode} does not support staff fulfillment.`,
          );
        }

        const now = Timestamp.now();

        tx.update(resolvedRedemptionRef, {
          status: 'fulfilled',
          fulfilledBy: callerUid,
          fulfilledAt: now,
        });

        if (requestRef && requestDoc) {
          if (requestDoc.status === 'approved' || requestDoc.status === 'pending') {
            tx.update(requestRef, {
              status: 'fulfilled',
              processedAt: FieldValue.serverTimestamp(),
              processedBy: callerUid,
              notes: data.notes?.trim() || requestDoc.notes || null,
            });
          }
        }

        if (tokenRef && rewardPickupToken) {
          tx.update(tokenRef, {
            status: 'used',
            usedAt: now,
            usedBy: callerUid,
            usedByRole: caller.role,
          });
        }

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: redemption.guestUid,
          actionType: 'fulfill_redemption',
          entityType: 'reward',
          entityId: redemption.rewardId,
          meta: {
            redemptionId: redemptionSnap.id,
            requestId: redemption.requestId,
            tokenId: resolvedTokenId,
            scannedCode: scannedCode || null,
            notes: data.notes?.trim() || null,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          redemptionId: redemptionSnap.id,
          guestUid: redemption.guestUid,
          rewardId: redemption.rewardId,
          requestId: redemption.requestId,
          tokenId: resolvedTokenId,
          status: 'fulfilled',
          fulfilledAt: now.toDate().toISOString(),
          alreadyFulfilled: false,
        } satisfies FulfillRedemptionResponse;
      });

      logger.info('Redemption fulfilled', {
        callerUid,
        redemptionId: result.redemptionId,
        guestUid: result.guestUid,
        rewardId: result.rewardId,
        tokenId: result.tokenId,
        alreadyFulfilled: result.alreadyFulfilled,
      });

      return result;
    } catch (error) {
      logger.error('fulfillRedemption failed', {
        callerUid,
        scannedCode,
        fallbackRedemptionId,
        error,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('internal', 'Unable to fulfill redemption.');
    }
  },
);
