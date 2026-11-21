/** 聚合渠道 provider 的显示名（中文优先）。
 *
 * 2026-11-21 用户要求「聚合渠道界面显示渠道中文名，便于选择」。中文名只收
 * 有把握的常见品牌；拿不准的小众服务商保持注册表英文名——宁可少译，不可
 * 发明错误译名。模型清单页与渠道配置页共用这一份；注册表列表由调用方注入
 * （ofm-provider-list 是构建期虚拟模块，node 测试环境不可用）。
 */
/** provider id → 中文名（缺省回落注册表英文名）。 */
const PROVIDER_ZH = {  alibaba_cloud: '阿里云百炼',
  anthropic: 'Anthropic（Claude）',
  azure_openai: '微软 Azure OpenAI',
  baidu: '百度千帆',
  bedrock: '亚马逊 Bedrock',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek（深度求索）',
  deepinfra: 'DeepInfra',
  fireworks: 'Fireworks AI',
  glm: '智谱 GLM（Anthropic 接口）',
  'glm-cn': '智谱 GLM（中国站）',
  groq: 'Groq',
  huggingface: 'Hugging Face',
  hyperbolic: 'Hyperbolic',
  kimi: 'Kimi（月之暗面）',
  kimi_code: 'Kimi Code（月之暗面）',
  minimax: 'MiniMax（稀宇科技）',
  'minimax-cn': 'MiniMax（中国站）',
  mistral: 'Mistral',
  mistral_codestral: 'Mistral Codestral',
  nebius: 'Nebius',
  novita: 'Novita AI',
  openai: 'OpenAI / ChatGPT',
  openai_api: 'OpenAI API',
  perplexity: 'Perplexity',
  qwencloud: '阿里云通义（Token 计划）',
  qwencloud_coding: '阿里云通义（编码计划）',
  sambanova: 'SambaNova',
  scaleway: 'Scaleway',
  siliconflow: '硅基流动 SiliconFlow',
  tencent: '腾讯混元',
  together: 'Together AI',
  venice: 'Venice AI',
  vercel: 'Vercel AI 网关',
  vertex: '谷歌 Vertex AI',
  'vertex-partner': 'Vertex 合作模型',
  'volcengine-ark': '火山引擎方舟',
  wandb: 'CoreWeave',
  xai: 'xAI（Grok）',
  'xiaomi-tokenplan': '小米 MiMo Token 计划',
  zai: 'Z.ai 编码计划（智谱国际）',
  zai_api: 'Z.AI（智谱国际）',
  byteplus: 'BytePlus 方舟（火山国际）',
  cloudflare: 'Cloudflare',
  gemini: '谷歌 Gemini',
  nvidia_nim: '英伟达 NIM',
  ollama: 'Ollama（本地）',
  ollama_cloud: 'Ollama 云端',
  llamacpp: 'llama.cpp（本地）',
  lmstudio: 'LM Studio（本地）',
  open_router: 'OpenRouter',
  github_copilot: 'GitHub Copilot',
  featherless: 'Featherless AI',
  cohere: 'Cohere',
  chutes: 'Chutes',
  morph: 'Morph LLM',
  kilo: 'Kilo.ai',
}

/**
 * provider 的显示名：中文优先，回落调用方给的英文原名，最后回落 id。
 * @param {string} id provider id
 * @param {string} [fallbackName] 注册表英文名（ofm-provider-list 是构建期
 *   虚拟模块，node 测试环境拿不到整表；页面组件自己查好传入即可）。
 * @returns {string}
 */
export function providerName(id, fallbackName) {
  if (typeof id !== 'string' || id === '') return ''
  const base = typeof fallbackName === 'string' ? fallbackName : ''
  return PROVIDER_ZH[id] ?? (base !== '' ? base : id)
}
