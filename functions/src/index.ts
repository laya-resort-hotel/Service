import { getApps, initializeApp } from 'firebase-admin/app';
import { setGlobalOptions } from 'firebase-functions/v2';

if (!getApps().length) {
  initializeApp();
}

setGlobalOptions({
  region: 'asia-southeast1',
  maxInstances: 20,
});

export { processScanEvent } from './scan/processScanEvent';
export { createWelcomeDrinkToken } from './tokens/createWelcomeDrinkToken';
export { createRewardPickupToken } from './tokens/createRewardPickupToken';
export { registerGuestProfile } from './guests/registerGuestProfile';
export { processRedemptionRequest } from './redemptions/processRedemptionRequest';
export { fulfillRedemption } from './redemptions/fulfillRedemption';
export { cancelRewardRedemption } from './redemptions/cancelRewardRedemption';
export { approvePendingRewardRequest } from './redemptions/approvePendingRewardRequest';
export { expireRewardPickupTokens } from './schedulers/expireRewardPickupTokens';

export { rejectPendingRewardRequest } from './redemptions/rejectPendingRewardRequest';
