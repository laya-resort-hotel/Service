import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import {
  type AppUserDoc,
  type CancelRewardRedemptionRequest,
  type CancelRewardRedemptionResponse,
  type RedemptionDoc,
  type RedemptionRequestDoc,
  type RewardDoc,
  type RewardTokenDoc,
  type UserRole,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

const ALLOWED_CANCEL_ROLES: UserRole[] = [
  'admin',
  'fo_npc',
  'guest_relations_npc',
  'mod_npc',
  'gm_npc',
];

function canCancel(role: UserRole): boolean {
  return ALLOWED_CANCEL_ROLES.includes(role);
}

export const cancelRewardRedemption = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<CancelRewardRedemptionResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as CancelRewardRedemptionRequest;
    const callerUid = request.auth.uid;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim() ? data.requestId.trim() : null;
    const redemptionId = typeof data.redemptionId === 'string' && data.redemptionId.trim() ? data.redemptionId.trim() : null;
    const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : 'cancelled_from_admin_queue';

    if (!requestId && !redemptionId) {
      throw new HttpsError('invalid-argument', 'requestId or redemptionId is required.');
    }

    const callerRef = db.collection('users').doc(callerUid);

    try {
      const result = await db.runTransaction(async (tx) => {
        const callerSnap = await tx.get(callerRef);
        if (!callerSnap.exists) {
          throw new HttpsError('permission-denied', 'Caller profile not found.');
        }

        const caller = callerSnap.data() as AppUserDoc;
        if (!caller.active || !canCancel(caller.role)) {
          throw new HttpsError('permission-denied', 'Caller cannot cancel this reward flow.');
        }

        let resolvedRequestId = requestId;
        let resolvedRedemptionId = redemptionId;

        let requestRef = resolvedRequestId ? db.collection('redemption_requests').doc(resolvedRequestId) : null;
        let redemptionRef = resolvedRedemptionId ? db.collection('redemptions').doc(resolvedRedemptionId) : null;

        let requestSnap = requestRef ? await tx.get(requestRef) : null;
        let redemptionSnap = redemptionRef ? await tx.get(redemptionRef) : null;

        let requestDoc = requestSnap?.exists ? (requestSnap.data() as RedemptionRequestDoc) : null;
        let redemptionDoc = redemptionSnap?.exists ? (redemptionSnap.data() as RedemptionDoc) : null;

        if (!requestDoc && !redemptionDoc) {
          throw new HttpsError('not-found', 'Reward request/redemption not found.');
        }

        if (!resolvedRequestId && redemptionDoc?.requestId) {
          resolvedRequestId = redemptionDoc.requestId;
          requestRef = db.collection('redemption_requests').doc(resolvedRequestId);
          requestSnap = await tx.get(requestRef);
          requestDoc = requestSnap.exists ? (requestSnap.data() as RedemptionRequestDoc) : null;
        }

        if (!resolvedRedemptionId && requestDoc?.approvedRedemptionId) {
          resolvedRedemptionId = requestDoc.approvedRedemptionId;
          redemptionRef = db.collection('redemptions').doc(resolvedRedemptionId);
          redemptionSnap = await tx.get(redemptionRef);
          redemptionDoc = redemptionSnap.exists ? (redemptionSnap.data() as RedemptionDoc) : null;
        }

        if (requestDoc?.status === 'cancelled' || redemptionDoc?.status === 'cancelled') {
          return {
            ok: true,
            requestId: resolvedRequestId,
            redemptionId: resolvedRedemptionId,
            status: 'cancelled',
            refunded: false,
            stockReturned: false,
            alreadyCancelled: true,
          };
        }

        if (redemptionDoc?.status === 'fulfilled') {
          throw new HttpsError('failed-precondition', 'Cannot cancel a fulfilled redemption.');
        }

        let refunded = false;
        let stockReturned = false;

        if (requestRef && requestDoc) {
          tx.update(requestRef, {
            status: 'cancelled',
            processedAt: FieldValue.serverTimestamp(),
            processedBy: callerUid,
            rejectionReason: reason,
            notes: reason,
          });
        }

        if (redemptionRef && redemptionDoc) {
          tx.update(redemptionRef, {
            status: 'cancelled',
            updatedAt: FieldValue.serverTimestamp(),
            fulfillmentNotes: reason,
          });

          const walletRef = db.collection('guest_wallets').doc(redemptionDoc.guestUid);
          tx.set(
            walletRef,
            {
              bronze: FieldValue.increment(redemptionDoc.costBronze),
              silver: FieldValue.increment(redemptionDoc.costSilver),
              gold: FieldValue.increment(redemptionDoc.costGold),
              totalSpentBronze: FieldValue.increment(-redemptionDoc.costBronze),
              totalSpentSilver: FieldValue.increment(-redemptionDoc.costSilver),
              totalSpentGold: FieldValue.increment(-redemptionDoc.costGold),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
          refunded = redemptionDoc.costBronze > 0 || redemptionDoc.costSilver > 0 || redemptionDoc.costGold > 0;

          const rewardRef = db.collection('rewards').doc(redemptionDoc.rewardId);
          const rewardSnap = await tx.get(rewardRef);
          if (rewardSnap.exists) {
            const reward = rewardSnap.data() as RewardDoc;
            if (reward.stockType === 'limited') {
              tx.update(rewardRef, {
                stock: FieldValue.increment(1),
                updatedAt: FieldValue.serverTimestamp(),
              });
              stockReturned = true;
            }
          }

          const tokenQuery = db
            .collection('reward_tokens')
            .where('tokenType', '==', 'reward_pickup')
            .where('relatedRedemptionId', '==', resolvedRedemptionId)
            .where('status', '==', 'unused');

          const tokenSnap = await tx.get(tokenQuery);
          tokenSnap.docs.forEach((tokenDocSnap) => {
            const token = tokenDocSnap.data() as RewardTokenDoc;
            tx.update(tokenDocSnap.ref, {
              status: 'cancelled',
              usedAt: null,
              usedBy: null,
              usedByRole: null,
            });

            const tokenLogRef = db.collection('activity_logs').doc();
            tx.set(tokenLogRef, {
              actorUid: callerUid,
              actorRole: caller.role,
              targetUid: token.guestUid,
              actionType: 'cancel_reward_pickup_token',
              entityType: 'token',
              entityId: tokenDocSnap.id,
              meta: {
                relatedRequestId: token.relatedRequestId ?? null,
                relatedRedemptionId: token.relatedRedemptionId ?? null,
                reason,
              },
              createdAt: FieldValue.serverTimestamp(),
            });
          });
        }

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: redemptionDoc?.guestUid ?? requestDoc?.guestUid ?? null,
          actionType: 'cancel_reward_redemption',
          entityType: 'reward',
          entityId: redemptionDoc?.rewardId ?? requestDoc?.rewardId ?? null,
          meta: {
            requestId: resolvedRequestId,
            redemptionId: resolvedRedemptionId,
            reason,
            refunded,
            stockReturned,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          requestId: resolvedRequestId,
          redemptionId: resolvedRedemptionId,
          status: 'cancelled',
          refunded,
          stockReturned,
          alreadyCancelled: false,
        };
      });

      logger.info('cancelRewardRedemption success', {
        callerUid,
        requestId: result.requestId,
        redemptionId: result.redemptionId,
        refunded: result.refunded,
        stockReturned: result.stockReturned,
        alreadyCancelled: result.alreadyCancelled,
      });

      return result;
    } catch (error) {
      logger.error('cancelRewardRedemption failed', {
        callerUid,
        requestId,
        redemptionId,
        error,
      });

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError('internal', 'Unable to cancel reward flow.');
    }
  },
);
