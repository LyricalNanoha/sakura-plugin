import { retrieveTags, hasArtistRequest } from "../animaTagRetriever.js"
import { warmupIndex } from "../semanticTagSearch.js"

// 启动时只加载向量缓存（不加载 ONNX 模型），实际模型在首次语义搜索时懒加载
warmupIndex()

export class TagSearchTool {
  name = "searchTags"
  description = "查询 Danbooru 标签。在使用 generateImage 之前调用，用于查找角色名、动作、服装等的准确英文标签。当你不确定某个角色/动作/概念的正确 Danbooru 标签时必须先调用此工具。"

  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "要查询的中文关键词（如角色名、动作描述、服装等）",
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
