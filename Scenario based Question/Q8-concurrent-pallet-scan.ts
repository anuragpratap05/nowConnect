// Q8 — Concurrent Pallet Scan: idempotent handler
//
// Reference implementation. The core dedup is extracted into a pure, testable
// function (`claimPallet`) so the idempotency logic can be asserted without
// standing up an HTTP server. The Express wiring and the DynamoDB production
// version follow.

// ---------------------------------------------------------------------------
// Core: atomic "claim" against a mock store.
// ---------------------------------------------------------------------------

type ClaimResult = { duplicate: boolean };

/**
 * Claim a pallet exactly once.
 *
 * has() + add() run with NO `await` between them, so in a single Node process
 * they are one uninterruptible step — the critical section. The moment you put
 * an `await` between the check and the write, you open a window for a duplicate
 * (two requests both pass has() before either add()s). So: claim synchronously
 * first, do slow work after.
 */
function claimPallet(store: Set<string>, palletId: string): ClaimResult {
  if (store.has(palletId)) {
    return { duplicate: true }; // already scanned — idempotent no-op
  }
  store.add(palletId);
  return { duplicate: false };
}

// ---------------------------------------------------------------------------
// Express handler (the local / single-instance answer to Task 1).
// ---------------------------------------------------------------------------
//
// import express, { Request, Response } from 'express';
//
// const app = express();
// app.use(express.json());
// const scannedPallets = new Set<string>(); // Mock DB
//
// app.post('/api/scan-pallet', async (req: Request, res: Response) => {
//   const { palletId, associateId, timestamp } = req.body ?? {};
//
//   // 1) Validate — never trust the body.
//   if (typeof palletId !== 'string' || typeof associateId !== 'string') {
//     return res
//       .status(400)
//       .json({ success: false, error: 'palletId and associateId are required strings' });
//   }
//
//   // 2) Atomic claim (synchronous critical section — no await inside).
//   const { duplicate } = claimPallet(scannedPallets, palletId);
//   if (duplicate) {
//     // 200, not 500: a retry / second associate gets a clean, repeatable answer.
//     return res.status(200).json({ success: true, palletId, duplicate: true });
//   }
//
//   // 3) Slow work happens AFTER the claim (persist, emit event, etc.).
//   console.log(`Pallet ${palletId} scanned by ${associateId} at ${timestamp ?? Date.now()}`);
//
//   return res.status(201).json({ success: true, palletId, duplicate: false });
// });
//
// app.listen(3001, () => console.log('Facilities API running on 3001'));

// ---------------------------------------------------------------------------
// The DANGEROUS version to contrast against (DO NOT ship this):
// ---------------------------------------------------------------------------
//
//   if (!scannedPallets.has(palletId)) {
//     await persistToDb(palletId);   // <-- await here = race window
//     scannedPallets.add(palletId);  //     two requests can both reach here
//   }
//
// The `await` between check and write lets a second concurrent request pass the
// has() check before the first one adds -> duplicate record.

// ---------------------------------------------------------------------------
// Production (distributed) answer — DynamoDB conditional write.
// ---------------------------------------------------------------------------
//
// The in-memory Set is per-instance: run 3 containers behind a load balancer and
// each has its OWN Set, so the same pallet scanned on two instances dedupes on
// neither. You need ONE shared, atomic source of truth. DynamoDB gives it with a
// conditional write — no separate lock required, because the conditional PutItem
// IS the atomic compare-and-set:
//
//   import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
//   const ddb = new DynamoDBClient({});
//
//   try {
//     await ddb.send(new PutItemCommand({
//       TableName: 'PalletScans',
//       Item: {
//         palletId:    { S: palletId },     // partition key
//         associateId: { S: associateId },
//         scannedAt:   { N: String(timestamp ?? Date.now()) },
//       },
//       // Only write if no item with this palletId exists. First writer wins;
//       // every concurrent duplicate fails this condition atomically.
//       ConditionExpression: 'attribute_not_exists(palletId)',
//     }));
//     return res.status(201).json({ success: true, palletId, duplicate: false });
//   } catch (err: any) {
//     if (err.name === 'ConditionalCheckFailedException') {
//       // Someone already claimed it. Idempotent success.
//       return res.status(200).json({ success: true, palletId, duplicate: true });
//     }
//     throw err; // real error -> 5xx
//   }
//
// Why this is the right primitive:
//   - ONE atomic operation (no read-then-write), so there is no TOCTOU window.
//   - Correct across ANY number of instances — the atomicity lives in the DB.
//   - No distributed lock to acquire/release/expire; the write condition is the lock.

export { claimPallet };

// ---------------------------------------------------------------------------
// Inline logic tests (run the JS equivalent to verify; see the .md).
// ---------------------------------------------------------------------------
if (require.main === module) {
  const store = new Set<string>();
  const a = claimPallet(store, 'PAL-1');
  const b = claimPallet(store, 'PAL-1'); // same pallet again
  const c = claimPallet(store, 'PAL-2');
  console.log(a.duplicate === false ? '✓ first scan is not a duplicate' : '✗');
  console.log(b.duplicate === true ? '✓ second scan of same pallet is a duplicate' : '✗');
  console.log(c.duplicate === false ? '✓ different pallet is not a duplicate' : '✗');
}
