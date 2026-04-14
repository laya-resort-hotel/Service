import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  type AppUserDoc,
  type ApprovePendingRewardRequestRequest,
  type ApprovePendingRewardRequestResponse,
  type GameRulesDoc,
  type GuestWalletDoc,
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

const ALLOWED_APPROVER_ROLES: UserRole[] = [
  'admin',
  'fo_npc',
  'guest_relations_npc',
  'mod_npc',
  'gm_npc',
];

function canApprove(role: UserRole): boolean {
  return ALLOWED_APPROVER_ROLES.includes(role);
}

function generateSecureRandom(length = 14): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

export const approvePendingRewardRequest = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<ApprovePendingRewardRequestResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as ApprovePendingRewardRequestRequest;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim() ? data.requestId.trim() : '';
    const forceReissue = data.forceReissue === true;
    const notes = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null;

    if (!requestId) {
      throw new HttpsError('invalid-argument', 'requestId is required.');
    }

    const callerUid = request.auth.uid;
    const callerRef = db.collection('users').doc(callerUid);
    const requestRef = db.collection('redemption_requests').doc(requestId);

    try {
      const result = await db.runTransaction(async (tx) => {
        const [callerSnap, requestSnap] = await Promise.all([tx.get(callerRef), tx.get(requestRef)]);

        if (!callerSnap.exists) {
          throw new HttpsError('permission-denied', 'Caller profile not found.');
        }
        if (!requestSnap.exists) {
          throw new HttpsError('not-found', 'Redemption request not found.');
        }

        const caller = callerSnap.data() as AppUserDoc;
        const requestDoc = requestSnap.data() as RedemptionRequestDoc;

        if (!caller.active || !canApprove(caller.role)) {
          throw new HttpsError('permission-denied', 'Caller cannot approve redemption requests.');
        }

        if (requestDoc.status === 'cancelled') {
          throw new HttpsError('failed-precondition', 'Request already cancelled.');
        }
        if (requestDoc.status === 'rejected') {
          throw new HttpsError('failed-precondition', 'Request already rejected.');
        }

        const rewardRef = db.collection('rewards').doc(requestDoc.rewardId);
        const walletRef = db.collection('guest_wallets').doc(requestDoc.guestUid);
        const guestRef = db.collection('users').doc(requestDoc.guestUid);
        const gameRulesRef = db.collection('system_config').doc('game_rules');
        const existingRedemptionRef = requestDoc.approvedRedemptionId
          ? db.collection('redemptions').doc(requestDoc.approvedRedemptionId)
          : null;

        const [rewardSnap, walletSnap, guestSnap, gameRulesSnap, existingRedemptionSnap] = await Promise.all([
          tx.get(rewardRef),
          tx.get(walletRef),
          tx.get(guestRef),
          tx.get(gameRulesRef),
          existingRedemptionRef ? tx.get(existingRedemptionRef) : Promise.resolve(null),
        ]);

        if (!guestSnap.exists || !guestSnap.data()?.active) {
          throw new HttpsError('failed-precondition', 'Guest is not active.');
        }
        if (!walletSnap.exists) {
          throw new HttpsError('failed-precondition', 'Guest wallet not found.');
        }
        if (!rewardSnap.exists) {
          throw new HttpsError('failed-precondition', 'Reward not found.');
        }

        const reward = rewardSnap.data() as RewardDoc;
        const wallet = walletSnap.data() as GuestWalletDoc;
        const gameRules = (gameRulesSnap.exists ? gameRulesSnap.data() : {}) as GameRulesDoc;

        if (!reward.isActive) {
          throw new HttpsError('failed-precondition', 'Reward is inactive.');
        }

        const currentRedemptionDoc = existingRedemptionSnap?.exists ? (existingRedemptionSnap.data() as RedemptionDoc) : null;

        if (requestDoc.status === 'approved' && currentRedemptionDoc) {
          // already approved, optionally reissue token only
          const tokenQuery = await tx.get(
            db
              .collection('reward_tokens')
              .where('relatedRedemptionId', '==', existingRedemptionRef!.id)
              .where('tokenType', '==', 'reward_pickup')
              .limit(5),
          );

          const now = Timestamp.now();
          const liveToken = tokenQuery.docs.find((docSnap) => {
            const token = docSnap.data() as RewardTokenDoc;
            return token.status === 'unused' && token.expiresAt.toMillis() > now.toMillis();
          });

          if (liveToken && !forceReissue) {
            return {
              ok: true,
              requestId,
              redemptionId: existingRedemptionRef!.id,
              guestUid: requestDoc.guestUid,
              rewardId: requestDoc.rewardId,
              status: 'approved' as const,
              tokenId: liveToken.id,
              qrCodeValue: (liveToken.data() as RewardTokenDoc).qrCodeValue,
              expiresAt: ((liveToken.data() as RewardTokenDoc).expiresAt).toDate().toISOString(),
              alreadyApproved: true,
              reusedToken: true,
            };
          }

          const expiresHours = Number(gameRules.defaultRewardPickupExpiresHours || 24);
          const issuedAt = Timestamp.now();
          const expiresAt = Timestamp.fromMillis(issuedAt.toMillis() + expiresHours * 60 * 60 * 1000);
          const tokenRef = db.collection('reward_tokens').doc();
          const qrCodeValue = `RP_${generateSecureRandom(14)}`;

          if (forceReissue) {
            for (const tokenDoc of tokenQuery.docs) {
              const token = tokenDoc.data() as RewardTokenDoc;
              if (token.status === 'unused') {
                tx.update(tokenDoc.ref, {
                  status: 'cancelled',
                  usedAt: FieldValue.serverTimestamp(),
                  usedBy: callerUid,
                  usedByRole: caller.role,
                });
              }
            }
          }

          tx.set(tokenRef, {
            guestUid: requestDoc.guestUid,
            stayId: requestDoc.stayId,
            tokenType: 'reward_pickup',
            relatedMissionId: null,
            dailyDrinkId: null,
            relatedRedemptionId: existingRedemptionRef!.id,
            relatedRequestId: requestId,
            rewardId: requestDoc.rewardId,
            qrCodeValue,
            status: 'unused',
            issuedAt,
            expiresAt,
            usedAt: null,
            usedBy: null,
            usedByRole: null,
          } satisfies RewardTokenDoc);

          const logRef = db.collection('activity_logs').doc();
          tx.set(logRef, {
            actorUid: callerUid,
            actorRole: caller.role,
            targetUid: requestDoc.guestUid,
            actionType: 'reissue_pickup_token',
            entityType: 'redemption',
            entityId: existingRedemptionRef!.id,
            meta: {
              requestId,
              redemptionId: existingRedemptionRef!.id,
              rewardId: requestDoc.rewardId,
              tokenId: tokenRef.id,
              notes,
            },
            createdAt: FieldValue.serverTimestamp(),
          });

          return {
            ok: true,
            requestId,
            redemptionId: existingRedemptionRef!.id,
            guestUid: requestDoc.guestUid,
            rewardId: requestDoc.rewardId,
            status: 'approved' as const,
            tokenId: tokenRef.id,
            qrCodeValue,
            expiresAt: expiresAt.toDate().toISOString(),
            alreadyApproved: true,
            reusedToken: false,
          };
        }

        if (requestDoc.status !== 'pending') {
          throw new HttpsError('failed-precondition', `Request is already ${requestDoc.status}.`);
        }

        if (wallet.bronze < (requestDoc.costBronze || 0) || wallet.silver < (requestDoc.costSilver || 0) || wallet.gold < (requestDoc.costGold || 0)) {
          throw new HttpsError('failed-precondition', 'Guest does not have enough coins.');
        }

        if (reward.stockType === 'limited' && Number(reward.stock || 0) <= 0) {
          throw new HttpsError('failed-precondition', 'Reward is out of stock.');
        }

        const redemptionRef = db.collection('redemptions').doc();
        const expiresHours = Number(gameRules.defaultRewardPickupExpiresHours || 24);
        const issuedAt = Timestamp.now();
        const expiresAt = Timestamp.fromMillis(issuedAt.toMillis() + expiresHours * 60 * 60 * 1000);
        const tokenRef = db.collection('reward_tokens').doc();
        const qrCodeValue = `RP_${generateSecureRandom(14)}`;

        tx.update(walletRef, {
          bronze: FieldValue.increment(-(requestDoc.costBronze || 0)),
          silver: FieldValue.increment(-(requestDoc.costSilver || 0)),
          gold: FieldValue.increment(-(requestDoc.costGold || 0)),
          totalSpentBronze: FieldValue.increment(requestDoc.costBronze || 0),
          totalSpentSilver: FieldValue.increment(requestDoc.costSilver || 0),
          totalSpentGold: FieldValue.increment(requestDoc.costGold || 0),
          updatedAt: FieldValue.serverTimestamp(),
        });

        if (reward.stockType === 'limited') {
          tx.update(rewardRef, {
            stock: FieldValue.increment(-1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(redemptionRef, {
          guestUid: requestDoc.guestUid,
          stayId: requestDoc.stayId,
          rewardId: requestDoc.rewardId,
          requestId,
          fulfilledBy: null,
          costBronze: requestDoc.costBronze || 0,
          costSilver: requestDoc.costSilver || 0,
          costGold: requestDoc.costGold || 0,
          status: 'approved',
          fulfilledAt: null,
          fulfillmentNotes: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        } satisfies RedemptionDoc);

        tx.update(requestRef, {
          status: 'approved',
          processedAt: FieldValue.serverTimestamp(),
          processedBy: callerUid,
          approvedRedemptionId: redemptionRef.id,
          notes: notes || requestDoc.notes || null,
        });

        tx.set(tokenRef, {
          guestUid: requestDoc.guestUid,
          stayId: requestDoc.stayId,
          tokenType: 'reward_pickup',
          relatedMissionId: null,
          dailyDrinkId: null,
          relatedRedemptionId: redemptionRef.id,
          relatedRequestId: requestId,
          rewardId: requestDoc.rewardId,
          qrCodeValue,
          status: 'unused',
          issuedAt,
          expiresAt,
          usedAt: null,
          usedBy: null,
          usedByRole: null,
        } satisfies RewardTokenDoc);

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: requestDoc.guestUid,
          actionType: 'approve_reward_request',
          entityType: 'redemption',
          entityId: redemptionRef.id,
          meta: {
            requestId,
            redemptionId: redemptionRef.id,
            rewardId: requestDoc.rewardId,
            tokenId: tokenRef.id,
            notes,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          requestId,
          redemptionId: redemptionRef.id,
          guestUid: requestDoc.guestUid,
          rewardId: requestDoc.rewardId,
          status: 'approved' as const,
          tokenId: tokenRef.id,
          qrCodeValue,
          expiresAt: expiresAt.toDate().toISOString(),
          alreadyApproved: false,
          reusedToken: false,
        };
      });

      return result;
    } catch (error) {
      logger.error('approvePendingRewardRequest failed', { error, requestId, callerUid });
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError('internal', 'Unable to approve pending reward request.');
    }
  },
);
