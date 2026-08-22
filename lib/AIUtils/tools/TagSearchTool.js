import * as danbooruApi from "../danbooruSearchClient.js"
import { retrieveTags, hasArtistRequest, loadVocabIndex, normalizeCJK } from "../animaTagRetriever.js"
import { warmupIndex } from "../semanticTagSearch.js"

warmupIndex()

/**
 * 根据查询内容推断最佳搜索模式
 */
function inferSearchMode(query) {
  const len = query.length
  // 超长描述 → 完整画面
  if (len > 20) return "full_scene"
  // 多个空格/逗号/顿号分隔的概念 → 完整画面
  if (/[\s，、,]/.test(query) && query.split(/[\s，、,]+/).filter(Boolean).length >= 3) return "full_scene"
  // 带有描述性语句（包含"的""在""了"等助词）→ 场景描述
  if (/[的在了着过]/.test(query) && len > 8) return "subject_describe"
  // 短查询 → 精确查找
  if (len <= 6) return "precise_lookup"
  return "subject_describe"
}

export class TagSearchTool {
  name = "searchTags"
  description = "查询 Danbooru 标签。在使用 generateImage 生图之前必须先调用此工具查询准确标签。支持中文和英文输入，返回语义匹配的 Danbooru 标签。"

  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "查询关键词。支持中文（如「水手服」「弗里莲」）和英文（如 frieren, school uniform）。多个概念可用空格分隔。",
      },
    },
    required: ["query"],
  }

  function() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    }
  }

  func = async (opts) => {
    const { query } = opts
    if (!query) return "请提供查询关键词"

    // 优先尝试 DanbooruSearchOnline API（语义搜索效果远优于本地）
    try {
      return await this._searchOnline(query)
    } catch (err) {
      logger.warn(`[TagSearch] DanbooruSearchOnline API 不可用，降级到本地搜索: ${err.message}`)
      return this._searchLocal(query)
    }
  }

  /**
   * 在线搜索：调用 DanbooruSearchOnline API
   */
  async _searchOnline(query) {
    const searchMode = inferSearchMode(query)
    const includeArtist = hasArtistRequest(query)

    const searchResult = await danbooruApi.searchTags(query, {
      searchMode,
      showNsfw: true,
      includeWiki: false,
    })

    if (!searchResult.results || searchResult.results.length === 0) {
      throw new Error("API 返回空结果")
    }

    let response = ""

    // 按类别分组输出
    const characters = searchResult.results.filter(r => r.category === "Character")
    const general = searchResult.results.filter(r => r.category === "General")
    const copyright = searchResult.results.filter(r => r.category === "Copyright")

    if (characters.length > 0) {
      response += "【角色】\n"
      for (const ch of characters.slice(0, 8)) {
        response += `- ${ch.tag}（${ch.cnName}）`
        if (ch.aliasFrom) response += ` [原: ${ch.aliasFrom}]`
        response += "\n"
      }
    }

    if (copyright.length > 0) {
      response += "【作品】\n"
      for (const cp of copyright.slice(0, 5)) {
        response += `- ${cp.tag}（${cp.cnName}）\n`
      }
    }

    if (general.length > 0) {
      response += "【通用标签】\n"
      const tagParts = general.slice(0, 30).map(t => `${t.tag}（${t.cnName}）`)
      response += tagParts.join(", ") + "\n"
    }

    // 提供可直接使用的 prompt 字符串
    if (searchResult.prompt) {
      response += `\n【可用 Prompt】${searchResult.prompt}\n`
    }

    if (searchResult.keywords?.length > 0) {
      response += `【检索关键词】${searchResult.keywords.join(", ")}\n`
    }

    // 画师推荐：当检测到画师请求且有足够标签时
    if (includeArtist && searchResult.results.length >= 3) {
      try {
        const topTags = searchResult.results.slice(0, 5).map(r => r.tag)
        const artistResult = await danbooruApi.getArtists(topTags, { limit: 5 })
        if (artistResult.results?.length > 0) {
          response += "【推荐画师】\n"
          for (const a of artistResult.results.slice(0, 3)) {
            response += `- @${a.artist}（共现: ${a.coocCount}, 作品数: ${a.postCount}）\n`
          }
        }
      } catch {
        // 画师推荐失败不影响主流程
      }
    }

    return response.trim()
  }

  /**
   * 本地搜索降级：使用本地标签库 + 语义索引
   */
  async _searchLocal(query) {
    const includeArtist = hasArtistRequest(query)
    const ragResult = retrieveTags(query, { includeArtist })

    let response = ""

    if (query.length >= 2) {
      const vocab = loadVocabIndex()
      if (vocab) {
        const queryClean = normalizeCJK(query.toLowerCase().trim())
        const existingTags = new Set(ragResult.characters.map(c => c.characterTag))
        for (const [cnKey, entry] of vocab) {
          if (entry.category === 4 && cnKey.includes(queryClean) && !existingTags.has(entry.tag.replace(/_/g, " "))) {
            ragResult.characters.push({
              characterTag: entry.tag.replace(/_/g, " "),
              appearance: entry.wiki || "",
              series: "",
            })
          }
        }
        if (ragResult.characters.length > 5) {
          ragResult.characters = ragResult.characters.slice(0, 5)
        }
      }
    }

    if (ragResult.characters.length > 0) {
      response += "【角色】\n"
      for (const ch of ragResult.characters) {
        response += `- 标签: ${ch.characterTag}\n`
        if (ch.appearance) response += `  外貌: ${ch.appearance}\n`
        if (ch.series) response += `  作品: ${ch.series}\n`
      }
    }

    if (ragResult.tags.length > 0) {
      const grouped = {}
      for (const t of ragResult.tags) {
        if (!grouped[t.category]) grouped[t.category] = []
        grouped[t.category].push(t.tags)
      }
      const names = { action: "动作", clothing: "服装", body: "属性", scene: "场景", composition: "构图" }
      for (const [cat, tagList] of Object.entries(grouped)) {
        response += `【${names[cat] || cat}】${tagList.join(", ")}\n`
      }
    }

    if (ragResult.vocabTags?.length > 0) {
      response += "【词汇匹配】\n"
      for (const v of ragResult.vocabTags) {
        response += `- ${v.cn} → ${v.tag}`
        if (v.wiki) response += ` (${v.wiki.slice(0, 40)})`
        response += "\n"
      }
    }

    if (ragResult.artistTags) {
      response += `【画师】${ragResult.artistTags}\n`
    }

    if (ragResult.characters.length === 0) {
      try {
        const { semanticSearch, isIndexReady } = await import("../semanticTagSearch.js")
        if (isIndexReady()) {
          const results = await semanticSearch(query, 5)
          const filtered = results.filter(r => r.score > 0.35)
          if (filtered.length > 0) {
            response += "【语义检索】\n"
            for (const r of filtered) {
              response += `- ${r.tag}（${r.cnName}）score:${r.score.toFixed(2)}`
              if (r.wiki) response += ` - ${r.wiki.slice(0, 50)}`
              response += "\n"
            }
          }
        }
      } catch {
        // 语义搜索不可用时静默降级
      }
    }

    if (!response) {
      const isEnglishOnly = /^[a-zA-Z0-9\s\-_.,():'"!?]+$/.test(query)
      if (isEnglishOnly) {
        response = `未找到"${query}"的匹配标签。提示：请尝试使用中文关键词查询，匹配率更高。`
      } else {
        response = `未找到"${query}"的匹配标签。建议换个关键词或使用更具体的角色名。`
      }
    }

    return response.trim()
  }
}
