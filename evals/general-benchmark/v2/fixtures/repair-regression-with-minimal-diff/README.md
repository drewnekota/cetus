# Invoice Regression Fixture

The checkout team changed discount handling in the latest patch. A regression
now causes percentage discounts to be applied incorrectly.

Expected behavior:

- `discountPct` is a percentage from 0 to 100.
- Discounts are applied to the subtotal before tax.
- `discountPct: 0` is valid and should not be treated as missing.
- Negative item prices and invalid discount percentages should throw.

The agent should fix the implementation with a minimal diff and add or
strengthen a test for the edge case it identifies.
