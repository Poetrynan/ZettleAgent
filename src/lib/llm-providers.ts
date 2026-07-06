// LLM Provider presets — supports multiple vendors and proxy services

export interface LlmProvider {
  id: string;
  name: string;
  nameZh: string;
  baseUrl: string;
  needsApiKey: boolean;
  models: LlmModel[];
  headers?: Record<string, string>;
  description: string;
  descriptionZh: string;
  keyUrl?: string;       // URL to get API key
  keyUrlZh?: string;     // Chinese version URL
}

export interface LlmModel {
  id: string;
  name: string;
  contextWindow: number;
  description: string;
}

export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    nameZh: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1/chat/completions',
    needsApiKey: false,
    models: [
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, description: 'DeepSeek latest flagship (2026.6)' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, description: 'Fast V4 variant (2026.5)' },
      { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: 128000, description: 'DeepSeek V3.2' },
      { id: 'deepseek-r1', name: 'DeepSeek R1', contextWindow: 128000, description: 'Reasoning model' },
      { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', contextWindow: 128000, description: 'Alibaba Qwen 3.7' },
      { id: 'llama3.1', name: 'Llama 3.1', contextWindow: 128000, description: 'Meta Llama 3.1' },
      { id: 'gemma2', name: 'Gemma 2', contextWindow: 8192, description: 'Google Gemma 2' },
    ],
    description: 'Local model server. No API key needed.',
    descriptionZh: '本地模型服务器，无需 API Key',
    keyUrl: 'https://ollama.com',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameZh: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V4 Pro', contextWindow: 128000, description: 'Latest flagship (2026.6)' },
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, description: 'Fast V4 (2026.5)' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', contextWindow: 128000, description: 'Reasoning model (R1)' },
    ],
    description: 'DeepSeek official API.',
    descriptionZh: 'DeepSeek 官方 API',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    nameZh: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 128000, description: 'Latest OpenAI model' },
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, description: 'Multimodal model' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, description: 'Fast & cheap' },
      { id: 'o1-mini', name: 'o1-mini', contextWindow: 128000, description: 'Reasoning model' },
    ],
    description: 'OpenAI official API.',
    descriptionZh: 'OpenAI 官方 API',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    nameZh: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    needsApiKey: true,
    models: [
      { id: 'claude-fable-5-20260609', name: 'Claude Fable 5', contextWindow: 200000, description: 'Latest Claude model (2026.6)' },
      { id: 'claude-mythos-5-20260609', name: 'Claude Mythos 5', contextWindow: 200000, description: 'Most capable model (2026.6)' },
      { id: 'claude-opus-4.8-20260528', name: 'Claude Opus 4.8', contextWindow: 200000, description: 'Opus latest (2026.5)' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000, description: 'Balance of speed and intelligence' },
    ],
    description: 'Anthropic Claude API.',
    descriptionZh: 'Anthropic Claude API',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    nameZh: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsApiKey: true,
    models: [
      { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, description: 'Latest flash model (2026.5)' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1048576, description: 'Most capable Gemini' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, description: 'Fast thinking model' },
    ],
    description: 'Google Gemini API. Free tier available.',
    descriptionZh: 'Google Gemini API，有免费额度',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameZh: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek Chat V3', contextWindow: 128000, description: 'DeepSeek via OpenRouter' },
      { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', contextWindow: 128000, description: 'DeepSeek R1 via OpenRouter' },
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', contextWindow: 200000, description: 'Claude via OpenRouter' },
      { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, description: 'OpenAI via OpenRouter' },
      { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', contextWindow: 1048576, description: 'Google Gemini via OpenRouter' },
      { id: 'meta-llama/llama-3.1-70b-instruct', name: 'Llama 3.1 70B', contextWindow: 128000, description: 'Meta Llama via OpenRouter' },
      { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', contextWindow: 128000, description: 'Qwen via OpenRouter' },
    ],
    headers: {
      'HTTP-Referer': 'https://zettelagent.app',
      'X-Title': 'ZettelAgent',
    },
    description: 'Multi-model aggregator. 100+ models, one key.',
    descriptionZh: '多模型聚合平台，一个 Key 访问 100+ 模型',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    nameZh: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, description: 'DeepSeek V4 Pro via SiliconFlow' },
      { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1', contextWindow: 128000, description: 'DeepSeek R1 via SiliconFlow' },
      { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max', contextWindow: 128000, description: 'Qwen via SiliconFlow' },
      { id: 'THUDM/GLM-5-Turbo', name: 'GLM-5 Turbo', contextWindow: 128000, description: 'Zhipu GLM-5 Turbo' },
    ],
    description: 'Chinese AI cloud. Affordable pricing.',
    descriptionZh: '国产 AI 云平台，价格实惠',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'together',
    name: 'Together AI',
    nameZh: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 128000, description: 'DeepSeek V3' },
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B Turbo', contextWindow: 128000, description: 'Fast Llama' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B Turbo', contextWindow: 128000, description: 'Fast Qwen' },
    ],
    description: 'Together AI inference platform.',
    descriptionZh: 'Together AI 推理平台',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'groq',
    name: 'Groq',
    nameZh: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'llama-3.1-70b-versatile', name: 'Llama 3.1 70B', contextWindow: 128000, description: 'Ultra-fast inference' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 128000, description: 'Instant responses' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, description: 'Mixtral via Groq' },
    ],
    description: 'Ultra-fast LPU inference.',
    descriptionZh: '超快 LPU 推理',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'qwen',
    name: 'Tongyi Qwen',
    nameZh: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'qwen-max', name: 'Qwen 3.7 Max', contextWindow: 131072, description: 'Most capable Qwen model (2026.5)' },
      { id: 'qwen-plus', name: 'Qwen 3.7 Plus', contextWindow: 131072, description: 'Balanced (2026.6)' },
      { id: 'qwen-turbo', name: 'Qwen 3.5 Flash', contextWindow: 131072, description: 'Fast and affordable' },
      { id: 'qwen-long', name: 'Qwen Long', contextWindow: 10000000, description: 'Ultra-long context (10M)' },
    ],
    description: 'Alibaba Tongyi Qwen API. OpenAI-compatible.',
    descriptionZh: '阿里通义千问 API，兼容 OpenAI 格式',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'zhipu',
    name: 'Zhipu AI',
    nameZh: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 128000, description: 'Latest GLM model (2026.4)' },
      { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 128000, description: 'Fast GLM-5' },
      { id: 'glm-5v-turbo', name: 'GLM-5V Turbo', contextWindow: 128000, description: 'Multimodal GLM-5' },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', contextWindow: 128000, description: 'Previous gen' },
    ],
    description: 'Zhipu AI GLM API. OpenAI-compatible.',
    descriptionZh: '智谱 AI GLM API，兼容 OpenAI 格式',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    nameZh: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    needsApiKey: true,
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 245000, description: 'Latest MiniMax (2026.6)' },
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', contextWindow: 245000, description: 'Balanced model' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', contextWindow: 245000, description: 'Previous gen' },
    ],
    description: 'MiniMax Abab API. OpenAI-compatible.',
    descriptionZh: 'MiniMax Abab API，兼容 OpenAI 格式',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  },
  {
    id: 'baichuan',
    name: 'Baichuan',
    nameZh: '百川智能',
    baseUrl: 'https://api.baichuan-ai.com/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'Baichuan4', name: 'Baichuan 4', contextWindow: 32000, description: 'Most capable Baichuan model' },
      { id: 'Baichuan3-Turbo', name: 'Baichuan 3 Turbo', contextWindow: 32000, description: 'Fast and affordable' },
    ],
    description: 'Baichuan AI API. OpenAI-compatible.',
    descriptionZh: '百川智能 API，兼容 OpenAI 格式',
    keyUrl: 'https://platform.baichuan-ai.com/console/apikey',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    nameZh: '月之暗面 (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 128000, description: 'Latest Kimi model' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 128000, description: 'Previous gen' },
      { id: 'moonshot-v1-128k', name: 'Moonshot 128K', contextWindow: 128000, description: 'Long context model' },
    ],
    description: 'Moonshot AI (Kimi) API. OpenAI-compatible.',
    descriptionZh: '月之暗面 (Kimi) API，兼容 OpenAI 格式',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'yi',
    name: '01.AI (Yi)',
    nameZh: '零一万物 (Yi)',
    baseUrl: 'https://api.lingyiwanwu.com/v1/chat/completions',
    needsApiKey: true,
    models: [
      { id: 'yi-large', name: 'Yi Large', contextWindow: 32000, description: 'Most capable Yi model' },
      { id: 'yi-medium', name: 'Yi Medium', contextWindow: 16000, description: 'Balanced model' },
      { id: 'yi-spark', name: 'Yi Spark', contextWindow: 16000, description: 'Fast and cheap' },
    ],
    description: '01.AI Yi API. OpenAI-compatible.',
    descriptionZh: '零一万物 Yi API，兼容 OpenAI 格式',
    keyUrl: 'https://platform.lingyiwanwu.com/apikeys',
  },
  {
    id: 'custom',
    name: 'Custom / Proxy',
    nameZh: '自定义 / 中转站',
    baseUrl: '',
    needsApiKey: true,
    models: [],
    description: 'Any OpenAI-compatible endpoint. Supports reverse proxies and relay services.',
    descriptionZh: '任何 OpenAI 兼容端点。支持反向代理和中转站',
  },
];

export function getProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

export function getDefaultProvider(): LlmProvider {
  return LLM_PROVIDERS[0]; // Ollama
}

/** Look up model metadata from the provider presets */
export function getModelMeta(providerId: string, modelId: string): LlmModel | undefined {
  const provider = getProvider(providerId);
  if (!provider) return undefined;
  return provider.models.find((m) => m.id === modelId);
}
