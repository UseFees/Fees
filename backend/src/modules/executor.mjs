// Module executor interface + registry.
//
// A "module" is what a coin's 90% is FOR. The 90/10 split itself is enforced on
// chain by the sharing_config — the module_dest receives its 90% directly when
// the epoch worker cranks distribute_creator_fees_v2. A module executor is the
// off-chain hook that runs AFTER a distribution settles: it reacts to the
// lamports that just landed in its module_dest (drive a game, fund a treasury,
// stake, etc.). The 10% FEES side is handled by the buyback module.
//
// Contract: an executor is pure orchestration. It NEVER changes the split,
// never signs launches, and must be idempotent per (coin, epochIndex) because
// the worker may retry.

/**
 * @typedef {Object} DistributionContext
 * @property {object} coin        the coins row
 * @property {number} epochIndex
 * @property {bigint} moduleLamports   90% that landed in module_dest this epoch
 * @property {bigint} buybackLamports  10% that landed in buyback_dest this epoch
 * @property {string} signature   the distribute_creator_fees_v2 signature
 */

const registry = new Map();

export function registerModule(kind, executor) {
  registry.set(kind, executor);
}

export function getExecutor(kind) {
  return registry.get(kind) ?? registry.get('passthrough');
}

// Default executor: the 90% simply rests in module_dest. Nothing to do. This is
// the safe alpha default and the reference implementation of the interface.
registerModule('passthrough', {
  kind: 'passthrough',
  async onDistribution(/** @type {DistributionContext} */ ctx) {
    return { kind: 'passthrough', note: 'module_dest holds its 90%; no post-distribution action', epochIndex: ctx.epochIndex };
  },
});
