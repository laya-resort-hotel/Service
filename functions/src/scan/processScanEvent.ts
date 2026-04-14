import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as logger from 'firebase-functions/logger';
import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  Timestamp,
  getFirestore,
} from 'firebase-admin/firestore';

import {
  HOTEL_TIMEZONE,
  type AppUserDoc,
  type GameRulesDoc,
  type GuestProfileDoc,
  type GuestWalletDoc,
  type MissionDoc,
  type QuestClaimDoc,
  type RewardTokenDoc,
  type ScanEventDoc,
  type StaffNpcProfileDoc,
  type UserRole,
} from '../../../shared/types';

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const REGION = 'asia-southeast1';

type RejectionStatus =
  | 'rejected'
  | 'duplicate'
  | 'expired'
  | 'invalid_role';

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

function buildClaimId(params: {
  limitType: MissionDoc['limitType'];
  stayId: string;
  missionId: string;
  guestUid: string;
  dayKey: string;
  scanEventId: string;
}): string {
  const { limitType, stayId, missionId, guestUid, dayKey, scanEventId } = params;

  switch (limitType) {
    case 'once_per_stay':
      return `claim_${stayId}_${missionId}`;
    case 'once_per_day':
      return `claim_${stayId}_${missionId}_${dayKey}`;
    case 'once_per_mission':
      return `claim_${guestUid}_${missionId}`;
    case 'repeatable':
    default:
      return `claim_${scanEventId}`;
  }
}

function isMissionActive(mission: MissionDoc, now: Timestamp): boolean {
  if (!mission.isActive) return false;

  if (mission.startAt && now.toMillis() < mission.startAt.toMillis()) {
    return false;
  }

  if (mission.endAt && now.toMillis() > mission.endAt.toMillis()) {
    return false;
  }

  return true;
}

function rewardTierAllowed(
  staffNpc: StaffNpcProfileDoc,
  rewardType: MissionDoc['rewardType'],
): boolean {
  if (rewardType === 'bronze') return staffNpc.canIssueBronze;
  if (rewardType === 'silver') return staffNpc.canIssueSilver;
  return staffNpc.canIssueGold;
}

function rejectScan(
  tx: FirebaseFirestore.Transaction,
  scanRef: FirebaseFirestore.DocumentReference,
  status: RejectionStatus,
  rejectionReason: string,
): void {
  tx.update(scanRef, {
    status,
    rejectionReason,
    processedAt: FieldValue.serverTimestamp(),
  });
}

