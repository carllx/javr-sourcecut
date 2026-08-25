import { BudgetExceededError } from "./types.js";

export interface TransferBudgetTrackerOptions {
  estimatedBytes: number;
  budgetMultiplier?: number;
  historicalFailedBytes?: number;
}

export class TransferBudgetTracker {
  readonly estimatedBytes: number;
  readonly budgetMultiplier: number;
  readonly maxBudgetBytes: number;
  readonly historicalFailedBytes: number;
  private _currentRunBytes: number = 0;

  constructor(options: TransferBudgetTrackerOptions) {
    const { estimatedBytes, budgetMultiplier = 1.5, historicalFailedBytes = 0 } = options;

    if (
      typeof budgetMultiplier !== "number" ||
      !Number.isFinite(budgetMultiplier) ||
      budgetMultiplier < 1.0
    ) {
      throw new Error("Budget multiplier must be a finite number >= 1.0");
    }

    if (
      typeof estimatedBytes !== "number" ||
      !Number.isFinite(estimatedBytes) ||
      estimatedBytes < 0
    ) {
      throw new Error("Estimated bytes must be a non-negative finite number");
    }

    this.estimatedBytes = estimatedBytes;
    this.budgetMultiplier = budgetMultiplier;
    this.maxBudgetBytes = Math.ceil(estimatedBytes * budgetMultiplier);
    this.historicalFailedBytes = Math.max(0, historicalFailedBytes);
  }

  get currentRunBytes(): number {
    return this._currentRunBytes;
  }

  get totalActualBytes(): number {
    return this.historicalFailedBytes + this._currentRunBytes;
  }

  get remainingBudget(): number {
    return Math.max(0, this.maxBudgetBytes - this.totalActualBytes);
  }

  /**
   * Prospective budget check before making a network request.
   * Throws BudgetExceededError immediately if prospective transfer would breach budget.
   */
  checkProspectiveBudget(requestedBytes: number): void {
    const prospective = this.totalActualBytes + requestedBytes;
    if (prospective > this.maxBudgetBytes) {
      throw new BudgetExceededError(
        `Budget exceeded: prospective transfer ${prospective} bytes exceeds maximum allowed budget ${this.maxBudgetBytes} bytes (estimated: ${this.estimatedBytes}, multiplier: ${this.budgetMultiplier})`
      );
    }
  }

  /**
   * Secondary defensive guard to record actual transferred bytes.
   * Throws BudgetExceededError if cumulative transferred bytes exceeds budget.
   */
  recordBytes(bytes: number): void {
    if (bytes <= 0) return;
    this._currentRunBytes += bytes;
    if (this.totalActualBytes > this.maxBudgetBytes) {
      throw new BudgetExceededError(
        `Budget exceeded: total actual transfer ${this.totalActualBytes} bytes exceeds maximum allowed budget ${this.maxBudgetBytes} bytes (estimated: ${this.estimatedBytes}, multiplier: ${this.budgetMultiplier})`
      );
    }
  }
}
