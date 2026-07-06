// Throwaway debug harness: replay a captured claude stream-json file through
// EventTranslator and print the PiEvents it would emit.
//   cargo run --example replay_jsonl -- /path/to/probe.jsonl
use cetus_bridge::cli_agent::{CliBackend, EventTranslator};

fn main() {
    let path = std::env::args().nth(1).expect("usage: replay_jsonl <file>");
    let data = std::fs::read_to_string(&path).unwrap();
    let mut tr = EventTranslator::new(CliBackend::ClaudeCode);
    for e in tr.start() {
        println!("{}", brief(&e));
    }
    let mut results = 0;
    for line in data.lines() {
        for e in tr.on_line(line) {
            println!("{}", brief(&e));
        }
        if tr.saw_result {
            results += 1;
            println!(
                "-- result #{results} (pending_tasks={}, saw_bg={})",
                tr.has_pending_tasks(),
                tr.saw_background_tasks()
            );
            tr.saw_result = false;
        }
    }
    for e in tr.finish(None) {
        println!("{}", brief(&e));
    }
    println!("== persisted rows ==");
    for m in tr.take_messages() {
        println!("{}", serde_json::to_string(&m).unwrap().chars().take(220).collect::<String>());
    }
}

fn brief(e: &serde_json::Value) -> String {
    let ty = e["type"].as_str().unwrap_or("?");
    match ty {
        "message_update" => format!(
            "message_update:{}",
            e["assistantMessageEvent"]["type"].as_str().unwrap_or("?")
        ),
        "tool_execution_update" => {
            let steps = e["partialResult"]["details"]["subagent"]["steps"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0);
            format!(
                "tool_execution_update id={} steps={} text={:.60}",
                e["toolCallId"].as_str().unwrap_or("?"),
                steps,
                e["partialResult"]["content"][0]["text"].as_str().unwrap_or("")
            )
        }
        "tool_execution_end" => {
            let steps = e["result"]["details"]["subagent"]["steps"]
                .as_array()
                .map(|a| a.len())
                .unwrap_or(0);
            format!(
                "tool_execution_end id={} steps={} err={} text={:.60}",
                e["toolCallId"].as_str().unwrap_or("?"),
                steps,
                e["isError"],
                e["result"]["content"][0]["text"].as_str().unwrap_or("")
            )
        }
        _ => ty.to_string(),
    }
}
