import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import {
  HOTEL_TIMEZONE,
  type AppUserDoc,
  type GuestWalletDoc,
  type RedemptionDoc,
  type RedemptionRequestDoc,
  type RewardDoc,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

type RequestFailureStatus = 'rejected' | 'cancelled';

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

function rejectRequest(
  tx: FirebaseFirestore.Transaction,
  requestRef: FirebaseFirestore.DocumentReference,
  status: RequestFailureStatus,
  reason: string,
): void {
  tx.update(requestRef, {
    status,
    rejectionReason: reason,
    processedAt: FieldValue.serverTimestamp(),
  });
}

function hasEnoughCoins(wallet: GuestWalletDoc, request: RedemptionRequestDoc): boolean {
  return (
    wallet.bronze >= request.costBronze &&
    wallet.silver >= request.costSilver &&
    wallet.gold >= request.costGold
  );
}

export const processRedemptionRequest = onDocumentCreated(
  {
    document: 'redemption_requests/{requestId}',
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (event) => {
    const snapshot = event.data;
    const requestId = event.params.requestId;

    if (!snapshot) {
      logger.warn('processRedemptionRequest fired without snapshot', { requestId });
      return;
    }

    const initialRequest = snapshot.data() as RedemptionRequestDoc | undefined;
    if (!initialRequest) {
      logger.warn('processRedemptionRequest received empty request data', { requestId });
      return;
    }

    if (initialRequest.status !== 'pending') {
      logger.info('Redemption request already processed before trigger execution', {
        requestId,
        status: initialRequest.status,
      });
      return;
    }

    const requestRef = db.collection('redemption_requests').doc(requestId);
    const rewardRef = db.collection('rewards').doc(initialRequest.rewardId);
    const walletRef = db.collection('guest_wallets').doc(initialRequest.guestUid);
    const guestRef = db.collection('users').doc(initialRequest.guestUid);
    const redemptionRef = db.collection('redemptions').doc(`redemption_${requestId}`);

    try {
      await db.runTransaction(async (tx) => {
        const [freshRequestSnap, rewardSnap, walletSnap, guestSnap, redemptionSnap] =
          await Promise.all([
            tx.get(requestRef),
            tx.get(rewardRef),
            tx.get(walletRef),
            tx.get(guestRef),
            tx.get(redemptionRef),
          ]);

        if (!freshRequestSnap.exists) {
          logger.warn('Redemption request disappeared during transaction', { requestId });
          return;
        }

        const freshRequest = freshRequestSnap.data() as RedemptionRequestDoc;
        if (freshRequest.status !== 'pending') {
          logger.info('Redemption request already processed inside transaction', {
            requestId,
            status: freshRequest.status,
          });
          return;
        }

        if (redemptionSnap.exists) {
          tx.update(requestRef, {
            status: 'approved',
            processedAt: FieldValue.serverTimestamp(),
          });
          return;
        }

        if (!rewardSnap.exists) {
          rejectRequest(tx, requestRef, 'rejected', 'reward_not_found');
          return;
        }

        if (!walletSnap.exists || !guestSnap.exists) {
          rejectRequest(tx, requestRef, 'rejected', 'guest_not_ready');
          return;
        }

        const reward = rewardSnap.data() as RewardDoc;
        const wallet = walletSnap.data() as GuestWalletDoc;
        const guest = guestSnap.data() as AppUserDoc;
        const now = Timestamp.now();

        if (guest.role !== 'guest' || !guest.active) {
          rejectRequest(tx, requestRef, 'rejected', 'guest_not_active');
          return;
        }

        if (!reward.isActive) {
          rejectRequest(tx, requestRef, 'rejected', 'reward_inactive');
          return;
        }

        if (reward.availableFrom && now.toMillis() < reward.availableFrom.toMillis()) {
          rejectRequest(tx, requestRef, 'rejected', 'reward_not_started');
          return;
        }

        if (reward.availableTo && now.toMillis() > reward.availableTo.toMillis()) {
          rejectRequest(tx, requestRef, 'rejected', 'reward_expired');
          return;
        }

        if (reward.costBronze !== freshRequest.costBronze ||
            reward.costSilver !== freshRequest.costSilver ||
            reward.costGold !== freshRequest.costGold) {
          rejectRequest(tx, requestRef, 'rejected', 'reward_cost_mismatch');
          return;
        }

        if (!hasEnoughCoins(wallet, freshRequest)) {
          rejectRequest(tx, requestRef, 'rejected', 'insufficient_balance');
          return;
        }

        if (reward.stockType === 'limited' && reward.stock <= 0) {
          rejectRequest(tx, requestRef, 'rejected', 'out_of_stock');
          return;
        }

        tx.set(
          walletRef,
          {
            bronze: FieldValue.increment(-freshRequest.costBronze),
            silver: FieldValue.increment(-freshRequest.costSilver),
            gold: FieldValue.increment(-freshRequest.costGold),
            totalSpentBronze: FieldValue.increment(freshRequest.costBronze),
            totalSpentSilver: FieldValue.increment(freshRequest.costSilver),
            totalSpentGold: FieldValue.increment(freshRequest.costGold),
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        if (reward.stockType === 'limited') {
          tx.update(rewardRef, {
            stock: FieldValue.increment(-1),
            updatedAt: FieldValue.serverTimestamp(),
          });
        }

        tx.set(redemptionRef, {
          guestUid: freshRequest.guestUid,
          stayId: freshRequest.stayId,
          rewardId: freshRequest.rewardId,
          requestId,
          fulfilledBy: null,
          costBronze: freshRequest.costBronze,
          costSilver: freshRequest.costSilver,
          costGold: freshRequest.costGold,
          status: 'approved',
          fulfilledAt: null,
          createdAt: now,
        } satisfies RedemptionDoc);

        tx.update(requestRef, {
          status: 'approved',
          processedAt: FieldValue.serverTimestamp(),
          approvedRedemptionId: redemptionRef.id,
        });

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: freshRequest.guestUid,
          actorRole: 'guest',
          targetUid: freshRequest.guestUid,
          actionType: 'redeem_reward',
          entityType: 'reward',
          entityId: freshRequest.rewardId,
          meta: {
            requestId,
            redemptionId: redemptionRef.id,
            costBronze: freshRequest.costBronze,
            costSilver: freshRequest.costSilver,
            costGold: freshRequest.costGold,
            processedDateKey: getHotelDateKey(new Date(), HOTEL_TIMEZONE),
          },
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (error) {
      logger.error('processRedemptionRequest failed', {
        requestId,
        error,
      });
      throw error;
    }
  },
);
