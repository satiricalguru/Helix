/**
 * Model resolution and deployment selection.
 */

import type { ModelGroup, ModelDeployment } from "@helix/config";

export interface DeploymentHealth {
  /** Consecutive failures; the deployment is skipped while above the threshold. */
  failures: number;
  /** Epoch ms until which the deployment is on cooldown. */
  cooldownUntil: number;
  lastLatencyMs?: number;
}

export interface RouterOptions {
  /** Consecutive failures before a deployment is taken out of rotation. */
  cooldownThreshold?: number;
  /** Cooldown duration in ms. */
  cooldownDurationMs?: number;
  now?: () => number;
}

export class ModelRouter {
  #groups: ModelGroup[];
  #health = new Map<string, DeploymentHealth>();
  #opts: Required<RouterOptions>;

  constructor(groups: ModelGroup[], opts: RouterOptions = {}) {
    this.#groups = groups;
    this.#opts = {
      cooldownThreshold: opts.cooldownThreshold ?? 3,
      cooldownDurationMs: opts.cooldownDurationMs ?? 30_000,
      now: opts.now ?? (() => Date.now()),
    };
  }

  get groups(): ModelGroup[] {
    return this.#groups;
  }

  find(advertisedId: string): ModelGroup | undefined {
    return this.#groups.find((g) => g.advertisedId === advertisedId);
  }

  /**
   * Choose a deployment for a model group.
   *
   * Healthy deployments are ordered by priority, then picked with a weight
   * proportional to their declared capacity. Returns undefined when every
   * deployment is on cooldown.
   */
  select(group: ModelGroup): ModelDeployment | undefined {
    const now = this.#opts.now();
    const healthy = group.deployments.filter((d) => {
      const health = this.#health.get(d.id);
      return !health || health.cooldownUntil <= now;
    });
    if (healthy.length === 0) return undefined;

    const bestPriority = Math.min(...healthy.map((d) => d.priority));
    const tier = healthy.filter((d) => d.priority === bestPriority);

    const totalWeight = tier.reduce((sum, d) => sum + Math.max(1, d.weight), 0);
    let pick = (this.#opts.now() % 1) * totalWeight;
    for (const d of tier) {
      pick -= Math.max(1, d.weight);
      if (pick <= 0) return d;
    }
    return tier[tier.length - 1];
  }

  /** Record a successful call. */
  recordSuccess(deploymentId: string): void {
    const health = this.#health.get(deploymentId) ?? { failures: 0, cooldownUntil: 0 };
    health.failures = 0;
    health.cooldownUntil = 0;
    this.#health.set(deploymentId, health);
  }

  /** Record a failure; repeated failures take the deployment out of rotation. */
  recordFailure(deploymentId: string): void {
    const health = this.#health.get(deploymentId) ?? { failures: 0, cooldownUntil: 0 };
    health.failures += 1;
    if (health.failures >= this.#opts.cooldownThreshold) {
      health.cooldownUntil = this.#opts.now() + this.#opts.cooldownDurationMs;
    }
    this.#health.set(deploymentId, health);
  }

  /** Current health for a deployment (for diagnostics). */
  health(deploymentId: string): DeploymentHealth | undefined {
    return this.#health.get(deploymentId);
  }
}
