# Belarrius AI Horde Bridge v1.3

Node.js bridge to connect one or more local LLM servers to **KoboldAI Horde** as a text worker, with a focus on robustness (retries, live dashboard, optional CSAM filtering, TPS limiting).

Official repository:
`https://github.com/Belarrius1/belarrius-ai-horde-bridge`

## Goal

This project is inspired by Medusa-Bridge and uses a modular architecture.

## Features

- Parallel workers (`threads`)
- Live TUI dashboard in TTY (responsive 1/2-column layout + worker/Horde stats)
- Retries for pop/generation/submit
- Optional CSAM filter (`enableCsamFilter`)
- Virtual token-per-second rate limiting (`maxTps`)
- Context length enforcement for engines that support tokenize/detokenize
- Optional prompt audit logging (`outputPrompt`)
- Configurable local API key (`serverApiKey`)

## Supported Engines

- `ollama`
- `oobabooga`
- `llamacpp`
- `koboldcpp`
- `vllm`
- `sglang`
- `tabbyapi`

## Installation

Node.js 22 is recommended.

Prerequisites:
- OS: Linux/Windows/macOS
- Node.js: 22.x recommended
- npm: included with Node.js
- A compatible local inference server (`ollama`, `oobabooga`, `llamacpp`, `koboldcpp`, `vllm`, `sglang`, `tabbyapi`)
- A valid AI Horde key (`AiHordeApiKey`)
- Optional for OpenAI CSAM mode: an OpenAI key (`openaiApiKey`)

Node.js dependencies used by this bridge:
- `axios`
- `winston`

Install dependencies:

```bash
npm ci
```

## Usage

1. Edit `config.yaml`
2. Run:

```bash
node index.js
```

## Configuration

The bridge automatically reads **`config.yaml`** from the project root.

Required fields:
- `AiHordeApiKey`
- `serverEngine`
- `model`
- `ctx`

Possible values:
- `nsfw`: `enabled` or `disabled`
- `enableCsamFilter`: `disabled`, `regex`, `openai`
- `csamPositiveAction`: `respond` or `fault`
- `enforceCtxLimit`: `enabled` or `disabled`
- `uiTheme`: `acide`, `cyberpunk`, `matrix`, `monochrome`

Context/generation block (read together):
- `ctx`: advertised/enforced max context
- `maxLength`: max generation length
- `enforceCtxLimit`: if `enabled`, rejects jobs that exceed `ctx - requested_max_length`

Performance/network block:
- `threads`: number of parallel jobs processed by the bridge
- `timeout` (seconds): max wait for Horde pop/submit and local generation
- `refreshTime` (milliseconds): polling frequency for new Horde jobs

UI block:
- `UI.layout`: `horizontal` or `vertical`
- `UI.showBridgeStats`: `enabled` or `disabled`
- `UI.showThreadActivity`: `enabled` or `disabled`
- `UI.showAiHordeUser`: `enabled` or `disabled`
- `UI.showAiHordePerformance`: `enabled` or `disabled`
- `UI.showRecentJobs`: `enabled` or `disabled`
- `UI.recentJobsCount`: integer `1..50`

Example:

```yaml
UI:
  layout: "horizontal"
  showBridgeStats: "enabled"
  showThreadActivity: "enabled"
  showAiHordeUser: "disabled"
  showAiHordePerformance: "disabled"
  showRecentJobs: "enabled"
  recentJobsCount: 5
```

Possible values for `serverEngine`:
- `ollama`
- `oobabooga`
- `llamacpp`
- `koboldcpp`
- `vllm`
- `sglang`
- `tabbyapi`

Aliases accepted for backward compatibility:
- `textgenwebui`
- `oogabooga`
- `lmstudio`
- `localai`
- `mistralrs` (and `mistral.rs`)
- `mlx`
- `openllm`
- `aphrodite` (and `aphrodite-engine`)

For `serverEngine: "ollama"`:
- Use `serverUrl: "http://localhost:11434"` (default Ollama URL)
- Set `serverModel` (required), example: `llama3.1:8b`
- Keep `model` as your Horde-advertised name, example: `ollama/llama3.1:8b`

For `serverEngine: "oobabooga"`:
- Use Text Generation WebUI OpenAI API endpoint (`/v1/*`) and not llama.cpp native endpoints
- Use `serverUrl: "http://localhost:5000"` (or your custom API port, e.g. `http://0.0.0.0:6565`)
- Set `serverModel` (required), example: `Llama-3.1-8B-Instruct`
- If WebUI API key is enabled, set `serverApiKey` to either raw key or `Bearer <key>`
- Keep `model` as your Horde-advertised name, example: `oobabooga/Llama-3.1-8B-Instruct`

LM Studio should also work with this same OpenAI-compatible path (`/v1/*`), or via alias:
- `serverEngine: "lmstudio"`
- Typical `serverUrl`: `http://localhost:1234`
- Example advertised model: `lmstudio/your-model-name`

LocalAI should also work with this same OpenAI-compatible path (`/v1/*`), or via alias:
- `serverEngine: "localai"`
- Typical `serverUrl`: `http://localhost:8080`
- Example advertised model: `localai/your-model-name`

mistral.rs should also work with this same OpenAI-compatible path (`/v1/*`), or via alias:
- `serverEngine: "mistralrs"` (or `mistral.rs`)
- Keep `serverModel` set to your loaded model identifier
- Example advertised model: `mistralrs/your-model-name`

MLX can work when used through an OpenAI-compatible server implementation:
- `serverEngine: "mlx"`
- Keep `serverModel` set to your served model identifier
- Example advertised model: `mlx/your-model-name`

OpenLLM and Aphrodite-engine may also work if they expose OpenAI-compatible endpoints
matching this bridge path (`/v1/models` + `/v1/completions`).

Aliases available:
- `serverEngine: "openllm"`
- `serverEngine: "aphrodite"` (or `aphrodite-engine`)

`priorityUsernames` must be a YAML list. Example:

```yaml
priorityUsernames:
  - "Belarrius#229816"
```

Optional worker description at startup:

```yaml
workerId: "123456-123456-123456"
workerInfo: "Your description text here"
```

The bridge sends `PUT /api/v2/workers/{workerId}` with `{"info":"..."}` only if both fields are provided.

Optional strict context limit:

```yaml
enforceCtxLimit: "enabled"
```

When enabled, the bridge rejects (faults) jobs whose prompt exceeds `ctx - requested_max_length`.

CSAM:

```yaml
enableCsamFilter: "openai"
csamPositiveAction: "respond"
csamBlockedResponse: "Your request has been filtered by this worker safety policy."
csamMetadataRef: "omni-moderation-latest sexual/minors"
openaiModerationMaxTokens: 10000
openaiApiKey: "sk-..."
```

In `openai` mode, the bridge calls `omni-moderation-latest` for each incoming prompt.
The CSAM decision is based on the `sexual/minors` category boolean returned by OpenAI.
If a prompt exceeds `openaiModerationMaxTokens`, it is truncated (prefix kept) before the OpenAI check.
The practical maximum value is `30000`.
With `csamPositiveAction: "respond"`, it submits a filtered result with:
- `state: "csam"`
- `generation: "<filtering message>"`
- `gen_metadata: [{ type: "censorship", value: "csam", ref: "..." }]`

In `fault` mode, it keeps refusing the job (job faulted), which can push the worker into maintenance mode.
If OpenAI moderation is unavailable, jobs are faulted (fail-closed mode).
`csamPositiveAction: "respond"` is recommended to avoid dropping/faulting too many jobs on Horde.
