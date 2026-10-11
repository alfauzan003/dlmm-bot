let _sdk = null;

export async function getDlmmSdk() {
  if (!_sdk) {
    const mod = await import("@meteora-ag/dlmm");
    _sdk = { DLMM: mod.default, StrategyType: mod.StrategyType };
  }
  return _sdk;
}
