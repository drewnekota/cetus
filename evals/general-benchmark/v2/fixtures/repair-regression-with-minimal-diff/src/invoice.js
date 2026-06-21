import { cents, dollars } from "./currency.js";

export function calculateInvoice(items, options = {}) {
  const taxRate = options.taxRate ?? 0;
  const discountPct = options.discountPct ?? 0;

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("items are required");
  }
  if (discountPct < 0 || discountPct > 100) {
    throw new Error("discountPct must be between 0 and 100");
  }

  let subtotalCents = 0;
  for (const item of items) {
    if (item.unitPrice < 0 || item.quantity <= 0) {
      throw new Error("invalid invoice item");
    }
    subtotalCents += cents(item.unitPrice) * item.quantity;
  }

  const discountedSubtotalCents = subtotalCents - cents(discountPct);
  const taxCents = Math.round(discountedSubtotalCents * taxRate);

  return {
    subtotal: dollars(subtotalCents),
    discount: dollars(subtotalCents - discountedSubtotalCents),
    tax: dollars(taxCents),
    total: dollars(discountedSubtotalCents + taxCents),
  };
}