export const processScanEvent = onDocumentCreated(
  {
    document: 'scan_events/{scanEventId}',
    region: REGION,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (event) => {
    const snapshot = event.data;
    const scanEventId = event.params.scanEventId;

    if (!snapshot) {
      logger.warn('processScanEvent fired without snapshot', { scanEventId });
      return;
    }

    const initialScan = snapshot.data() as ScanEventDoc | undefined;
    if (!initialScan) {
      logger.warn('processScanEvent received empty scan data', { scanEventId });
      return;
    }

    if (initialScan.status !== 'pending') {
      logger.info('Scan event already processed before trigger execution', {
        scanEventId,
        status: initialScan.status,
      });
      return;
    }

    const scanRef = db.collection('scan_events').doc(scanEventId);
    const missionRef = db.collection('missions').doc(initialScan.missionId);
    const guestRef = db.collection('users').doc(initialScan.guestUid);
    const guestProfileRef = db.collection('guest_profiles').doc(initialScan.guestUid);
    const walletRef = db.collection('guest_wallets').doc(initialScan.guestUid);
    const staffRef = db.collection('users').doc(initialScan.scannedBy);
    const staffNpcRef = db.collection('staff_npc_profiles').doc(initialScan.scannedBy);
    const gameRulesRef = db.collection('system_config').doc('game_rules');
    const tokenRef = initialScan.tokenId
      ? db.collection('reward_tokens').doc(initialScan.tokenId)
      : null;

    try {
      await db.runTransaction(async (tx) => {
        const [
          freshScanSnap,
          missionSnap,
          guestSnap,
          guestProfileSnap,
          walletSnap,
          staffSnap,
          staffNpcSnap,
          gameRulesSnap,
        ] = await Promise.all([
          tx.get(scanRef),
          tx.get(missionRef),
          tx.get(guestRef),
          tx.get(guestProfileRef),
          tx.get(walletRef),
          tx.get(staffRef),
          tx.get(staffNpcRef),
          tx.get(gameRulesRef),
        ]);

        if (!freshScanSnap.exists) {
          logger.warn('Scan event document disappeared during processing', { scanEventId });
          return;
        }

        const freshScan = freshScanSnap.data() as ScanEventDoc;
        if (freshScan.status !== 'pending') {
          logger.info('Scan event is no longer pending, skipping duplicate trigger', {
            scanEventId,
            status: freshScan.status,
          });
          return;
        }

        if (!missionSnap.exists) {
          rejectScan(tx, scanRef, 'rejected', 'mission_not_found');
          return;
        }
        if (!guestSnap.exists || !guestProfileSnap.exists || !walletSnap.exists) {
          rejectScan(tx, scanRef, 'rejected', 'guest_not_ready');
          return;
        }
        if (!staffSnap.exists || !staffNpcSnap.exists) {
          rejectScan(tx, scanRef, 'invalid_role', 'staff_profile_not_ready');
          return;
        }

        const mission = missionSnap.data() as MissionDoc;
        const guest = guestSnap.data() as AppUserDoc;
        const guestProfile = guestProfileSnap.data() as GuestProfileDoc;
        const wallet = walletSnap.data() as GuestWalletDoc;
        const staff = staffSnap.data() as AppUserDoc;
        const staffNpc = staffNpcSnap.data() as StaffNpcProfileDoc;
        const gameRules = gameRulesSnap.exists
          ? (gameRulesSnap.data() as GameRulesDoc)
          : {};
        const now = Timestamp.now();
        const dayKey = getHotelDateKey(new Date(), HOTEL_TIMEZONE);

        void wallet;
        void gameRules;

        if (!guest.active || guest.role !== 'guest' || guestProfile.status !== 'active') {
          rejectScan(tx, scanRef, 'rejected', 'guest_not_active');
          return;
        }

        if (!staff.active || !staffNpc.active || staffNpc.shiftStatus !== 'on_duty') {
          rejectScan(tx, scanRef, 'invalid_role', 'staff_not_on_duty');
          return;
        }

        if (staff.role !== freshScan.staffRole) {
          rejectScan(tx, scanRef, 'invalid_role', 'staff_role_mismatch');
          return;
        }

        if (!mission.allowedScannerRoles.includes(staff.role)) {
          rejectScan(tx, scanRef, 'invalid_role', 'role_not_allowed_for_mission');
          return;
        }

        if (!staffNpc.allowedQuestTypes.includes(mission.questType)) {
          rejectScan(tx, scanRef, 'invalid_role', 'quest_type_not_allowed_for_staff');
          return;
        }

        if (!rewardTierAllowed(staffNpc, mission.rewardType)) {
          rejectScan(tx, scanRef, 'invalid_role', 'reward_tier_not_allowed_for_staff');
          return;
        }

        if (!isMissionActive(mission, now)) {
          rejectScan(tx, scanRef, 'rejected', 'mission_inactive');
          return;
        }

        if (mission.questType !== freshScan.questType) {
          rejectScan(tx, scanRef, 'rejected', 'quest_type_mismatch');
          return;
        }

        if (guestProfile.stayId !== freshScan.stayId) {
          rejectScan(tx, scanRef, 'rejected', 'stay_mismatch');
          return;
        }

        if (mission.requiresLocation) {
          if (!freshScan.locationId) {
            rejectScan(tx, scanRef, 'rejected', 'location_required');
            return;
          }
          if (mission.locationId && mission.locationId !== freshScan.locationId) {
            rejectScan(tx, scanRef, 'rejected', 'location_mismatch');
            return;
          }
        }

        if (mission.questType === 'find_gm' && gameRules.gmQuestEnabled === false) {
          rejectScan(tx, scanRef, 'rejected', 'gm_quest_disabled');
          return;
        }

        let token: RewardTokenDoc | null = null;
        if (mission.requiresToken) {
          if (!tokenRef) {
            rejectScan(tx, scanRef, 'rejected', 'token_required');
            return;
          }

          const tokenSnap = await tx.get(tokenRef);
          if (!tokenSnap.exists) {
            rejectScan(tx, scanRef, 'rejected', 'token_not_found');
            return;
          }

          token = tokenSnap.data() as RewardTokenDoc;

          if (token.guestUid !== freshScan.guestUid || token.stayId !== freshScan.stayId) {
            rejectScan(tx, scanRef, 'rejected', 'token_guest_mismatch');
            return;
          }

          if (token.status !== 'unused') {
            rejectScan(tx, scanRef, 'duplicate', 'token_already_used');
            return;
          }

          if (token.expiresAt.toMillis() < now.toMillis()) {
            tx.update(tokenRef, {
              status: 'expired',
            });
            rejectScan(tx, scanRef, 'expired', 'token_expired');
            return;
          }
        }

        const claimId = buildClaimId({
          limitType: mission.limitType,
          stayId: freshScan.stayId,
          missionId: freshScan.missionId,
          guestUid: freshScan.guestUid,
          dayKey,
          scanEventId,
        });
        const claimRef = db.collection('quest_claims').doc(claimId);
        const guestMissionRef = db
          .collection('guest_missions')
          .doc(`${freshScan.guestUid}_${freshScan.missionId}`);

        const [claimSnap, guestMissionSnap] = await Promise.all([
          tx.get(claimRef),
          tx.get(guestMissionRef),
        ]);

        if (claimSnap.exists) {
          rejectScan(tx, scanRef, 'duplicate', 'claim_already_exists');
          return;
        }

        const existingGuestMission = guestMissionSnap.exists
          ? (guestMissionSnap.data() as GuestMissionDoc)
          : null;

        if (
          mission.limitType === 'once_per_day' &&
          existingGuestMission?.dayKeyLastClaimed === dayKey
        ) {
          rejectScan(tx, scanRef, 'duplicate', 'daily_claim_limit_reached');
          return;
        }

        if (
          mission.limitType === 'once_per_stay' &&
          existingGuestMission?.claimCount &&
          existingGuestMission.claimCount > 0
        ) {
          rejectScan(tx, scanRef, 'duplicate', 'stay_claim_limit_reached');
          return;
        }

        if (
          mission.limitType === 'once_per_mission' &&
          existingGuestMission?.claimCount &&
          existingGuestMission.claimCount > 0
        ) {
          rejectScan(tx, scanRef, 'duplicate', 'mission_claim_limit_reached');
          return;
        }

        const rewardAmount = Number(mission.rewardAmount ?? 0);
        if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
          rejectScan(tx, scanRef, 'rejected', 'invalid_reward_amount');
          return;
        }

        const walletUpdate: Record<string, unknown> = {
          updatedAt: FieldValue.serverTimestamp(),
          lastRewardAt: FieldValue.serverTimestamp(),
          xp: FieldValue.increment(rewardAmount),
        };

        if (mission.rewardType === 'bronze') {
          walletUpdate.bronze = FieldValue.increment(rewardAmount);
          walletUpdate.totalEarnedBronze = FieldValue.increment(rewardAmount);
        } else if (mission.rewardType === 'silver') {
          walletUpdate.silver = FieldValue.increment(rewardAmount);
          walletUpdate.totalEarnedSilver = FieldValue.increment(rewardAmount);
        } else {
          walletUpdate.gold = FieldValue.increment(rewardAmount);
          walletUpdate.totalEarnedGold = FieldValue.increment(rewardAmount);
        }

        const claimDoc: QuestClaimDoc = {
          guestUid: freshScan.guestUid,
          stayId: freshScan.stayId,
          missionId: freshScan.missionId,
          questType: freshScan.questType,
          rewardType: mission.rewardType,
          rewardAmount,
          approvedBy: freshScan.scannedBy,
          approvedByRole: freshScan.staffRole as UserRole,
          tokenId: freshScan.tokenId,
          scanEventId,
          claimDateKey: dayKey,
          status: 'approved',
          createdAt: now,
          reversedAt: null,
          reversalReason: null,
        };

        tx.set(claimRef, claimDoc);

        tx.set(
          guestMissionRef,
          {
            guestUid: freshScan.guestUid,
            missionId: freshScan.missionId,
            stayId: freshScan.stayId,
            status: 'claimed',
            progress: 1,
            progressTarget: 1,
            completedAt: FieldValue.serverTimestamp(),
            claimedAt: FieldValue.serverTimestamp(),
            lastScannedAt: FieldValue.serverTimestamp(),
            lastScannedBy: freshScan.scannedBy,
            claimCount: FieldValue.increment(1),
            dayKeyLastClaimed: dayKey,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        tx.set(walletRef, walletUpdate, { merge: true });

        if (tokenRef && token) {
          tx.update(tokenRef, {
            status: 'used',
            usedAt: FieldValue.serverTimestamp(),
            usedBy: freshScan.scannedBy,
            usedByRole: freshScan.staffRole,
          });
        }

        if (freshScan.questType === 'welcome_drink') {
          tx.set(
            guestProfileRef,
            {
              welcomeDrinkClaimed: true,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }

        tx.update(scanRef, {
          status: 'approved',
          rejectionReason: null,
          processedAt: FieldValue.serverTimestamp(),
        });

        const logRef = db.collection('activity_logs').doc();
        tx.set(logRef, {
          actorUid: freshScan.scannedBy,
          actorRole: freshScan.staffRole,
          targetUid: freshScan.guestUid,
          actionType: 'approve_claim',
          entityType: 'mission',
          entityId: freshScan.missionId,
          meta: {
            rewardType: mission.rewardType,
            rewardAmount,
            scanEventId,
          },
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      logger.info('Scan event processed successfully', {
        scanEventId,
        missionId: initialScan.missionId,
        guestUid: initialScan.guestUid,
      });
    } catch (error) {
      logger.error('processScanEvent failed', {
        scanEventId,
        error,
      });

      try {
        await scanRef.set(
          {
            status: 'rejected',
            rejectionReason: 'internal_error',
            processedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      } catch (updateError) {
        logger.error('Failed to mark scan event as internal_error', {
          scanEventId,
          updateError,
        });
      }
    }
  },
);
