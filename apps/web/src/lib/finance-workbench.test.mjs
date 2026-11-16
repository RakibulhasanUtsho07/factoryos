import assert from "node:assert/strict";
import test from "node:test";

import {
  createFinanceWorkbenchClient,
  financeClosePeriodStatuses,
} from "./finance-workbench.mjs";

function createClient() {
  const calls = [];
  const client = createFinanceWorkbenchClient({
    request: async (path, options = {}) => {
      calls.push({ path, options });
      return { accepted: true };
    },
  });
  return { client, calls };
}

test("workbench report query delegates to the authenticated factory session", async () => {
  const { client, calls } = createClient();
  const result = await client.readWorkbench({
    from: "2026-06-01",
    to: "2026-11-16",
    currency: "bdt",
    horizonDays: 60,
    unreconciledLimit: 20,
  });

  assert.deepEqual(result, { accepted: true });
  assert.deepEqual(calls, [{
    path: "/finance/workbench?from=2026-06-01&to=2026-11-16&currency=BDT&horizon_days=60&unreconciled_limit=20",
    options: {},
  }]);
});

test("workbench report applies the backend defaults for horizon and exception limit", async () => {
  const { client, calls } = createClient();
  await client.readWorkbench();

  assert.equal(calls[0].path, "/finance/workbench?horizon_days=30&unreconciled_limit=50");
  assert.deepEqual(calls[0].options, {});
});

test("workbench and close-period date filters reject malformed calendar dates", async () => {
  const { client, calls } = createClient();

  await assert.rejects(
    client.readWorkbench({ from: "2026-02-30" }),
    /real calendar date/i,
  );
  await assert.rejects(
    client.listClosePeriods({ to: "16-11-2026" }),
    /YYYY-MM-DD/i,
  );
  assert.equal(calls.length, 0);
});

test("workbench and close-period queries reject inverted date ranges before requesting", async () => {
  const { client, calls } = createClient();

  await assert.rejects(
    client.readWorkbench({ from: "2026-11-17", to: "2026-11-16" }),
    /from must be earlier/i,
  );
  await assert.rejects(
    client.listClosePeriods({ from: "2026-11-17", to: "2026-11-16" }),
    /from must be earlier/i,
  );
  assert.equal(calls.length, 0);
});

test("workbench validates currency, cash horizon and bounded exception rows", async () => {
  const { client, calls } = createClient();

  await assert.rejects(client.readWorkbench({ currency: "BDTX" }), /three-letter/i);
  await assert.rejects(client.readWorkbench({ horizonDays: 366 }), /between 1 and 365/i);
  await assert.rejects(client.readWorkbench({ horizonDays: 0 }), /between 1 and 365/i);
  await assert.rejects(client.readWorkbench({ unreconciledLimit: 101 }), /between 1 and 100/i);
  await assert.rejects(client.readWorkbench({ unreconciledLimit: 1.5 }), /between 1 and 100/i);
  assert.equal(calls.length, 0);
});

test("close-period query uses only supported read filters and URL-encodes values", async () => {
  const { client, calls } = createClient();
  await client.listClosePeriods({
    status: "submitted",
    currency: "usd",
    from: "2026-09-01",
    to: "2026-09-30",
  });

  assert.deepEqual(calls, [{
    path: "/finance/close-periods?status=SUBMITTED&currency=USD&from=2026-09-01&to=2026-09-30",
    options: {},
  }]);
  assert.deepEqual(financeClosePeriodStatuses, ["DRAFT", "SUBMITTED", "APPROVED"]);
});

test("close-period query rejects lifecycle states outside the GET contract", async () => {
  const { client, calls } = createClient();
  await assert.rejects(
    client.listClosePeriods({ status: "CANCELLED" }),
    /DRAFT, SUBMITTED or APPROVED/i,
  );
  assert.equal(calls.length, 0);
});

test("finance client requires the shared authenticated session request function", () => {
  assert.throws(
    () => createFinanceWorkbenchClient({ request: null }),
    /authenticated.*session/i,
  );
});
