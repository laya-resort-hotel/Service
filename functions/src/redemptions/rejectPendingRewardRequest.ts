import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

import {
  type AppUserDoc,
  type RejectPendingRewardRequestRequest,
  type RejectPendingRewardRequestResponse,
  type RedemptionRequestDoc,
  type UserRole,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

const ALLOWED_REJECT_ROLES: UserRole[] = [
  'admin',
  'fo_npc',
  'guest_relations_npc',
  'mod_npc',
  'gm_npc',
];

function canReject(role: UserRole): boolean {
  return ALLOWED_REJECT_ROLES.includes(role);
}

export const rejectPendingRewardRequest = onCall(
  {
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (request): Promise<RejectPendingRewardRequestResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Login required.');
    }

    const data = (request.data ?? {}) as RejectPendingRewardRequestRequest;
    const requestId = typeof data.requestId === 'string' && data.requestId.trim() ? data.requestId.trim() : '';
    const reason = typeof data.reason === 'string' && data.reason.trim() ? data.reason.trim() : 'rejected_by_admin';
    const notes = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null;

    if (!requestId) {
      throw new HttpsError('invalid-argument', 'requestId is required.');
    }

    const callerUid = request.auth.uid;
    const callerRef = db.collection('users').doc(callerUid);
    const requestRef = db.collection('redemption_requests').doc(requestId);

    try {
      return await db.runTransaction(async (tx) => {
        const [callerSnap, requestSnap] = await Promise.all([tx.get(callerRef), tx.get(requestRef)]);

        if (!callerSnap.exists) {
          throw new HttpsError('permission-denied', 'Caller profile not found.');
        }
        if (!requestSnap.exists) {
          throw new HttpsError('not-found', 'Redemption request not found.');
        }

        const caller = callerSnap.data() as AppUserDoc;
        const requestDoc = requestSnap.data() as RedemptionRequestDoc;

        if (!caller.active || !canReject(caller.role)) {
          throw new HttpsError('permission-denied', 'Caller cannot reject redemption requests.');
        }

        if (requestDoc.status === 'rejected') {
          return {
            ok: true,
            requestId,
            guestUid: requestDoc.guestUid,
            rewardId: requestDoc.rewardId,
            status: 'rejected' as const,
            alreadyRejected: true,
          };
        }

        if (requestDoc.status !== 'pending') {
          throw new HttpsError('failed-precondition', `Only pending requests can be rejected. Current status: ${requestDoc.status}`);
        }

        tx.update(requestRef, {
          status: 'rejected',
          rejectionReason: reason,
          notes,
          processedAt: FieldValue.serverTimestamp(),
          processedBy: callerUid,
        });

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: callerUid,
          actorRole: caller.role,
          targetUid: requestDoc.guestUid,
          actionType: 'reject_redemption_request',
          entityType: 'redemption_request',
          entityId: requestId,
          meta: {
            requestId,
            rewardId: requestDoc.rewardId,
            reason,
            notes,
          },
          createdAt: FieldValue.serverTimestamp(),
        });

        return {
          ok: true,
          requestId,
          guestUid: requestDoc.guestUid,
          rewardId: requestDoc.rewardId,
          status: 'rejected' as const,
          alreadyRejected: false,
        };
      });
    } catch (error) {
      logger.error('rejectPendingRewardRequest failed', { callerUid, requestId, error });
      if (error instanceof HttpsError) throw error;
      throw new HttpsError('internal', 'Failed to reject pending reward request.');
    }
  },
);
