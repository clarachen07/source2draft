# Validation record

Last validated: 2026-09-22. This file records project validation only; it contains no personal accounts, real tasks, or draft identifiers.

## Current results

- `npm run check`: 162 tests passed, 0 skipped. The check covers syntax, project isolation, regression tests, and dependency auditing; the audit found 0 vulnerabilities at validation time.
- Real Chrome verified article text, formulas, tables, images, and covers. The 390px and 1024px viewports had no horizontal overflow, and all 21 image references in the mixed sample loaded successfully.
- The mixed-sample HTML, images, and cover were byte-for-byte identical before and after rendering optimization; the mobile preview and cover were visually inspected.
- PDF parsing was checked with real Poppler and mocked Datalab responses. The same PDF was downloaded once.

The full check requires Node.js 22+, Chrome, and Poppler; it does not require real account credentials.

## Regression coverage

- Single-instance locking: eight-process contention, recovery after forced exit, and a shared lock for real paths and symlinks.
- Slack: workspace, channel, user, and mention restrictions; duplicate messages, out-of-order edits, cross-revision control replay, and restart recovery.
- Material: restricted sources block expanded search; latest source and cover selections; item-by-item recovery in a stable order.
- Network: private-network blocking, DNS pinning, cross-origin credential stripping, response-size limits, full-request deadlines, and cancellation.
- Translation: a mocked truncation from the real-model adapter triggers bounded split batches; page ranges, charts, formulas, and structural completeness are checked.
- Cache: review-fingerprint invalidation, isolation of image-upload receipts, and retained approved translation blocks after a failed batch.
- WeChat: operations persist before creation, `media_id` persists immediately, lost responses are verified only, ambiguous results pause, and existing drafts are never recreated.
- Browser: reusable batches, isolated contexts, no network, cancellation resource release, and recovery for the next task.
- Telemetry: timing and counts only; telemetry failures neither change task results nor repeat remote operations.

## Offline performance results

| Scenario | Before | After | Equivalence check |
| --- | --- | --- | --- |
| Six tables, median Chrome duration across three runs | 2.970 s, 6 launches | 1.568 s, 1 launch | Matching PNG hashes for every run |
| Checkpoints for 1,601 translation units | 1,668 writes, 413.10 MiB serialized | 67 writes, 16.89 MiB serialized | 67 model calls in both cases; matching final article |
| Six fixed-latency searches | 303.0 ms, concurrency 1 | 107.2 ms, concurrency 3 | 6 requests in both cases; matching text and source order |
| Review requests on a resumed identical task | 1 | 0 | Reused approved review with matching fingerprint |

Search and model calls use fixed mocked responses. The checkpoint benchmark performs real serialization with simulated disk writes. These results describe only the corresponding stages and do not predict whole-article generation time.

## Real integration acceptance

Offline testing is not real-account acceptance. Each installation should independently validate Slack commands and notifications, model authentication, Exa search, Datalab PDF parsing, WeChat draft creation and readback, plus reconnection and login recovery, using the [setup guide](SETUP.md).

Real testing creates drafts only and never publishes. Personal acceptance records, articles, credentials, databases, and logs remain local and are not distributed with the public repository.
