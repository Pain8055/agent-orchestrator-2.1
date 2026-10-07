// Public routing policy only. Never put keys or account-specific secrets here.
// These are application safety limits, NOT promises about provider free quotas.
(function (root) {
  const config = Object.freeze({
    requestTimeoutMs: 30000,
    passTimeoutMs: 75000,
    maxAttempts: 3,
    finalOutputTokens: 4096,
    maxContinuations: 2,
    rateLimitCooldownMs: 60000,
    transientCooldownMs: 20000,
    unavailableModelCooldownMs: 30 * 60000,
    configurationCooldownMs: 10 * 60000,
  });

  // Verified against official catalogs; availability and account quotas can change.
  const groq = { provider: 'groq', model: 'openai/gpt-oss-120b' };
  const gemini = { provider: 'gemini', model: 'gemini-3.6-flash' };
  const nemotron = { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free' };
  const qwen = { provider: 'openrouter', model: 'qwen/qwen3.8-27b:free' };
  const lightning = { provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free' };
  const models = {
    // Try independent providers before spending more attempts on one shared quota.
    general: [groq, gemini, nemotron, qwen, lightning],
    specialist: [nemotron, gemini, groq, qwen, lightning],
    vision: [gemini, qwen],
  };

  function retryAfterMs(value, now = Date.now()) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - now) : 0;
  }

  function classify(status, data) {
    const detail = typeof data?.error === 'string' ? data.error
      : typeof data?.error?.message === 'string' ? data.error.message : '';
    if (status === 401 || status === 403) return 'authorization';
    if (status === 429) return 'rate_limit';
    if (status === 413 || ([400, 422].includes(status) && /context.{0,30}(length|window|limit)|too many tokens|maximum context|input.{0,20}too long/i.test(detail))) return 'capacity';
    if (status === 404) return 'model_unavailable';
    if (status === 400 || status === 422) return 'invalid_request';
    return 'transient';
  }

  function createRouter({ now = Date.now, policy = config } = {}) {
    const cooldowns = new Map();
    const key = p => `${p.provider}:${p.model}`;
    function remaining(p) { return Math.max(0, (cooldowns.get(key(p)) || 0) - now()); }
    function failure(p, kind, retryMs = 0) {
      // Oversized or malformed input is request-specific, not a broken model.
      if (kind === 'capacity' || kind === 'invalid_request') return;
      const duration = kind === 'rate_limit' ? Math.max(policy.rateLimitCooldownMs, retryMs)
        : kind === 'authorization' ? policy.configurationCooldownMs
        : kind === 'model_unavailable' ? policy.unavailableModelCooldownMs
        : policy.transientCooldownMs;
      cooldowns.set(key(p), now() + duration);
    }
    return {
      remaining,
      available: providers => providers.filter(p => remaining(p) === 0),
      success: p => cooldowns.delete(key(p)),
      failure,
      reset: () => cooldowns.clear(),
    };
  }
  function incompleteNotice(reason) {
    return `\n\n**Answer incomplete:** ${reason} You can ask to continue from the last section.`;
  }
  async function completeText(request, prompt, history = [], onProgress = () => {}) {
    let combined = '';
    let nextPrompt = prompt;
    const turns = history.slice();
    for (let segment = 0; segment <= config.maxContinuations; segment++) {
      onProgress(segment);
      let response;
      try { response = await request(nextPrompt, turns, config.finalOutputTokens); }
      catch { return combined + incompleteNotice('The next section could not be generated.'); }
      if (!response.text) return combined + incompleteNotice('No further text was available within the routing limits.');
      combined += (combined ? '\n\n' : '') + response.text;
      if (response.finishReason === 'content_filter') return combined + incompleteNotice('The provider stopped this response for safety filtering.');
      if (response.finishReason === 'error') return combined + incompleteNotice('The provider reported an error during generation.');
      if (!response.truncated) return combined;
      if (segment === config.maxContinuations) break;
      turns.push({ role: 'user', content: nextPrompt }, { role: 'assistant', content: response.text });
      nextPrompt = 'Continue the unfinished answer exactly where it stopped. Do not repeat earlier sections or start over. Complete the remaining requirements, include a concise conclusion, and do not invent sources.';
    }
    return combined + incompleteNotice('The output limit was reached after the allowed continuation requests.');
  }
  const api = { config, models, retryAfterMs, classify, createRouter, incompleteNotice, completeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProviderPolicy = api;
})(globalThis);
