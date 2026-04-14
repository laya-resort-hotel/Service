import type { Timestamp } from 'firebase-admin/firestore';

export const HOTEL_TIMEZONE = 'Asia/Bangkok';

export type UserRole =
  | 'guest'
  | 'fo_npc'
  | 'guest_relations_npc'
  | 'dining_npc'
  | 'bartender_npc'
  | 'recreation_npc'
  | 'spa_npc'
  | 'mod_npc'
  | 'gm_npc'
  | 'admin';

export type RewardType = 'bronze' | 'silver' | 'gold';

export type MissionCategory =
  | 'starter'
  | 'dining'
  | 'activity'
  | 'hidden'
  | 'boss'
  | 'wellness'
  | 'family'
  | 'drink';

export type MissionLimitType =
  | 'once_per_stay'
  | 'once_per_day'
  | 'once_per_mission'
  | 'repeatable';

export type ScanEventStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'duplicate'
  | 'expired'
  | 'invalid_role';

export type TokenStatus = 'unused' | 'used' | 'expired' | 'cancelled';
export type RedemptionRequestStatus = 'pending' | 'approved' | 'rejected' | 'fulfilled' | 'cancelled';
export type RedemptionStatus = 'approved' | 'fulfilled' | 'reversed' | 'cancelled';

export interface AppUserDoc {
  displayName: string;
  role: UserRole;
  department: string | null;
  active: boolean;
  language: 'en' | 'th' | 'zh' | 'ru';
  photoURL: string | null;
  phone: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt: Timestamp | null;
}

