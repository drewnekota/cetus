import assert from "node:assert/strict";
import test from "node:test";
import { calculateInvoice } from "../src/invoice.js";

test("calculates invoice totals without a discount", () => {
  const invoice = calculateInvoice(
    [
      { sku: "pro-seat", quantity: 2, unitPrice: 50 },
      { sku: "support", quantity: 1, unitPrice: 25 },
    ],
    { taxRate: 0.08 }
  );

  assert.deepEqual(invoice, {
    subtotal: 125,
    discount: 0,
    tax: 10,
    total: 135,
  });
});

test("applies a percentage discount before tax", () => {
  const invoice = calculateInvoice(
    [{ sku: "annual-plan", quantity: 1, unitPrice: 200 }],
    { discountPct: 10, taxRate: 0.05 }
  );

  assert.deepEqual(invoice, {
    subtotal: 200,
    discount: 20,
    tax: 9,
    total: 189,
  });
});

test("rejects invalid invoice inputs", () => {
  assert.throws(
    () => calculateInvoice([{ sku: "bad", quantity: 1, unitPrice: -1 }]),
    /invalid invoice item/
  );
  assert.throws(
    () => calculateInvoice([{ sku: "seat", quantity: 1, unitPrice: 10 }], { discountPct: 150 }),
    /discountPct/
  );
});
