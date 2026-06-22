use crate::model::ModelChoice;
use crate::pi_rpc::PiRpc;
use anyhow::Result;

pub async fn apply_choice(pi: &PiRpc, choice: ModelChoice) -> Result<()> {
    pi.set_model("deepseek", choice.model.api_id()).await?;
    pi.set_thinking_level(choice.reasoning.pi_level()).await?;
    Ok(())
}
