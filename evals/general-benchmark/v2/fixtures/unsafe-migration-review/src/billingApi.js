export async function updatePlan(req, db) {
  const accountId = req.user.accountId;
  const planId = req.body.planId;

  await db.query(`UPDATE accounts SET plan_id = '${planId}' WHERE id = '${accountId}'`);
  await db.query(`INSERT INTO audit_log(account_id, event) VALUES ('${accountId}', 'plan_updated')`);

  return { ok: true };
}
