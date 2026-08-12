import { retrieveTags, hasArtistRequest } from "../animaTagRetriever.js"
import { warmupIndex } from "../semanticTagSearch.js"

// 启动时只加载向量缓存（不加载 ONNX 模型），实际模型在首次语义搜索时懒加载
warmupIndex()

export class TagSearchTool {
  name = "searchTags"
  description = "查询 Danbooru 标签。在使用 generateImage 生图之前必须先调用此工具查询准确标签。输入角色名/动作/概念的中文，返回正确的英文 Danbooru 标签和描述。"

  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "直接传入用户原文中的中文关键词，不要翻译成英文。例如用户说「画伊芙琳」则传入「伊芙琳」，用户说「虹夏弹吉他」则传入「虹夏 弹吉他」。",
      },
      semantic: {
        type: "boolean",
        description: "是否启用语义搜索（当精确匹配无结果时设为true）。默认false。",
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
    const { query, semantic = false } = opts
    if (!query) return "请提供查询关键词"

    // 检测是否传入了纯英文（不含中文字符），提示应使用中文
    if (/^[a-zA-Z0-9\s\-_.,():'"!?]+$/.test(query)) {
      return `查询"${query}"无结果。请使用中文关键词查询（如角色的中文名），不要翻译成英文。`
    }

    const includeArtist = hasArtistRequest(query)
    const ragResult = retrieveTags(query, { includeArtist })

    let response = ""

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

    if (ragResult.vocabTags && ragResult.vocabTags.length > 0) {
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

    // 语义搜索（仅在 semantic=true 且关键词无角色结果时）
    if (semantic && ragResult.characters.length === 0) {
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
        } else {
          response += "（语义索引尚未就绪，仅返回关键词匹配结果）\n"
        }
      } catch {
        // 语义搜索不可用时静默降级
      }
    }

    if (!response) {
      response = `未找到"${query}"的匹配标签。建议：直接使用英文 Danbooru 格式标签，或尝试 semantic:true 语义搜索。`
    }

    return response.trim()
  }
}
