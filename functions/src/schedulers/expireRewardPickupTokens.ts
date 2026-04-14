import { onSchedule } from 'firebase-functions/v2/scheduler';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';

import { HOTEL_TIMEZONE, type RewardTokenDoc } from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';
const BATCH_SIZE = 200;

export const expireRewardPickupTokens = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: HOTEL_TIMEZONE,
    region: REGION,
    timeoutSeconds: 300,
    memory: '256MiB',
    retryCount: 0,
  },
  async () => {
    const startedAt = Timestamp.now();
    let totalExpired = 0;
    let rounds = 0;

    while (true) {
      rounds += 1;
      const snapshot = await db
        .collection('reward_tokens')
        .where('tokenType', '==', 'reward_pickup')
        .where('status', '==', 'unused')
        .where('expiresAt', '<=', Timestamp.now())
        .orderBy('expiresAt', 'asc')
        .limit(BATCH_SIZE)
        .get();

      if (snapshot.empty) {
        break;
      }

      const batch = db.batch();
      for (const doc of snapshot.docs) {
        const token = doc.data() as RewardTokenDoc;
        batch.update(doc.ref, {
          status: 'expired',
          usedAt: null,
          usedBy: null,
          usedByRole: null,
        });

        const logRef = db.collection('activity_logs').doc();
        batch.set(logRef, {
          actorUid: null,
          actorRole: 'admin',
          targetUid: token.guestUid,
          actionType: 'expire_reward_pickup_token',
          entityType: 'token',
          entityId: doc.id,
          meta: {
            relatedRedemptionId: token.relatedRedemptionId ?? null,
            relatedRequestId: token.relatedRequestId ?? null,
            rewardId: token.rewardId ?? null,
            expiredAtIso: new Date().toISOString(),
          },
          createdAt: FieldValue.serverTimestamp(),
        });
      }

      await batch.commit();
      totalExpired += snapshot.size;

      logger.info('Expired reward pickup token batch', {
        round: rounds,
        batchSize: snapshot.size,
        totalExpired,
      });

      if (snapshot.size < BATCH_SIZE) {
        break;
      }
    }

    logger.info('expireRewardPickupTokens complete', {
      totalExpired,
      rounds,
      startedAt: startedAt.toDate().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  },
);
