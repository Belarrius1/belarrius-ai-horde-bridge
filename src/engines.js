import { safePost } from './http.js';

export function buildEngines(logger) {
  return {
    ollama: {
      healthUrl: '/api/tags',
      generateUrl: '/api/generate',
      generatePayload: (payload) => {
        const options = {
          num_predict: payload.max_length,
          num_ctx: payload.max_context_length,
          temperature: payload.temperature ?? 1.0,
          top_p: payload.top_p ?? 1.0,
          repeat_penalty: payload.rep_pen ?? 1.0,
          repeat_last_n: payload.rep_pen_range ?? 64,
          stop: payload.stop_sequence ?? []
        };

        const topK = Number(payload.top_k);
        if (Number.isFinite(topK) && topK > 0) {
          options.top_k = topK;
        }

        return {
          prompt: payload.prompt,
          stream: false,
          options
        };
      },
      extractGeneration: (data) => {
        if (typeof data?.response !== 'string') {
          throw new Error('Invalid Ollama response: missing response field');
        }
        return data.response;
      }
    },

    vllm: {
      healthUrl: '/health',
      generateUrl: '/generate',
      generatePayload: (payload) => {
        const req = {
          prompt: payload.prompt,
          stop: payload.stop_sequence ?? [],
          max_tokens: payload.max_length,
          temperature: payload.temperature ?? 1.0,
          top_k: payload.top_k ?? -1,
          top_p: payload.top_p ?? 1.0,
          repetition_penalty: payload.rep_pen ?? 1.0
        };

        if (req.top_k === 0) req.top_k = -1;
        if (req.repetition_penalty > 2) req.repetition_penalty = 2.0;
        if (req.repetition_penalty < 0.01) req.repetition_penalty = 0.01;
        return req;
      },
      extractGeneration: (data, prompt) => {
        let generation = data.text;
        if (Array.isArray(generation)) generation = generation[0];
        return generation.slice(prompt.length);
      }
    },

    tabbyapi: {
      healthUrl: '/health',
      generateUrl: '/v1/completions',
      tokenize: async (text, serverUrl, serverHeaders) => {
        const response = await safePost({
          url: `${serverUrl}/v1/token/encode`,
          body: { text },
          headers: serverHeaders,
          logger
        });
        return response.ok ? response.data.tokens : null;
      },
      detokenize: async (tokens, serverUrl, serverHeaders) => {
        const response = await safePost({
          url: `${serverUrl}/v1/token/decode`,
          body: { tokens },
          headers: serverHeaders,
          logger
        });
        return response.ok ? response.data.text : null;
      },
      generatePayload: async (payload) => ({ ...payload, tfs: 1.0 }),
      extractGeneration: (data) => data.choices[0].text
    },

    sglang: {
      healthUrl: '/health',
      generateUrl: '/generate',
      generatePayload: (payload) => {
        const req = {
          text: payload.prompt,
          sampling_params: {
            stop: payload.stop_sequence ?? [],
            max_new_tokens: payload.max_length,
            temperature: payload.temperature ?? 1.0,
            top_k: payload.top_k ?? -1,
            top_p: payload.top_p ?? 1.0
          }
        };
        if (req.sampling_params.top_k === 0) req.sampling_params.top_k = -1;
        return req;
      },
      extractGeneration: (data) => {
        let generation = data.text;
        if (Array.isArray(generation)) generation = generation[0];
        return generation;
      }
    },

    koboldcpp: {
      healthUrl: '/api/extra/version',
      generateUrl: '/api/v1/generate',
      generatePayload: (payload) => payload,
      extractGeneration: (data) => data.results[0].text
    },

    llamacpp: {
      healthUrl: '/props',
      generateUrl: '/completion',
      generatePayload: (payload) => ({
        prompt: payload.prompt,
        stop: payload.stop_sequence ?? [],
        n_predict: payload.max_length,
        n_keep: payload.max_context_length - payload.max_length,
        temperature: payload.temperature ?? 1.0,
        tfs_z: payload.tfs ?? 1.0,
        top_k: payload.top_k ?? -1,
        top_p: payload.top_p ?? 1.0,
        repeat_penalty: payload.rep_pen ?? 1.0,
        repeat_last_n: payload.rep_pen_range ?? 64,
        typical_p: payload.typical ?? 0.0
      }),
      extractGeneration: (data) => data.content
    }
  };
}
