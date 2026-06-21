export async function runRenewals(db, clock) {
  const rows = await db.query("SELECT id, account_id, amount_cents FROM renewals WHERE due_at < now()");

  for (const row of rows) {
    await db.query("INSERT INTO invoices(account_id, amount_cents) VALUES ($1, $2)", [
      row.account_id,
      row.amount_cents,
    ]);
    await db.query("UPDATE renewals SET processed_at = $1 WHERE id = $2", [clock.now(), row.id]);
  }
}
