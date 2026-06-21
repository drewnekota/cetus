# Data Rules

- Convert `created_at_utc` to Asia/Shanghai before grouping by month.
- Deduplicate exact repeated `order_id` rows, keeping the first paid row.
- Net revenue is paid amount plus refund rows.
- Empty channel should be reported as `unknown`.
- Flag any single paid order above 5000 USD as an anomaly.
