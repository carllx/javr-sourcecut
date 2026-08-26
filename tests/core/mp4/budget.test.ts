import { describe, it, expect } from "vitest";
import { TransferBudgetTracker } from "../../../src/core/mp4/budget.js";
import { BudgetExceededError } from "../../../src/core/mp4/types.js";

describe("TransferBudgetTracker", () => {
  it("initializes with valid budget multiplier and calculates maxBudgetBytes", () => {
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 10_000_000,
      budgetMultiplier: 1.5,
    });

    expect(tracker.estimatedBytes).toBe(10_000_000);
    expect(tracker.budgetMultiplier).toBe(1.5);
    expect(tracker.maxBudgetBytes).toBe(15_000_000);
    expect(tracker.remainingBudget).toBe(15_000_000);
  });

  it("defaults budgetMultiplier to 1.5 when omitted", () => {
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 20_000_000,
    });

    expect(tracker.budgetMultiplier).toBe(1.5);
    expect(tracker.maxBudgetBytes).toBe(30_000_000);
  });

  it("rejects invalid budget multiplier (< 1.0 or non-finite)", () => {
    expect(
      () => new TransferBudgetTracker({ estimatedBytes: 1000, budgetMultiplier: 0.9 })
    ).toThrow("Budget multiplier must be a finite number >= 1.0");

    expect(
      () => new TransferBudgetTracker({ estimatedBytes: 1000, budgetMultiplier: -1 })
    ).toThrow("Budget multiplier must be a finite number >= 1.0");

    expect(
      () => new TransferBudgetTracker({ estimatedBytes: 1000, budgetMultiplier: Infinity })
    ).toThrow("Budget multiplier must be a finite number >= 1.0");

    expect(
      () => new TransferBudgetTracker({ estimatedBytes: 1000, budgetMultiplier: NaN })
    ).toThrow("Budget multiplier must be a finite number >= 1.0");
  });

  it("passes prospective check when within budget and records transferred bytes", () => {
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 1000,
      budgetMultiplier: 1.5, // max 1500
    });

    expect(() => tracker.checkProspectiveBudget(500)).not.toThrow();
    tracker.recordBytes(500);
    expect(tracker.currentRunBytes).toBe(500);
    expect(tracker.remainingBudget).toBe(1000);

    expect(() => tracker.checkProspectiveBudget(1000)).not.toThrow();
    tracker.recordBytes(1000);
    expect(tracker.currentRunBytes).toBe(1500);
    expect(tracker.remainingBudget).toBe(0);
  });

  it("throws BudgetExceededError prospectively BEFORE issuing request that would breach budget", () => {
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 1000,
      budgetMultiplier: 1.5, // max 1500
    });

    tracker.recordBytes(1200);

    // Requesting 400 more bytes would make total 1600 > 1500
    expect(() => tracker.checkProspectiveBudget(400)).toThrow(BudgetExceededError);
    expect(() => tracker.checkProspectiveBudget(400)).toThrow(
      /prospective transfer 1600 bytes exceeds maximum allowed budget 1500 bytes/
    );

    // The recorded bytes should not have changed
    expect(tracker.currentRunBytes).toBe(1200);
  });

  it("accounts for historical failed attempt bytes across restarts", () => {
    // Previous run failed after consuming 600 bytes
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 1000,
      budgetMultiplier: 1.5, // max 1500
      historicalTransferredBytes: 600,
    });

    expect(tracker.historicalTransferredBytes).toBe(600);
    expect(tracker.totalActualBytes).toBe(600);
    expect(tracker.remainingBudget).toBe(900);

    // Prospective check for 900 bytes should pass (600 + 900 = 1500)
    expect(() => tracker.checkProspectiveBudget(900)).not.toThrow();

    // Prospective check for 901 bytes should throw BudgetExceededError
    expect(() => tracker.checkProspectiveBudget(901)).toThrow(BudgetExceededError);
  });


  it("enforces secondary defensive guard on recordBytes if stream exceeds budget", () => {
    const tracker = new TransferBudgetTracker({
      estimatedBytes: 1000,
      budgetMultiplier: 1.5,
    });

    tracker.recordBytes(1000);
    expect(() => tracker.recordBytes(600)).toThrow(BudgetExceededError);
  });

  it("proves repeated restarts cannot exceed the logical transfer budget", () => {
    const estimatedBytes = 1000;
    const multiplier = 1.5; // max 1500

    // Run 1: downloads 500 bytes then crashes
    let historicalBytes = 500;

    // Run 2: starts with 500 historical bytes, downloads 600 bytes then fails
    const run2Tracker = new TransferBudgetTracker({
      estimatedBytes,
      budgetMultiplier: multiplier,
      historicalTransferredBytes: historicalBytes,
    });
    expect(run2Tracker.remainingBudget).toBe(1000);
    expect(() => run2Tracker.checkProspectiveBudget(600)).not.toThrow();
    run2Tracker.recordBytes(600);
    historicalBytes += 600; // total 1100

    // Run 3: starts with 1100 historical bytes. Remaining budget is 400.
    const run3Tracker = new TransferBudgetTracker({
      estimatedBytes,
      budgetMultiplier: multiplier,
      historicalTransferredBytes: historicalBytes,
    });
    expect(run3Tracker.remainingBudget).toBe(400);

    // Requesting 500 bytes in Run 3 must fail prospectively
    expect(() => run3Tracker.checkProspectiveBudget(500)).toThrow(BudgetExceededError);
  });
});