export interface GuestProfileDoc {
  guestUid: string;
  fullName: string;
  roomNo: string;
  stayId: string;
  checkInDate: Timestamp;
  checkOutDate: Timestamp;
  partySize: number;
  nationality: string | null;
  languagePreference: 'en' | 'th' | 'zh' | 'ru';
  currentLocationId: string | null;
  mapVisible: boolean;
  registrationSource: string;
  welcomeDrinkClaimed: boolean;
  tutorialCompleted: boolean;
  status: 'active' | 'checked_out' | 'inactive';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface GuestWalletDoc {
  guestUid: string;
  bronze: number;
  silver: number;
  gold: number;
  totalEarnedBronze: number;
  totalEarnedSilver: number;
  totalEarnedGold: number;
  totalSpentBronze: number;
  totalSpentSilver: number;
  totalSpentGold: number;
  level: number;
  xp: number;
  updatedAt: Timestamp;
  lastRewardAt: Timestamp | null;
}

export interface MissionDoc {
  title: string;
  titleTh: string | null;
  description: string;
  descriptionTh: string | null;
  missionGroupId: string | null;
  questType: string;
  category: MissionCategory;
  rewardType: RewardType;
  rewardAmount: number;
  requiresToken: boolean;
  requiresLocation: boolean;
  locationId: string | null;
  allowedScannerRoles: UserRole[];
  limitType: MissionLimitType;
  dailyLimit: number;
  sortOrder: number;
  isHidden: boolean;
  isActive: boolean;
  startAt: Timestamp | null;
  endAt: Timestamp | null;
  icon: string | null;
  bannerImage: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface GuestMissionDoc {
  guestUid: string;
  missionId: string;
  stayId: string;
  status: 'not_started' | 'available' | 'in_progress' | 'completed' | 'claimed' | 'expired';
  progress: number;
  progressTarget: number;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  claimedAt: Timestamp | null;
  lastScannedAt: Timestamp | null;
  lastScannedBy: string | null;
  claimCount: number;
  dayKeyLastClaimed: string | null;
  notes: string | null;
  updatedAt: Timestamp;
}

export interface ScanDeviceInfo {
  platform: 'ios' | 'android' | 'web';
  browser: string | null;
}

export interface ScanEventDoc {
  guestUid: string;
  guestRoomNo: string | null;
  stayId: string;
  missionId: string;
  questType: string;
  tokenId: string | null;
  locationId: string | null;
  scannedBy: string;
  staffRole: UserRole;
  staffDepartment: string | null;
  status: ScanEventStatus;
  rejectionReason: string | null;
  source: string;
  deviceInfo: ScanDeviceInfo | null;
  createdAt: Timestamp;
  processedAt: Timestamp | null;
}

export interface QuestClaimDoc {
  guestUid: string;
  stayId: string;
  missionId: string;
  questType: string;
  rewardType: RewardType;
  rewardAmount: number;
  approvedBy: string;
  approvedByRole: UserRole;
  tokenId: string | null;
  scanEventId: string;
  claimDateKey: string;
  status: 'approved' | 'reversed';
  createdAt: Timestamp;
  reversedAt: Timestamp | null;
  reversalReason: string | null;
}

export interface RewardTokenDoc {
  guestUid: string;
  stayId: string;
  tokenType: 'welcome_drink' | 'special_drink' | 'reward_pickup';
  relatedMissionId: string | null;
  dailyDrinkId: string | null;
  relatedRedemptionId?: string | null;
  relatedRequestId?: string | null;
  rewardId?: string | null;
  qrCodeValue: string;
  status: TokenStatus;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  usedAt: Timestamp | null;
  usedBy: string | null;
  usedByRole: UserRole | null;
}

export interface DailyFeaturedDrinkDoc {
  dateKey: string;
  title: string;
  titleTh: string | null;
  image: string | null;
  missionId: string;
  rewardType: RewardType;
  rewardAmount: number;
  isActive: boolean;
  createdAt: Timestamp;
}

export interface StaffNpcProfileDoc {
  staffUid: string;
  npcName: string;
  npcTitle: string | null;
  department: string;
  npcTier: number;
  avatarImage: string | null;
  bio: string | null;
  allowedQuestTypes: string[];
  canIssueBronze: boolean;
  canIssueSilver: boolean;
  canIssueGold: boolean;
  shiftStatus: 'on_duty' | 'off_duty';
  isVisibleOnMap: boolean;
  active: boolean;
  updatedAt: Timestamp;
}

export interface RewardDoc {
  title: string;
  titleTh: string | null;
  description: string | null;
  image: string | null;
  costBronze: number;
  costSilver: number;
  costGold: number;
  stock: number;
  stockType: 'limited' | 'unlimited';
  category: 'drink' | 'souvenir' | 'activity' | 'spa' | 'dining';
  isActive: boolean;
  redeemMode: 'staff_verify' | 'token_issue' | 'manual_pickup';
  availableFrom: Timestamp | null;
  availableTo: Timestamp | null;
  sortOrder: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RedemptionRequestDoc {
  guestUid: string;
  stayId: string;
  rewardId: string;
  costBronze: number;
  costSilver: number;
  costGold: number;
  status: RedemptionRequestStatus;
  requestedAt: Timestamp;
  processedAt: Timestamp | null;
  processedBy: string | null;
  approvedRedemptionId?: string | null;
  rejectionReason?: string | null;
  notes: string | null;
}

export interface RedemptionDoc {
  guestUid: string;
  stayId: string;
  rewardId: string;
  requestId: string | null;
  fulfilledBy: string | null;
  costBronze: number;
  costSilver: number;
  costGold: number;
  status: RedemptionStatus;
  fulfilledAt: Timestamp | null;
  fulfillmentNotes?: string | null;
  createdAt: Timestamp;
  updatedAt?: Timestamp | null;
}

export interface GameRulesDoc {
  maxDailyBronzeFromRepeatable?: number;
  gmQuestEnabled?: boolean;
  welcomeDrinkEnabled?: boolean;
  defaultWelcomeDrinkExpiresHours?: number;
  defaultRewardPickupExpiresHours?: number;
  allowGuestMapTracking?: boolean;
  updatedAt?: Timestamp;
}

export interface RegisterGuestProfileRequest {
  fullName: string;
  roomNo: string;
  stayId?: string;
  partySize?: number;
  nationality?: string | null;
  languagePreference?: 'en' | 'th' | 'zh' | 'ru';
  phone?: string | null;
  registrationSource?: string;
  checkInDateIso?: string;
  checkOutDateIso?: string;
}

export interface RegisterGuestProfileResponse {
  ok: boolean;
  guestUid: string;
  stayId: string;
  roomNo: string;
  fullName: string;
  languagePreference: 'en' | 'th' | 'zh' | 'ru';
  isNewProfile: boolean;
}

export interface CreateWelcomeDrinkTokenRequest {
  guestUid?: string;
  stayId: string;
  forceReissue?: boolean;
}

export interface CreateWelcomeDrinkTokenResponse {
  ok: boolean;
  tokenId: string;
  qrCodeValue: string;
  expiresAt: string;
  missionId: string;
  drinkTitle: string;
  drinkTitleTh: string | null;
  reused: boolean;
}

export interface CreateRewardPickupTokenRequest {
  redemptionId: string;
  forceReissue?: boolean;
}

export interface CreateRewardPickupTokenResponse {
  ok: boolean;
  tokenId: string;
  qrCodeValue: string;
  expiresAt: string;
  redemptionId: string;
  rewardId: string;
  requestId: string | null;
  guestUid: string;
  reused: boolean;
}


export interface ApprovePendingRewardRequestRequest {
  requestId: string;
  forceReissue?: boolean;
  notes?: string;
}

export interface ApprovePendingRewardRequestResponse {
  ok: boolean;
  requestId: string;
  redemptionId: string;
  guestUid: string;
  rewardId: string;
  status: 'approved';
  tokenId: string;
  qrCodeValue: string;
  expiresAt: string;
  alreadyApproved: boolean;
  reusedToken: boolean;
}

export interface RejectPendingRewardRequestRequest {
  requestId: string;
  reason?: string;
  notes?: string;
}

export interface RejectPendingRewardRequestResponse {
  ok: boolean;
  requestId: string;
  guestUid: string;
  rewardId: string;
  status: 'rejected';
  alreadyRejected: boolean;
}

export interface FulfillRedemptionRequest {
  scannedCode?: string;
  redemptionId?: string;
  notes?: string;
}

export interface FulfillRedemptionResponse {
  ok: boolean;
  redemptionId: string;
  guestUid: string;
  rewardId: string;
  requestId: string | null;
  status: RedemptionStatus | 'fulfilled';
  fulfilledAt: string;
  alreadyFulfilled: boolean;
  tokenId?: string | null;
}

export interface CancelRewardRedemptionRequest {
  requestId?: string;
  redemptionId?: string;
  reason?: string;
}

export interface CancelRewardRedemptionResponse {
  ok: boolean;
  requestId: string | null;
  redemptionId: string | null;
  status: 'cancelled';
  refunded: boolean;
  stockReturned: boolean;
  alreadyCancelled: boolean;
}
