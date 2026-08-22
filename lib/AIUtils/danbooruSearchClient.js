/**
 * DanbooruSearchOnline REST API 客户端
 * 基于 https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline
 * 提供语义标签搜索、共现关联推荐、画师推荐
 */

const API_ENDPOINTS = [
  "https://sakizuki-danboorusearch.hf.space/api",
  "https://sakizuki-danboorusearchonline.ms.show/api",
]

const REQUEST_TIMEOUT = 15_000

const SEARCH_MODE_PRESETS = {
  full_scene: { top_k: 5, limit: 80, use_segmentation: true },
  concept_explore: { top_k: 80, limit: 80, use_segmentation: true },
  subject_describe: { top_k: 20, limit: 20, use_segmentation: false },
  precise_lookup: { top_k: 20, limit: 10, use_segmentation: false },
}

let _lastHealthyEndpoint = 0

/**
 * 向指定端点发送请求，支持超时和重试
 */
async function request(path, body, timeout = REQUEST_TIMEOUT) {
  const endpoints = [
    API_ENDPOINTS[_lastHealthyEndpoint],
    API_ENDPOINTS[1 - _lastHealthyEndpoint],
  ]

  for (let i = 0; i < endpoints.length; i++) {
    const url = `${endpoints[i]}${path}`
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)

      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      }

      // 记住成功的端点
      _lastHealthyEndpoint = API_ENDPOINTS.indexOf(endpoints[i])
      return await res.json()
    } catch (err) {
      logger.warn(`[DanbooruSearch] ${url} 请求失败: ${err.message}`)
      if (i === endpoints.length - 1) throw err
    }
  }
}

/**
 * 检查 API 服务健康状态（HF Space 可能在休眠）
 */
export async function checkHealth() {
  for (const base of API_ENDPOINTS) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(`${base}/health`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const data = await res.json()
        return data.status === "ok" && data.loaded
      }
    } catch {}
  }
  return false
}

/**
 * 语义搜索标签
 * @param {string} query - 用户查询（中文/英文）
 * @param {object} options
 * @param {"full_scene"|"concept_explore"|"subject_describe"|"precise_lookup"} options.searchMode
 * @param {"all"|"general"|"character"|"copyright"} options.category
 * @param {boolean} options.showNsfw
 * @param {boolean} options.includeWiki
 * @returns {Promise<{prompt: string, keywords: string[], results: Array}>}
 */
export async function searchTags(query, options = {}) {
  const {
    searchMode = "full_scene",
    category = "all",
    showNsfw = true,
    includeWiki = false,
  } = options

  const preset = SEARCH_MODE_PRESETS[searchMode] || SEARCH_MODE_PRESETS.full_scene

  const categoryMap = {
    all: ["General", "Character", "Copyright"],
    general: ["General"],
    character: ["Character"],
    copyright: ["Copyright"],
  }

  const body = {
    query,
    top_k: preset.top_k,
    limit: preset.limit,
    popularity_weight: 0.15,
    show_nsfw: showNsfw,
    use_segmentation: preset.use_segmentation,
    target_layers: ["英文", "中文扩展词", "释义", "中文核心词"],
    target_categories: categoryMap[category] || categoryMap.all,
    group_mode: "off",
    max_per_group: 2,
  }

  const data = await request("/search", body)

  const results = (data.results || []).map(r => ({
    tag: r.tag,
    cnName: r.cn_name,
    category: r.category,
    score: r.final_score,
    count: r.count,
    wiki: includeWiki ? (r.wiki || "") : "",
    aliasFrom: r.alias_from || null,
  }))

  return {
    prompt: data.tags_all || "",
    promptSfw: data.tags_sfw || "",
    keywords: data.keywords || [],
    results,
  }
}

/**
 * 共现关联推荐
 * @param {string[]} tags - 已选标签列表（Danbooru 英文标签名）
 * @param {object} options
 * @param {number} options.limit
 * @param {boolean} options.showNsfw
 * @returns {Promise<{results: Array, corrections?: object}>}
 */
export async function getRelatedTags(tags, options = {}) {
  const { limit = 50, showNsfw = true } = options

  const data = await request("/related", {
    tags,
    limit,
    show_nsfw: showNsfw,
  })

  if (data.error) {
    return { results: [], error: data.error }
  }

  const results = (data.results || []).map(r => ({
    tag: r.tag,
    cnName: r.cn_name,
    category: r.category || "",
    sources: r.sources || [],
    wiki: r.wiki || "",
  }))

  return {
    results,
    correctionNote: data.correction_note || null,
    corrections: data.corrections || null,
  }
}

/**
 * 推荐擅长画师
 * @param {string[]} tags - 标签列表
 * @param {object} options
 * @param {number} options.limit
 * @param {number} options.minCooc
 * @param {boolean} options.showNsfw
 * @returns {Promise<{results: Array, corrections?: object}>}
 */
export async function getArtists(tags, options = {}) {
  const { limit = 15, minCooc = 3, showNsfw = true } = options

  const data = await request("/artists", {
    tags,
    limit,
    min_cooc: minCooc,
    show_nsfw: showNsfw,
  })

  if (data.error) {
    return { results: [], error: data.error }
  }

  const results = (data.results || []).map(r => ({
    artist: r.artist,
    coocCount: r.cooc_count,
    postCount: r.post_count,
    sources: r.sources || [],
    topTags: r.top_tags || [],
  }))

  return {
    results,
    correctionNote: data.correction_note || null,
    corrections: data.corrections || null,
  }
}
