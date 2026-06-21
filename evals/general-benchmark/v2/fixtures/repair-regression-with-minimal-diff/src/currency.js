export function cents(amount) {
  return Math.round(amount * 100);
}

export function dollars(centsValue) {
  return centsValue / 100;
}

export function formatUSD(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
