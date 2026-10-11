import config from "../config/index.js";
import log from "../core/logger.js";
import {
  getBounceRecoveryState,
  armBounceRecovery,
  activateBounceRecovery,
  updateBounceRecoveryPeak,
} from "../state/bounce.js";

// Bounce Recovery state machine (opsional per mode)
export function processBounceRecovery(pos, pairLabel) {
  const rulesForBounce = config.rulesFor(pos.mode);
  if (!rulesForBounce.enableBounceRecovery || pos.pnlPct == null) return;

  const brState = getBounceRecoveryState(pos.position);

  if (!brState) {
    if (pos.pnlPct <= rulesForBounce.bounceRecoveryTrigger) {
      armBounceRecovery(pos.position);
      log.info(
        `${pairLabel}: bounce recovery ARMED (PnL ${pos.pnlPct.toFixed(2)}% <= ${rulesForBounce.bounceRecoveryTrigger}%)`
      );
    }
  } else if (brState.state === "armed") {
    if (pos.pnlPct >= rulesForBounce.bounceRecoveryTarget) {
      activateBounceRecovery(pos.position, pos.pnlPct);
      log.info(
        `${pairLabel}: bounce recovery ACTIVE (PnL ${pos.pnlPct.toFixed(2)}% >= ${rulesForBounce.bounceRecoveryTarget}%, trailing ${rulesForBounce.bounceRecoveryTrailingPct}% from peak)`
      );
    } else {
      log.info(
        `${pairLabel}: bounce recovery armed | PnL ${pos.pnlPct.toFixed(2)}% | waiting for >= ${rulesForBounce.bounceRecoveryTarget}%`
      );
    }
  } else if (brState.state === "active") {
    updateBounceRecoveryPeak(pos.position, pos.pnlPct);
    const currentPeak = getBounceRecoveryState(pos.position)?.activePeak;
    const trigger = currentPeak != null ? currentPeak - rulesForBounce.bounceRecoveryTrailingPct : null;
    log.info(
      `${pairLabel}: bounce recovery active | peak ${currentPeak?.toFixed(2)}% | trigger ${trigger?.toFixed(2)}% | current ${pos.pnlPct.toFixed(2)}%`
    );
  }
}
